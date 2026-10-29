#!/usr/bin/env python3
"""Compatibility entrypoint for the MCP-owned Whisper backend."""

from pathlib import Path
import runpy


backend = Path(__file__).resolve().parents[1] / "apps" / "mcp-server" / "runtime" / "whisper-speech-backend.py"
runpy.run_path(str(backend), run_name="__main__")
