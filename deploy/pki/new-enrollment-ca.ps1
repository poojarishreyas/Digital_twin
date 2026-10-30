# Create the issuing CA that signs agent certificates during one-line enrollment.
# Run once. It is separate from the lab root so its key can only mint agent identities.
$ErrorActionPreference = 'Stop'
$dir = Join-Path (Resolve-Path "$PSScriptRoot/../..") 'certs/enrollment'
if (Test-Path (Join-Path $dir 'enroll-ca.key')) {
  Write-Host "Enrollment CA already exists in $dir; keeping it (enrolled agents depend on it)."; exit 0
}
New-Item -ItemType Directory -Force -Path $dir | Out-Null
& openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1825 `
  -keyout "$dir/enroll-ca.key" -out "$dir/enroll-ca.crt" -subj "/CN=Digital Twin Agent Enrollment CA" `
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>$null
if ($LASTEXITCODE -ne 0) { throw 'openssl failed; install OpenSSL and retry.' }
& icacls.exe (Join-Path $dir 'enroll-ca.key') /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
Write-Host "Created $dir\enroll-ca.crt and enroll-ca.key. Restart ingestion to enable 'Add host' in the dashboard."
