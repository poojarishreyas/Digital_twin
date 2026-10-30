param(
  [Parameter(Mandatory=$true)][string]$Binary,
  [Parameter(Mandatory=$true)][string]$Config
)
$ErrorActionPreference = 'Stop'
$binaryPath = (Resolve-Path -LiteralPath $Binary).Path
$configPath = (Resolve-Path -LiteralPath $Config).Path
$command = '"' + $binaryPath + '" -config "' + $configPath + '"'
if (Get-Service -Name 'TwinAgent' -ErrorAction SilentlyContinue) {
  throw 'TwinAgent already exists. Remove or update the existing service explicitly.'
}
& sc.exe create TwinAgent binPath= $command start= auto DisplayName= 'Digital Twin Passive Discovery Agent'
if ($LASTEXITCODE -ne 0) { throw "sc.exe create failed: $LASTEXITCODE" }
& sc.exe failure TwinAgent reset= 86400 actions= restart/5000/restart/15000/none/0
& sc.exe description TwinAgent 'Passive inventory and graph synchronization agent; performs no active probing.'
Start-Service TwinAgent
Get-Service TwinAgent

