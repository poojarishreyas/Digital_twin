# Install and enroll the Digital Twin discovery agent on a Windows machine.
# Run in an elevated PowerShell window:
#
#   & ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing https://PLATFORM/agent/install.ps1).Content)) -Url https://PLATFORM -Token dtk_...
#
# The agent only reads this machine (services, versions, sockets, firewall rules and
# allowlisted configuration with secrets redacted). It never changes the system.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$Token = $env:TWIN_ENROLL_TOKEN,
  [switch]$AllowHttp
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this in an elevated PowerShell window (Run as administrator).'
}
if (-not $Token) { throw 'Provide -Token dtk_... from the dashboard.' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Only 64-bit Windows agents are published today.' }
$Url = $Url.TrimEnd('/')
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$installDir = Join-Path $env:ProgramFiles 'TwinAgent'
$configDir = Join-Path $env:ProgramData 'TwinAgent\config'
$exe = Join-Path $installDir 'twin-agent.exe'
$temp = Join-Path $env:TEMP ('twin-agent-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $temp, $installDir | Out-Null
try {
  Write-Host "Downloading agent from $Url ..."
  Invoke-WebRequest -UseBasicParsing -Uri "$Url/agent/twin-agent-windows-amd64.exe" -OutFile "$temp\twin-agent.exe"
  Invoke-WebRequest -UseBasicParsing -Uri "$Url/agent/SHA256SUMS" -OutFile "$temp\SHA256SUMS"
  $line = Get-Content "$temp\SHA256SUMS" | Where-Object { $_ -match '\s\*?twin-agent-windows-amd64\.exe$' } | Select-Object -First 1
  $expected = if ($line) { ($line -split '\s+')[0].ToLowerInvariant() } else { '' }
  $actual = (Get-FileHash -Algorithm SHA256 "$temp\twin-agent.exe").Hash.ToLowerInvariant()
  if (-not $expected -or $expected -ne $actual) { throw 'Checksum mismatch for the downloaded agent; nothing was installed.' }

  $service = Get-Service -Name 'TwinAgent' -ErrorAction SilentlyContinue
  if ($service -and $service.Status -ne 'Stopped') { Stop-Service TwinAgent }
  Copy-Item "$temp\twin-agent.exe" $exe -Force

  if (Test-Path (Join-Path $configDir 'config.yaml')) {
    Write-Host 'This machine is already enrolled; keeping its identity and updating the agent binary.'
  } else {
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    # Only SYSTEM and Administrators may read the private key and configuration.
    & icacls.exe $configDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
    $env:TWIN_ENROLL_TOKEN = $Token   # Keeps the token out of process listings.
    try {
      $arguments = @('enroll', '-url', $Url, '-dir', $configDir)
      if ($AllowHttp) { $arguments += '-allow-http' }
      & $exe @arguments
      if ($LASTEXITCODE -ne 0) { throw "Enrollment failed (exit $LASTEXITCODE)." }
    } finally {
      Remove-Item Env:\TWIN_ENROLL_TOKEN -ErrorAction SilentlyContinue
    }
  }

  if (-not $service) {
    $command = '"' + $exe + '" -config "' + (Join-Path $configDir 'config.yaml') + '"'
    & sc.exe create TwinAgent binPath= $command start= auto DisplayName= 'Digital Twin Passive Discovery Agent' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Service creation failed ($LASTEXITCODE)." }
    & sc.exe failure TwinAgent reset= 86400 actions= restart/5000/restart/15000/none/0 | Out-Null
    & sc.exe description TwinAgent 'Passive inventory and graph synchronization agent; performs no active probing.' | Out-Null
  }
  Start-Service TwinAgent
  Start-Sleep -Seconds 2
  if ((Get-Service TwinAgent).Status -eq 'Running') {
    Write-Host 'Done. This machine will appear in your 3D twin within a few seconds.'
  } else {
    throw 'The TwinAgent service did not start; check the Windows Event Log.'
  }
} finally {
  Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
