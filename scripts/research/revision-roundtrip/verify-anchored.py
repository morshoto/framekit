"""Independent fixture manifest, not a Final Cut editability check."""
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
project = root.find('./library/event/project')
assert root.tag == 'fcpxml' and project is not None
assert project.get('uid') == 'project-framekit-8b68711b3f'
expected_name = sys.argv[2] if len(sys.argv) > 2 else 'Approved name'
assert expected_name in ('Approved name', 'Synthetic rename')
clips = project.findall('./sequence/spine/asset-clip')
assert [(c.get('name'), c.get('start'), c.get('duration')) for c in clips] == [
    (expected_name, '2s', '1s'), ('Closing A', '3s', '1s'), ('Opening', '4s', '1s')]
assert [c.find('./metadata/md').get('value') for c in clips] == ['opening-v1', 'closing-v1', 'inserted-v1']
assert clips[0].find('audio').attrib == {'ref': 'm', 'lane': '-1', 'offset': '1s', 'start': '0s', 'duration': '2s'}
assert clips[0].find('./title/text/text-style').text == 'Intro'
print('Anchored synthetic revision B manifest verified')
