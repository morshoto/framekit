"""Independent-process fixture edit, not a human or Final Cut editor."""
import copy
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
spine = root.find('./library/event/project/sequence/spine')
assert spine is not None
clips = spine.findall('asset-clip')
assert len(clips) == 2
opening, closing = clips
assert opening.get('name') == 'Opening' and opening.get('start') == '1s'
assert closing.get('name') == 'Closing' and closing.get('start') == '3s'
opening.set('start', '2s')
for kind in ('audio', 'title'):
    child = opening.find(kind)
    assert child is not None and child.get('offset') == '1s'
    child.set('offset', '2s')
closing.set('name', 'Closing A')
closing.set('duration', '1s')
inserted = copy.deepcopy(closing)
inserted.set('name', 'Opening')
inserted.set('offset', '2s')
inserted.set('start', '4s')
metadata = inserted.find('./metadata/md')
assert metadata is not None and metadata.get('value') == 'closing-v1'
metadata.set('value', 'inserted-v1')
spine.append(inserted)
with open(sys.argv[2], 'xb') as output:
    ET.ElementTree(root).write(output, encoding='utf-8', xml_declaration=True)
