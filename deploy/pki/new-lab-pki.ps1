$ErrorActionPreference = 'Stop'
$certDir = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'certs'
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
function Invoke-OpenSSL([string[]]$opensslArgs) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & openssl @opensslArgs 2>$null | Out-Null }
  finally { $ErrorActionPreference = $previousPreference }
  if ($LASTEXITCODE -ne 0) { throw "OpenSSL failed while creating lab certificates (exit $LASTEXITCODE)" }
}
Invoke-OpenSSL @('req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '365', '-keyout', "$certDir/ca.key", '-out', "$certDir/ca.crt", '-subj', '/CN=Digital Twin Lab CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', 'subjectKeyIdentifier=hash')
Invoke-OpenSSL @('req', '-newkey', 'rsa:3072', '-nodes', '-keyout', "$certDir/server.key", '-out', "$certDir/server.csr", '-subj', '/CN=ingestion.local')
@('subjectAltName=DNS:ingestion.local,DNS:localhost,IP:127.0.0.1', 'extendedKeyUsage=serverAuth', 'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment', 'subjectKeyIdentifier=hash', 'authorityKeyIdentifier=keyid,issuer') | Set-Content "$certDir/server.ext"
Invoke-OpenSSL @('x509', '-req', '-in', "$certDir/server.csr", '-CA', "$certDir/ca.crt", '-CAkey', "$certDir/ca.key", '-CAcreateserial', '-days', '365', '-extfile', "$certDir/server.ext", '-out', "$certDir/server.crt")
function New-AgentCertificate([string]$name) {
  $bytes = New-Object byte[] 16
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $agentId = [System.BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
  [System.IO.File]::WriteAllText((Join-Path $certDir "$name.id"), $agentId)
  Invoke-OpenSSL @('req', '-newkey', 'rsa:3072', '-nodes', '-keyout', "$certDir/$name.key", '-out', "$certDir/$name.csr", '-subj', "/CN=$agentId")
  @('extendedKeyUsage=clientAuth', 'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', 'subjectKeyIdentifier=hash', 'authorityKeyIdentifier=keyid,issuer') | Set-Content "$certDir/$name.ext"
  Invoke-OpenSSL @('x509', '-req', '-in', "$certDir/$name.csr", '-CA', "$certDir/ca.crt", '-CAkey', "$certDir/ca.key", '-CAcreateserial', '-days', '365', '-extfile', "$certDir/$name.ext", '-out', "$certDir/$name.crt")
}
New-AgentCertificate 'agent'
New-AgentCertificate 'agent-linux'
Remove-Item "$certDir/*.csr", "$certDir/*.ext", "$certDir/*.srl" -Force -ErrorAction SilentlyContinue
Write-Host "Lab certificates created in $certDir"

