import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  EditingSession,
  type ContextRevision,
  type EditingSessionDocument,
  type TimelineIr,
  type TimelineIrEditOperation,
  type TimelineIrProvider,
} from "@framekit/runtime";

export interface StoredEditingSession {
  sessionId: string;
  document: EditingSessionDocument;
}

export class EditingSessionRepository {
  public constructor(private readonly directory: string) {}

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
    return session.preview(operations, expectedRevision);
  }

  public async execute(
    sessionId: string,
    operations: TimelineIrEditOperation[],
    expectedRevision?: ContextRevision,
  ): Promise<StoredEditingSession> {
    const session = await this.load(sessionId);
    session.apply(operations, expectedRevision);
    return this.save(sessionId, session);
  }

  public async status(sessionId: string) {
    const { document } = await this.inspect(sessionId);
    return {
      sessionId,
      state: document.state,
      ...(document.provider ? { provider: document.provider } : {}),
      baseRevision: document.base.revision,
      desiredRevision: document.desired.revision,
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
