#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 2 ]]; then echo "usage: $0 ABSOLUTE_BINARY ABSOLUTE_CONFIG" >&2; exit 2; fi
binary="$(readlink -f "$1")"
config="$(readlink -f "$2")"
[[ -x "$binary" && -f "$config" ]] || { echo "binary must be executable and config must exist" >&2; exit 2; }
install -d -m 0750 /var/lib/twin-agent
cat >/etc/systemd/system/twin-agent.service <<EOF
[Unit]
Description=Digital Twin passive discovery agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$binary -config $config
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
systemctl enable --now twin-agent.service
systemctl --no-pager status twin-agent.service

