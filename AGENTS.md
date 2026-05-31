# Agents

## GitHub

- PRs should be created against `ryanlyn/symphony`, not `openai/symphony`
  - Use `gh pr create --repo ryanlyn/symphony` to ensure the correct target

## Claude

- For remote Claude SSH-worker tests, reuse the existing local Claude OAuth credential from the macOS Keychain item with service `Claude Code-credentials`
  - Export `CLAUDE_CODE_OAUTH_TOKEN` from that existing credential for the worker container/session
- Do not use `claude setup-token` or otherwise mint a new token just to run the repo's remote Claude tests

## Typescript

- When working on the ts/ folder, run `mise run tidy` for linting and formatting autofix
- When working on the ts/ folder, run `mise run check` to run lint, build, types and tests (this rebuilds automatically)
- When running tests directly with vitest, make sure you rebuild first
