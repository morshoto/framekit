#!/usr/bin/env python3
"""Measure source audio through Framekit's optional JSON command protocol."""

import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def fail(code: str, message: str) -> None:
    print(f"{code}: {message}", file=sys.stderr)
    raise SystemExit(78)


def number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        fail("AUDIO_REQUEST_INVALID", "range coordinates must be finite numbers")
    return float(value)


def run(args: list[str], code: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(args, capture_output=True, text=True, check=True, timeout=45,
                              env={**os.environ, "LC_ALL": "C"})
    except (OSError, subprocess.SubprocessError):
        fail(code, "required local media tool failed or exceeded its deadline")
    raise AssertionError("unreachable")


def sample_coordinate(seconds: float, rate: int, start: bool) -> int:
    samples = seconds * rate
    if not math.isfinite(samples) or samples > 2**53 - 1:
        fail("AUDIO_REQUEST_INVALID", "range exceeds supported sample coordinates")
    nearest = round(samples)
    inward = nearest / rate >= seconds if start else nearest / rate <= seconds
    if abs(samples - nearest) < 1e-7 and inward:
        return nearest
    return math.ceil(samples) if start else math.floor(samples)


def main() -> None:
    try:
        request = json.load(sys.stdin)
    except (ValueError, TypeError):
        fail("AUDIO_REQUEST_INVALID", "expected one JSON request")
    if not isinstance(request, dict) or not isinstance(request.get("media"), dict):
        fail("AUDIO_REQUEST_INVALID", "media is required")
    if request.get("occurrenceId") is not None:
        fail("AUDIO_SCOPE_UNAVAILABLE", "this backend measures source audio, not an occurrence or editor output")
    requested = request.get("range")
    if requested is not None:
        if not isinstance(requested, dict):
            fail("AUDIO_REQUEST_INVALID", "range must be an object")
        start, end = number(requested.get("start")), number(requested.get("end"))
        if start < 0 or end <= start:
            fail("AUDIO_REQUEST_INVALID", "range must be nonnegative and positive in duration")
    source = request["media"].get("source")
    if not isinstance(source, str) or not os.path.isfile(source):
        fail("AUDIO_SOURCE_UNAVAILABLE", "a readable local source file is required")
    probe = run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_streams", "-show_format", "-of", "json", source],
                "AUDIO_SOURCE_UNAVAILABLE")
    try:
        metadata = json.loads(probe.stdout)
        streams = metadata["streams"]
        if not isinstance(streams, list) or len(streams) != 1:
            raise ValueError("ambiguous audio streams")
        audio = streams[0]
        rate, channels = int(audio["sample_rate"]), audio["channels"]
        if audio.get("codec_type") != "audio" or rate <= 0 or isinstance(channels, bool) or channels not in (1, 2):
            raise ValueError("unsupported format")
        offset = float(audio.get("start_time", 0))
        if not math.isfinite(offset) or abs(offset) > 1e-9:
            raise ValueError("source offset is not supported")
        layout = audio.get("channel_layout")
        if layout is not None and layout not in ("mono" if channels == 1 else "stereo", "unknown"):
            raise ValueError("unsupported channel layout")
        if requested is None:
            start = 0.0
            end = float(audio.get("duration", metadata.get("format", {}).get("duration")))
            if not math.isfinite(end) or end <= 0:
                raise ValueError("unknown source duration")
    except (ValueError, TypeError, KeyError):
        fail("AUDIO_SOURCE_UNAVAILABLE", "expected one mono/stereo audio stream with supported source timing")
    first, last = sample_coordinate(start, rate, True), sample_coordinate(end, rate, False)
    count = last - first
    if count / rate < 0.4:
        fail("AUDIO_MEASUREMENT_UNAVAILABLE", "at least 400 ms of sample-aligned signal is required")
    with tempfile.TemporaryDirectory(prefix="framekit-source-meter-") as temporary:
        pcm = Path(temporary) / "source.f32le"
        run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-i", source,
             "-map", "0:a:0", "-vn", "-af", f"atrim=start_sample={first}:end_sample={last},asetpts=PTS-STARTPTS",
             "-ar", str(rate), "-ac", str(channels), "-c:a", "pcm_f32le", "-f", "f32le", "-y", str(pcm)],
            "AUDIO_MEASUREMENT_UNAVAILABLE")
        if pcm.stat().st_size != count * channels * 4:
            fail("AUDIO_MEASUREMENT_UNAVAILABLE", "decoded samples do not cover the requested source interval")
        measured = run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "info", "-f", "f32le",
                        "-ar", str(rate), "-ac", str(channels), "-i", str(pcm), "-af",
                        "silencedetect=noise=-60dB:d=0.1,ebur128=peak=true:framelog=verbose", "-f", "null", "-"],
                       "AUDIO_MEASUREMENT_UNAVAILABLE").stderr
    summary = measured[measured.rfind("Summary:"):]
    try:
        integrated = float(re.search(r"Integrated loudness:\s+I:\s+(\S+)\s+LUFS", summary)[1])
        peak = float(re.search(r"True peak:\s+Peak:\s+(\S+)\s+dBFS", summary)[1])
        silence = sum(float(value) * 1000 for value in re.findall(r"silence_duration:\s*(\S+)", measured))
        if not all(math.isfinite(value) for value in (integrated, peak, silence)) or integrated <= -70 or not 0 <= silence <= count / rate * 1000 + 1:
            raise ValueError("unavailable metrics")
    except (ValueError, TypeError):
        fail("AUDIO_MEASUREMENT_UNAVAILABLE", "signal is silent, below the loudness gate or lacks a valid measurement summary")
    result = {
        "signalScope": "source", "integratedLufs": integrated, "truePeakDb": peak, "silenceMs": silence,
        "sourceTimebase": {"value": "1", "timescale": str(rate)},
        "signalFormat": {"sampleRate": rate, "channels": channels},
        "requestedRange": {"start": start, "end": end},
        "measuredRange": {"start": first / rate, "end": last / rate,
                          "startTime": {"value": str(first), "timescale": str(rate)},
                          "durationTime": {"value": str(count), "timescale": str(rate)}},
        "analyzedDurationSeconds": count / rate,
    }
    if layout in ("mono", "stereo"):
        result["signalFormat"]["channelLayout"] = layout
    print(json.dumps(result, separators=(",", ":"), allow_nan=False))


if __name__ == "__main__":
    main()
