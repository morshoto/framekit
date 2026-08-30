export interface ContextRevision {
  id: string;
  sequence: number;
  timestamp: string;
}

export interface TimeRange {
  start: number;
  end: number;
  /** Exact representation used when the range crossed an editor boundary. */
  startTime?: RationalTime;
  durationTime?: RationalTime;
}

export interface RationalTimeRange {
  start: RationalTime;
  duration: RationalTime;
}

/** Exact interchange time; strings keep it JSON-safe at the MCP boundary. */
export interface RationalTime {
  value: string;
  timescale: string;
}
