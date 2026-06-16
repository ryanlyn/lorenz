---
name: lorenz-jira
description: |
  Use Lorenz's Jira tracker tools for raw Jira REST API operations
  such as issue queries, transitions, comments, and JQL searches.
---

# Jira REST API

Use this skill for raw Jira REST API work during Lorenz app-server sessions.

## Primary tools

Lorenz exposes Jira operations through its tracker tool layer. The available
tools depend on the tracker kind configured for the session:

- **`jira` kind** — direct REST API calls to Jira Cloud using basic auth
  (email + API token).
- **`jira-mcp` kind** — proxied through an external MCP server with
  configurable tool names.

Default MCP tool names (when using `jira-mcp` kind):

| Operation     | Default tool name       |
|---------------|-------------------------|
| Search        | `jira_search`           |
| Read issue    | `jira_get_issue`        |
| Transition    | `jira_transition_issue` |
| List comments | `jira_get_comments`     |
| Comment       | `jira_add_comment`      |
| Update comment | `jira_update_comment`   |
| Create issue  | `jira_create_issue`     |

## Jira REST API patterns

All REST calls target `/rest/api/3/` on the configured `tracker.base_url`.
Authentication is HTTP Basic with the configured email and API token.

### Read an issue by key

```
GET /rest/api/3/issue/{issueIdOrKey}?fields=summary,description,status,labels,issuelinks,assignee,priority,created,updated
```

Response shape:

```json
{
  "id": "10001",
  "key": "PROJ-42",
  "fields": {
    "summary": "Issue title",
    "description": { "type": "doc", "version": 1, "content": [...] },
    "status": {
      "name": "In Progress",
      "statusCategory": { "key": "indeterminate" }
    },
    "labels": ["agent", "bug"],
    "assignee": { "accountId": "abc123", "displayName": "User" },
    "priority": { "name": "High" },
    "issuelinks": [...],
    "created": "2026-01-15T10:00:00.000+0000",
    "updated": "2026-06-10T14:30:00.000+0000"
  }
}
```

### Search issues with JQL

Use the enhanced search endpoint (Jira Cloud removed the legacy `/rest/api/3/search`):

```
POST /rest/api/3/search/jql
Content-Type: application/json

{
  "jql": "project = PROJ AND status = \"In Progress\" AND assignee = currentUser()",
  "maxResults": 50,
  "fields": ["summary", "description", "status", "labels", "issuelinks", "assignee", "priority", "created", "updated"]
}
```

Response uses opaque `nextPageToken` for pagination (no `startAt`/`total`):

```json
{
  "issues": [...],
  "nextPageToken": "eyJ..."
}
```

Pass `nextPageToken` in subsequent requests to paginate. Stop when `nextPageToken`
is absent or `issues` is empty.

### Transition an issue (change status)

Two-step process:

1. Fetch available transitions:

```
GET /rest/api/3/issue/{issueIdOrKey}/transitions
```

Response:

```json
{
  "transitions": [
    { "id": "31", "name": "In Progress" },
    { "id": "41", "name": "Done" }
  ]
}
```

2. Execute the transition by ID:

```
POST /rest/api/3/issue/{issueIdOrKey}/transitions
Content-Type: application/json

{
  "transition": { "id": "41" }
}
```

Always fetch transitions first and match by name (case-insensitive) to find
the correct transition ID. Never hardcode transition IDs.

### Add a comment

Jira Cloud uses Atlassian Document Format (ADF) for comment bodies:

```
POST /rest/api/3/issue/{issueIdOrKey}/comment
Content-Type: application/json

{
  "body": {
    "type": "doc",
    "version": 1,
    "content": [
      {
        "type": "paragraph",
        "content": [
          { "type": "text", "text": "Comment text here" }
        ]
      }
    ]
  }
}
```

Multi-line text: split on newlines, each line becomes a separate paragraph.
Empty lines become paragraphs with empty `content` arrays.

### List comments

```
GET /rest/api/3/issue/{issueIdOrKey}/comment?startAt=0&maxResults=100
```

Response comments use ADF in `body`. Use comment `id` values with the update endpoint.

### Update a comment

Jira Cloud uses ADF for comment bodies:

```
PUT /rest/api/3/issue/{issueIdOrKey}/comment/{id}
Content-Type: application/json

{
  "body": {
    "type": "doc",
    "version": 1,
    "content": [
      {
        "type": "paragraph",
        "content": [
          { "type": "text", "text": "Updated comment text" }
        ]
      }
    ]
  }
}
```

For Jira MCP trackers, configure `tracker.mcp.tools.list_comments` or
`tracker.mcp.tools.update_comment` when the external server does not expose
the default `jira_get_comments` and `jira_update_comment` tool names.

### Create an issue

```
POST /rest/api/3/issue
Content-Type: application/json

{
  "fields": {
    "project": { "key": "PROJ" },
    "issuetype": { "name": "Task" },
    "summary": "Issue title",
    "description": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [{ "type": "text", "text": "Description text" }]
        }
      ]
    },
    "assignee": { "accountId": "abc123" }
  }
}
```

### Get current user

```
GET /rest/api/3/myself
```

Returns `accountId` and `displayName` for the authenticated user.

### Get project statuses

```
GET /rest/api/3/project/{projectKeyOrId}/statuses
```

Returns issue types with their available statuses — useful for discovering
valid transition targets.

## JQL patterns

Common JQL clauses:

```
project = "PROJ"
project in ("PROJ1", "PROJ2")
status = "In Progress"
status in ("To Do", "In Progress")
assignee = currentUser()
assignee = "accountId"
labels = "agent"
key = "PROJ-42"
key in ("PROJ-1", "PROJ-2", "PROJ-3")
id in (10001, 10002)
updated >= -7d
ORDER BY priority ASC, updated DESC
```

Combine with `AND`/`OR` and parentheses for complex queries.

## Atlassian Document Format (ADF)

Jira Cloud API v3 uses ADF for rich text fields (`description`, `comment.body`).
Minimal document structure:

```json
{
  "type": "doc",
  "version": 1,
  "content": [
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "Plain text" }
      ]
    }
  ]
}
```

Common node types:
- `paragraph` — block of inline text
- `heading` — has `attrs: { level: 1..6 }`
- `bulletList` / `orderedList` — contain `listItem` children
- `codeBlock` — fenced code, has `attrs: { language: "..." }`
- `text` — inline text, optionally with `marks` for bold/italic/code/link

When reading descriptions, recursively extract `.text` fields from the ADF tree
and join with appropriate separators (space within paragraphs, newline between blocks).

## Usage rules

- For status transitions, always fetch available transitions first and match
  by name — transition IDs are workflow-specific and cannot be assumed.
- Use the narrowest JQL that covers your need — avoid `ORDER BY` on large
  result sets when you only need a few issues.
- Prefer issue keys (e.g. `PROJ-42`) over numeric IDs when referencing issues.
- When creating or commenting, always use ADF format for the body — plain
  strings are rejected by Jira Cloud API v3.
- Do not hardcode status category keys; use the returned `statusCategory.key`
  values (`new`, `indeterminate`, `done`) for state type classification.
- For the `jira-mcp` kind, the tool names may differ from defaults — check
  `tracker.mcp.tools` configuration for the session's actual tool names.
- Do not introduce new raw-token shell helpers for Jira API access.
