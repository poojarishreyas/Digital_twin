#!/usr/bin/env bash
# Create the issuing CA that signs agent certificates during one-line enrollment.
# Run once. It is separate from the lab root so its key can only mint agent identities.
set -euo pipefail
dir="$(cd "$(dirname "$0")/../.." && pwd)/certs/enrollment"
if [[ -f "$dir/enroll-ca.key" ]]; then
  echo "Enrollment CA already exists in $dir; keeping it (enrolled agents depend on it)."; exit 0
fi
install -d -m 0700 "$dir"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1825 \
  -keyout "$dir/enroll-ca.key" -out "$dir/enroll-ca.crt" -subj "/CN=Digital Twin Agent Enrollment CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
chmod 0600 "$dir/enroll-ca.key"
echo "Created $dir/enroll-ca.crt and enroll-ca.key. Restart ingestion to enable 'Add host' in the dashboard."
