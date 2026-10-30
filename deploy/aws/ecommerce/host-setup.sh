#!/bin/bash
# Larkspur Goods (synthetic e-commerce store) host setup on Amazon Linux 2023.
#   host-setup.sh web|app|orders|db
# Environment from EC2 user data: DB_PASSWORD, APP_IP, ORDERS_IP, DB_IP, VPC_CIDR.
# Installs real packages at their standard paths so the twin agent discovers them.
# It does NOT install the twin agent: you join each host from the dashboard.
set -euxo pipefail
ROLE="$1"
VERSION_TAG="larkspur-goods/2.4.1"
HERE="$(cd "$(dirname "$0")" && pwd)"
hostnamectl set-hostname "shop-${ROLE}01"

declare_workload() {  # name version port file-whose-digest-identifies-the-release
  install -d -m 0700 /etc/twin-agent
  printf '{"name":"%s","version":"%s","image_id":"sha256:%s","port":%s}\n' \
    "$1" "$2" "$(sha256sum "$4" | cut -d' ' -f1)" "$3" > /etc/twin-agent/workload.json
}

install_services() {  # role names served by shop_service.py on this host
  dnf -y install python3 python3-psycopg2 || { dnf -y install python3-pip && pip3 install psycopg2-binary; }
  id larkspur >/dev/null 2>&1 || useradd --system --home-dir /opt/larkspur --shell /sbin/nologin larkspur
  install -d -o larkspur /opt/larkspur
  install -m 0755 "$HERE/shop_service.py" /opt/larkspur/shop_service.py
  umask 077
  cat > /etc/larkspur.env <<ENV
DB_HOST=${DB_IP:-}
DB_PASSWORD=${DB_PASSWORD:-}
PAYMENTS_HOST=127.0.0.1
REDIS_HOST=127.0.0.1
ENV
  umask 022
  cat > /etc/systemd/system/larkspur@.service <<'UNIT'
[Unit]
Description=Larkspur Goods %i service
After=network-online.target
Wants=network-online.target

[Service]
User=larkspur
EnvironmentFile=/etc/larkspur.env
ExecStart=/usr/bin/python3 /opt/larkspur/shop_service.py %i
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  for name in "$@"; do systemctl enable --now "larkspur@${name}"; done
}

case "$ROLE" in
web)
  dnf -y install nginx
  install -d /usr/share/nginx/larkspur
  cat > /usr/share/nginx/larkspur/index.html <<'HTML'
<!doctype html><meta charset="utf-8"><title>Larkspur Goods — home & kitchen</title>
<style>body{font-family:system-ui;margin:0;background:#faf7f2;color:#222}header{background:#2f4f3a;color:#fff;padding:18px 32px}
main{padding:24px 32px}#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
.card{background:#fff;border-radius:10px;padding:14px;box-shadow:0 1px 3px #0002}.price{color:#2f4f3a;font-weight:700}</style>
<header><h1>Larkspur Goods</h1><p>Home, kitchen & garden — synthetic demo store</p></header>
<main><div id="grid">Loading catalog…</div></main>
<script>fetch('/api/catalog/products').then(r=>r.json()).then(d=>{grid.innerHTML=d.products.map(p=>
`<div class=card><b>${p.name}</b><p>${p.category}</p><p class=price>$${(p.price_cents/100).toFixed(2)}</p></div>`).join('')})</script>
HTML
  cat > /etc/nginx/nginx.conf <<CONF
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log;
pid /run/nginx.pid;
events { worker_connections 1024; }
http {
  include /etc/nginx/mime.types;
  access_log /var/log/nginx/access.log;
  keepalive_timeout 65;
  server_tokens on;
  upstream catalog { server ${APP_IP}:8081; keepalive 8; }
  upstream cart { server ${APP_IP}:8082; keepalive 8; }
  upstream orders { server ${ORDERS_IP}:8083; keepalive 8; }
  server {
    listen 80 default_server;
    server_name shop.larkspur.example;
    root /usr/share/nginx/larkspur;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    location /api/catalog/ { proxy_pass http://catalog/; }
    location /api/cart/ { proxy_pass http://cart/; }
    location /api/orders/ { proxy_pass http://orders/; }
    location / { try_files \$uri /index.html; }
  }
}
CONF
  nginx -t
  systemctl enable --now nginx
  install_services shopper
  declare_workload storefront "nginx-storefront/2.4.1" 80 /etc/nginx/nginx.conf
  ;;
app)
  dnf -y install redis6
  # Cart sessions; left without a password on the internal network (a common finding).
  sed -i -e 's/^bind .*/bind 0.0.0.0/' -e 's/^protected-mode .*/protected-mode no/' /etc/redis6/redis6.conf
  systemctl enable --now redis6
  install_services catalog cart
  declare_workload catalog "$VERSION_TAG" 8081 /opt/larkspur/shop_service.py
  ;;
orders)
  install_services orders payments
  declare_workload orders "$VERSION_TAG" 8083 /opt/larkspur/shop_service.py
  ;;
db)
  dnf -y install postgresql15-server
  [ -f /var/lib/pgsql/data/PG_VERSION ] || postgresql-setup --initdb
  sed -i "s/^#\?listen_addresses.*/listen_addresses = '*'/" /var/lib/pgsql/data/postgresql.conf
  grep -q "shop_app" /var/lib/pgsql/data/pg_hba.conf || \
    echo "host shop shop_app ${VPC_CIDR} scram-sha-256" >> /var/lib/pgsql/data/pg_hba.conf
  systemctl enable --now postgresql
  sudo -u postgres psql -v ON_ERROR_STOP=1 -v pw="$DB_PASSWORD" <<'SQL'
SELECT 'CREATE DATABASE shop' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='shop')\gexec
SELECT format('CREATE ROLE shop_app LOGIN PASSWORD %L', :'pw') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='shop_app')\gexec
SQL
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d shop -f "$HERE/seed.sql"
  declare_workload customer-db "postgresql/15" 5432 "$(readlink -f "$(command -v postgres || echo /usr/bin/psql)")"
  ;;
*) echo "unknown role $ROLE" >&2; exit 2 ;;
esac
echo "shop-${ROLE}01 ready"
