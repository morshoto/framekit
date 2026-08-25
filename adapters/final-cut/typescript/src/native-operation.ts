export interface NativeOperationLease {
  acquire(): void;
  release(): void;
}

/** Coordinates one shared native-operation suspension across nested adapters. */
export function createNativeOperationLease(
  suspend?: () => void,
  resume?: () => void,
): NativeOperationLease {
  let depth = 0;
  return {
    acquire() {
      if (depth === 0) suspend?.();
      depth += 1;
    },
    release() {
      if (depth === 0) return;
      depth -= 1;
      if (depth === 0) resume?.();
    },
  };
}
