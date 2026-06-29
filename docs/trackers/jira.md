# Jira tracker

Drive Lorenz dispatch from Jira Cloud issues, either by calling the Jira REST API directly or by
proxying through an external MCP server. This page is for operators wiring Jira into a
`WORKFLOW.md` and a tracker config. It covers both tracker kinds (`jira` and `jira-mcp`), every
config key, the gating rule that decides which issues run, and the agent-facing `jira_*` tools.

## Two kinds, one behavior

The Jira extension registers two tracker kinds. They share option parsing, the candidate-issue
query, normalization, and the `jira_*` tool surface. They differ only in transport.

| Kind | Transport | Auth | Required config |
| --- | --- | --- | --- |
| `jira` | Jira Cloud REST API v3 | HTTP Basic (`email` + `api_key`) | `base_url`, `email`, `api_key`, and `jql` or `project_keys` |
| `jira-mcp` | JSON-RPC `tools/call` to an external MCP server | Bearer (`mcp.token`) | `mcp.url`, and `jql` or `project_keys` |

Pick `jira` when Lorenz can reach Jira Cloud directly. Pick `jira-mcp` when an MCP server already
fronts Jira for you and you want Lorenz to call its tools instead of the REST API.

## The agent + assignee gate

This is the rule to internalize before anything else: Lorenz only picks up issues that are both
labeled `agent` and assigned to its worker. The candidate query (`candidateJql`) always appends two
clauses to whatever scope you configure:

```text
... AND assignee = currentUser() AND labels = "agent"
```

The `agent` label is a fixed constant (`AGENT_LABEL = "agent"` in `client.ts`). There is no config
key to change it. A wide `tracker.jql` does not widen dispatch past this gate: your `jql` is wrapped
in parentheses and `AND`-ed with the assignee and label clauses. An issue that matches your `jql`
but lacks the `agent` label, or is assigned to someone else, is never dispatched.

The full candidate query is built in this order:

1. Base scope: `(<jql>)` if `tracker.jql` is set, else `project in (<keys>)` from `project_keys`,
   else empty.
2. Active states: `status in (<active_states>)` when `tracker.active_states` is non-empty, gating
   candidates to those statuses. See the [configuration reference](../reference/configuration.md)
   for the active/terminal defaults.
3. Assignee clause (see below).
4. `labels = "agent"`.

The clauses are joined with `AND`.

### Assignee clause

The assignee clause comes from `tracker.assignee`:

- Unset, or the literal `me` (case-insensitive): `assignee = currentUser()`.
- Any other value: `assignee = "<value>"`.

The same value drives the post-fetch worker filter during normalization. When the assignee is unset
or `me`, that filter is skipped (`currentUser()` already scoped the query server-side).

To delegate an issue to Lorenz: add the `agent` label and assign it to the account whose
credentials the worker uses. See [dispatch](../dispatch.md) for how candidates flow into the run
loop.

## Configure `jira` (direct REST)

```yaml
tracker:
  kind: jira
trackers:
  jira:
    provider: jira
    base_url: https://example.atlassian.net
    email: bot@example.com
    api_key: $JIRA_API_KEY
    project_keys: [ENG, PLAT]
```

Use `jql:` instead of `project_keys:` to scope candidates with native JQL (set one, not both).
`active_states` defaults to `[Todo, In Progress]`, so omit it unless you need other statuses.

Key reference for `jira`:

| Config key | Alias / env | Default | Meaning |
| --- | --- | --- | --- |
| `tracker.base_url` | alias `base_url` -> `baseUrl`; resolves `$JIRA_BASE_URL` | none (required) | Jira site URL, e.g. `https://example.atlassian.net`. |
| `tracker.email` | resolves secret, falls back to `JIRA_EMAIL` | none (required) | Account email paired with the API key for Basic auth. |
| `tracker.api_key` | `settings.tracker.apiKey`; env fallback `JIRA_API_KEY` | none (required) | API token for Basic auth. |
| `tracker.project_keys` | alias `project_keys` -> `projectKeys` | none | Project keys that scope candidates and receive created issues. |
| `tracker.jql` | | none | Native JQL replacing the project-key scope. |
| `tracker.issue_type` | alias `issue_type` -> `issueType` | `Task` | Issue type used when creating issues. |
| `tracker.assignee` | | unset (`currentUser()`) | Assignee clause; `me` also means `currentUser()`. |
| `tracker.active_states` | `settings.tracker.activeStates` | `["Todo", "In Progress"]` | Status names added as `status in (...)` to the candidate query. |

`jira` requires `base_url`, `email`, and `api_key` at dispatch validation, plus at least one of
`jql` or `project_keys`. Setting only `jql` or only `project_keys` is fine; setting neither is a
config error.

## Configure `jira-mcp` (external MCP server)

```yaml
tracker:
  kind: jira-mcp
trackers:
  jira-mcp:
    provider: jira-mcp
    project_keys: [ENG]
    mcp:
      url: https://mcp.example.com/jira
```

Scope with either `project_keys:` or `jql:` (set one). Supply `mcp.token`, `mcp.headers`, and
`mcp.tools` overrides when your server needs them - see the tool-name map below.

Key reference for `jira-mcp`:

| Config key | Notes | Default |
| --- | --- | --- |
| `tracker.mcp.url` | JSON-RPC endpoint; resolves `$ENV`. Required at dispatch validation. | none (required) |
| `tracker.mcp.token` | Resolved as a secret; sent as `Authorization: Bearer <token>`. | none |
| `tracker.mcp.headers` | Map of string to string; merged into every request. | none |
| `tracker.mcp.tools.*` | Override the tool name Lorenz calls for each operation. | see table below |

`jira-mcp` requires only `mcp.url` at validation, plus `jql` or `project_keys`. It declares no
`envFallbacks` (no `api_key -> JIRA_API_KEY` fallback), and the MCP client reads neither `api_key`
nor `email`. `base_url` is optional for `jira-mcp`: it is only
used to build issue URLs when an MCP payload omits a URL. It still resolves `$JIRA_BASE_URL` if you
set it.

### Default MCP tool names

When you omit `tracker.mcp.tools`, Lorenz calls the `jira_*` tool family by default. Override any
entry to match your server's names.

| Operation | Config key (with snake_case alias) | Default tool name |
| --- | --- | --- |
| Search issues | `tracker.mcp.tools.search` | `jira_search` |
| Read one issue | `tracker.mcp.tools.read_issue` / `readIssue` | `jira_get_issue` |
| Transition status | `tracker.mcp.tools.update_status` / `updateStatus` | `jira_transition_issue` |
| List comments | `tracker.mcp.tools.list_comments` / `listComments` | `jira_get_comments` |
| Add comment | `tracker.mcp.tools.comment` | `jira_add_comment` |
| Update comment | `tracker.mcp.tools.update_comment` / `updateComment` | `jira_update_comment` |
| Create issue | `tracker.mcp.tools.create_issue` / `createIssue` | `jira_create_issue` |

The `tools` map accepts both snake_case and camelCase keys. Snake_case aliases
(`read_issue`, `update_status`, `list_comments`, `update_comment`, `create_issue`) are mapped during
parsing because `tracker.mcp` is nested and cannot use top-level config aliases. `search` and
`comment` are single words and have no snake_case alias.

The `jira_*` names above are Lorenz defaults, not Atlassian-provided names. The `atlassian_*` names
in the `jira-mcp` example are an override you supply to match a specific server. Each MCP call posts
a JSON-RPC 2.0 `tools/call` request, unwraps `result.content[].text`, and parses it as JSON when
possible.

## The `jira_*` tools

Both kinds expose the same `jira_*` tool pack, owned by the Jira extension and defined in
`extensions/jira-tracker/src/tools.ts`. The pack registers under the name `"jira"` and the
`jira` and `jira-mcp` providers mount it via `defaultToolPacks(): ["jira"]`. The seven tools
implement directly over `JiraClient` or `JiraMcpClient`, selected by `settings.tracker.kind`. See
the [trackers overview](index.md) for the read surface and
[reference/tracker-tools](../reference/tracker-tools.md) for the seven tools and their contract.

`jira_query` routes by its arguments: `issueIds` fetches by id, a `query` or `jql` string runs a
native search, `states` fetches by status, and otherwise it returns the candidate set scoped by
`active_states`.

### Workpad comments

Agents read and write a workpad as a tracker comment, the same flow on both kinds.
`jira_list_comments`, `jira_comment`, and `jira_update_comment` map to
`listComments` / `addComment` / `updateComment`. On `jira` these are REST comment calls with bodies
encoded as Atlassian Document Format (one paragraph per line); on `jira-mcp` they are the configured
comment tools. Comments normalize to `{id, body, author, createdAt, updatedAt, url}`, with `author`
the account id (falling back to display name).

## Status transitions

`jira` has no direct status write, so it transitions the issue in these steps:

1. `GET` the issue transitions.
2. Match a transition by name, case-insensitively, against the target status.
3. `POST` the matched transition id.
4. Re-read the issue.

If no transition matches the target status, the call throws
`jira transition not found for status: <status>`. On `jira-mcp` the single configured
`update_status` tool performs the transition.

## Creating issues

`jira_create_issue` uses `project_keys[0]` as the target project and `issue_type` (default
`Task`) as the type. On `jira`, a created issue defaults to the current user as assignee unless an
explicit or configured non-`me` assignee is set; status is applied via a transition after creation.
On `jira-mcp`, assignee arguments are forwarded only when a concrete non-`me` assignee resolves, and
omitted otherwise.

## Timeouts and errors

Both kinds use a 30-second request timeout (`JIRA_REQUEST_TIMEOUT_MS = 30_000`). A non-2xx REST
response throws `jira api status <n>: <body>` with the body truncated to 500 characters. When every
MCP argument-shape variant fails, the call throws `jira-mcp <op> failed: <joined failures>`. These
surface to the agent as tool data, never thrown - see
[reference/tracker-tools](../reference/tracker-tools.md). See
[troubleshooting](../troubleshooting.md) for recovery.

## See also

- [Trackers overview](index.md) - the tracker contract and the other backends.
- [Dispatch](../dispatch.md) - how candidate issues become runs.
- [jira_* tools reference](../reference/tracker-tools.md) - the exact tool input and output shapes.
- [Configuration reference](../reference/configuration.md) - every config key in one table.
- [Agent skills](../agents/skills.md) - how Lorenz overlays reusable agent playbooks into a workspace.
