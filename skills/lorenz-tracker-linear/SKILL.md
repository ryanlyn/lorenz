---
name: lorenz-tracker-linear
description: |
  Linear-specific mechanics for the tracker-agnostic Lorenz workflow: reading
  the issue, maintaining the single workpad comment, changing status, filing
  follow-up issues, linking the PR, and uploading media evidence. Use whenever
  the workflow requires a tracker operation and the configured tracker is
  Linear.
---

# Lorenz tracker: Linear

This skill maps the workflow's tracker contract onto Linear. The workflow
defines *what and when*; this skill defines *how* for Linear. For raw GraphQL
mechanics — query shapes, targeted introspection, upload flows — defer to the
`lorenz-linear` skill; do not duplicate its queries from memory when it already
documents them.

## Tools

Use the configured Linear MCP server or the injected `linear_graphql` tool.
Prefer the MCP surface for simple reads and writes; use `linear_graphql` for
anything the MCP surface lacks (comment editing, attachments, uploads,
relations). If neither is available, you are blocked per the workflow's blocker
rules.

## Reading the issue

- Fetch by ticket key (for example `MT-42`); `issue(id: $key)` accepts keys
  directly. Read the state name and type, description, labels, attachments, and
  comments.
- PR linkage lives in `attachments`; do not query `Issue.links` (it does not
  exist).

## The workpad comment

- The workpad is ONE Linear comment on the issue. Find it by searching comment
  bodies for the marker heading `## Lorenz Workpad`; also accept the legacy
  `## Codex Workpad` marker and reuse whichever exists. Never create a second
  workpad.
- Only active/unresolved comments are eligible; skip comments with
  `resolvedAt` set when searching. (Comment records expose `resolvedAt` and
  `archivedAt`, not `resolved`/`archived`.)
- Persist the workpad comment ID and write every update to that ID in place
  with `commentUpdate`; use `commentCreate` only when no workpad exists yet.
- If MCP comment editing is unavailable, fall back to `linear_graphql`
  `commentUpdate`. Report blocked only when both paths fail.
- Prefer fenced code blocks in the comment over uploading `.md`/`.txt`
  attachments.

## Changing status

- Resolve the destination `stateId` by exact state name from the issue's team
  workflow states (query in `lorenz-linear`); never hardcode state IDs or pass
  state names into mutations.
- Transition with `issueUpdate(id, input: { stateId })`.

## Follow-up issues

Create with `issueCreate`, using the project/team/state resolution queries in
`lorenz-linear`:

- Resolve the current issue's `teamId` and `projectId` and the team's
  `Backlog` state ID.
- Pass `{ teamId, projectId, stateId, title, description }`, plus
  `assigneeId` set to the current issue's assignee when the issue has an
  owner.
- Then link relations with `issueRelationCreate`: a `related` relation between
  the follow-up and the current issue; when the follow-up is blocked by the
  current work, also create the blocking relation from the current issue to
  the follow-up. Verify the exact `IssueRelationCreateInput` shape with
  targeted introspection if unsure.

## Linking the PR

- Attach the PR to the issue with `attachmentLinkGitHubPR` (preferred over a
  generic URL attachment). Treat a `Duplicate attachment for duplicate url`
  error as success; do not retry with a different attachment mutation.
- Keep PR linkage on the issue attachment, not in the workpad body.

## Media evidence

For screenshot/video proof, use the `fileUpload` -> signed `PUT` ->
`commentCreate`/`commentUpdate` flow documented in `lorenz-linear`, embedding
the returned `assetUrl` in the workpad.
