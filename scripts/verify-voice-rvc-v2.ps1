[CmdletBinding()]
param([string]$DataRoot = "")
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $DataRoot) { $DataRoot = Join-Path $repoRoot "MagicBoxData\voice_clone" }
$lock = Get-Content -LiteralPath (Join-Path $repoRoot "server\voice\vtv\runtime-locks.json") -Raw | ConvertFrom-Json
$rvcLock = $lock.'rvc-v2-finetuned'
$activePath = Join-Path $DataRoot "engines\rvc-v2-finetuned\active.json"
if (-not (Test-Path -LiteralPath $activePath)) { throw "RVC v2 active.json is missing." }
$active = Get-Content -LiteralPath $activePath -Raw | ConvertFrom-Json
$manifestPath = Join-Path (Join-Path $DataRoot "engines\rvc-v2-finetuned\versions") "$($active.activeVersion)\runtime-manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.sourceRevision -ne "8f2fdbf") { throw "RVC v2 source revision is not pinned to 8f2fdbf." }
if ($manifest.runtimeVersion -ne "2.3.260718-8f2fdbf") { throw "RVC v2 runtime version is not pinned." }
if ([string]$manifest.sourceArchiveSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "RVC v2 source archive hash is not pinned." }
if ([string]$manifest.patchedTreeHash -notmatch '^[0-9a-fA-F]{64}$' -or $manifest.patchedTreeHash -ne $rvcLock.patchedTreeHash) { throw "RVC v2 patched tree hash is not pinned to the runtime lock." }
if (-not (Test-Path -LiteralPath $manifest.sourceRoot)) { throw "RVC v2 pinned source tree is missing." }
if (-not (Test-Path -LiteralPath $manifest.pythonExecutable)) { throw "RVC v2 isolated Python executable is missing." }
if (-not (Test-Path -LiteralPath $manifest.workerEntry)) { throw "RVC v2 worker entry is missing." }
if (-not (Test-Path -LiteralPath $manifest.runnerEntry)) { throw "RVC v2 runner entry is missing." }
if (-not (Test-Path -LiteralPath $manifest.requirementsLock)) { throw "RVC v2 requirements lock is missing." }
if ((Get-FileHash -LiteralPath $manifest.requirementsLock -Algorithm SHA256).Hash.ToLowerInvariant() -ne ([string]$manifest.requirementsLockSha256).ToLowerInvariant()) { throw "RVC v2 requirements lock hash mismatch." }
$treeRows = Get-ChildItem -LiteralPath $manifest.sourceRoot -Recurse -File | Where-Object { $_.FullName -notlike ((Join-Path $manifest.sourceRoot "assets") + "\*") -and $_.FullName -notlike ((Join-Path $manifest.sourceRoot "logs") + "\*") -and $_.FullName -notmatch '\\__pycache__\\' -and $_.Extension -ne '.pyc' } | Sort-Object FullName | ForEach-Object {
  $relative = $_.FullName.Substring($manifest.sourceRoot.Length).TrimStart([char]92, [char]47)
  "$relative`t$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
}
$treeHashInput = Join-Path ([IO.Path]::GetTempPath()) ("rvc-tree-" + [guid]::NewGuid().ToString("N") + ".txt")
try {
  [IO.File]::WriteAllText($treeHashInput, (($treeRows -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
  $actualTreeHash = (Get-FileHash -LiteralPath $treeHashInput -Algorithm SHA256).Hash.ToLowerInvariant()
} finally {
  Remove-Item -LiteralPath $treeHashInput -Force -ErrorAction SilentlyContinue
}
if ($actualTreeHash -ne $manifest.patchedTreeHash) { throw "RVC v2 patched source tree hash mismatch. Expected $($manifest.patchedTreeHash), got $actualTreeHash." }
$assetPaths = @(
  @{ relative = "hubert_base\config.json"; sha256 = [string]$manifest.assets.hubertConfigSha256 },
  @{ relative = "hubert_base\preprocessor_config.json"; sha256 = [string]$manifest.assets.hubertPreprocessorSha256 },
  @{ relative = "hubert_base\pytorch_model.bin"; sha256 = [string]$manifest.assets.hubertModelSha256 },
  @{ relative = "rmvpe\rmvpe.pt"; sha256 = [string]$manifest.assets.rmvpeSha256 },
  @{ relative = "pretrained_v2\f0G48k.pth"; sha256 = [string]$manifest.assets.pretrainedF0GSha256 },
  @{ relative = "pretrained_v2\f0D48k.pth"; sha256 = [string]$manifest.assets.pretrainedF0DSha256 }
)
foreach ($asset in $assetPaths) {
  $assetPath = Join-Path $manifest.sourceRoot (Join-Path "assets" $asset.relative)
  if (-not (Test-Path -LiteralPath $assetPath)) { throw "RVC v2 model asset is missing: $assetPath" }
  if ((Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.sha256.ToLowerInvariant()) { throw "RVC v2 model asset hash mismatch: $assetPath" }
}
if ($manifest.smokeTest.passed -ne $true) { throw "RVC v2 runtime was not activated by a passing model smoke test." }
Write-Output "RVC v2 manifest and isolated worker boundary verified: $manifestPath"
