# Durable remote dispatch fence — 2026-10-13

## Problem

Fleet's Windows session correctly refuses fallback after dispatch when the reply is lost (`src/winsession.ts:197–213`). SSH cannot distinguish a command that never started from one whose side effects happened before its acknowledgement disappeared. Retrying arbitrary commands cannot guarantee exactly-once effects. Concurrent broker startup, inherited output pipes, and interrupted teardown add independent races.

## Approach and runnable prototype

This spike is an **opt-in target-side module**, not a change to `fleet exec`, Windows sessions, detached jobs, CLI, or MCP. It uses Bun's built-in SQLite and filesystem/process APIs; no dependencies were added. Place/run the source on the target host, with a dedicated private spool directory:

```sh
bun run src/spikes/safe-exec.ts --spool /tmp/fleet-safe-spike submit example-1 -- /bin/sh -c 'echo executed'
bun run src/spikes/safe-exec.ts --spool /tmp/fleet-safe-spike status example-1
# Repeating the identical submit returns its recorded receipt, without another launch.
```

A caller must choose and persist its request ID **before** sending it, reuse that ID after transport failure, and use the same target ledger. Responses are JSON. Output paths are target-local private files. The executable receives argv directly, without shell interpolation; invoke a shell explicitly when needed. The current target working directory is bound into the request fingerprint. An ID reused with another argv/cwd is rejected.

The ledger atomically admits each request, then uses a committed compare-and-set from `prepared` to `dispatching` as a **one-way dispatch fence**. Only its winner may spawn a process. SQLite WAL, FULL synchronous commits, a uniqueness constraint, and busy timeout coordinate independently started brokers; no PID checks, lease expiry, or stale lock deletion can authorize redispatch. File-backed stdout/stderr avoid waiting for inherited pipes to close. The leader's exit code, not descendant termination, defines completion.

This deliberately chooses **at-most-once dispatch plus durable replay**, not a false claim of exactly-once external effects. There is necessarily an ambiguity window between the dispatch commit and process creation/completion. It is represented explicitly rather than retried.

## Outcomes at every boundary

| Failure point | Stored/public outcome | May retry execution with same ID? |
| --- | --- | --- |
| Before admission / incomplete request | `absent` | Yes |
| After admission, before winning dispatch CAS | `prepared` | Yes; one contender wins |
| Dispatch CAS committed, before spawn | `indeterminate` | Never, even if no side effects happened |
| Spawn succeeded, command running | `indeterminate` | Never |
| Broker dies while child continues | `indeterminate` | Never |
| Leader exited, completion not committed | `indeterminate` | Never |
| Completion committed, acknowledgement lost / teardown interrupted | `completed` | Replay only |
| Synchronous process creation rejected | `not-started` | Replay the rejection; no automatic new attempt |
| Same ID, different argv/cwd | Rejected | Never under that ID |
| Concurrent broker startup or duplicate submission | One CAS winner; others see current outcome | No duplicate dispatch |

CLI exit codes: completed command's exit code, 75 for indeterminate, 127 for not-started, 1 for invalid/colliding requests, 2 for usage. `status` may report absent/prepared with exit 0; consumers must inspect JSON rather than treat exit 0 as execution completion. An indeterminate command may still be running; `retry: never` prohibits **execution**, not harmless status polling.

## Failure-injection proof and measured results

Run the focused integration matrix once:

```sh
bun test test/safe-exec-spike.test.ts
```

It launches independent real Bun brokers and real child processes in temporary private spools. At durable boundaries the broker publishes a marker, then the test SIGKILLs only that broker. Each crash case is retried three times and checked against a real append-only side-effect file. Twelve brokers race on one ID and one freshly created ledger. A grandchild retains stdout/stderr until an explicit release-file handshake, proving the receipt is independent of pipe EOF without timing guesses. A post-completion broker kill exercises lost acknowledgement/interrupted teardown; an exit-before-completion kill exercises the other side of the persistence boundary.

Measured once locally on macOS arm64 with Bun 1.4.2: **1 test passed, 0 failed, 34 assertions, 888 ms total**. No SSH or Windows machine was contacted.

| Injected point / experiment | Outcome after retries | Actual side-effect appends | Measured time |
| --- | --- | --- | --- |
| Before admission, then 3 retries | `completed` | 1 | 131 ms |
| After admission, then 3 retries | `completed` | 1 | 111 ms |
| After dispatch fence, before spawn, then 3 retries | `indeterminate` | 0 | 99 ms |
| After spawn and actual side effect, then 3 retries | `indeterminate` | 1 | 104 ms |
| After leader exit, before completion commit, then 3 retries | `indeterminate` | 1 | 103 ms |
| After completion commit, before reply / teardown, then 3 retries | `completed` | 1 | 105 ms |
| 12 concurrent independent brokers / fresh ledger | `completed` | 1 | 46 ms |
| Same request key with different command | Rejected | Remained 1 | Included in total |
| Grandchild holds inherited output behind release handshake | Leader `completed`; child still waiting | N/A (output lifecycle) | Leader receipt 23 ms |
| Missing executable, then retry | `not-started`; rejection replayed | 0 | Included in total |
| Command exits 23, then retry | `completed`, exit 23 replayed | 0 | Included in total |

The zero-effect indeterminate case is the intentional availability cost: the durable fence was crossed, so retries refused to guess. No experiment produced duplicate appends. The inherited-handle experiment also read the grandchild's later output after releasing it; all test-owned children were allowed to finish. Timing is an observation from this run, not a benchmark or a production latency guarantee.

## Limits

- The claim survives broker/process crashes; hardware power-loss, disk corruption, filesystem rollback, SQLite durability on network filesystems, and malicious spool modification are not tested. Do not put the ledger on a network filesystem.
- An arbitrary external side effect cannot transact atomically with this ledger. A dead broker after the fence yields permanent uncertainty, including a command that never actually spawned. Exactly-once effects require idempotency at the destination or a transaction shared with that destination.
- This is target-side, local-process transport-failure simulation, **not an SSH or Windows deployment proof**. Runtime support and process creation semantics must be tested on each supported OS before integration.
- Completion records the process leader. Descendants may survive, write later output, or continue side effects. Output files are intentionally not immutable snapshots. No cancellation, timeout, output quota, descendant supervision, or cleanup command is offered.
- All request rows are retained. Deleting/replacing the ledger, changing the spool, generating a new ID on retry, or rerouting to another physical host loses deduplication. No retention TTL is safe without a documented replay horizon and tombstones.
- The fingerprint binds argv/cwd, not executable contents, inherited environment, user identity, or ambient filesystem state. A prepared request may execute under changed ambient conditions. Dedicated private spools isolate cooperative callers; they are not a security sandbox.
- Private spool permissions protect receipts and output, but commands are still visible in process arguments. Do not supply secret values in argv.
- No automatic recovery converts `indeterminate` back into executable state. Operator reconciliation or destination-specific idempotency is required; guessing from a reused PID is unsafe.

## Production requirements

Persist client IDs and bind them to stable physical target identity; add an explicit opt-in Fleet API/CLI and a versioned request/receipt protocol. Transport only complete validated requests and distinguish admission from completion acknowledgement. Bind environment, execution principal and interpreter/executable identity where repeatability requires it. Harden ledger creation and durability for all supported filesystems/OSes. Supervise process trees, bound disk usage, record output snapshots with clear leader/tree semantics, and make teardown ownership explicit. Add a reconciliation API for operator-verified results without redispatching arbitrary commands. Define replay horizons/tombstones, host migration and backup restoration rules. Extend this failure matrix to real SSH half-writes/disconnects and Windows broker lifecycle faults; use destination idempotency keys or shared transactions for workflows needing exactly-once effects.
