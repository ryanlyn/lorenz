# Dispatch routing

Run several Lorenz instances against one tracker and split the work between them with route labels. This page is for operators who want to shard a backlog, dedicate a worker to a subsystem, or partition by assignee. It covers the routing model, the config keys that turn it on, the label conventions for Linear and Slack, and a worked multi-shard example. For the routing predicate line by line, see [../dispatch.md](../dispatch.md).

## Why route at all

One Lorenz process polls a tracker, picks eligible issues, and runs an agent per issue. Run more than one process against the same tracker when a single process can't keep up, or when different issues need different environments. Routing tells each process which issues are its own. Without it, two processes polling the same project both claim the same issue.

Three things partition the work:

- **Assignee.** Each instance filters to one `tracker.assignee`. An issue assigned to someone else is never this instance's.
- **Route labels.** A label like `Lorenz:backend` tags an issue for a named route. An instance accepts only the routes it is configured for.
- **`accept_unrouted`.** Decides what happens to issues that carry no route label at all.

These three combine into one predicate, `routedToThisWorker`, evaluated on every candidate issue during each poll: the assignee gate first, then route-label parsing, then the `accept_unrouted` and `only_routes` branches. For that predicate line by line and its decision diagram, see [../dispatch.md](../dispatch.md).

## The routing decision

Route labels and `only_routes` are normalized the same way (trim, lowercase), so a label `Lorenz:Backend` and an allowlist entry `["backend"]` match. The three keys that turn routing on, all under `tracker.dispatch`:

### The three dispatch keys

| Key | Default | Meaning |
|---|---|---|
| `tracker.dispatch.route_label_prefix` | `Lorenz:` | Label prefix that marks a route. Case-insensitive, stripped before matching. |
| `tracker.dispatch.accept_unrouted` | `true` | Whether to accept issues that carry no route label. |
| `tracker.dispatch.only_routes` | `null` | `null` = any route; `[]` = no routes; a list = only these routes. |

A worker that picks up everything leaves `only_routes` null and `accept_unrouted` true. A worker dedicated to one shard sets `only_routes` to that shard's name and labels its issues with the matching prefix.

## Assignee partitioning

Routing layers on top of the assignee filter, it does not replace it. Each instance sets one `tracker.assignee`, and the tracker resolves which issues are assigned to it. An issue assigned to a different user is rejected at step 1 above, before any route label is read.

This matters when you run instances side by side. Two instances that share an assignee and a route both claim the same issue and collide. The safe partitions:

- **Different assignees, no routes.** Each instance owns its own assignee's issues. Simple, but the tracker has to assign issues to the right account.
- **Same assignee, disjoint routes.** Each instance sets `accept_unrouted: false` and a distinct `only_routes`. Issues are labeled to steer them. No issue is owned by two instances as long as the route sets do not overlap.
- **One catch-all plus routed shards.** One instance keeps `accept_unrouted: true` for unlabeled work; the shard instances set `accept_unrouted: false`. Unlabeled issues land on the catch-all; labeled issues land on their shard.

Slack is a special case: `tracker.assignee` is rejected for `kind: slack`, because Slack messages have no assignee and an assignee filter would double-dispatch in a partitioned deployment. Partition a Slack deployment by channel and route label instead.

## Label conventions per tracker

The route mechanism is the same across trackers. Only the label text differs, because each tracker has a different labeling primitive.

### Linear

Linear issues carry labels directly. With the default `route_label_prefix` of `Lorenz:`, you tag an issue for the `backend` route by adding the Linear label `Lorenz:backend`. The Linear client fetches each issue's labels and lowercases them, so `Lorenz:Backend` normalizes to `lorenz:backend` and resolves to the route `backend`. Route labels are a core dispatch concept, not a Linear feature: the Linear tracker only reports the labels, and the runtime decides routing. See [../trackers/linear.md](../trackers/linear.md).

### Slack

A Slack issue is a thread that @-mentions the bot. There are no issue labels, so routes come from hashtags in the message text. The shipped `WORKFLOW.slack.md` sets `route_label_prefix` to `route-`, so a hashtag `#route-backend` becomes the label `route-backend`, which resolves to the route `backend`. A plain `#backend` is an ordinary label, not a route. With `accept_unrouted: true` (the Slack default), every bot-mention is still picked up whether or not it carries a route hashtag. See [../trackers/slack.md](../trackers/slack.md).

| Tracker | `route_label_prefix` | Route source | Example for route `backend` |
|---|---|---|---|
| Linear | `Lorenz:` | Issue label | label `Lorenz:backend` |
| Slack | `route-` | Hashtag in message | `#route-backend` |

## Worked example: two shards plus a catch-all

Split a Linear backlog across three instances: a `backend` shard, a `frontend` shard, and a catch-all that drains everything unlabeled. All three poll the same Linear project under one assignee.

Backend shard. Accepts only issues labeled `Lorenz:backend`:

```yaml
tracker:
  kind: linear
  assignee: lorenz-bot
  project_slugs: ["platform"]
  dispatch:
    route_label_prefix: "Lorenz:"
    accept_unrouted: false
    only_routes: ["backend"]
```

Frontend shard. Same project and assignee, a different route:

```yaml
tracker:
  kind: linear
  assignee: lorenz-bot
  project_slugs: ["platform"]
  dispatch:
    route_label_prefix: "Lorenz:"
    accept_unrouted: false
    only_routes: ["frontend"]
```

Catch-all. Takes everything that is unlabeled, and nothing routed:

```yaml
tracker:
  kind: linear
  assignee: lorenz-bot
  project_slugs: ["platform"]
  dispatch:
    route_label_prefix: "Lorenz:"
    accept_unrouted: true
    only_routes: []
```

How a few issues route under this setup:

| Issue labels | Backend (`only_routes: ["backend"]`, no unrouted) | Frontend (`only_routes: ["frontend"]`, no unrouted) | Catch-all (`only_routes: []`, accept unrouted) |
|---|---|---|---|
| `Lorenz:backend` | claims | skips | skips |
| `Lorenz:frontend` | skips | claims | skips |
| `Lorenz:backend`, `Lorenz:frontend` | claims | claims | skips |
| (no route label) | skips | skips | claims |

Two rows are worth a second look:

- **An issue with both route labels is claimed by both shards.** Routes are an allowlist intersection, not an exclusive assignment. For exactly-one ownership, keep route sets disjoint and put one route per issue.
- **The catch-all sets `only_routes: []` deliberately.** That rejects every routed issue, so the catch-all never competes with a shard for a labeled issue, while `accept_unrouted: true` still lets it drain the unlabeled tail.

Each instance enforces its own concurrency caps independently. `agent.max_concurrent_agents` (default `10`) is per process, so three instances can run up to thirty agents in total. Plan host capacity for the sum.

## See also
- [../dispatch.md](../dispatch.md) - the full eligibility chain, the routing predicate line by line, and concurrency caps
- [../trackers/linear.md](../trackers/linear.md) - Linear labels, project selection, and the `Lorenz:` prefix
- [../trackers/slack.md](../trackers/slack.md) - Slack hashtag routes and why `tracker.assignee` is rejected
- [../reference/configuration.md](../reference/configuration.md) - every `tracker.dispatch` key and its default
- [../agent-orchestrator.md](../agent-orchestrator.md) - the poll loop and concurrency accounting that routing feeds into
