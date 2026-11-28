"""Independent, fixture-specific B manifest verifier."""
import sys
import xml.etree.ElementTree as ET
before = ET.parse(sys.argv[1]).getroot()
root = ET.parse(sys.argv[2]).getroot()
original = before.find('./library/event/project/sequence/spine')[1]
assert original.get('name') == 'Opening'
original.set('name', 'Selected split')
assert ET.tostring(before) == ET.tostring(root), 'B changed more than the selected name'
assert root.get('version') == '1.10'
spine = root.find('./library/event/project/sequence/spine')
assert spine is not None and len(spine) == 3
assert [(x.get('name'), x.get('start'), x.get('duration'), x.get('offset')) for x in spine] == [
    ('Opening', '6000/6000s', '3000/6000s', '0s'),
    ('Selected split', '9000/6000s', '3000/6000s', '3000/6000s'),
    ('Closing', '18000/6000s', '12000/6000s', '6000/6000s')]
assert all(x.tag == 'asset-clip' and x.get('ref') == 'r3' for x in spine)
title = spine[0].find('title')
assert title is not None and title.get('lane') == '1' and title.get('offset') == '6000/6000s'
assert title.findtext('text/text-style') == 'Intro'
audio = spine[0].find('asset-clip')
assert audio is not None and audio.get('ref') == 'r4' and audio.get('lane') == '-1'
assert audio.get('offset') == '6000/6000s' and audio.get('duration') == '12000/6000s'
assert root.find("./resources/asset[@id='r3']/media-rep").get('src') == 'file:///synthetic/interview.mov'
assert root.find("./resources/asset[@id='r4']/media-rep").get('src') == 'file:///synthetic/music.wav'
