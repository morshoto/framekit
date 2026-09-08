---
name: validate-mcp
description: Audit the Framekit MCP contract and runtime behavior with deterministic evaluation, headless Final Cut tests, real MCP calls, capability inspection, preview-execute-verify-undo sequencing, and explicit evidence tiers. Use for MCP QA prompts, checklist audits, capability questions, or requests to verify that MCP features work correctly.
---

# Validate the Framekit MCP

Start with deterministic contract evidence:

```sh
.agents/skills/validate-mcp/scripts/validate-contract.sh
```

Use `--full` to include the complete repository test suite. Then read `docs/tests/mcp-qa-prompt.md` and inspect the current tool schemas before making real MCP calls.

## Live QA order

1. Call `connection.status`.
2. Call `editor.inspect` and `project.inspect`.
3. Inspect `capabilities.families.<family>.<operation>` for `available`, `backend`, `guarantee`, and `unavailableReason`.
4. Route the edit and resolve intent when required.
5. Preview before execute.
6. Execute only when the requested backend and guarantee are available.
7. Verify with `edit.diff` and `edit.verify`.
8. Exercise `edit.undo` and verify restoration when the operation mutates state.

Treat unsupported capability results as authoritative and fail closed. `ready` proves only that a bridge answered.

## Report by evidence tier

Keep these claims separate:

1. fixture or deterministic contract;
2. FCPXML artifact behavior;
3. metadata-only live bridge behavior;
4. canonical live read/write behavior;
5. headed native Final Cut behavior.

List every requested invariant with pass, fail, unavailable, or not run. Never upgrade fixture, FCPXML, discovery, or metadata evidence into native placement, revision, duration, export, or Undo proof.
