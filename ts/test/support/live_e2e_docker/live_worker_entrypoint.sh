#!/bin/sh
set -eu

install -d -m 700 /root/.ssh /root/.codex

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  install -d -m 755 /etc/profile.d
  escaped_token=$(printf "%s" "$CLAUDE_CODE_OAUTH_TOKEN" | sed "s/'/'\\\\''/g")
  printf "export CLAUDE_CODE_OAUTH_TOKEN='%s'\n" "$escaped_token" > /etc/profile.d/claude-code-oauth-token.sh
  chmod 600 /etc/profile.d/claude-code-oauth-token.sh

  cat > /root/.bash_profile <<'EOF'
if [ -f /etc/profile ]; then
  . /etc/profile
fi
EOF
  chmod 600 /root/.bash_profile
fi

if [ ! -s /run/symphony/ssh/authorized_key.pub ]; then
  echo "missing authorized key at /run/symphony/ssh/authorized_key.pub" >&2
  exit 1
fi

install -m 600 /run/symphony/ssh/authorized_key.pub /root/.ssh/authorized_keys

exec /usr/sbin/sshd -D -e
