import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  EditingSession,
  type ContextRevision,
  type EditingSessionDocument,
  type TimelineIr,
  type TimelineIrEditOperation,
  type TimelineIrProvider,
} from "@framekit/runtime";
import type { FinalCutSqliteInspectionProvider } from "@framekit/final-cut";

export interface StoredEditingSession {
  sessionId: string;
  document: EditingSessionDocument;
}

export interface EditingSessionProviderChange {
  from: ContextRevision;
  to: ContextRevision;
}

export interface EditingSessionChangeSource {
  changesSince(revision: ContextRevision): Promise<EditingSessionProviderChange>;
}

export function createCanonicalSessionChangeSource(
  readCurrent: () => Promise<Pick<TimelineIr, "revision">>,
): EditingSessionChangeSource {
  return {
    changesSince: async (revision) => ({
      from: revision,
      to: (await readCurrent()).revision,
    }),
  };
}

export class EditingSessionRepository {
  public constructor(
    private readonly directory: string,
    private readonly changeSource?: EditingSessionChangeSource,
  ) {}

  public async create(input: {
    sessionId?: string;
    base: TimelineIr;
    provider?: TimelineIrProvider;
  }): Promise<StoredEditingSession> {
    const sessionId = input.sessionId ?? `session-${randomUUID()}`;
    await this.assertMissing(sessionId);
    const session = EditingSession.create({ base: input.base, provider: input.provider });
    return this.save(sessionId, session);
  }

  public async inspect(sessionId: string): Promise<StoredEditingSession> {
    const session = await this.load(sessionId);
    return { sessionId, document: session.document() };
  }

  public async preview(
    sessionId: string,
    operations: TimelineIrEditOperation[],
    expectedRevision?: ContextRevision,
  ) {
    const session = await this.load(sessionId);
    await this.refreshLoaded(sessionId, session);
    return session.preview(operations, expectedRevision);
  }

  public async execute(
    sessionId: string,
    operations: TimelineIrEditOperation[],
    expectedRevision?: ContextRevision,
  ): Promise<StoredEditingSession> {
    const session = await this.load(sessionId);
    await this.refreshLoaded(sessionId, session);
    session.apply(operations, expectedRevision);
    return this.save(sessionId, session);
  }

  public async status(sessionId: string) {
    const session = await this.load(sessionId);
    await this.refreshLoaded(sessionId, session);
    const document = session.document();
    return {
      sessionId,
      state: document.state,
      ...(document.provider ? { provider: document.provider } : {}),
      baseRevision: document.base.revision,
      desiredRevision: document.desired.revision,
      ...(document.observation ? { observation: document.observation } : {}),
      readyToMaterialize: document.state === "clean" || document.state === "dirty" || document.state === "rebased",
    };
  }

  public async reconcile(
    sessionId: string,
    provider: TimelineIrProvider,
    providerState: TimelineIr,
  ) {
    const session = await this.load(sessionId);
    const boundProvider = session.document().provider;
    if (boundProvider && boundProvider.id !== provider.id) {
      throw new Error(`SESSION_PROVIDER_MISMATCH: expected ${boundProvider.id}, received ${provider.id}`);
    }
    const reconciliation = session.reconcile(providerState);
    const stored = await this.save(sessionId, session);
    return { ...stored, reconciliation };
  }

  public async observe(
    sessionId: string,
    sourcePath: string,
    provider: Pick<FinalCutSqliteInspectionProvider, "inspect">,
  ) {
    const result = await provider.inspect(sourcePath);
    if (result.status !== "partial") {
      throw new Error(`${result.error.code}: ${result.error.message.replaceAll(sourcePath, "[redacted]")}`);
    }
    const session = await this.load(sessionId);
    const observation = {
      backend: result.observation.backend,
      sourceId: createHash("sha256").update(resolve(sourcePath)).digest("hex"),
      databaseKind: result.observation.databaseKind,
      digest: result.observation.digest,
      schemaVersion: result.observation.schemaVersion,
      observedAt: result.observation.revision.timestamp,
      canonical: false as const,
      coverageComplete: false as const,
    };
    const change = session.bindObservation(observation);
    const stored = await this.save(sessionId, session);
    return { ...stored, observation, change };
  }

  public async refresh(sessionId: string) {
    const session = await this.load(sessionId);
    if (!this.changeSource) throw new Error("CAPABILITY_UNAVAILABLE: session provider change stream");
    const change = await this.refreshLoaded(sessionId, session);
    return {
      sessionId,
      document: session.document(),
      providerRevision: change!.to,
      change: sameRevision(change!.from, change!.to) ? "unchanged" as const : "changed" as const,
    };
  }

  public async loadForMaterialization(sessionId: string): Promise<EditingSession> {
    const session = await this.load(sessionId);
    await this.refreshLoaded(sessionId, session);
    return session;
  }

  public checkpoint(sessionId: string, session: EditingSession): Promise<StoredEditingSession> {
    return this.save(sessionId, session);
  }

  private async load(sessionId: string): Promise<EditingSession> {
    try {
      return EditingSession.fromJSON(await readFile(this.path(sessionId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`SESSION_NOT_FOUND: unknown editing session ${sessionId}`);
      }
      throw error;
    }
  }

  private async refreshLoaded(
    sessionId: string,
    session: EditingSession,
  ): Promise<EditingSessionProviderChange | undefined> {
    if (!this.changeSource) return undefined;
    const change = await this.changeSource.changesSince(session.base().revision);
    if (!sameRevision(change.from, session.base().revision)) {
      throw new Error("SESSION_CHANGE_STREAM_BASE_MISMATCH: provider change stream did not start at the session base");
    }
    const freshness = session.observeProviderRevision(change.to);
    if (freshness === "changed") await this.save(sessionId, session);
    return change;
  }

  private async save(sessionId: string, session: EditingSession): Promise<StoredEditingSession> {
    const path = this.path(sessionId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${session.serialize()}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
    return { sessionId, document: session.document() };
  }

  private async assertMissing(sessionId: string): Promise<void> {
    try {
      await readFile(this.path(sessionId));
      throw new Error(`SESSION_ALREADY_EXISTS: editing session ${sessionId} already exists`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private path(sessionId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
      throw new Error("SESSION_ID_INVALID: sessionId must be a portable identifier");
    }
    return join(this.directory, `${sessionId}.json`);
  }
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}
