"""Check the synthetic B manifest using an independent XML parser."""
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
assert root.tag == 'fcpxml'
project = root.find('./library/event/project')
assert project is not None and project.get('uid') == 'project-framekit-8b68711b3f'
clips = project.findall('./sequence/spine/asset-clip')
assert [(c.get('name'), c.get('start'), c.get('duration')) for c in clips] == [
    ('Approved name', '1s', '1s'), ('Closing A', '3s', '1s'), ('Closing B', '4s', '1s')]
assert clips[0].find('audio').attrib == {'ref': 'm', 'lane': '-1', 'offset': '1s', 'start': '0s', 'duration': '2s'}
assert clips[0].find('./title/text/text-style').text == 'Intro'
print('Synthetic revision B manifest verified')
