#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cert_dir="$(cd "$script_dir/../.." && pwd)/certs"
mkdir -p "$cert_dir"
umask 077
openssl req -x509 -newkey rsa:3072 -nodes -days 365 -keyout "$cert_dir/ca.key" -out "$cert_dir/ca.crt" -subj "/CN=Digital Twin Lab CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -addext "subjectKeyIdentifier=hash"
openssl req -newkey rsa:3072 -nodes -keyout "$cert_dir/server.key" -out "$cert_dir/server.csr" -subj "/CN=ingestion.local"
printf 'subjectAltName=DNS:ingestion.local,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n' > "$cert_dir/server.ext"
openssl x509 -req -in "$cert_dir/server.csr" -CA "$cert_dir/ca.crt" -CAkey "$cert_dir/ca.key" -CAcreateserial -days 365 -extfile "$cert_dir/server.ext" -out "$cert_dir/server.crt"
new_agent_certificate() {
  local name="$1" agent_id
  agent_id="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s' "$agent_id" > "$cert_dir/$name.id"
  openssl req -newkey rsa:3072 -nodes -keyout "$cert_dir/$name.key" -out "$cert_dir/$name.csr" -subj "/CN=$agent_id"
  printf 'extendedKeyUsage=clientAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n' > "$cert_dir/$name.ext"
  openssl x509 -req -in "$cert_dir/$name.csr" -CA "$cert_dir/ca.crt" -CAkey "$cert_dir/ca.key" -CAcreateserial -days 365 -extfile "$cert_dir/$name.ext" -out "$cert_dir/$name.crt"
}
new_agent_certificate agent
new_agent_certificate agent-linux
rm -f "$cert_dir"/*.csr "$cert_dir"/*.ext "$cert_dir"/*.srl
echo "Lab certificates created in $cert_dir"

