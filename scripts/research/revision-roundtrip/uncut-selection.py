"""Fixture-only explicit mapping, not a production identity or approval mechanism."""
import hashlib
import json
from fractions import Fraction
import sys
import xml.etree.ElementTree as ET

assert len(sys.argv) == 4
raw = open(sys.argv[1], 'rb').read()
selection = json.load(open(sys.argv[2], encoding='utf8'))
assert set(selection) == {'digest', 'ordinal', 'source', 'start', 'duration', 'rename'}
assert hashlib.sha256(raw).hexdigest() == selection['digest']
assert b'<!ENTITY' not in raw.upper() and raw.count(b'<!DOCTYPE fcpxml>') == 1
root = ET.fromstring(raw)
assert root.tag == 'fcpxml' and root.get('version') == '1.10'
spine = root.find('./library/event/project/sequence/spine')
assert spine is not None and len(spine) == 3 and all(x.tag == 'asset-clip' for x in spine)
assert selection['ordinal'] == 1 and selection['rename'] == 'Selected split'
clip = spine[selection['ordinal']]
assert clip.get('name') == 'Opening'
assert clip.get('start') == selection['start'] and clip.get('duration') == selection['duration']
resources = root.find('./resources')
assert resources is not None
assets = resources.findall('asset')
ids = [a.get('id') for a in assets]
assert all(ids) and len(ids) == len(set(ids))
by_id = dict(zip(ids, assets))
def original_source(ref):
    asset = by_id.get(ref)
    assert asset is not None
    representations = asset.findall('media-rep')
    assert len(representations) == 1 and representations[0].get('kind') == 'original-media'
    src = representations[0].get('src')
    assert src
    return src
assert original_source(clip.get('ref')) == selection['source']
# Identical source URLs under different resource IDs cannot establish uniqueness.
assert sum(original_source(a.get('id')) == selection['source'] for a in assets) == 1
# Refuse an indistinguishable same-source/range candidate even with an ordinal.
def seconds(value):
    assert isinstance(value, str) and value.endswith('s')
    return Fraction(value[:-1])
assert sum(x.get('ref') == clip.get('ref') and seconds(x.get('start')) == seconds(clip.get('start')) and seconds(x.get('duration')) == seconds(clip.get('duration')) for x in spine) == 1
clip.set('name', selection['rename'])
result = b'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n' + ET.tostring(root, encoding='utf-8')
with open(sys.argv[3], 'xb') as output:
    output.write(result)
