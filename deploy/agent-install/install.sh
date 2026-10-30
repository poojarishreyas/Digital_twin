#!/usr/bin/env bash
# Install and enroll the Digital Twin discovery agent on a Linux server.
#
#   curl -fsSL https://PLATFORM/agent/install.sh | sudo bash -s -- --url https://PLATFORM --token dtk_...
#
# The agent only reads this machine (services, versions, sockets, firewall rules and
# allowlisted configuration with secrets redacted). It never changes the system.
set -euo pipefail

URL=""
TOKEN="${TWIN_ENROLL_TOKEN:-}"
ALLOW_HTTP=""
usage() { echo "usage: install.sh --url https://PLATFORM --token dtk_... [--allow-http]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --allow-http) ALLOW_HTTP="-allow-http"; shift ;;
    *) usage ;;
  esac
done
[ -n "$URL" ] && [ -n "$TOKEN" ] || usage
URL="${URL%/}"
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required." >&2; exit 1; }
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  *) echo "Unsupported architecture $(uname -m); only x86_64 agents are published today." >&2; exit 1 ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fetch() {
  if command -v curl >/dev/null; then curl -fsSL --retry 3 "$1" -o "$2"
  elif command -v wget >/dev/null; then wget -q -O "$2" "$1"
  else echo "curl or wget is required." >&2; exit 1; fi
}

echo "Downloading agent from $URL ..."
fetch "$URL/agent/twin-agent-linux-$ARCH" "$tmp/twin-agent"
fetch "$URL/agent/SHA256SUMS" "$tmp/SHA256SUMS"
expected="$(awk -v f="twin-agent-linux-$ARCH" '$2 == f || $2 == "*"f {print $1}' "$tmp/SHA256SUMS")"
actual="$(sha256sum "$tmp/twin-agent" | awk '{print $1}')"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "Checksum mismatch for the downloaded agent; nothing was installed." >&2
  exit 1
fi
install -m 0755 "$tmp/twin-agent" /usr/local/bin/twin-agent
install -d -m 0700 /etc/twin-agent
install -d -m 0750 /var/lib/twin-agent

if [ -f /etc/twin-agent/config.yaml ]; then
  echo "This machine is already enrolled; keeping its identity and updating the agent binary."
else
  # Pass the token through the environment so it does not appear in process listings.
  TWIN_ENROLL_TOKEN="$TOKEN" /usr/local/bin/twin-agent enroll -url "$URL" -dir /etc/twin-agent $ALLOW_HTTP
fi

# A machine may declare its main service so connections to it resolve to this host.
if [ -f /etc/twin-agent/workload.json ] && ! grep -q '^workload_file:' /etc/twin-agent/config.yaml; then
  echo 'workload_file: /etc/twin-agent/workload.json' >> /etc/twin-agent/config.yaml
fi

cat >/etc/systemd/system/twin-agent.service <<'EOF'
[Unit]
Description=Digital Twin passive discovery agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/twin-agent -config /etc/twin-agent/config.yaml
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/twin-agent
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable twin-agent.service >/dev/null
systemctl restart twin-agent.service
sleep 2
if systemctl is-active --quiet twin-agent.service; then
  echo "Done. This server will appear in your 3D twin within a few seconds."
else
  echo "The agent service did not start; see: journalctl -u twin-agent -n 50" >&2
  exit 1
fi
