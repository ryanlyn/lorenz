# Agents

## GitHub

- PRs should be created against `ryanlyn/lorenz`, not `openai/symphony`
  - Use `gh pr create --repo ryanlyn/lorenz` to ensure the correct target

## Claude

- For remote Claude SSH-worker tests, reuse the existing local Claude OAuth credential from the macOS Keychain item with service `Claude Code-credentials`
  - Export `CLAUDE_CODE_OAUTH_TOKEN` from that existing credential for the worker container/session
- Do not use `claude setup-token` or otherwise mint a new token just to run the repo's remote Claude tests

## Typescript

- Run `mise run tidy` for linting and formatting autofix
- Run `mise run check` to run lint, build, types and tests (this rebuilds automatically)
- When running tests directly with vitest, make sure you rebuild first

## TraceViz UI debugging

- Start the dashboard with `pnpm --filter @lorenz/dashboard dev --host 0.0.0.0` from the repository root, then drive `http://localhost:5173/#/trace/<issueId>` with Playwright.
- Mock the REST endpoints and inject a fake `WebSocket` with `page.addInitScript` to emit `events` and `events_append` messages.
- For visual checks, use `recordVideo`, targeted screenshots, and `requestAnimationFrame` sampling of stable DOM markers.
