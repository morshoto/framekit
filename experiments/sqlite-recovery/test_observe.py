import importlib.util
import hashlib
import plistlib
import sqlite3
import shutil
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('observe', Path(__file__).with_name('observe.py'))
o = importlib.util.module_from_spec(spec)
spec.loader.exec_module(o)


def blob(fields):
    objects = ['$null', {}]
    keys, vals = [], []
    for k, v in fields.items():
        objects.append(k); keys.append(plistlib.UID(len(objects)-1))
        objects.append(v); vals.append(plistlib.UID(len(objects)-1))
    objects[1] = {'NS.keys': keys, 'NS.objects': vals}
    return plistlib.dumps({'$objects': objects, '$top': {'root': plistlib.UID(1)}}, fmt=plistlib.FMT_BINARY)


class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'media.mov'
        self.source.write_bytes(b'synthetic media')
        self.dbpath = self.root / 'backup.sqlite'
        db = sqlite3.connect(self.dbpath)
        db.executescript('CREATE TABLE ZCOLLECTION(Z_PK INTEGER PRIMARY KEY,ZTYPE TEXT,ZMETADATA INTEGER); CREATE TABLE ZCOLLECTIONMD(Z_PK INTEGER PRIMARY KEY,ZDICTIONARYDATA BLOB); CREATE TABLE Z_3CHILDCOLLECTIONS(Z_3PARENTCOLLECTIONS INTEGER,Z_3CHILDCOLLECTIONS INTEGER);')
        self.schema = o.schema_hash(db)
        records = [(1,'FFAnchoredSequence',{'mediaIdentifier':'sequence'}), (2,'FFAnchoredMediaComponent',{}),
                   (3,'FFAssetRef',{'mediaIdentifier':'asset'}), (4,'FFAsset',{'mediaIdentifier':'asset'}),
                   (5,'FFMediaRep',{'projectRelativePath':'media.mov','repType':'originalMediaRep'})]
        for pk, kind, attrs in records:
            db.execute('INSERT INTO ZCOLLECTION VALUES(?,?,?)', (pk,kind,pk))
            db.execute('INSERT INTO ZCOLLECTIONMD VALUES(?,?)', (pk,blob(attrs)))
        db.executemany('INSERT INTO Z_3CHILDCOLLECTIONS VALUES(?,?)', [(1,2),(2,3),(4,5)])
        db.commit(); db.close()
        self.xml = self.root / 'reference.fcpxml'
        self.xml.write_text(f'<fcpxml><resources><asset id="a"><media-rep kind="original-media" src="{self.source.as_uri()}"/></asset></resources><library><event><project uid="project"><sequence><spine><asset-clip ref="a"/></spine></sequence></project></event></library></fcpxml>')

    def compare(self, **kwargs):
        args = dict(stores=[self.dbpath], roots=[self.root], sequence_id='sequence', project_id='project', xml_path=self.xml, expected_schema=self.schema)
        args.update(kwargs)
        return o.compare(**args)

    def alter(self, sql, args=()):
        db = sqlite3.connect(self.dbpath)
        try:
            db.execute(sql,args)
            db.commit()
        finally:
            db.close()

    def test_matching_source_is_only_partial_evidence(self):
        result = self.compare()
        self.assertTrue(result['source_occurrence_multiset_matches'])
        self.assertFalse(result['recovery_authorized'])
        self.assertIn('unproven', result['project_binding'])

    def test_backup_bytes_unchanged(self):
        before = hashlib.sha256(self.dbpath.read_bytes()).digest()
        self.compare()
        self.assertEqual(before, hashlib.sha256(self.dbpath.read_bytes()).digest())
        self.assertEqual([], list(self.root.glob('backup.sqlite-*')))

    def test_wrong_target(self):
        for target in ({'sequence_id':'other'}, {'project_id':'other'}):
            with self.subTest(target=target), self.assertRaises(o.Unsupported): self.compare(**target)

    def test_changed_snapshot_detected(self):
        other = self.root / 'other.mov'; other.write_bytes(b'other')
        self.alter('UPDATE ZCOLLECTIONMD SET ZDICTIONARYDATA=? WHERE Z_PK=5', (blob({'projectRelativePath':'other.mov','repType':'originalMediaRep'}),))
        self.assertFalse(self.compare()['source_occurrence_multiset_matches'])

    def test_missing_source(self):
        self.source.unlink()
        with self.assertRaises(OSError): self.compare()

    def test_ambiguous_sequence_and_asset(self):
        for kind, ident in [('FFAnchoredSequence','sequence'),('FFAsset','asset')]:
            with self.subTest(kind=kind):
                self.alter('INSERT INTO ZCOLLECTION VALUES(10,?,10)', (kind,))
                self.alter('INSERT INTO ZCOLLECTIONMD VALUES(10,?)', (blob({'mediaIdentifier':ident}),))
                with self.assertRaises(o.Unsupported): self.compare()
                self.alter('DELETE FROM ZCOLLECTION WHERE Z_PK=10')
                self.alter('DELETE FROM ZCOLLECTIONMD WHERE Z_PK=10')

    def test_inconsistent_store_is_rejected(self):
        self.alter('INSERT INTO Z_3CHILDCOLLECTIONS VALUES(1,999)')
        with self.assertRaises(o.Unsupported): self.compare()

    def test_unsupported_schema_and_sidecars_rejected(self):
        with self.assertRaises(o.Unsupported): self.compare(expected_schema='0'*64)
        Path(str(self.dbpath)+'-wal').touch()
        with self.assertRaises(o.Unsupported): self.compare()

    def test_duplicate_store_rejected(self):
        with self.assertRaises(o.Unsupported): self.compare(stores=[self.dbpath,self.dbpath], roots=[self.root,self.root])

    def test_individually_valid_inconsistent_stores_rejected(self):
        second = self.root / 'asset-store.sqlite'
        shutil.copyfile(self.dbpath, second)
        self.alter("DELETE FROM ZCOLLECTION WHERE Z_PK IN (4,5)")
        self.alter("DELETE FROM Z_3CHILDCOLLECTIONS WHERE Z_3PARENTCOLLECTIONS=4")
        db = sqlite3.connect(second)
        db.execute("DELETE FROM ZCOLLECTION WHERE Z_PK IN (1,2,3,4,5)")
        db.execute("DELETE FROM Z_3CHILDCOLLECTIONS")
        db.commit(); db.close()
        with self.assertRaises(o.Unsupported):
            self.compare(stores=[self.dbpath,second], roots=[self.root,self.root])

    def test_timeline_changes_can_preserve_source_multiset(self):
        before = self.compare()
        text = self.xml.read_text().replace('<asset-clip ref="a"/>', '<asset-clip ref="a" offset="99s" duration="1s"/>')
        self.xml.write_text(text)
        after = self.compare()
        self.assertTrue(before['source_occurrence_multiset_matches'])
        self.assertTrue(after['source_occurrence_multiset_matches'])
        self.assertIn('no order, timing', after['coverage'])
        self.assertFalse(after['recovery_authorized'])

    def test_media_contents_can_change_without_detection(self):
        self.source.write_bytes(b'changed')
        self.assertTrue(self.compare()['source_occurrence_multiset_matches'])
        self.assertFalse(self.compare()['recovery_authorized'])


if __name__ == '__main__': unittest.main()
