# Rough-cut duration policy

Status: implemented policy contract for issue #87.

The duration planner runs before a rough-cut shot plan chooses timing. It sums
each source's usable ranges once as `uniqueDurationSeconds` and separately
reports the amount marked `reusable`. A source is never repeated merely because
the requested duration is longer than the unique footage.

## Constraint policy

Callers may classify a requested duration as `hard` or `soft`. Ambiguous duration requests default to soft. A soft constraint recommends delivering a shorter
strong edit when unique footage is insufficient. A hard constraint remains
unmet unless the plan explicitly selects an allowed alternative or requests
additional footage.

The planner never silently loops or slows footage. Reuse is represented by
explicit `reusedRanges` containing the source ID, source range, and occurrence
number. Slow motion and generated/interstitial assets remain alternatives that
require confirmation, even when the caller permits them. Generated assets are
not permitted by default.

## Alternatives and reporting

An insufficient-footage plan lists the tradeoffs for:

- a shorter strong edit;
- intentional reuse of selected B-roll;
- editorially appropriate slow motion;
- requesting additional footage; and
- generated or interstitial assets when explicitly allowed.

Every plan and final result reports requested, achievable, and actual durations.
The planning response uses `actualDurationSeconds: null` until an observed
result is supplied. `editing.duration.plan` is read-only and can be called by
MCP clients before `timeline.edit.preview` or a future rough-cut constructor.

For a ten-minute request backed by four minutes of usable footage, the default
result is a four-minute shorter strong edit, with the other choices visible as
explicit alternatives and the missing six minutes reported as an unmet
duration constraint.
