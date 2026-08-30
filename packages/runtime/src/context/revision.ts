import type { ContextRevision } from "../domain/primitives.js";

export function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}
