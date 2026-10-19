[CmdletBinding()]
param([string]$DataRoot = "")
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $DataRoot) { $DataRoot = Join-Path $repoRoot "MagicBoxData\voice_clone" }
$activePath = Join-Path $DataRoot "engines\yingmusic-svc-zero-shot-v1\active.json"
if (-not (Test-Path -LiteralPath $activePath)) { throw "YingMusic active.json is missing." }
$active = Get-Content -LiteralPath $activePath -Raw | ConvertFrom-Json
$manifestPath = Join-Path (Join-Path $DataRoot "engines\yingmusic-svc-zero-shot-v1\versions") "$($active.activeVersion)\runtime-manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach ($field in @("sourceRevision", "sourceArchiveSha256", "patchedTreeHash", "checkpointSha256", "configSha256")) { if ([string]::IsNullOrWhiteSpace([string]$manifest.$field)) { throw "YingMusic manifest field '$field' is not pinned." } }
foreach ($field in @("BigVGANRevision", "WhisperRevision", "CAMPPlusHash", "RMVPEHash", "requirementsLockSha256", "torchOpenMpDllSha256")) {
  if ([string]::IsNullOrWhiteSpace([string]$manifest.$field) -or [string]$manifest.$field -eq "record-separately") { throw "YingMusic manifest field '$field' is not recorded." }
}
foreach ($field in @("sourceRoot", "runnerEntry", "checkpointPath", "configPath")) { if (-not (Test-Path -LiteralPath $manifest.$field)) { throw "YingMusic manifest path '$field' is missing." } }
if (-not (Test-Path -LiteralPath $manifest.pythonExecutable)) { throw "YingMusic isolated Python executable is missing." }
if (-not (Test-Path -LiteralPath $manifest.workerEntry)) { throw "YingMusic worker entry is missing." }
if (-not (Test-Path -LiteralPath $manifest.cacheRoot)) { throw "YingMusic isolated model cache is missing." }
if ((Get-FileHash -LiteralPath $manifest.checkpointPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne ([string]$manifest.checkpointSha256).ToLowerInvariant()) { throw "YingMusic checkpoint hash mismatch." }
if ((Get-FileHash -LiteralPath $manifest.configPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne ([string]$manifest.configSha256).ToLowerInvariant()) { throw "YingMusic config hash mismatch." }
if ((Get-FileHash -LiteralPath $manifest.requirementsLock -Algorithm SHA256).Hash.ToLowerInvariant() -ne ([string]$manifest.requirementsLockSha256).ToLowerInvariant()) { throw "YingMusic requirements lock hash mismatch." }
if ($manifest.smokeTest.passed -ne $true) { throw "YingMusic runtime was not activated by a passing model smoke test." }
Write-Output "YingMusic-SVC manifest and isolated worker boundary verified: $manifestPath"
