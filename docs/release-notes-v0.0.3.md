# v0.0.3 Release Evidence

The v0.0.3 release gate verifies the filler-removal and dialogue-normalization
closed loops against the repository-owned deterministic corpus through generic
MCP Skill tools.

Verified locally:

- preview authorization and non-mutation;
- deterministic plans, operations, canonical diffs, and digests;
- safe filler verification and the 95% target calculation;
- dialogue LUFS/true-peak verification from a new measurement;
- non-mutation for unsafe inputs;
- complete rollback for induced verification failures.

This evidence is fixture-backed. The current FCPXML adapter and bundled live
Final Cut Workflow Extension remain explicitly unsupported for the complete
v0.0.3 Skills. Release notes must not claim autonomous open-project Final Cut
support until a disposable headed run records reproducible live evidence.
