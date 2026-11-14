import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EvidenceStatus } from "./native-editing.js";

const execFileAsync = promisify(execFile);

export interface RepositoryCheck {
  name: "install" | "build" | "test" | "mcp-evaluation" | "boundaries";
  command: string;
  status: EvidenceStatus;
  detail: string;
}

export interface RepositoryChecksReport {
  passed: boolean;
  checks: RepositoryCheck[];
}

export interface RepositoryCheckOptions {
  rootDirectory: string;
  run?: RepositoryCommandRunner;
}

export interface RepositoryCommandResult {
  code: number;
}

export type RepositoryCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<RepositoryCommandResult>;

const commands: Array<Pick<RepositoryCheck, "name" | "command"> & { args: string[] }> = [
  { name: "install", command: "pnpm", args: ["install", "--frozen-lockfile"] },
  { name: "build", command: "pnpm", args: ["run", "build"] },
  { name: "test", command: "pnpm", args: ["run", "test"] },
  { name: "mcp-evaluation", command: "pnpm", args: ["run", "evaluate"] },
  { name: "boundaries", command: "pnpm", args: ["run", "check:boundaries"] },
];

export function unrunRepositoryChecks(): RepositoryChecksReport {
  return {
    passed: false,
    checks: commands.map((current) => ({
      name: current.name,
      command: [current.command, ...current.args].join(" "),
      status: "unrun" as const,
      detail: `${current.name} was not run by this API call`,
    })),
  };
}

export async function runRepositoryChecks(options: RepositoryCheckOptions): Promise<RepositoryChecksReport> {
  const run = options.run ?? runCommand;
  const checks: RepositoryCheck[] = [];

  for (const current of commands) {
    try {
      const result = await run(current.command, current.args, { cwd: options.rootDirectory });
      const command = [current.command, ...current.args].join(" ");
      checks.push({
        name: current.name,
        command,
        status: result.code === 0 ? "verified" : "failed",
        detail: result.code === 0
          ? `${current.name} passed`
          : `${current.name} exited with code ${result.code}`,
      });
    } catch {
      checks.push({
        name: current.name,
        command: [current.command, ...current.args].join(" "),
        status: "failed",
        detail: `${current.name} could not be started`,
      });
    }
  }

  return {
    passed: checks.every((check) => check.status === "verified"),
    checks,
  };
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<RepositoryCommandResult> {
  try {
    await execFileAsync(command, args, { cwd: options.cwd, maxBuffer: 1024 * 1024 });
    return { code: 0 };
  } catch (error) {
    const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "number"
      ? (error as { code: number }).code
      : 1;
    return { code };
  }
}
