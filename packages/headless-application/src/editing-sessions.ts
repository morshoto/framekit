import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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

const sessionUpdateQueues = new Map<string, Promise<void>>();

export interface StoredEditingSession {
  sessionId: string;
  document: EditingSessionDocument;
}

export interface EditingSessionPersistencePort {
  create(sessionId: string, document: EditingSessionDocument): Promise<void>;
  read(sessionId: string): Promise<EditingSessionDocument>;
  update(sessionId: string, document: EditingSessionDocument, expectedRevision: ContextRevision): Promise<void>;
}

/** File-backed session storage that preserves the established JSON path and shape. */
export class JsonFileEditingSessionPersistence implements EditingSessionPersistencePort {
  public constructor(private readonly directory: string) {}

  public async create(sessionId: string, document: EditingSessionDocument): Promise<void> {
    const path = this.path(sessionId);
    await withSessionUpdateLock(path, async () => {
      await this.assertMissing(sessionId);
      await this.write(sessionId, document);
    });
  }

  public async read(sessionId: string): Promise<EditingSessionDocument> {
    try {
      return EditingSession.fromJSON(await readFile(this.path(sessionId), "utf8")).document();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`SESSION_NOT_FOUND: unknown editing session ${sessionId}`);
      }
      throw error;
    }
  }

  public async update(
    sessionId: string,
    document: EditingSessionDocument,
    expectedRevision: ContextRevision,
  ): Promise<void> {
    const path = this.path(sessionId);
    await withSessionUpdateLock(path, async () => {
      const current = await this.read(sessionId);
      if (!sameRevision(current.desired.revision, expectedRevision)) {
        throw new Error("STALE_CONTEXT: persisted session revision changed before update");
      }
      await this.write(sessionId, document);
    });
  }

  private async write(sessionId: string, document: EditingSessionDocument): Promise<void> {
    const path = this.path(sessionId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const serialized = `${EditingSession.fromJSON(document).serialize()}\n`;
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
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
    private readonly persistence: EditingSessionPersistencePort,
    private readonly changeSource?: EditingSessionChangeSource,
  ) {}

  public async create(input: {
    sessionId?: string;
    base: TimelineIr;
    provider?: TimelineIrProvider;
  }): Promise<StoredEditingSession> {
    const sessionId = input.sessionId ?? `session-${randomUUID()}`;
    const session = EditingSession.create({ base: input.base, provider: input.provider });
    await this.persistence.create(sessionId, session.document());
    return { sessionId, document: session.document() };
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
    const storedRevision = session.desired().revision;
    session.apply(operations, expectedRevision);
    return this.save(sessionId, session, storedRevision);
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
    const storedRevision = session.desired().revision;
    const reconciliation = session.reconcile(providerState);
    const stored = await this.save(sessionId, session, storedRevision);
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
    const storedRevision = session.desired().revision;
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
    const stored = await this.save(sessionId, session, storedRevision);
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

  public hasChangeSource(): boolean {
    return this.changeSource !== undefined;
  }

  public checkpoint(sessionId: string, session: EditingSession): Promise<StoredEditingSession> {
    return this.save(sessionId, session, session.desired().revision);
  }

  private async load(sessionId: string): Promise<EditingSession> {
    try {
      return EditingSession.fromJSON(await this.persistence.read(sessionId));
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
    const storedRevision = session.desired().revision;
    const change = await this.changeSource.changesSince(session.base().revision);
    if (!sameRevision(change.from, session.base().revision)) {
      throw new Error("SESSION_CHANGE_STREAM_BASE_MISMATCH: provider change stream did not start at the session base");
    }
    const freshness = session.observeProviderRevision(change.to);
    if (freshness === "changed") await this.save(sessionId, session, storedRevision);
    return change;
  }

  private async save(
    sessionId: string,
    session: EditingSession,
    expectedRevision: ContextRevision,
  ): Promise<StoredEditingSession> {
    await this.persistence.update(sessionId, session.document(), expectedRevision);
    return { sessionId, document: session.document() };
  }
}

export type EditingSessionRepositoryPort = Pick<
  EditingSessionRepository,
  | "create"
  | "inspect"
  | "preview"
  | "execute"
  | "status"
  | "reconcile"
  | "observe"
  | "refresh"
  | "loadForMaterialization"
  | "hasChangeSource"
  | "checkpoint"
>;

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}

async function withSessionUpdateLock<T>(path: string, update: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = sessionUpdateQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveQueue) => {
    release = resolveQueue;
  });
  const queued = previous.then(() => current);
  sessionUpdateQueues.set(key, queued);
  await previous;
  try {
    return await update();
  } finally {
    release();
    if (sessionUpdateQueues.get(key) === queued) sessionUpdateQueues.delete(key);
  }
}
