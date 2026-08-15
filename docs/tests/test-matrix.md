# Test Matrix

| Area | In-memory fixture | FCPXML adapter | Live Workflow Extension |
| --- | --- | --- | --- |
| Project read | passed | passed | metadata only |
| Complete timeline read | passed | passed | unavailable |
| Timeline write | passed | passed | unavailable |
| Read-after-write | passed | passed | unavailable |
| Diff/change history | passed | passed | live sequence events |
| Playhead | fixture state | file-derived | passed live |
| Selected range | fixture state | file-derived | passed live |
| Speech/audio analysis | fixture provider | external provider required | unavailable |
| Verification/rollback | passed | passed | unavailable |
| Native assets | fixture assets | unavailable | unavailable |

“Metadata only” is not equivalent to a complete canonical timeline. The live
backend intentionally reports `timelineRead: false` until a supported native
clip/media enumeration surface is available.
