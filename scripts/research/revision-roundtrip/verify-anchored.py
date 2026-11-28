"""Independent fixture manifest, not a Final Cut editability check."""
import sys
import xml.etree.ElementTree as ET
from fractions import Fraction

root = ET.parse(sys.argv[1]).getroot()
project = root.find('./library/event/project')
assert root.tag == 'fcpxml' and project is not None
assert project.get('uid') == 'project-framekit-8b68711b3f'
expected_name = sys.argv[2] if len(sys.argv) > 2 else 'Approved name'
assert expected_name in ('Approved name', 'Synthetic rename')
clips = project.findall('./sequence/spine/asset-clip')
assert [(c.get('name'), c.get('start'), c.get('duration')) for c in clips] == [
    (expected_name, '2s', '1s'), ('Closing A', '3s', '1s'), ('Opening', '4s', '1s')]
assert [(c.get('ref'), c.get('offset')) for c in clips] == [('a', '0s'), ('a', '1s'), ('a', '2s')]
assert [c.find('./metadata/md').get('value') for c in clips] == ['opening-v1', 'closing-v1', 'inserted-v1']
assert clips[0].find('audio').attrib == {'ref': 'm', 'lane': '-1', 'offset': '2s', 'start': '0s', 'duration': '2s'}
assert clips[0].find('title').attrib == {'ref': 'title-effect', 'lane': '2', 'offset': '2s', 'name': 'Intro', 'duration': '1s'}
assert clips[0].find('./title/text/text-style').text == 'Intro'
def seconds(value):
    assert value.endswith('s')
    return Fraction(value[:-1])
for kind in ('audio', 'title'):
    child = clips[0].find(kind)
    assert seconds(clips[0].get('offset')) + seconds(child.get('offset')) - seconds(clips[0].get('start')) == 0
print('Anchored synthetic revision B manifest verified')
