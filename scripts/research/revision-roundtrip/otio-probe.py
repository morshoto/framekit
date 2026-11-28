"""Pinned, test-only third-party conversion; never opens Final Cut or media."""
import hashlib
import importlib.metadata
import json
import subprocess
import sys
import xml.etree.ElementTree as ET

import opentimelineio as otio

assert len(sys.argv) == 3
raw = open(sys.argv[1], 'rb').read()
assert hashlib.sha256(raw).hexdigest() == '623ac3f65c4206d79ad41c56ab7cc020e0011ee64969bb7519e20253cdd29bcb'
assert otio.__version__ == '0.18.1'
adapter_version = importlib.metadata.version('otio-fcpx-xml-adapter')
assert adapter_version == '1.0.0'
# The adapter's output writer may run ffprobe for a path. Never inspect media.
def no_media_probe(*_args, **_kwargs):
    raise OSError('media probing disabled for this fixture')
subprocess.check_output = no_media_probe

def manifest(data):
    root = ET.fromstring(data)
    spine = root.find('.//sequence/spine')
    assert spine is not None
    return {'version': root.get('version'), 'clips': len(root.findall('.//sequence/spine/asset-clip')),
            'spineItems': len(spine), 'spineNames': [node.get('name') for node in spine],
            'audio': len(root.findall('.//audio')), 'titles': len(root.findall('.//title')),
            'anchors': len([md for md in root.findall('.//md') if md.get('key') == 'com.framekit.id']),
            'sha256': hashlib.sha256(data).hexdigest()}

collection = otio.adapters.read_from_string(raw.decode('utf8'), adapter_name='fcpx_xml')
assert isinstance(collection, otio.schema.SerializableCollection) and len(collection) == 1
sequence = collection[0]
assert isinstance(sequence, otio.schema.Timeline) and len(sequence.tracks) == 1
track = sequence.tracks[0]
assert len(track) > 0 and isinstance(track[0], otio.schema.Clip)
# A test-authored external edit in the third-party timeline, not a native export.
track[0].name = 'Third party edit'
converted = otio.adapters.write_to_string(sequence, adapter_name='fcpx_xml').encode('utf8')
with open(sys.argv[2], 'xb') as output:
    output.write(converted)
report = {'otioVersion': otio.__version__, 'adapterVersion': adapter_version, 'input': manifest(raw),
          'observedTrackCount': len(sequence.tracks), 'observedClipCount': len(track),
          'missingReferences': sum(isinstance(item.media_reference, otio.schema.MissingReference) for item in track if isinstance(item, otio.schema.Clip)),
          'output': manifest(converted), 'mediaProbe': 'disabled'}
print(json.dumps(report, sort_keys=True))
