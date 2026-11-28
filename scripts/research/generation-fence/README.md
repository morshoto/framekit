# Generation fence and recovery research

These are synthetic, test-owned subprocesses and temporary files only. They do not use Final Cut, System Events, a Final Cut database, the retained reservation or any existing process. They are not a production recovery implementation or native evidence.

From this worktree, with Node, Python 3 and the SQLite CLI installed:

```sh
node --test scripts/research/generation-fence/*.test.mjs
sqlite3 --version
python3 -c 'import sqlite3, sys; print(sys.version.split()[0], sqlite3.sqlite_version)'
```

The delayed-receiver tests show that killing their own sender cannot retract already delivered work. The generation fixture models both a receiver check and a check/write race; legacy bypass, duplicate clients and target mismatch are separate controls. The temporary SQLite fixture covers claim conflicts, corrupted data, a killed test-owned claimant, and an uncommitted writer whose record disappears while independently queued mock work can still execute. The claim reports an existing row; it does not itself stop an external receiver or retry.

A Framekit-owned durable claim can coordinate cooperating clients, but it cannot establish terminality or fence a nonparticipating receiver. A new receiver-enforced protocol would need an atomic boundary that covers final execution, all writers and already queued work, target identity and independently verified restoration. No supported Final Cut boundary with those guarantees has been established. Historical v2 records lack the necessary correlated evidence; no new protocol retroactively resolves them. See [issue #902](https://github.com/morshoto/framekit/issues/902#issuecomment-7238751275) for the conditional indistinguishability argument and its limits. Never clear, replay, bypass or infer the outcome of an existing reservation from these tests.
