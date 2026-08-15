# ADR-0003: Preserve Rational Time

- Status: Accepted
- Date: 2026-08-16

## Context

Video timelines use frame rates such as 24000/1001. Floating-point seconds
cannot reliably preserve frame identity across editor boundaries.

## Decision

Use `{ value, timescale }` rational time values as the canonical representation
in the runtime and live IPC protocol. Convert to display seconds only at user
interface or command boundaries.

## Consequences

- Frame-accurate values remain distinguishable across round trips.
- JSON uses strings for integer values so large values remain safe.
- Tests must assert both value and timescale.
- Bootstrap events may temporarily report a zero timescale when Final Cut has
  not published that value yet; consumers must use current state and treat
  such values as unavailable.
