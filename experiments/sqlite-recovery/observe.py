#!/usr/bin/env python3
"""Offline, exploratory SQLite graph comparison. Never use for recovery decisions.

Input databases must be closed, standalone SQLite backup copies without journals.
The private graph is interpreted only under an explicit, exact schema fingerprint.
This compares occurrence/source multiplicities, not timeline semantics or completion.
"""
import argparse
import collections
import hashlib
import json
import plistlib
import sqlite3
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import unquote, urlparse


class Unsupported(ValueError):
    pass


def schema_hash(connection):
    rows = connection.execute("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").fetchall()
    return hashlib.sha256(repr(rows).encode()).hexdigest()


def fields(blob):
    try:
        archive = plistlib.loads(blob)
        objects = archive['$objects']
        def deref(value):
            return objects[value.data] if isinstance(value, plistlib.UID) else value
        root = deref(archive['$top']['root'])
        keys, values = root['NS.keys'], root['NS.objects']
        if len(keys) != len(values):
            raise ValueError('invalid dictionary')
        pairs = [(deref(k), deref(v)) for k, v in zip(keys, values)]
        if any(not isinstance(k, str) for k, _ in pairs) or len(dict(pairs)) != len(pairs):
            raise ValueError('invalid keys')
        return dict(pairs)
    except (KeyError, TypeError, IndexError, ValueError, plistlib.InvalidFileException) as exc:
        raise Unsupported('invalid metadata') from exc


def load_store(path, expected_schema):
    path = Path(path).resolve(strict=True)
    if not path.is_file() or any(Path(str(path) + suffix).exists() for suffix in ('-wal', '-shm', '-journal')):
        raise Unsupported('input must be a standalone closed backup without sidecars')
    db = sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)
    try:
        db.execute('PRAGMA query_only=ON')
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise Unsupported('database integrity check failed')
        if schema_hash(db) != expected_schema:
            raise Unsupported('unsupported schema fingerprint')
        records = {}
        for pk, kind, blob in db.execute('SELECT z.Z_PK,z.ZTYPE,m.ZDICTIONARYDATA FROM ZCOLLECTION z LEFT JOIN ZCOLLECTIONMD m ON z.ZMETADATA=m.Z_PK'):
            records[pk] = (kind, fields(blob) if blob and kind in {'FFAnchoredSequence', 'FFAssetRef', 'FFAsset', 'FFMediaRep'} else {})
        edges = collections.defaultdict(list)
        for parent, child in db.execute('SELECT Z_3PARENTCOLLECTIONS,Z_3CHILDCOLLECTIONS FROM Z_3CHILDCOLLECTIONS'):
            if parent not in records or child not in records:
                raise Unsupported('dangling graph edge')
            edges[parent].append(child)
        return records, edges
    except sqlite3.Error as exc:
        raise Unsupported('unreadable or unsupported database') from exc
    finally:
        db.close()


def reachable(store, start, kind):
    records, edges = store
    seen, queue, found = {start}, collections.deque([(start, 0)]), []
    while queue:
        node, depth = queue.popleft()
        if records[node][0] == kind:
            found.append(node)
        for child in edges[node]:
            if child not in seen:
                if depth >= 24:
                    raise Unsupported('graph exceeds traversal limit')
                seen.add(child)
                queue.append((child, depth + 1))
    return found


def unique(items, reason):
    if len(items) != 1:
        raise Unsupported(reason)
    return items[0]


def compare(stores, roots, sequence_id, project_id, xml_path, expected_schema):
    if not stores or len(stores) != len(roots) or len(set(map(lambda p: str(Path(p).resolve()), stores))) != len(stores):
        raise Unsupported('missing or duplicate stores')
    loaded = [load_store(p, expected_schema) for p in stores]
    seq_store, seq = unique([(i, pk) for i, (records, _) in enumerate(loaded) for pk, (kind, f) in records.items()
                             if kind == 'FFAnchoredSequence' and f.get('mediaIdentifier') == sequence_id], 'sequence missing or ambiguous')
    components = reachable(loaded[seq_store], seq, 'FFAnchoredMediaComponent')
    if not components:
        raise Unsupported('no components')
    observed = []
    for component in components:
        refs = reachable(loaded[seq_store], component, 'FFAssetRef')
        identifiers = {loaded[seq_store][0][n][1].get('mediaIdentifier') for n in refs}
        if None in identifiers:
            raise Unsupported('missing asset identifier')
        ident = unique(list(identifiers), 'asset reference missing or ambiguous')
        asset_store, asset = unique([(i, pk) for i, (records, _) in enumerate(loaded) for pk, (kind, f) in records.items()
                                     if kind == 'FFAsset' and f.get('mediaIdentifier') == ident], 'asset missing or ambiguous across stores')
        reps = reachable(loaded[asset_store], asset, 'FFMediaRep')
        rep = unique(reps, 'representation missing or ambiguous')
        f = loaded[asset_store][0][rep][1]
        relative = f.get('projectRelativePath')
        if f.get('repType') != 'originalMediaRep' or not isinstance(relative, str) or not relative or Path(relative).is_absolute() or '..' in Path(relative).parts:
            raise Unsupported('original-media representation unavailable')
        path = (Path(roots[asset_store]) / relative).resolve(strict=True)
        if not path.is_file():
            raise Unsupported('source missing')
        observed.append(str(path))
    root = ET.parse(xml_path).getroot()
    projects = root.findall('.//project')
    project = unique([p for p in projects if p.get('uid') == project_id], 'reference project missing or ambiguous')
    assets = {}
    for asset in root.findall('./resources/asset'):
        ident = asset.get('id')
        reps = asset.findall('media-rep')
        if not ident or ident in assets:
            raise Unsupported('reference asset id missing or ambiguous')
        rep = unique([r for r in reps if r.get('kind') == 'original-media'], 'reference original media missing or ambiguous')
        url = urlparse(rep.get('src', ''))
        if url.scheme != 'file' or url.netloc not in ('', 'localhost') or url.query or url.fragment:
            raise Unsupported('reference source is not a local file')
        path = Path(unquote(url.path)).resolve(strict=True)
        if not path.is_file():
            raise Unsupported('reference source missing')
        assets[ident] = str(path)
    clips = project.findall('.//asset-clip')
    if not clips or any(c.get('ref') not in assets for c in clips):
        raise Unsupported('reference clip source missing')
    expected = [assets[c.get('ref')] for c in clips]
    return {'source_occurrence_multiset_matches': collections.Counter(observed) == collections.Counter(expected),
            'observed_component_count': len(observed), 'reference_asset_clip_count': len(expected),
            'sequence_identity': 'matched undocumented mediaIdentifier',
            'project_binding': 'unproven: reference uid is not linked to observed sequence',
            'coverage': 'source multiplicities only; no order, timing, effects, nesting, integrity or completeness proof',
            'freshness': 'unproven; backups may represent different instants',
            'receiver_terminality': 'unproven', 'recovery_authorized': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store', action='append', required=True, help='closed backup copy; repeat in same order as --root')
    parser.add_argument('--root', action='append', required=True, help='original event directory for relative paths')
    parser.add_argument('--sequence', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--reference', required=True)
    parser.add_argument('--schema-sha256', required=True, help='explicit experimental schema fingerprint, not a compatibility guarantee')
    args = parser.parse_args()
    try:
        result = compare(args.store, args.root, args.sequence, args.project, args.reference, args.schema_sha256)
    except (Unsupported, OSError, ET.ParseError) as exc:
        parser.exit(2, 'observation unavailable: ' + str(exc) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
