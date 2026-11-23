import { createHash } from "node:crypto";

/** Test-only receiver: its observations never establish native terminality. */
export type SimulatedIdentity = {
  operationId: string;
  targetId: string;
  sourceDigest: string;
  desiredDigest: string;
  revisionId: string;
};
type State = "accepted" | "rejected" | "uncertain" | "not-dispatched";
type Step = { kind: "accept" | "reject" | "lose-response" | "stall" | "disconnect-before-dispatch" };
type Event = SimulatedIdentity & { tick: number; kind: "dispatch" | "accepted" | "rejected" | "response-lost" | "stalled" | "disconnected" };
type Entry = { identity: SimulatedIdentity; state: State; awaitingLateReply?: boolean; resolve?: (result: { state: State }) => void };
type Snapshot = { version: 1; tick: number; events: Event[]; entries: Array<{ identity: SimulatedIdentity; state: State; awaitingLateReply: boolean }>; script: Step[] };
type Storage = { tick: number; events: Event[]; entries: Map<string, Entry>; script: Step[] };

export class ScriptedNativeReceiver {
  public readonly evidenceTier = "simulated-native" as const;
  private readonly storage: Storage;

  public constructor(script: Step[], storage?: Storage) {
    this.storage = storage ?? { tick: 0, events: [], entries: new Map(), script: [...script] };
  }

  public snapshot(): Snapshot {
    return {
      version: 1,
      tick: this.storage.tick,
      events: this.trace(),
      entries: [...this.storage.entries.values()].map(entry => ({ identity: { ...entry.identity }, state: entry.state, awaitingLateReply: Boolean(entry.resolve || entry.awaitingLateReply) })),
      script: this.storage.script.map(step => ({ ...step })),
    };
  }

  public static restore(snapshot: Snapshot): ScriptedNativeReceiver {
    if (snapshot.version !== 1) throw new Error("SIMULATED_SNAPSHOT_VERSION_UNSUPPORTED");
    const entries = new Map(snapshot.entries.map(entry => [entry.identity.operationId, { identity: { ...entry.identity }, state: entry.state, awaitingLateReply: entry.awaitingLateReply }]));
    return new ScriptedNativeReceiver([], { tick: snapshot.tick, events: snapshot.events.map(event => ({ ...event })), entries, script: snapshot.script.map(step => ({ ...step })) });
  }

  public trace(): Event[] {
    return this.storage.events.map(event => ({ ...event }));
  }

  public inspect(operationId: string): { state: State } | undefined {
    const entry = this.storage.entries.get(operationId);
    return entry ? { state: entry.state } : undefined;
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
    if (step.kind === "disconnect-before-dispatch") {
      entry.state = "not-dispatched";
      this.record("disconnected", entry.identity);
      return { state: entry.state };
    }
    this.record("dispatch", entry.identity);
    if (step.kind === "stall") {
      this.record("stalled", entry.identity);
      return new Promise(resolve => { entry.resolve = resolve; });
    }
    if (step.kind === "lose-response") {
      entry.awaitingLateReply = true;
      this.record("response-lost", entry.identity);
      return { state: "uncertain" };
    }
    entry.state = step.kind === "accept" ? "accepted" : "rejected";
    this.record(entry.state, entry.identity);
    return { state: entry.state };
  }

  public reply(operationId: string, state: "accepted" | "rejected"): void {
    const entry = this.storage.entries.get(operationId);
    if (!entry || (!entry.resolve && !entry.awaitingLateReply)) throw new Error("SIMULATED_OPERATION_NOT_PENDING");
    entry.state = state;
    const resolve = entry.resolve;
    delete entry.resolve;
    delete entry.awaitingLateReply;
    this.record(state, entry.identity);
    resolve?.({ state });
  }

  private record(kind: Event["kind"], identity: SimulatedIdentity): void {
    this.storage.events.push({ tick: ++this.storage.tick, kind, ...identity });
  }
}

/** Inject the fake at the production materialization publisher boundary. */
export function simulatedMaterializationPublisher(receiver: ScriptedNativeReceiver): import("../../apps/mcp-server/src/materialization-jobs.js").SessionMaterializationPublisher {
  return {
    async publish(request) {
      const result = await receiver.dispatch({
        operationId: request.jobId,
        targetId: [request.target.libraryUid, request.target.eventUid, request.destination.projectUid, request.destination.sequenceUid].join("/"),
        // Hash source references without exposing paths; this is not a media-content digest.
        sourceDigest: createHash("sha256").update(JSON.stringify(request.desired.resources.map(resource => [resource.id, resource.source ?? null]).sort(([a], [b]) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))).digest("hex"),
        desiredDigest: request.desiredDigest,
        revisionId: request.baseRevision.id,
      });
      if (result.state === "uncertain") throw new Error("SIMULATED_RESPONSE_LOST");
      if (result.state === "not-dispatched") return { state: "blocked", code: "SIMULATED_DISCONNECTED", message: "Simulated connection lost before dispatch", retryable: true };
      if (result.state === "rejected") return { state: "blocked", code: "SIMULATED_REJECTION", message: "Simulated receiver rejected the request", retryable: false };
      return {
        state: "completed",
        canonicalReadback: request.desired,
        canonicalTarget: { libraryUid: request.target.libraryUid, eventUid: request.target.eventUid, projectUid: request.destination.projectUid, sequenceUid: request.destination.sequenceUid },
        headedNativeVerified: false,
      };
    },
  };
}
