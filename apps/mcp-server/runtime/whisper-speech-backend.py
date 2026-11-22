#!/usr/bin/env python3
"""Run an optional local Whisper implementation against Framekit's JSON protocol.

The script intentionally has no Python package dependency of its own. Install
either mlx-whisper or openai-whisper in the environment that runs it and select
the model with FRAMEKIT_WHISPER_MODEL.
"""

import importlib
import hashlib
import json
import math
import os
import sys
import subprocess
from typing import Any


def fail(code: int, message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def read_request() -> dict[str, Any]:
    try:
        value = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        fail(65, f"WHISPER_REQUEST_INVALID: backend received invalid JSON: {error}")
    if not isinstance(value, dict):
        fail(65, "WHISPER_REQUEST_INVALID: backend request must be an object")
    return value


def required_record(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(65, f"WHISPER_REQUEST_INVALID: {name} must be an object")
    return value


def finite_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        fail(65, f"WHISPER_OUTPUT_INVALID: {name} must be a finite number")
    return float(value)


def load_backend() -> tuple[str, Any]:
    requested = os.environ.get("FRAMEKIT_WHISPER_BACKEND", "auto").strip().lower()
    candidates = {
        "mlx-whisper": ("mlx_whisper", "MLX Whisper"),
        "openai-whisper": ("whisper", "openai-whisper"),
    }
    if requested not in {"auto", *candidates}:
        fail(78, "WHISPER_SETUP_REQUIRED: FRAMEKIT_WHISPER_BACKEND must be auto, mlx-whisper, or openai-whisper")

    ordered = list(candidates) if requested == "auto" else [requested]
    errors: list[str] = []
    for name in ordered:
        module_name, label = candidates[name]
        try:
            return label, importlib.import_module(module_name)
        except ImportError as error:
            errors.append(f"{name}: {error}")
    detail = "; ".join(errors)
    fail(78, f"WHISPER_SETUP_REQUIRED: install a selected local backend ({detail})")
    raise AssertionError("unreachable")


def transcribe(module_label: str, module: Any, source: str) -> dict[str, Any]:
    model = os.environ.get("FRAMEKIT_WHISPER_MODEL", "").strip()
    if not model:
        fail(78, "WHISPER_SETUP_REQUIRED: set FRAMEKIT_WHISPER_MODEL to a local model or model repository")
    language = os.environ.get("FRAMEKIT_WHISPER_LANGUAGE", "").strip() or None

    try:
        if module_label == "MLX Whisper":
            options: dict[str, Any] = {
                "path_or_hf_repo": model,
                "word_timestamps": True,
            }
            if language:
                options["language"] = language
            result = module.transcribe(source, **options)
        else:
            model_instance = module.load_model(model)
            options = {"word_timestamps": True, "verbose": False, "fp16": False}
            if language:
                options["language"] = language
            result = model_instance.transcribe(source, **options)
    except Exception as error:  # noqa: BLE001 - provider diagnostics must cross the process boundary
        fail(78, f"WHISPER_ANALYZER_FAILED: {module_label} could not transcribe the source: {error}")
    if not isinstance(result, dict):
        fail(65, "WHISPER_OUTPUT_INVALID: Whisper backend must return an object")
    return result


def confidence(value: Any) -> float:
    if value is None:
        # Whisper implementations may omit probability even when they expose
        # reliable timestamps. Zero preserves that uncertainty for selectors.
        return 0.0
    number = finite_number(value, "word confidence")
    if number < 0 or number > 1:
        fail(65, "WHISPER_OUTPUT_INVALID: word confidence must be between 0 and 1")
    return number


def normalized_words(result: dict[str, Any], requested: dict[str, Any] | None) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    segments = result.get("segments", [])
    if not isinstance(segments, list):
        fail(65, "WHISPER_OUTPUT_INVALID: segments must be an array")
    for segment in segments:
        segment_record = required_record(segment, "segment")
        segment_start = finite_number(segment_record.get("start"), "segment start")
        segment_end = finite_number(segment_record.get("end"), "segment end")
        if segment_start < 0 or segment_end < segment_start:
            fail(65, "WHISPER_OUTPUT_INVALID: segment boundaries are invalid")
        words = segment_record.get("words")
        text = str(segment_record.get("text", "")).strip()
        if segment_start == segment_end:
            if not text and (words is None or words == []):
                continue
            fail(65, "WHISPER_OUTPUT_INVALID: segment boundaries are invalid")
        if not isinstance(words, list) or not words:
            words = [{"word": text, "start": segment_start, "end": segment_end}]
        for word in words:
            word_record = required_record(word, "word")
            text = str(word_record.get("word", word_record.get("text", ""))).strip()
            if not text:
                continue
            start = finite_number(word_record.get("start"), "word start")
            end = finite_number(word_record.get("end"), "word end")
            if start < 0 or end < start:
                fail(65, "WHISPER_OUTPUT_INVALID: word boundaries are invalid")
            if start == end:
                continue
            if requested is not None:
                request_start = finite_number(requested.get("start"), "request start")
                request_end = finite_number(requested.get("end"), "request end")
                if start < request_start or end > request_end:
                    continue
            entries.append({
                "text": text,
                "start": start,
                "end": end,
                "confidence": confidence(word_record.get("probability", word_record.get("confidence"))),
            })

    entries.sort(key=lambda value: (value["start"], value["end"], value["text"]))
    for previous, current in zip(entries, entries[1:]):
        if current["start"] < previous["end"]:
            fail(65, "WHISPER_OUTPUT_INVALID: word timestamps overlap")
    return entries


class VadFailure(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def analyze_vad(source: str, media: dict[str, Any], requested: dict[str, Any] | None) -> dict[str, Any]:
    """Run a pinned local detector; ASR timestamps are never activity evidence."""
    model_path = os.environ.get("FRAMEKIT_SILERO_VAD_MODEL", "").strip()
    expected = os.environ.get("FRAMEKIT_SILERO_VAD_SHA256", "").strip().lower()
    if not model_path or len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
        raise VadFailure("SILERO_VAD_SETUP_REQUIRED")
    try:
        with open(model_path, "rb") as model_file:
            initial = hashlib.sha256(model_file.read()).hexdigest()
        if initial != expected:
            raise VadFailure("SILERO_VAD_MODEL_MISMATCH")
        torch = importlib.import_module("torch")
        detector = importlib.import_module("silero_vad")
        torch.set_num_threads(1)
        model = torch.jit.load(model_path, map_location="cpu")
        model.eval()
        decoded = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-i", source,
                                  "-map", "0:a:0", "-ar", "16000", "-ac", "1", "-f", "f32le", "-"],
                                 capture_output=True, check=True, timeout=45).stdout
        if not decoded or len(decoded) % 4:
            raise VadFailure("SILERO_VAD_SOURCE_INCOMPLETE")
        audio = torch.frombuffer(bytearray(decoded), dtype=torch.float32).clone()
        count = audio.numel()
        start = requested["start"] if requested is not None else 0
        end = requested["end"] if requested is not None else media.get("duration", count / 16000)
        if isinstance(end, bool) or not isinstance(end, (int, float)) or not math.isfinite(end) or end > count / 16000 + 1e-9:
            raise VadFailure("SILERO_VAD_SOURCE_INCOMPLETE")
        first, last = math.ceil(start * 16000), math.floor(end * 16000)
        if first < 0 or last <= first:
            raise VadFailure("SILERO_VAD_SOURCE_INCOMPLETE")
        intervals = detector.get_speech_timestamps(audio, model, sampling_rate=16000, threshold=0.5,
                                                 min_speech_duration_ms=250, min_silence_duration_ms=100,
                                                 speech_pad_ms=30, return_seconds=False)
        if not isinstance(intervals, list):
            raise VadFailure("SILERO_VAD_OUTPUT_INVALID")
        segments = []
        previous = 0
        for interval in intervals:
            if not isinstance(interval, dict):
                raise VadFailure("SILERO_VAD_OUTPUT_INVALID")
            a, b = interval.get("start"), interval.get("end")
            if type(a) is not int or type(b) is not int or a < previous or b <= a or b > count:
                raise VadFailure("SILERO_VAD_OUTPUT_INVALID")
            previous = b
            left, right = max(first, a), min(last, b)
            if right > left:
                segments.append({"start": left / 16000, "end": right / 16000, "kind": "speech"})
        with open(model_path, "rb") as model_file:
            if hashlib.sha256(model_file.read()).hexdigest() != initial:
                raise VadFailure("SILERO_VAD_MODEL_MISMATCH")
        return {"vadSegments": segments, "observedRange": {"start": first / 16000, "end": last / 16000},
                "requestedRange": {"start": start, "end": end}}
    except VadFailure:
        raise
    except Exception:  # Optional detector failures must not suppress available ASR.
        raise VadFailure("SILERO_VAD_ANALYZER_FAILED") from None


def main() -> None:
    request = read_request()
    media = required_record(request.get("media"), "media")
    source = media.get("source")
    if not isinstance(source, str) or not source:
        fail(65, "WHISPER_REQUEST_INVALID: media.source is required")
    if not os.path.isfile(source):
        fail(78, f"WHISPER_MEDIA_UNAVAILABLE: source does not exist: {source}")

    requested = request.get("range")
    if requested is not None:
        requested = required_record(requested, "range")
        start = finite_number(requested.get("start"), "request start")
        end = finite_number(requested.get("end"), "request end")
        if start < 0 or end <= start:
            fail(65, "WHISPER_REQUEST_INVALID: range boundaries are invalid")

    vad = None
    vad_failure = None
    required_vad = os.environ.get("FRAMEKIT_SPEECH_REQUIRE_VAD") == "1"
    if os.environ.get("FRAMEKIT_SILERO_VAD_MODEL") or required_vad:
        try:
            vad = analyze_vad(source, media, requested)
        except VadFailure as error:
            if required_vad:
                fail(78, error.code + ": required detector unavailable; check its local model pin and dependencies")
            vad_failure = error.code
    module_label, module = load_backend()
    result = transcribe(module_label, module, source)
    output = {
        "words": normalized_words(result, vad["observedRange"] if vad is not None else requested),
        # Both supported Whisper implementations decode input at 16 kHz;
        # detector availability does not change the transcription clock.
        "sourceTimebase": {"value": "1", "timescale": "16000"},
    }
    if vad is not None:
        output.update(vad)
        output["schemaVersion"] = 1
        if "mediaId" in media:
            output.update(mediaId=media["mediaId"], sourceIdentity=media)
        if "revision" in request:
            output["revision"] = request["revision"]
        version = os.environ.get("FRAMEKIT_SPEECH_ANALYZER_VERSION", "").strip()
        if version:
            output["provider"] = {"id": "command.speech", "provider": "command", "version": version}
    if vad_failure is not None:
        output["vadUnavailableReason"] = vad_failure
    print(json.dumps(output, separators=(",", ":")))


if __name__ == "__main__":
    main()
