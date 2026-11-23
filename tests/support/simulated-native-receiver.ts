/** Test-only receiver: its observations never establish native terminality. */
export type SimulatedIdentity = {
  operationId: string;
  targetId: string;
  sourceDigest: string;
  revisionId: string;
};
type State = "accepted" | "rejected" | "uncertain";
type Step = { kind: "accept" | "reject" | "lose-response" | "stall" };
type Event = SimulatedIdentity & { tick: number; kind: "dispatch" | "accepted" | "rejected" | "response-lost" | "stalled" };
type Entry = { identity: SimulatedIdentity; state: State; resolve?: (result: { state: State }) => void };
type Storage = { tick: number; events: Event[]; entries: Map<string, Entry>; script: Step[] };

export class ScriptedNativeReceiver {
  public readonly evidenceTier = "simulated-native" as const;
  private readonly storage: Storage;

  public constructor(script: Step[], storage?: Storage) {
    this.storage = storage ?? { tick: 0, events: [], entries: new Map(), script: [...script] };
  }

  public trace(): Event[] {
    return this.storage.events.map(event => ({ ...event }));
  }

  public restart(): ScriptedNativeReceiver {
    return new ScriptedNativeReceiver([], this.storage);
  }

  public async dispatch(request: SimulatedIdentity): Promise<{ state: State }> {
    const previous = this.storage.entries.get(request.operationId);
    if (previous) {
      if (Object.keys(request).some(key => request[key as keyof SimulatedIdentity] !== previous.identity[key as keyof SimulatedIdentity])) {
        throw new Error("SIMULATED_IDENTITY_MISMATCH");
      }
      return { state: previous.state };
    }
    const step = this.storage.script.shift();
    if (!step) throw new Error("SIMULATED_SCRIPT_EXHAUSTED");
    const entry: Entry = { identity: { ...request }, state: "uncertain" };
    this.storage.entries.set(request.operationId, entry);
    this.record("dispatch", entry.identity);
    if (step.kind === "stall") {
      this.record("stalled", entry.identity);
      return new Promise(resolve => { entry.resolve = resolve; });
    }
    if (step.kind === "lose-response") {
      this.record("response-lost", entry.identity);
      return { state: "uncertain" };
    }
    entry.state = step.kind === "accept" ? "accepted" : "rejected";
    this.record(entry.state, entry.identity);
    return { state: entry.state };
  }

  public reply(operationId: string, state: "accepted" | "rejected"): void {
    const entry = this.storage.entries.get(operationId);
    if (!entry?.resolve) throw new Error("SIMULATED_OPERATION_NOT_STALLED");
    entry.state = state;
    const resolve = entry.resolve;
    delete entry.resolve;
    this.record(state, entry.identity);
    resolve({ state });
  }

  private record(kind: Event["kind"], identity: SimulatedIdentity): void {
    this.storage.events.push({ tick: ++this.storage.tick, kind, ...identity });
  }
}
