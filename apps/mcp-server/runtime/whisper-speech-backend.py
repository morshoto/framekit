#!/usr/bin/env python3
"""Run an optional local Whisper implementation against Framekit's JSON protocol.

The script intentionally has no Python package dependency of its own. Install
either mlx-whisper or openai-whisper in the environment that runs it and select
the model with FRAMEKIT_WHISPER_MODEL.
"""

import importlib
import json
import math
import os
import sys
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
        if segment_start < 0 or segment_end <= segment_start:
            fail(65, "WHISPER_OUTPUT_INVALID: segment boundaries are invalid")
        words = segment_record.get("words")
        if not isinstance(words, list) or not words:
            text = str(segment_record.get("text", "")).strip()
            words = [{"word": text, "start": segment_start, "end": segment_end}]
        for word in words:
            word_record = required_record(word, "word")
            text = str(word_record.get("word", word_record.get("text", ""))).strip()
            if not text:
                continue
            start = finite_number(word_record.get("start"), "word start")
            end = finite_number(word_record.get("end"), "word end")
            if start < 0 or end <= start:
                fail(65, "WHISPER_OUTPUT_INVALID: word boundaries are invalid")
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

    module_label, module = load_backend()
    result = transcribe(module_label, module, source)
    output = {
        "words": normalized_words(result, requested),
        "sourceTimebase": {"value": "1", "timescale": "1000"},
    }
    print(json.dumps(output, separators=(",", ":")))


if __name__ == "__main__":
    main()
