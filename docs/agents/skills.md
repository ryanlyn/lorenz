# Skills

A skill is a directory of Markdown instructions (a `SKILL.md` plus any supporting files) that Lorenz copies into every prepared workspace at `.lorenz/skills/<name>`. This page is for operators who want to give their agent reusable playbooks. It covers where skills come from, how the overlay is assembled, why the directory stays uncommitted, the orchestration skills Lorenz ships, and how to add your own.

## Where skills come from

The overlay is the union of two sources, computed in `apps/cli/src/daemon.ts` by `resolveSkillOverlay`:

- **`agent.skills`** - skill directories you maintain and list in your `WORKFLOW.md` front matter. Each entry is one directory and is copied to `.lorenz/skills/<basename>`. Relative paths resolve from the workflow file directory; `~` and a whole-value `$VAR` expand. The default is an empty list.
- **Tool packs** - a mounted tool pack can bundle the skill that documents it. The skill ships automatically when the pack is in use, so you do not list it under `agent.skills`. The Linear pack (`name: "linear"`) bundles `lorenz-linear`, which teaches the agent to call the injected `linear_graphql` tool. Mounting the pack overlays the skill.

The two sets are de-duplicated by absolute path. If nothing is configured and no pack bundles a skill, the overlay is skipped entirely.

```yaml
agent:
  skills:
    - ./skills/lorenz-land
    - ./skills/my-team-conventions
```

## How the overlay is assembled

For each source directory, `syncWorkspaceSkills` (in `packages/workspace/src/index.ts`) copies the whole tree to `<workspace>/.lorenz/skills/<basename>` with `fs.cp({ dereference: true, recursive: true })`. The destination prefix `.lorenz/skills` is a fixed string assembled in `daemon.ts`; it is not configurable through `workspace` settings. On a remote worker, the source is tarred and piped over SSH into a guard script that recreates the same layout.

The copy enforces three containment rules. Each source must be a real directory: a source that is a file throws `workspace_skill_source_unsupported`, and a symlink anywhere in its subtree throws `workspace_skill_source_symlink`. A source that does not exist throws `workspace_skill_source_missing`. The target is replaced before each copy unless the source and target already resolve to the same realpath.

The overlay runs on every workspace prepare, including the shared `workspace.isolation = "none"` mode, where skills land in the shared root.

## The `.gitignore` that keeps skills uncommitted

Each sync writes a `.gitignore` containing a single `*` at the skills root (`.lorenz/skills/.gitignore`). That ignores everything under it, so overlaid skills never show up in the agent's commits or PRs. The file is rewritten on every sync, so editing or deleting it has no lasting effect.

## Shipped orchestration skills

Lorenz ships six skills under `skills/` in the repository. Four document the git and PR workflow an agent runs after writing code, and `lorenz-debug` traces stuck runs. The sixth, `lorenz-linear`, also lives under `skills/`, but its runtime overlay comes from a copy bundled with the Linear tool pack at `extensions/linear-tracker/skills/lorenz-linear`, not from `skills/lorenz-linear`.

| Skill | What it does |
| --- | --- |
| `lorenz-commit` | Builds a well-formed commit from the current changes, using the session history for rationale and a wrapped body. |
| `lorenz-push` | Pushes the current branch to `origin` and creates or updates the matching pull request via the `gh` CLI. |
| `lorenz-pull` | Merges `origin/main` into the current branch (merge, not rebase) and guides conflict resolution, enabling `rerere` first. |
| `lorenz-land` | Lands a PR: keeps it conflict-free with main, waits for checks, and squash-merges once green. |
| `lorenz-debug` | Investigates stuck, retrying, or failing runs by correlating issue and session identifiers across the Lorenz and Codex logs. |
| `lorenz-linear` | Teaches the agent to run raw Linear GraphQL through the `linear_graphql` tool, reusing Lorenz's configured Linear auth. |

To use the orchestration skills, list the directories under `agent.skills`:

```yaml
agent:
  skills:
    - ./skills/lorenz-commit
    - ./skills/lorenz-push
    - ./skills/lorenz-pull
    - ./skills/lorenz-land
    - ./skills/lorenz-debug
```

`lorenz-linear` is the exception: enable Linear tools and the pack overlays it for you.

## Reference the overlay in your prompt

Copying a skill into the workspace does not make the agent read it. The agent only knows the skill exists if your prompt points at the path. Reference `.lorenz/skills` in your `WORKFLOW.md` (or the executor's equivalent configuration) so the agent looks there at runtime. Both Codex and Claude read the overlaid skills as files from the workspace filesystem at `.lorenz/skills`.

## Add your own skill

1. Create a directory with a `SKILL.md`. Give it front matter with a `name` and a `description` so the agent can decide when the skill applies:

   ```md
   ---
   name: deploy-runbook
   description: Steps to ship a change to staging and verify the smoke tests.
   ---

   # Deploy runbook

   1. ...
   ```

2. Put the directory anywhere reachable from your workflow file. Keep the tree free of symlinks; a single symlinked entry fails the sync.

3. List it under `agent.skills` in `WORKFLOW.md`:

   ```yaml
   agent:
     skills:
       - ./skills/deploy-runbook
   ```

4. Reference `.lorenz/skills/deploy-runbook` in your prompt so the agent reads it.

The directory's basename becomes the overlay name, so `./skills/deploy-runbook` lands at `.lorenz/skills/deploy-runbook`. Two sources that share a basename collide; rename one to keep both.

## See also
- [workspace.md](../workspace.md) - the workspace lifecycle and containment rules the overlay runs inside
- [workflows.md](../workflows.md) - the `WORKFLOW.md` front matter where `agent.skills` lives
- [trackers/linear.md](../trackers/linear.md) - the Linear pack that bundles `lorenz-linear`
- [extensions/tool-pack.md](../extensions/tool-pack.md) - how a tool pack bundles its own skill
- [reference/configuration.md](../reference/configuration.md) - the full `agent.skills` and `workspace` key reference
