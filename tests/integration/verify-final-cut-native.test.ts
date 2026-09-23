import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");
const preflight = join(
  repository,
  ".agents/skills/verify-final-cut-native/scripts/run-headed-check.sh",
);

test("headed preflight accepts the current IOConsoleLocked signal", async () => {
  const result = await runPreflight('"IOConsoleLocked" = No');

  assert.equal(result.code, 0);
  assert.match(result.stdout, /console_lock_state=unlocked/);
  assert.match(result.stdout, /console_lock_source=IOConsoleLocked/);
  assert.match(result.stdout, /PREFLIGHT PASS/);
});

test("headed preflight rejects a locked current console signal", async () => {
  const result = await runPreflight('"IOConsoleLocked" = Yes');

  assert.equal(result.code, 1);
  assert.match(result.stderr, /code=FINAL_CUT_NATIVE_CONSOLE_LOCKED/);
  assert.match(result.stderr, /state=locked/);
  assert.match(result.stderr, /retryable=false/);
});

test("headed preflight supports the legacy lock signal", async () => {
  const result = await runPreflight('"CGSSessionScreenIsLocked" = No');

  assert.equal(result.code, 0);
  assert.match(result.stdout, /console_lock_state=unlocked/);
  assert.match(result.stdout, /console_lock_source=CGSSessionScreenIsLocked/);
});

test("headed preflight returns a retryable result for unknown lock state", async () => {
  const result = await runPreflight('"IOConsoleUsers" = ()');

  assert.equal(result.code, 75);
  assert.match(result.stderr, /code=FINAL_CUT_NATIVE_CONSOLE_LOCK_STATE_UNKNOWN/);
  assert.match(result.stderr, /state=unknown/);
  assert.match(result.stderr, /retryable=true/);
});

test("headed preflight fails closed when lock signals conflict", async () => {
  const result = await runPreflight([
    '"IOConsoleLocked" = No',
    '"CGSSessionScreenIsLocked" = Yes',
  ].join("\n"));

  assert.equal(result.code, 75);
  assert.match(result.stderr, /code=FINAL_CUT_NATIVE_CONSOLE_LOCK_STATE_UNKNOWN/);
  assert.match(result.stderr, /source=conflict/);
  assert.match(result.stderr, /retryable=true/);
});

type PreflightResult = {
  code: number;
  stdout: string;
  stderr: string;
};

async function runPreflight(lockProbe: string): Promise<PreflightResult> {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-headed-preflight-"));
  const bin = join(directory, "bin");
  await writeFile(join(directory, "ioreg-output"), `${lockProbe}\n`);
  await mkdir(bin);
  await writeExecutable(join(bin, "ioreg"), `#!/usr/bin/env bash\ncat ${shellQuote(join(directory, "ioreg-output"))}\n`);
  await writeExecutable(join(bin, "uname"), "#!/usr/bin/env bash\nprintf '%s\\n' Darwin\n");
  await writeExecutable(join(bin, "pgrep"), "#!/usr/bin/env bash\nexit 0\n");
  await writeExecutable(join(bin, "osascript"), "#!/usr/bin/env bash\nprintf '%s\\n' 'Final Cut Pro'\n");

  try {
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FRAMEKIT_FINAL_CUT_E2E_PROJECT: join(directory, "Disposable.fcpxml"),
    };
    try {
      const result = await exec("bash", [preflight, "canonical-read"], {
        cwd: repository,
        env: environment,
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof failure.code === "number" ? failure.code : -1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
