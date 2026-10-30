#!/bin/bash
# twin-control: runs the Digital Twin platform (dashboard, ingestion, Neo4j, PostgreSQL)
# on Amazon Linux 2023. Called from EC2 user data with the repository unpacked in /opt/twin.
set -euxo pipefail
cd /opt/twin
TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
meta() { curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/$1"; }
PRIV=$(meta local-ipv4)
PUB=$(meta public-ipv4)

dnf -y install docker git openssl
systemctl enable --now docker
install -d /usr/local/lib/docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Agent binary served to machines that join from the dashboard.
install -d bin
docker run --rm -v /opt/twin/agent:/src -v /opt/twin/bin:/out -w /src golang:1.23 \
  sh -c 'CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/twin-agent-linux-amd64 ./cmd/twin-agent'
(cd bin && sha256sum twin-agent-linux-amd64 > SHA256SUMS)

# Server TLS for agent telemetry, and the CA that signs agent identities at enrollment.
[ -f certs/server.crt ] || bash deploy/pki/new-lab-pki.sh
bash deploy/pki/new-enrollment-ca.sh
install -d -m 0700 secrets/auth

if [ ! -f .env ]; then
  umask 077
  cat > .env <<ENV
POSTGRES_DB=digital_twin
POSTGRES_USER=twin
POSTGRES_PASSWORD=$(openssl rand -hex 24)
NEO4J_PASSWORD=$(openssl rand -hex 24)
TWIN_AUTH_MODE=tokens
TWIN_DEPLOYMENT_MODE=local
TWIN_COOKIE_SECURE=false
TWIN_ALLOWED_ORIGINS=http://${PUB}:3000,http://${PRIV}:3000
TWIN_AGENT_BIND=0.0.0.0
TWIN_PUBLIC_GRPC_ADDRESS=${PRIV}:8443
TWIN_GRPC_SERVER_NAME=ingestion.local
ENV
  umask 022
fi

# Lab override: the dashboard listens on all interfaces; the security group limits who reaches it.
cat > compose.aws.yml <<YML
services:
  ui:
    ports: !override
      - "0.0.0.0:3000:80"
YML

docker compose -f docker-compose.yml -f compose.aws.yml up -d --build
for _ in $(seq 120); do
  code=$(docker compose logs ingestion 2>/dev/null | grep -o 'setup code: [a-f0-9-]*' | tail -1 | cut -d' ' -f3)
  [ -n "$code" ] && break
  sleep 5
done
printf 'Dashboard: http://%s:3000\nSetup code: %s\n' "$PUB" "${code:-not found yet; run: docker compose logs ingestion | grep setup}" \
  > /root/twin-ready.txt
cat /root/twin-ready.txt
