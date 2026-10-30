#!/bin/bash
# dmz-web01 — public reverse proxy (entry asset). Proxies to app01 internally.
set -euxo pipefail
dnf -y install docker
systemctl enable --now docker
mkdir -p /opt/lab-web
# server_tokens on => version disclosure, a lab weakness the twin flags.
cat >/opt/lab-web/default.conf <<CONF
server {
  listen 8080;
  server_tokens on;
  location / { proxy_pass http://APP_PRIVATE_IP:8080; proxy_set_header Host \; }
  location = /healthz { return 200 'ok'; add_header Content-Type text/plain; }
}
CONF
docker rm -f lab-web 2>/dev/null || true
docker run -d --name lab-web --restart unless-stopped -p 8080:8080   -v /opt/lab-web/default.conf:/etc/nginx/conf.d/default.conf:ro nginx:1.27
echo "web01 ready: public reverse proxy :8080 -> app01"
