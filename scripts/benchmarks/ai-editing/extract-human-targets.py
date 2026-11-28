#!/usr/bin/env python3
"""Extract only the preselected public audio rows to a disposable directory.

Requires pyarrow. The Node runner verifies the original parquet SHA-256 first.
"""
import hashlib
import json
import sys
import wave
from pathlib import Path

import pyarrow
import pyarrow.parquet as pq

parquet_path, case_path, output_path = map(Path, sys.argv[1:])
case = json.loads(case_path.read_text(encoding="utf-8"))
selected = case["sampleIds"]
if len(selected) != len(set(selected)):
    raise ValueError("Duplicate selected IDs")
rows = pq.read_table(parquet_path, columns=["id", "audio", "text", "target", "target_onset", "target_offset"]).to_pylist()
by_id = {}
for row in rows:
    if row["id"] in selected:
        if row["id"] in by_id:
            raise ValueError("Duplicate dataset ID")
        by_id[row["id"]] = row
if set(by_id) != set(selected):
    raise ValueError("Selected dataset IDs missing")
output_path.mkdir()
result = []
for index, sample_id in enumerate(selected):
    row = by_id[sample_id]
    audio = row["audio"]["bytes"]
    if not isinstance(audio, bytes):
        raise ValueError("Embedded audio is unavailable")
    filename = f"sample-{index:02}.wav"
    file = output_path / filename
    file.write_bytes(audio)
    with wave.open(str(file), "rb") as stream:
        duration = stream.getnframes() / stream.getframerate()
    if not (0 <= row["target_onset"] < row["target_offset"] <= duration):
        raise ValueError("Human target outside audio")
    result.append({"id":sample_id,"file":filename,"audioSha256":hashlib.sha256(audio).hexdigest(),"duration":duration,
                   "text":row["text"],"target":row["target"],"start":row["target_onset"],"end":row["target_offset"]})
print(json.dumps({"samples":result,"pythonVersion":sys.version.split()[0],"pyarrowVersion":pyarrow.__version__}, ensure_ascii=False))
