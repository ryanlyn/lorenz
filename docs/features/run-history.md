# Run history

`lorenz runs` is the operator's post-mortem tool. When a run fails, stalls, or burns more tokens than expected, it pulls the forensic record the live dashboards drop: every attempt, the retry chain, per-run token totals, the session id, the worker host, and the workspace path. This page is for the operator triaging a finished or in-flight run from the terminal.

## What it queries

`lorenz runs` is a thin HTTP client. It builds a base URL, fetches `GET /api/v1/runs` from the running daemon's observability API, and renders the JSON as text tables (or raw JSON with `--json`). It holds no state and starts no server. The daemon must be running for the command to return anything.

It reads the runtime's in-memory run history, a bounded ring buffer of the most recent completed runs (the cap is the same `runHistory(50)` view from the [RuntimeSnapshot](../observability.md)). Run history is not database-backed, so on restart the buffer starts empty and refills as new runs finish, and history past the cap is gone. Capture the output you need before it ages out.

Live `running` entries are merged on top of history, so an in-flight run shows up with `outcome=running` alongside the completed ones.

## When you'd reach for it

- A run failed and you need the `failure_reason`, the `last_event`, and the `session_id` to find it in the logs.
- An issue keeps retrying and you want the attempt count and the latest failure across the whole retry chain (`--retries`).
- A run or agent ran expensive and you want input/output/total token totals per agent plus the heaviest runs (`--cost`).
- You have a run id from the dashboard and want that run plus its sibling attempts on the same issue (`--id`).

The TUI and web dashboard show what is happening now. `lorenz runs` shows what already happened, with the detail those live views drop.

## Base URL precedence

The command resolves where to send the request in a fixed order. The first match wins:

1. `--url <url>` - used verbatim, with any trailing slash trimmed.
2. `--port <port>` when greater than `0` - combined with `server.host` from `WORKFLOW.md` as `http://<host>:<port>`.
3. `server.port` from `WORKFLOW.md` when greater than `0` - combined with `server.host`.

Port `0` counts as unset at every level; it is the ephemeral-port sentinel the daemon uses for an auto-assigned port. If none of the three resolve, the command fails with:

```text
No observability server port configured. Pass --port/--url or set server.port in WORKFLOW.md.
```

Nothing checks `--url` and `--port` for mutual exclusion. Pass both and `--url` wins. The default `server.port` in code is `4040` and the default `server.host` is `127.0.0.1`, so a daemon started with defaults answers on `http://127.0.0.1:4040`.

## Filters and flags

`lorenz runs` with no flags prints the run-history table. The flags below narrow or change the view, mapping directly to query params on `GET /api/v1/runs`.

| Flag | Param | Effect |
| --- | --- | --- |
| `--issue <id>` | `issue` | Keep runs whose `issue_identifier` or `issue_id` matches the value exactly. |
| `--failed` | `failed` | Keep runs with outcome `failed` or `stalled`. |
| `--cost` | `cost` | Render the token-and-cost summary by agent plus the top runs by tokens. |
| `--retries` | `retries` | Render the retry summary grouped by issue (issues with at least one retry attempt). |
| `--id <runId>` | `id` | Render one run by id plus its related attempts on the same issue. |
| `--limit <limit>` | `limit` | Cap the number of runs in the list view. Positive integer. |
| `--url <url>` | - | Observability API base URL. Trailing slash trimmed. |
| `--port <port>` | - | Observability API localhost port. Non-negative integer. |
| `--json` | - | Print the raw JSON response instead of tables. |

Filters compose. `--issue` and `--failed` apply before the view is built, so `--cost`, `--retries`, and the list view all reflect the filtered set. The list `--limit` defaults to `20` server-side and clamps to a maximum of `200`; `--cost` and `--retries` ignore it. The server's view precedence runs `cost`, then `retries`, then `id`, then the default runs list, so combining `--cost` with `--retries` yields the cost view.

## Output shape

The default invocation prints a summary line and a table. Column widths size to content, so exact spacing varies.

```text
Run History

total=6 running=1 success=3 failed=1 stalled=1 canceled=0

ID                ISSUE     AGENT   OUTCOME  ATTEMPT  TURNS  TOKENS  DURATION  SESSION
----------------  --------  ------  -------  -------  -----  ------  --------  ---------------
run-7c1a          ENG-412   codex   running  0        4      18204   42s       thr-92...a1f0c
run-6b03          ENG-411   codex   success  0        9      53120   311s      thr-77...c4e21
run-5f9d          ENG-410   claude  failed   2        3      9981    18s       thr-41...90b2d
```

Each row is one run. `ATTEMPT` is the retry attempt (`0` for a first attempt). `TOKENS` is `tokens.total_tokens` for that run. `DURATION` renders as seconds once it reaches 1000 ms, otherwise milliseconds; an unknown duration shows `n/a`. `SESSION` is the `thread_id-turn_id` session id, compacted to `first6...last5` past 14 characters, or `n/a` when absent.

### Single run (`--id`)

`lorenz runs --id run-5f9d` prints the full forensic record for one run, then a table of related attempts on the same issue (up to 10):

```text
Run run-5f9d

issue=ENG-410 agent=claude outcome=failed attempt=2
duration=18s tokens=9981 turns=3
session=thr-41a0-90b2d worker=local
workspace=/Users/you/.lorenz/workspaces/ENG-410
last_event=turn_failed at=2026-06-17T09:14:51.022Z
failure_reason=hook failed with status 1
log_file=/Users/you/.lorenz/log/lorenz.log

Related runs
ID        OUTCOME  TOKENS  STARTED
--------  -------  ------  ------------------------
run-4e1b  failed   8042    2026-06-17T09:02:10.880Z
run-3c77  failed   4410    2026-06-17T08:51:33.140Z
```

`worker` shows the SSH host, or `local` when the run executed on the daemon host. `workspace` is the on-disk workspace path where you inspect the run's working tree. `log_file` is the `logging.log_file` target, the file you grep with the `session` id and `issue` identifier to find the run's events. A field that was never populated renders as `n/a`.

### Cost view (`--cost`)

```text
Cost Summary

AGENT   RUNS  DONE  INPUT   OUTPUT  TOTAL   AVG/RUN  USD
------  ----  ----  ------  ------  ------  -------  ---
claude  3     3     41020   8190    49210   16403.3  n/a
codex   3     2     60110   11204   71314   23771.3  n/a

Top Runs
ID        ISSUE    AGENT   OUTCOME  TOKENS
--------  -------  ------  -------  ------
run-6b03  ENG-411  codex   success  53120
run-5f9d  ENG-410  claude  failed   9981
```

`RUNS` is the run count for the agent; `DONE` counts runs whose outcome is not `running`. `INPUT`, `OUTPUT`, and `TOTAL` are summed token counts; `AVG/RUN` is total tokens divided by run count. The `USD` column is always `n/a`: dollar cost estimation is not implemented, and `estimated_cost_usd` is null everywhere. Cost here means tokens. `Top Runs` lists the heaviest runs by total tokens, up to 10.

### Retry view (`--retries`)

```text
Retry Summary

ISSUE    ATTEMPTS  LATEST  TOKENS  RUN ID    FAILURE
-------  --------  ------  ------  --------  ----------------------
ENG-410  3         failed  22433   run-5f9d  hook failed with status 1
ENG-405  2         success 31002   run-2a90  n/a
```

One row per issue with at least one run whose retry attempt exceeds `0`. `ATTEMPTS` counts distinct retry attempts seen for the issue, `LATEST` is the most recent outcome, `TOKENS` sums tokens across the issue's runs, and `FAILURE` is the latest failure reason or `n/a`. Rows sort by attempts, then total tokens, then issue identifier.

## Raw JSON and the API

`--json` prints the response body verbatim, which is the contract documented in [the HTTP API reference](../reference/http-api.md). Use it to script against run history or to read fields the tables omit, such as `log_hints`, `slot_index`, `ensemble_size`, and `executor_pid`. The status mapping the command applies:

| HTTP status | Behavior |
| --- | --- |
| `200` | Render the view (or raw JSON). |
| `404` | Error `Run not found` (a `--id` that matched nothing). |
| `503` | Error `Observability API unavailable` (snapshot could not be taken). |
| other | Error `Unexpected response status N`. |

The outcomes you will see are `running`, `success`, `failed`, and `stalled`. `canceled` is defined in the run-outcome vocabulary and appears in the summary line, but the runtime never records it, so its count stays `0`.

## See also

- [CLI](../cli.md) - the daemon, `lorenz doctor`, and the full flag set.
- [CLI reference](../reference/cli.md) - exhaustive flag and exit-code tables.
- [HTTP API reference](../reference/http-api.md) - the `/api/v1/runs` views and JSON field shapes.
- [Observability](../observability.md) - the live TUI and web dashboard that complement run history.
- [Agent orchestrator](../agent-orchestrator.md) - how runs, retries, and the run-history ring buffer are produced.
