[CmdletBinding()]
param(
  [string]$DataRoot = "",
  [string]$Python = "py",
  [string]$SourceArchiveSha256 = "",
  [string]$SourceArchivePath = "",
  [string]$SourceArchiveUrl = "",
  [string]$AssetCachePath = "",
  [string]$WheelhousePath = "",
  [string]$SmokeModelPath = "",
  [string]$SmokeIndexPath = "",
  [string]$SmokeInputPath = "",
  [switch]$Offline
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$lock = Get-Content -LiteralPath (Join-Path $repoRoot "server\voice\vtv\runtime-locks.json") -Raw | ConvertFrom-Json
if (-not $SourceArchiveSha256 -or -not $SourceArchiveUrl) {
  if (-not $SourceArchiveSha256) { $SourceArchiveSha256 = [string]$lock.'rvc-v2-finetuned'.sourceArchiveSha256 }
  if (-not $SourceArchiveUrl) { $SourceArchiveUrl = [string]$lock.'rvc-v2-finetuned'.sourceArchiveUrl }
}
if ([string]$SourceArchiveSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "RVC source archive hash must be a 64-character SHA-256." }
if (-not $DataRoot) { $DataRoot = Join-Path $repoRoot "MagicBoxData\voice_clone" }
if ($Offline -and -not $WheelhousePath) { throw "Offline RVC installation requires -WheelhousePath containing the dependency wheels." }
if (-not $AssetCachePath) { $AssetCachePath = Join-Path $DataRoot "asset-cache\rvc-v2-model-assets" }
$rvcLock = $lock.'rvc-v2-finetuned'
if ([string]$rvcLock.patchedTreeHash -notmatch '^[0-9a-fA-F]{64}$') { throw "RVC patched tree hash is not pinned in runtime-locks.json." }
if (-not (Test-Path -LiteralPath $AssetCachePath)) { throw "RVC model asset cache is missing: $AssetCachePath" }
$engineRoot = Join-Path $DataRoot "engines\rvc-v2-finetuned"
$version = "2.3.260718-8f2fdbf"
$staging = Join-Path $engineRoot ("versions\.staging-" + [guid]::NewGuid().ToString("N"))
$archive = Join-Path $staging "rvc-source.zip"
$sourceRoot = Join-Path $staging "source"
$worker = Join-Path $repoRoot "server\workers\vtv_rvc_worker.py"
New-Item -ItemType Directory -Force -Path (Join-Path $staging "integration"), $sourceRoot, (Join-Path $engineRoot "logs") | Out-Null
try {
  if ($SourceArchivePath) {
    Copy-Item -LiteralPath $SourceArchivePath -Destination $archive -Force
  } elseif ($Offline) {
    throw "Offline RVC installation requires -SourceArchivePath."
  } else {
    Invoke-WebRequest -Uri $SourceArchiveUrl -OutFile $archive -UseBasicParsing
  }
  $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $SourceArchiveSha256.ToLowerInvariant()) { throw "RVC source archive SHA256 mismatch. Expected $SourceArchiveSha256, got $actualHash." }
  $unpacked = Join-Path $staging "unpacked"
  Expand-Archive -LiteralPath $archive -DestinationPath $unpacked -Force
  $sourceTop = Get-ChildItem -LiteralPath $unpacked -Directory | Select-Object -First 1
  if (-not $sourceTop) { throw "RVC source archive did not contain a repository directory." }
  Copy-Item -Path (Join-Path $sourceTop.FullName "*") -Destination $sourceRoot -Recurse -Force
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot "infer\vc\modules.py"))) { throw "Pinned RVC source does not contain infer/vc/modules.py." }
  $patchPath = Join-Path $repoRoot "server\voice\vtv\engines\rvc-v2\patches\infer-audio.py"
  if (-not (Test-Path -LiteralPath $patchPath)) { throw "MagicBox RVC audio-loader patch is missing." }
  Copy-Item -LiteralPath $patchPath -Destination (Join-Path $sourceRoot "infer\audio.py") -Force
  $treeRows = Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Where-Object { $_.FullName -notlike ((Join-Path $sourceRoot "assets") + "\*") -and $_.FullName -notlike ((Join-Path $sourceRoot "logs") + "\*") -and $_.FullName -notmatch '\\__pycache__\\' -and $_.Extension -ne '.pyc' } | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($sourceRoot.Length).TrimStart([char]92, [char]47)
    "$relative`t$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
  }
  $treeHashInput = Join-Path $staging "patched-tree-hash.input.txt"
  [IO.File]::WriteAllText($treeHashInput, (($treeRows -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
  $patchedTreeHash = (Get-FileHash -LiteralPath $treeHashInput -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($patchedTreeHash -ne ([string]$rvcLock.patchedTreeHash).ToLowerInvariant()) { throw "RVC patched tree hash mismatch. Expected $($rvcLock.patchedTreeHash), got $patchedTreeHash." }
  $assetSpecs = @(
    @{ relative = "hubert_base\config.json"; sha256 = [string]$rvcLock.assets.hubertConfigSha256 },
    @{ relative = "hubert_base\preprocessor_config.json"; sha256 = [string]$rvcLock.assets.hubertPreprocessorSha256 },
    @{ relative = "hubert_base\pytorch_model.bin"; sha256 = [string]$rvcLock.assets.hubertModelSha256 },
    @{ relative = "rmvpe\rmvpe.pt"; sha256 = [string]$rvcLock.assets.rmvpeSha256; cacheRelative = "rmvpe.pt" },
    @{ relative = "pretrained_v2\f0G48k.pth"; sha256 = [string]$rvcLock.assets.pretrainedF0GSha256 },
    @{ relative = "pretrained_v2\f0D48k.pth"; sha256 = [string]$rvcLock.assets.pretrainedF0DSha256 }
  )
  foreach ($asset in $assetSpecs) {
    if ([string]$asset.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "RVC asset hash is not pinned for $($asset.relative)." }
    $cacheRelative = if ($asset.cacheRelative) { [string]$asset.cacheRelative } else { [string]$asset.relative }
    $assetSource = Join-Path $AssetCachePath $cacheRelative
    if (-not (Test-Path -LiteralPath $assetSource)) { throw "RVC model asset is missing from cache: $assetSource" }
    $assetHash = (Get-FileHash -LiteralPath $assetSource -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($assetHash -ne $asset.sha256.ToLowerInvariant()) { throw "RVC model asset SHA256 mismatch for $($asset.relative). Expected $($asset.sha256), got $assetHash." }
    $assetDestination = Join-Path $sourceRoot (Join-Path "assets" $asset.relative)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $assetDestination) | Out-Null
    Copy-Item -LiteralPath $assetSource -Destination $assetDestination -Force
  }
  Copy-Item -LiteralPath $worker -Destination (Join-Path $staging "integration\magicbox_rvc_worker.py") -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot "server\workers\vtv_rvc_runner.py") -Destination (Join-Path $staging "integration\magicbox_rvc_runner.py") -Force
  $pythonCommand = Get-Command $Python -ErrorAction SilentlyContinue
  if (-not $pythonCommand) { throw "Python launcher '$Python' was not found. Install Python 3.12 x64 before installing RVC v2." }
  $pythonSelector = if ([IO.Path]::GetFileName($Python) -in @("py", "py.exe")) { @("-3.12") } else { @() }
  & $Python @pythonSelector -m venv (Join-Path $staging ".venv")
  $pythonExe = Join-Path $staging ".venv\Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $pythonExe)) { throw "Python 3.12 venv creation failed." }
  if ($Offline) {
    & $pythonExe -m pip install --no-index --find-links $WheelhousePath --upgrade pip setuptools wheel
    & $pythonExe -m pip install --no-index --find-links $WheelhousePath torch==2.7.1+cu118 torchaudio==2.7.1+cu118
  } else {
    & $pythonExe -m pip install --upgrade pip setuptools wheel
    & $pythonExe -m pip install torch==2.7.1+cu118 torchaudio==2.7.1+cu118 --index-url https://download.pytorch.org/whl/cu118 --extra-index-url https://pypi.org/simple
  }
  $requirements = Join-Path $sourceRoot "requirments_cu118_py312.txt"
  if (-not (Test-Path -LiteralPath $requirements)) { throw "Pinned RVC source is missing requirments_cu118_py312.txt; do not install an unverified dependency set." }
  $runtimeRequirements = Join-Path $staging "requirements.magicbox.in.txt"
  $webOnlyPackages = '^\s*(gradio|altair|anyio|fastapi|httpx|markdown-it-py|mdit-py-plugins|pydantic|pyparsing|starlette|uvicorn|websockets)\b'
  Get-Content -LiteralPath $requirements | Where-Object { $_ -notmatch $webOnlyPackages } | Set-Content -LiteralPath $runtimeRequirements -Encoding UTF8
  if ($Offline) { & $pythonExe -m pip install --no-index --find-links $WheelhousePath -r $runtimeRequirements } else { & $pythonExe -m pip install -r $runtimeRequirements }
  $lockPath = Join-Path $staging "requirements.lock.txt"
  & $pythonExe -m pip freeze | Set-Content -LiteralPath $lockPath -Encoding UTF8
  $env:MAGICBOX_RVC_RUNTIME_READY = "1"
  $env:MAGICBOX_RVC_SOURCE_ROOT = $sourceRoot
  $env:MAGICBOX_RVC_RUNNER = Join-Path $staging "integration\magicbox_rvc_runner.py"
  $healthRequest = '{"requestId":"install-health","command":"health"}'
  $healthOutput = $healthRequest | & $pythonExe (Join-Path $staging "integration\magicbox_rvc_worker.py")
  $health = $healthOutput | Select-Object -Last 1 | ConvertFrom-Json
  if (-not $health.ready) { throw "RVC runtime health smoke failed. CUDA and pinned source must be available before activation." }
  $smokeArgsProvided = @($SmokeModelPath, $SmokeIndexPath, $SmokeInputPath) | Where-Object { $_ }
  if ($smokeArgsProvided.Count -gt 0 -and $smokeArgsProvided.Count -ne 3) { throw "RVC smoke requires -SmokeModelPath, -SmokeIndexPath and -SmokeInputPath together." }
  $smokePassed = $false
  $smokeFixtureHash = ""
  $smokeOutputHash = ""
  if ($smokeArgsProvided.Count -eq 3) {
    $smokeOutput = Join-Path $staging "rvc-smoke-output.wav"
    $requests = @(
      (@{ requestId = "smoke-load"; command = "load_model"; model = @{ modelPath = (Resolve-Path $SmokeModelPath).Path; indexPath = (Resolve-Path $SmokeIndexPath).Path } } | ConvertTo-Json -Compress),
      (@{ requestId = "smoke-infer"; command = "infer"; inputPath = (Resolve-Path $SmokeInputPath).Path; outputPath = $smokeOutput; settings = @{ f0Method = "rmvpe"; indexRate = 0.65; rmsMixRate = 0.25; protect = 0.33; pitchShiftSemitones = 0 } } | ConvertTo-Json -Compress),
      (@{ requestId = "smoke-shutdown"; command = "shutdown" } | ConvertTo-Json -Compress)
    ) -join "`n"
    $smokeOutputLines = $requests | & $pythonExe (Join-Path $staging "integration\magicbox_rvc_worker.py")
    $smokeResult = $smokeOutputLines | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} } | Where-Object { $_.requestId -eq "smoke-infer" } | Select-Object -Last 1
    if (-not $smokeResult.ok -or -not (Test-Path -LiteralPath $smokeOutput)) { throw "RVC model smoke failed; runtime will not be activated." }
    $smokePassed = $true
    $smokeFixtureHash = (Get-FileHash -LiteralPath $SmokeInputPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $smokeOutputHash = (Get-FileHash -LiteralPath $smokeOutput -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $pythonVersion = (& $pythonExe --version 2>&1).ToString().Replace("Python ", "").Trim()
  $requirementsLockSha256 = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $verifiedHardware = @{}
  try {
    $gpuRow = (& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1).ToString().Trim()
    if ($gpuRow) {
      $gpuParts = $gpuRow -split ',' | ForEach-Object { $_.Trim() }
      $verifiedHardware = @{ gpuName = $gpuParts[0]; vramMiB = [int]$gpuParts[1] }
    }
  } catch { $verifiedHardware = @{} }
  $smokeCompletedAt = if ($smokePassed) { (Get-Date).ToUniversalTime().ToString("o") } else { $null }
  $active = Join-Path $engineRoot "active.json"
  $finalDir = Join-Path $engineRoot "versions\$version"
  if (Test-Path -LiteralPath $finalDir) {
    $previousDir = Join-Path $engineRoot ("versions\.previous-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ"))
    Move-Item -LiteralPath $finalDir -Destination $previousDir -Force
  }
  Move-Item -LiteralPath $staging -Destination $finalDir -Force
  $manifest = [ordered]@{
    schemaVersion = 1; engineId = "rvc-v2-finetuned"; displayName = "RVC v2"; runtimeVersion = $version
    sourceRepository = "RVC-Project/Retrieval-based-Voice-Conversion-WebUI"; sourceRevision = "8f2fdbf"; sourceArchiveSha256 = $SourceArchiveSha256; patchedTreeHash = $patchedTreeHash; patchSha256 = (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash.ToLowerInvariant()
    sourceRoot = (Join-Path $finalDir "source"); pythonVersion = $pythonVersion
    pythonExecutable = (Join-Path $finalDir ".venv\Scripts\python.exe"); torchVersion = "2.7.1+cu118"; torchaudioVersion = "2.7.1+cu118"; cudaRuntime = "11.8"
    workerEntry = (Join-Path $finalDir "integration\magicbox_rvc_worker.py"); runnerEntry = (Join-Path $finalDir "integration\magicbox_rvc_runner.py"); requirementsLock = (Join-Path $finalDir "requirements.lock.txt"); requirementsLockSha256 = $requirementsLockSha256
    assets = @{ hubertConfigSha256 = [string]$rvcLock.assets.hubertConfigSha256; hubertPreprocessorSha256 = [string]$rvcLock.assets.hubertPreprocessorSha256; hubertModelSha256 = [string]$rvcLock.assets.hubertModelSha256; rmvpeSha256 = [string]$rvcLock.assets.rmvpeSha256; pretrainedF0GSha256 = [string]$rvcLock.assets.pretrainedF0GSha256; pretrainedF0DSha256 = [string]$rvcLock.assets.pretrainedF0DSha256 }
    installedAt = (Get-Date).ToUniversalTime().ToString("o"); verifiedHardware = $verifiedHardware; smokeTest = @{ passed = $smokePassed; fixtureHash = $smokeFixtureHash; outputHash = $smokeOutputHash; completedAt = $smokeCompletedAt }
    license = @{ code = "MIT"; modelWeights = "record-separately" }
  }
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $finalDir "runtime-manifest.json") -Encoding UTF8
  if ($smokePassed) {
    @{ activeVersion = $version; updatedAt = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $active -Encoding UTF8
    Write-Output "RVC v2 runtime installed and activated after health/model smoke."
  } else {
    Write-Output "RVC v2 runtime installed but not activated: provide model smoke inputs before writing active.json."
  }
} catch {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  throw
} finally {
  Remove-Item Env:MAGICBOX_RVC_RUNTIME_READY -ErrorAction SilentlyContinue
  Remove-Item Env:MAGICBOX_RVC_SOURCE_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:MAGICBOX_RVC_RUNNER -ErrorAction SilentlyContinue
}
