#!/bin/bash
# app01 — internal app host: Redis cache + a lab SSH service + a small app page.
# Synthetic lab config only.
set -euxo pipefail
dnf -y install docker
systemctl enable --now docker

# Redis with protected-mode OFF and no auth bound to the internal interface:
# a classic lab weakness for the twin to detect. Lab only, internal subnet.
docker rm -f lab-redis 2>/dev/null || true
docker run -d --name lab-redis --restart unless-stopped -p 6379:6379 \
  redis:7 redis-server --protected-mode no --bind 0.0.0.0

# A tiny "internal app" so web->app traffic is observable.
docker rm -f lab-app 2>/dev/null || true
mkdir -p /opt/lab-app
cat >/opt/lab-app/index.html <<'HTML'
<!doctype html><title>Acme Internal App</title><h1>Acme Logistics — internal</h1>
<p>Synthetic lab service. Orders, inventory and HR links (demo only).</p>
HTML
docker run -d --name lab-app --restart unless-stopped -p 8080:80 \
  -v /opt/lab-app:/usr/share/nginx/html:ro nginx:1.27

# A separate lab SSH service on 2222 with password auth enabled (synthetic account).
# Kept apart from the real OS SSH on 22. Lab only.
docker rm -f lab-ssh 2>/dev/null || true
docker run -d --name lab-ssh --restart unless-stopped -p 2222:22 \
  -e USER_NAME=labadmin -e USER_PASSWORD=synthetic-lab-pw -e PASSWORD_ACCESS=true \
  -e PUID=1000 -e PGID=1000 lscr.io/linuxserver/openssh-server:latest || \
  echo "openssh-server image pull failed; continuing (lab SSH optional)"
echo "app01 ready: redis :6379, app :8080, lab ssh :2222"
