import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ContextRevision,
  EditorCapabilities,
  EditorIdentity,
  EditOperation,
  FinalCutLiveChange,
  FinalCutLivePort,
  FinalCutLiveState,
  ProjectSnapshot,
} from "../core/types.js";

export const FINAL_CUT_LIVE_PROTOCOL_VERSION = 1;

/** Matches FileManager.default.temporaryDirectory for the sandboxed container. */
export const DEFAULT_FINAL_CUT_LIVE_SOCKET = join(
  homedir(),
  "Library/Containers/com.playhead.finalcut.workflow.extension/Data/p.sock",
);

export type FinalCutLiveMethod = "capabilities" | "state" | "changes";

export interface FinalCutLiveRequest {
  version: number;
  id: string;
  method: FinalCutLiveMethod;
  afterSequence?: number;
  waitMs?: number;
}

export type FinalCutLiveResponse =
  | {
      version: number;
      id: string;
      ok: true;
      result: {
        identity: EditorIdentity;
        capabilities: EditorCapabilities;
        state?: FinalCutLiveState;
        changes?: FinalCutLiveChange[];
      };
    }
  | {
      version: number;
      id: string;
      ok: false;
      error: { code: string; message: string };
    };

export interface FinalCutLiveTransport {
  request(request: FinalCutLiveRequest): Promise<FinalCutLiveResponse>;
}

/** Newline-delimited JSON transport for the local Workflow Extension socket. */
export class UnixSocketFinalCutLiveTransport implements FinalCutLiveTransport {
  public constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 2_000,
  ) {}

  public request(request: FinalCutLiveRequest): Promise<FinalCutLiveResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";
      let socket: Socket | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (socket && !socket.destroyed) socket.destroy();
        callback();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`FINAL_CUT_LIVE_TIMEOUT: ${this.socketPath}`)));
      }, this.timeoutMs);

      socket = createConnection(this.socketPath);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket?.write(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        const line = buffer.slice(0, newline);
        finish(() => {
          try {
            resolve(JSON.parse(line) as FinalCutLiveResponse);
          } catch (error) {
            reject(new Error(`FINAL_CUT_LIVE_PROTOCOL: invalid JSON response (${String(error)})`));
          }
        });
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        finish(() => reject(new Error(`FINAL_CUT_LIVE_UNAVAILABLE: ${error.message}`)));
      });
      socket.on("end", () => {
        if (!settled) {
          clearTimeout(timer);
          finish(() => reject(new Error("FINAL_CUT_LIVE_PROTOCOL: bridge closed before response")));
        }
      });
    });
  }
}

export class FinalCutLiveAdapter implements FinalCutLivePort {
  public constructor(
    private readonly transport: FinalCutLiveTransport,
    private readonly socketPath = "configured-socket",
  ) {}

  public async getIdentity(): Promise<EditorIdentity> {
    const response = await this.request({ method: "capabilities" });
    return response.identity;
  }

  public async getCapabilities(): Promise<EditorCapabilities> {
    const response = await this.request({ method: "capabilities" });
    return response.capabilities;
  }

  public async readLiveState(): Promise<FinalCutLiveState> {
    const response = await this.request({ method: "state" });
    if (!response.state) throw new Error("FINAL_CUT_LIVE_PROTOCOL: state response was empty");
    return response.state;
  }

  public async liveChangesSince(revision: ContextRevision, waitMs = 0): Promise<FinalCutLiveChange[]> {
    const response = await this.request({
      method: "changes",
      afterSequence: revision.sequence,
      waitMs,
    });
    return response.changes ?? [];
  }

  /**
   * The Workflow Extension proxy is intentionally not treated as a complete
   * EditorPort snapshot source. It exposes live sequence state, not a
   * documented clip/media enumeration API.
   */
  public async read(): Promise<ProjectSnapshot> {
    return this.readProject();
  }

  public async readProject(): Promise<ProjectSnapshot> {
    throw new Error(
      "CAPABILITY_UNAVAILABLE: Final Cut Workflow Extension does not expose a complete canonical timeline snapshot",
    );
  }

  public async apply(_operation: EditOperation, _expectedRevision: ContextRevision): Promise<void> {
    throw new Error("CAPABILITY_UNAVAILABLE: live Final Cut timeline writes are not enabled");
  }

  public async restore(_snapshot: ProjectSnapshot, _expectedRevision: ContextRevision): Promise<void> {
    throw new Error("CAPABILITY_UNAVAILABLE: live Final Cut rollback is not enabled");
  }

  private async request(input: Pick<FinalCutLiveRequest, "method" | "afterSequence" | "waitMs">) {
    const response = await this.transport.request({
      version: FINAL_CUT_LIVE_PROTOCOL_VERSION,
      id: randomUUID(),
      ...input,
    });
    if (response.version !== FINAL_CUT_LIVE_PROTOCOL_VERSION) {
      throw new Error(`FINAL_CUT_LIVE_PROTOCOL: unsupported version ${response.version}`);
    }
    if (!response.ok) {
      throw new Error(`${response.error.code}: ${response.error.message}`);
    }
    return response.result;
  }
}

export function createFinalCutLiveAdapter(
  socketPath = process.env.PLAYHEAD_FINAL_CUT_SOCKET ?? DEFAULT_FINAL_CUT_LIVE_SOCKET,
): FinalCutLiveAdapter {
  return new FinalCutLiveAdapter(new UnixSocketFinalCutLiveTransport(socketPath), socketPath);
}
