#!/bin/bash
# db01 — "company" PostgreSQL with SYNTHETIC HR/inventory data. Critical asset.
# All names, emails and numbers below are invented for the lab. No real data.
set -euxo pipefail

dnf -y install docker
systemctl enable --now docker

# A deliberately weak lab policy: first pg_hba rule trusts the app subnet with no
# password. This is the exact kind of config the twin is meant to surface. Lab only.
mkdir -p /opt/lab-db
cat >/opt/lab-db/init.sql <<'SQL'
CREATE TABLE employees (id serial PRIMARY KEY, name text, email text, dept text, salary_band text);
INSERT INTO employees (name,email,dept,salary_band) VALUES
 ('Ava Thompson','ava.thompson@synthetic.lab','Finance','B4'),
 ('Noah Patel','noah.patel@synthetic.lab','Engineering','B5'),
 ('Mia Rodriguez','mia.rodriguez@synthetic.lab','People','B3'),
 ('Liam Chen','liam.chen@synthetic.lab','Engineering','B5'),
 ('Zoe Williams','zoe.williams@synthetic.lab','Sales','B4');
CREATE TABLE inventory (sku text PRIMARY KEY, description text, on_hand int);
INSERT INTO inventory VALUES ('SKU-1001','Pallet jack',42),('SKU-1002','Shelving unit',130),('SKU-1003','Forklift battery',7);
SQL

cat >/opt/lab-db/pg_hba.conf <<'HBA'
local   all   all                     trust
host    all   all   127.0.0.1/32      trust
# Lab weakness: unauthenticated access from the internal app subnet.
host    all   all   10.20.2.0/24      trust
host    all   all   0.0.0.0/0         scram-sha-256
HBA

docker rm -f lab-postgres 2>/dev/null || true
docker run -d --name lab-postgres --restart unless-stopped -p 5432:5432 \
  -e POSTGRES_PASSWORD=synthetic-lab-pw -e POSTGRES_DB=company \
  -v /opt/lab-db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro \
  -v /opt/lab-db/pg_hba.conf:/etc/postgresql/pg_hba.conf:ro \
  postgres:16 -c hba_file=/etc/postgresql/pg_hba.conf
echo "db01 ready: synthetic company PostgreSQL on :5432"
