# Secret resolution

Your `WORKFLOW.md` is committed to a repository, so it should never hold a raw API key. This page is for operators who configure a tracker or tool pack. It covers how Lorenz turns a config placeholder into a real secret at parse time, the exact rules and their order, and how to keep credentials out of the file.

Secret resolution runs while the front matter is parsed into typed `Settings`. It applies to the tracker `api_key` and `assignee` fields, and to any string value under a `tools.<pack>` block. The code lives in `resolveConfiguredSecret` in `packages/config/src/parse.ts`.

## Three ways to supply a secret

A config value can be a literal, an environment-variable placeholder, or a 1Password reference.

- **Literal string** - used as-is. Fine for non-secret values, but do not commit real keys this way.
- **`$VAR` placeholder** - the whole value is replaced by the named environment variable.
- **`op://` reference** - read from 1Password through the `op` CLI at parse time.

In addition, each tracker provider declares **env fallbacks**: if you omit the field entirely, Lorenz reads a provider-specific environment variable.

<p align="center"><img src="../assets/diagrams/secret-resolution.svg" alt="secret resolution diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*How a configured value resolves: whole-value `$VAR` substitution, then the provider env fallback, then any `op://` reference through the `op` CLI.*

## Whole-value `$VAR` substitution

A value is an environment reference only when the entire value matches `$NAME`, against the regex `^\$[A-Za-z_][A-Za-z0-9_]*$`. The name must start with a letter or underscore and contain only letters, digits, and underscores.

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
```

Lorenz replaces the whole value with `env["LINEAR_API_KEY"]`. An unset variable yields an empty string, which falls through to the provider env fallback below.

This is substitution, not interpolation. `$VAR` fires only as the complete value. A value like `prefix-$TOKEN` or `$A$B` fails the whole-value regex, so it passes through untouched as a literal.

## Per-provider env fallbacks

Leave the field out of the front matter and the tracker provider supplies a fallback environment variable. The fallback is read with `nonEmptyString`, so an unset or empty variable counts as no value.

| Provider | Field | Fallback env var |
| --- | --- | --- |
| `linear` | `api_key` | `LINEAR_API_KEY` |
| `linear` | `assignee` | `LINEAR_ASSIGNEE` |
| `jira` | `api_key` | `JIRA_API_KEY` |
| `slack` | `api_key` | `SLACK_BOT_TOKEN` |

Each provider declares its fallbacks in `envFallbacks` (see `extensions/linear-tracker/src/provider.ts`, `extensions/jira-tracker/src/provider.ts`, `extensions/slack-tracker/src/provider.ts`). A provider with no entry for a field has no fallback for it.

For Linear, omit `api_key` entirely and export `LINEAR_API_KEY` in the environment:

```yaml
tracker:
  kind: linear
  # api_key omitted; resolves from LINEAR_API_KEY
```

## `op://` 1Password references

A value (or a fallback) that starts with `op://` is read from 1Password through the `op` CLI. Resolution shells out twice: `op --version` probes that the CLI exists, then `op read <ref>` fetches the secret. Both run with the merged environment `{ ...process.env, ...env }`, and the returned `stdout` is trimmed.


```yaml
tracker:
  kind: linear
  api_key: op://Engineering/Linear/api_key
```

The `op://` step runs after `$VAR` substitution and after the env fallback. A bare `op://` reference set only as a fallback still resolves: with no inline value configured, a fallback environment variable holding an `op://` reference is read through the `op` CLI.

## Order of precedence

For each resolvable field, `resolveConfiguredSecret` applies this order:

1. **Inline value, `$VAR`-expanded.** If the value is exactly `$NAME`, substitute `env[NAME]` (empty string if unset). Otherwise the literal value stands.
2. **Provider env fallback.** If the expanded inline value is empty or the field was omitted, use the provider's fallback env var (when set and non-empty).
3. **`op://` resolution.** Whichever value won steps 1-2, if it starts with `op://`, read it through the `op` CLI.

The first non-empty result from steps 1 and 2 wins, then step 3 dereferences it if it points at 1Password. An omitted field with no fallback resolves to `undefined`.

## Best practice

Keep secrets in the environment or in 1Password, and reference them from `WORKFLOW.md`. The file stays safe to commit because it carries only `$VAR` placeholders, `op://` references, or nothing at all (relying on the env fallback). Three patterns cover the cases:

- For local runs and CI, export the provider fallback var (`LINEAR_API_KEY`, `JIRA_API_KEY`, `SLACK_BOT_TOKEN`) and omit the field.
- For shared secret stores, use `op://` references and let each operator's `op` session supply the value.
- Reserve literal strings for non-secret config only.

The same rules apply to tool pack options. Any string value under a `tools.<pack>` block passes through `resolveConfiguredSecret`, so a tool's token can be `$VAR` or `op://` too (see `packages/config/src/parse.ts` around the per-pack options copy).

## Caveats

- **The `op` CLI must be on `PATH`.** If a value needs 1Password and `op` is missing, parsing throws: `1Password CLI (op) is required to resolve op:// references but was not found. Install it from https://developer.1password.com/docs/cli/get-started - it cannot be managed by mise.`
- **A failed read is fatal.** If `op read <ref>` fails (wrong vault, no session, bad reference), parsing throws `Failed to resolve 1Password reference: <ref>`.
- **Unset `$VAR` is silent.** An unset variable substitutes to an empty string, not an error. The value falls through to the env fallback; if that is also empty, the field resolves to undefined and surfaces later as a validation or auth error, not at substitution time.
- **Whole-value only.** `$VAR` does not interpolate inside a larger string. Use a dedicated environment variable holding the full value.
- **Bare `op://` fallbacks resolve.** A fallback env var whose value is an `op://` reference is dereferenced, even with no inline config value.

## See also

- [Security](../security.md) - credential handling and the broader threat model
- [Configuration reference](../reference/configuration.md) - every config key, default, and the tracker fields these rules apply to
- [Workflows](../workflows.md) - how `WORKFLOW.md` front matter is structured
- [Linear tracker](../trackers/linear.md) - the `LINEAR_API_KEY` / `LINEAR_ASSIGNEE` fallbacks in context
