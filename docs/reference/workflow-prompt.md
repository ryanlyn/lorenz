# Workflow prompt reference

The exact contract for the Liquid prompt body in `WORKFLOW.md`: every variable Lorenz exposes, the
filters and control flow it supports, the strict-mode behavior that turns a typo into a hard error,
and the built-in fallbacks. This is the integrator reference. For the configuration front matter
that lives above the prompt, see [configuration](configuration.md); for the operator walkthrough of
authoring a workflow, see [workflows](../workflows.md).

A `WORKFLOW.md` file has two parts: YAML front matter fenced by `---`, and a Markdown body. The body
is the prompt template. Lorenz renders it once per dispatched issue, and once per ensemble slot,
through [LiquidJS](https://liquidjs.com), substituting the issue's fields and the run-time values.
The rendered string becomes the first message the agent receives.

## Where the template comes from

`parseWorkflowContent` splits the file at the first `---` line and the next `---`. Everything after
the closing fence is trimmed and used as the prompt body. If the file has no front matter, the whole
file is the body. The body is always trimmed.

A blank or whitespace-only body does not produce a blank prompt. `effectivePromptTemplate` falls
back to the built-in `defaultPromptTemplate` whenever the trimmed body is empty. See
[The default prompt](#the-default-prompt).

The body is parsed once at load time (`parsePromptTemplate`) and rendered per dispatch
(`buildPrompt`). A syntax error in the template throws `template_parse_error` at load, with the
offending template text attached. The render path is in `packages/prompt/src/index.ts`; the parse
path is in `packages/workflow/src/index.ts`.

## The render context

Every render exposes three top-level objects: `issue`, `attempt`, and `ensemble`. Nothing else is in
scope. Referencing any other variable raises an error (see [Strict mode](#strict-mode)).

### `issue`

The issue under work, normalized from the tracker payload. Keys are **snake_case**, even though the
internal `Issue` object uses camelCase. Templates must use the snake_case spelling.

| Variable | Type | Meaning | When absent |
| --- | --- | --- | --- |
| `issue.id` | string | Tracker-internal issue id | always present |
| `issue.identifier` | string | Human key, for example `ENG-204` | always present |
| `issue.title` | string | Issue title | always present |
| `issue.description` | string or null | Issue body | `null` if unset |
| `issue.priority` | number or null | Tracker priority value | `null` if unset |
| `issue.state` | string | Workflow state name, for example `In Progress` | always present |
| `issue.state_type` | string or null | State bucket (`backlog`, `unstarted`, `started`, `completed`, `canceled`, `triage`) | `null` if unset |
| `issue.labels` | string[] | Labels, lowercased and trimmed | empty array if none |
| `issue.url` | string or null | Link to the issue in the tracker | `null` if unset |
| `issue.branch_name` | string or null | Tracker-suggested branch name | `null` if unset |
| `issue.assignee_id` | string or null | Assignee id from the tracker | `null` if unset |
| `issue.created_at` | string or null | Creation timestamp | `null` if unset |
| `issue.updated_at` | string or null | Last-update timestamp | `null` if unset |
| `issue.assigned_to_worker` | boolean | Whether this issue is assigned to the configured worker identity | defaults to `true` when undefined |
| `issue.blocked_by` | array of issue refs | Issues that block this one | empty array if none |

Each entry in `issue.blocked_by` is an object with `id`, `identifier`, `state`, and `state_type`.
Any of those four can be `null`.

`issue.assigned_to_worker` defaults to `true` when the normalized issue leaves it undefined; it is
not `null` or `false` in that case. Treat a missing value as "assigned".

### `attempt`

`attempt` is the retry attempt number for the current dispatch, or `null` when no attempt counter is
supplied. Default is `null`. Use it to vary instructions on retries.

### `ensemble`

When [context ensembles](../features/context-ensembles.md) run several agents on one issue, each
slot renders the prompt with its own `ensemble` block.

| Variable | Type | Meaning |
| --- | --- | --- |
| `ensemble.enabled` | boolean | `true` when the ensemble size is greater than 1 |
| `ensemble.slot_index` | number | Zero-based index of this slot |
| `ensemble.size` | number | Total number of slots |

For a solo run, `ensemble.enabled` is `false`, `ensemble.slot_index` is `0`, and `ensemble.size`
is `1`.

## Liquid features

Lorenz renders with stock LiquidJS in strict mode. The full standard tag and filter set applies.
The constructs you reach for in a prompt body:

Conditionals:

```md
{% if issue.description %}
{{ issue.description }}
{% else %}
No description was provided. Read the title and infer the scope.
{% endif %}
```

Null fallbacks with the `default` filter:

```md
Branch: {{ issue.branch_name | default: "create one from the identifier" }}
Priority: {{ issue.priority | default: "unspecified" }}
```

Loops over arrays, with `forloop` metadata:

```md
{% if issue.labels.size > 0 %}
Labels:
{% for label in issue.labels %}
- {{ label }}{% unless forloop.last %},{% endunless %}
{% endfor %}
{% endif %}
```

`forloop` exposes the standard fields inside a `{% for %}` block: `forloop.index`,
`forloop.index0`, `forloop.first`, `forloop.last`, `forloop.length`, `forloop.rindex`, and
`forloop.rindex0`.

Filters chain (`{{ issue.title | upcase | truncate: 60 }}`). The LiquidJS string, array, and math
filters are available. Slot-aware instructions read off `ensemble`:

```md
{% if ensemble.enabled %}
You are agent {{ ensemble.slot_index | plus: 1 }} of {{ ensemble.size }}. Explore an approach
distinct from the other slots.
{% endif %}
```

## Strict mode

Both the workflow engine and the prompt engine are constructed with `strictVariables: true` and
`strictFilters: true`. Two consequences:

- Referencing a variable that is not in scope throws at render. A typo such as `{{ issue.titel }}`
  or a stray `{{ user.name }}` fails the render rather than emitting an empty string.
- Using a filter that is not registered throws. Only built-in LiquidJS filters are available in the
  prompt body.

A `null` value is in scope and renders as empty; the strict check is about the variable *existing*,
not being non-null. `{{ issue.description }}` is safe even when the description is unset, but
`{{ issue.summary }}` (no such key) is an error.

The prompt engine caches parsed string templates in a process-global map keyed by the effective
template text, so re-rendering the same template across polls reuses the parse.

## The default prompt

When the body is empty, Lorenz renders this built-in template (`defaultPromptTemplate` in
`packages/workflow/src/index.ts`):

```md
You are working on an issue from the configured tracker.

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}

Body:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}
```

It uses only `issue.identifier`, `issue.title`, and `issue.description`. A "blank" prompt is never
actually blank.

## The continuation prompt

When an agent run completes a turn but the issue is still in an active state, Lorenz injects a
fixed continuation message on the next turn instead of re-rendering the workflow template. This
string is not Liquid and not user-configurable; it comes from `continuationPrompt(turnNumber,
maxTurns)` in `packages/prompt/src/index.ts`:

```text
Continuation guidance:

- The previous agent turn completed normally, but the issue is still in an active state.
- This is continuation turn #<turnNumber> of <maxTurns> for the current agent run.
- Resume from the current workspace and workpad state instead of restarting from scratch.
- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.
```

`turnNumber` is the continuation turn count and `maxTurns` is the configured turn ceiling
(`agent.max_turns`, default `20`). The workflow template renders once at the start of a run; the
continuation prompt drives subsequent turns of the same run.

## Hooks also render Liquid

Lifecycle hook commands (`hooks.after_create`, `hooks.before_run`, `hooks.after_run`,
`hooks.before_remove`) render through their own Liquid engine before they run. The hook engine
shares the same strict flags but differs from the prompt engine in three ways.

- **It only activates when the command references `issue`.** A command is templated only if it
  contains `{{` or `{%` followed by `issue.` or `issue[`. Otherwise the command string runs
  verbatim, so plain shell with `{{` in unrelated contexts is left alone.
- **Every interpolation is shell-escaped by default.** The engine sets `outputEscape` to a
  shell-escaping function, so `{{ issue.title }}` is safe to drop into a command. To emit a value
  without escaping, use `| raw`. To shell-escape explicitly without double-escaping, use the
  registered `| shell_escape` filter.
- **It exposes the same snake_case `issue` keys** as the prompt context (`id`, `identifier`,
  `title`, `description`, `priority`, `state`, `state_type`, `branch_name`, `url`, `assignee_id`,
  `blocked_by`, `labels`, `assigned_to_worker`, `created_at`, `updated_at`). There is no `attempt`
  or `ensemble` in hook scope.

A hook that names the branch from the issue:

```yaml
hooks:
  after_create: "git checkout -b {{ issue.branch_name | default: issue.identifier }}"
```

The interpolated branch name is shell-escaped automatically. See [workspace](../workspace.md) for
the full hook lifecycle and fail-fast behavior.

## Worked example

A full prompt body that adapts to description, labels, blockers, and ensemble slot:

```md
You are working {{ issue.identifier }}: {{ issue.title }}.

State: {{ issue.state }} ({{ issue.state_type | default: "unknown" }})
Link: {{ issue.url | default: "n/a" }}

{% if issue.description %}
## Task
{{ issue.description }}
{% else %}
No description was provided. Scope the work from the title.
{% endif %}

{% if issue.blocked_by.size > 0 %}
## Blocked by
{% for blocker in issue.blocked_by %}
- {{ blocker.identifier }} ({{ blocker.state | default: "unknown state" }})
{% endfor %}
Do not assume blockers are resolved.
{% endif %}

{% if issue.labels contains "needs-tests" %}
This issue is labeled needs-tests. Add or update tests before finishing.
{% endif %}

{% if ensemble.enabled %}
You are slot {{ ensemble.slot_index | plus: 1 }} of {{ ensemble.size }}. Take an approach the other
slots are unlikely to take.
{% endif %}

{% if attempt %}
This is retry attempt {{ attempt }}. Review why the prior attempt did not land before retrying.
{% endif %}
```

## See also

- [Configuration reference](configuration.md) - every front-matter key, default, and alias
- [Workflows](../workflows.md) - authoring `WORKFLOW.md` end to end
- [Workspace](../workspace.md) - the lifecycle hooks that also render Liquid
- [Context ensembles](../features/context-ensembles.md) - what populates the `ensemble` block
- [Events](events.md) - `template_parse_error` and the workflow reload events
