# Deployment

## Multi-Project Configuration

Symphony supports multiple Linear projects via three mutually exclusive config options:

```yaml
# Explicit list
tracker:
  project_slugs: ["slug-a", "slug-b"]

# Dynamic discovery via labels
tracker:
  project_labels: ["symphony-managed"]

# Single project (deprecated)
tracker:
  project_slug: "slug-a"
```

## systemd Service

`/etc/systemd/system/symphony.service`:

```ini
[Unit]
Description=Symphony
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/symphony-2/ts
ExecStart=/usr/local/bin/op run --env-file=/etc/symphony/env.template -- \
    /usr/bin/node apps/cli/dist/bin/cli.js --no-tui /path/to/workflow.md
Restart=on-failure
RestartSec=5

Environment=OP_SERVICE_ACCOUNT_TOKEN_FILE=/etc/symphony/op-token
EnvironmentFile=/etc/symphony/op-token

User=symphony
Group=symphony

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Key flags:
- `--no-tui` is required (no terminal available in a service)
- Build with `pnpm build` before starting

## 1Password CLI Integration

Use `op run` to inject secrets without writing them to disk.

`/etc/symphony/env.template`:
```bash
LINEAR_API_KEY=op://Vault/LinearAPI/credential
ANTHROPIC_API_KEY=op://Vault/Anthropic/api-key
```

Auth for headless use requires a service account. Store the bootstrap token in `/etc/symphony/op-token`:
```
OP_SERVICE_ACCOUNT_TOKEN=ey...
```

Permissions: `chmod 600 /etc/symphony/op-token`, owned by root.

## Log Cleanup

Use systemd tmpfiles.d to clean logs older than 14 days.

`/etc/tmpfiles.d/symphony.conf`:
```
d /path/to/logs-root 0755 symphony symphony -
e /path/to/logs-root - - - 14d
```

This piggybacks on `systemd-tmpfiles-clean.timer` which runs daily. Apply immediately with `systemd-tmpfiles --clean`.

## Commands

```bash
# Build
pnpm build

# Enable and start
systemctl daemon-reload
systemctl enable --now symphony

# View logs
journalctl -u symphony -f
```
