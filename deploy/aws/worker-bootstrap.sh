#!/bin/bash
# Bring up the twin platform on twin-worker (storage + ingestion first).
set -euxo pipefail
cd /opt/twin
PRIV=10.20.1.87

mkdir -p secrets/auth certs/enrollment

# Agent enrollment issuing CA (separate from the lab server CA).
if [ ! -f certs/enrollment/enroll-ca.key ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1825 \
    -keyout certs/enrollment/enroll-ca.key -out certs/enrollment/enroll-ca.crt \
    -subj "/CN=Digital Twin Agent Enrollment CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  chmod 600 certs/enrollment/enroll-ca.key
fi

# .env (lab: HTTP access, loopback cookies). Strong DB passwords.
if [ ! -f .env ]; then
  cat > .env <<ENV
POSTGRES_DB=digital_twin
POSTGRES_USER=twin
POSTGRES_PASSWORD=$(openssl rand -hex 24)
NEO4J_PASSWORD=$(openssl rand -hex 24)
TWIN_AUTH_MODE=tokens
TWIN_DEPLOYMENT_MODE=local
TWIN_COOKIE_SECURE=false
TWIN_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://${PRIV}:3000
TWIN_AGENT_BIND=0.0.0.0
TWIN_PUBLIC_GRPC_ADDRESS=${PRIV}:8443
TWIN_GRPC_SERVER_NAME=ingestion.local
TWIN_OPERATOR_TENANT=acme
ENV
fi

# Lab override: publish ingestion HTTP on the private interface so in-VPC hosts can enroll.
cat > compose.lab.yml <<YML
services:
  ingestion:
    ports:
      - "${PRIV}:8080:8080"
      - "0.0.0.0:8443:8443"
YML

/usr/local/bin/docker-compose -f docker-compose.yml -f compose.lab.yml up -d --build postgres neo4j ingestion
sleep 5
docker ps --format '{{.Names}} {{.Status}}'
