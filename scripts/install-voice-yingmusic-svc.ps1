[CmdletBinding()]
param(
  [string]$DataRoot = "",
  [string]$Python = "py",
  [string]$SourceRevision = "",
  [string]$SourceArchiveSha256 = "",
  [Parameter(Mandatory=$true)][string]$PatchedTreeHash,
  [Parameter(Mandatory=$true)][string]$CheckpointSha256,
  [Parameter(Mandatory=$true)][string]$ConfigSha256,
  [Parameter(Mandatory=$true)][string]$CheckpointPath,
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [string]$TorchOpenMpDllPath = "",
  [string]$TorchOpenMpDllSha256 = "",
  [string]$SourceArchivePath = "",
  [string]$SourceArchiveUrl = "",
  [string]$WheelhousePath = "",
  [string]$SmokeInputPath = "",
  [string]$SmokeReferencePath = "",
  [string]$BigVGANRevision = "record-separately",
  [string]$WhisperRevision = "record-separately",
  [string]$CAMPPlusHash = "record-separately",
  [string]$RMVPEHash = "record-separately",
  [switch]$Offline
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $SourceRevision -or -not $SourceArchiveSha256) {
  $lock = Get-Content -LiteralPath (Join-Path $repoRoot "server\voice\vtv\runtime-locks.json") -Raw | ConvertFrom-Json
  if (-not $SourceRevision) { $SourceRevision = [string]$lock.'yingmusic-svc-zero-shot-v1'.sourceRevision }
  if (-not $SourceArchiveSha256) { $SourceArchiveSha256 = [string]$lock.'yingmusic-svc-zero-shot-v1'.sourceArchiveSha256 }
}
if ([string]$SourceArchiveSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "YingMusic source archive hash must be a 64-character SHA-256." }
if (-not $DataRoot) { $DataRoot = Join-Path $repoRoot "MagicBoxData\voice_clone" }
if (-not $TorchOpenMpDllPath) { $TorchOpenMpDllPath = Join-Path $DataRoot "asset-cache\libomp140.x86_64.dll" }
if (-not $TorchOpenMpDllSha256) {
  $lock = Get-Content -LiteralPath (Join-Path $repoRoot "server\voice\vtv\runtime-locks.json") -Raw | ConvertFrom-Json
  $TorchOpenMpDllSha256 = [string]$lock.'yingmusic-svc-zero-shot-v1'.torchOpenMpDllSha256
}
if ($TorchOpenMpDllSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "YingMusic Torch OpenMP DLL hash must be a 64-character SHA-256." }
if ($Offline -and -not $WheelhousePath) { throw "Offline YingMusic installation requires -WheelhousePath containing the dependency wheels." }
if (-not $SourceArchiveUrl) { $SourceArchiveUrl = "https://github.com/GiantAILab/YingMusic-SVC/archive/$SourceRevision.zip" }
$engineRoot = Join-Path $DataRoot "engines\yingmusic-svc-zero-shot-v1"
$cacheRoot = Join-Path $engineRoot "cache"
$version = $SourceRevision
$staging = Join-Path $engineRoot ("versions\.staging-" + [guid]::NewGuid().ToString("N"))
$archive = Join-Path $staging "yingmusic-source.zip"
$sourceRoot = Join-Path $staging "source"
$assetsRoot = Join-Path $staging "assets"
$installLog = Join-Path $engineRoot ("logs\yingmusic-install-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ") + ".jsonl")
New-Item -ItemType Directory -Force -Path (Join-Path $staging "integration"), $sourceRoot, $assetsRoot, $cacheRoot, (Join-Path $engineRoot "logs") | Out-Null
function Write-InstallLog {
  param([string]$Stage, [object]$Payload)
  $record = [ordered]@{ stage = $Stage; at = (Get-Date).ToUniversalTime().ToString("o"); payload = [string]$Payload }
  ($record | ConvertTo-Json -Compress -Depth 8) | Add-Content -LiteralPath $installLog -Encoding UTF8
}
try {
  Write-InstallLog "start" "sourceRevision=$SourceRevision staging=$staging"
  if ($SourceArchivePath) {
    Copy-Item -LiteralPath $SourceArchivePath -Destination $archive -Force
  } elseif ($Offline) {
    throw "Offline YingMusic installation requires -SourceArchivePath."
  } else {
    Invoke-WebRequest -Uri $SourceArchiveUrl -OutFile $archive -UseBasicParsing
  }
  $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $SourceArchiveSha256.ToLowerInvariant()) { throw "YingMusic source archive SHA256 mismatch. Expected $SourceArchiveSha256, got $actualHash." }
  $unpacked = Join-Path $staging "unpacked"
  Expand-Archive -LiteralPath $archive -DestinationPath $unpacked -Force
  $sourceTop = Get-ChildItem -LiteralPath $unpacked -Directory | Select-Object -First 1
  if (-not $sourceTop) { throw "YingMusic source archive did not contain a repository directory." }
  Copy-Item -Path (Join-Path $sourceTop.FullName "*") -Destination $sourceRoot -Recurse -Force
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot "my_inference.py"))) { throw "Pinned YingMusic source does not contain my_inference.py." }
  $treeRows = Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Sort-Object FullName | ForEach-Object { $relative = $_.FullName.Substring($sourceRoot.Length).TrimStart([char]92, [char]47).Replace('\\','/'); "$relative`t$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())" }
  $treeHashInput = Join-Path $staging "patched-tree-hash.input.txt"
  $treeRows -join "`n" | Set-Content -LiteralPath $treeHashInput -Encoding UTF8
  $actualPatchedTreeHash = (Get-FileHash -LiteralPath $treeHashInput -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualPatchedTreeHash -ne $PatchedTreeHash.ToLowerInvariant()) { throw "YingMusic patched tree hash mismatch. Expected $PatchedTreeHash, got $actualPatchedTreeHash." }
  $checkpointHash = (Get-FileHash -LiteralPath $CheckpointPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($checkpointHash -ne $CheckpointSha256.ToLowerInvariant()) { throw "YingMusic checkpoint SHA256 mismatch. Expected $CheckpointSha256, got $checkpointHash." }
  $configHash = (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($configHash -ne $ConfigSha256.ToLowerInvariant()) { throw "YingMusic config SHA256 mismatch. Expected $ConfigSha256, got $configHash." }
  Copy-Item -LiteralPath $CheckpointPath -Destination (Join-Path $assetsRoot "YingMusic-SVC-full.pth") -Force
  Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $assetsRoot "YingMusic-SVC.yml") -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot "server\workers\vtv_yingmusic_worker.py") -Destination (Join-Path $staging "integration\magicbox_yingmusic_worker.py") -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot "server\workers\vtv_yingmusic_runner.py") -Destination (Join-Path $staging "integration\magicbox_yingmusic_runner.py") -Force
  $pythonCommand = Get-Command $Python -ErrorAction SilentlyContinue
  if (-not $pythonCommand) { throw "Python launcher '$Python' was not found. Install Python 3.10 x64 before installing YingMusic-SVC." }
  $pythonSelector = if ([IO.Path]::GetFileName($Python) -in @("py", "py.exe")) { @("-3.10") } else { @() }
  & $Python @pythonSelector -m venv (Join-Path $staging ".venv")
  $pythonExe = Join-Path $staging ".venv\Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $pythonExe)) { throw "Python 3.10 venv creation failed." }
  $pythonHome = Split-Path -Parent (Resolve-Path $Python).Path
  $pythonLibraryBin = Join-Path $pythonHome "Library\bin"
  if (Test-Path -LiteralPath $pythonLibraryBin) { $env:MAGICBOX_YINGMUSIC_PYTHON_LIBRARY_BIN = $pythonLibraryBin; $env:PATH = "$pythonLibraryBin;$env:PATH" }
  if (-not (Test-Path -LiteralPath $TorchOpenMpDllPath)) { throw "YingMusic requires the pinned libomp140.x86_64.dll in the runtime asset bundle." }
  $actualTorchOpenMpHash = (Get-FileHash -LiteralPath $TorchOpenMpDllPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualTorchOpenMpHash -ne $TorchOpenMpDllSha256.ToLowerInvariant()) { throw "YingMusic Torch OpenMP DLL SHA256 mismatch. Expected $TorchOpenMpDllSha256, got $actualTorchOpenMpHash." }
  $torchLibraryPath = Join-Path $staging ".venv\Lib\site-packages\torch\lib"
  New-Item -ItemType Directory -Force -Path $torchLibraryPath | Out-Null
  Copy-Item -LiteralPath $TorchOpenMpDllPath -Destination (Join-Path $torchLibraryPath "libomp140.x86_64.dll") -Force
  if ($Offline) {
    & $pythonExe -m pip install --no-index --find-links $WheelhousePath --upgrade pip setuptools wheel
    & $pythonExe -m pip install --no-index --find-links $WheelhousePath torch==2.4.0+cu118 torchvision==0.19.0+cu118 torchaudio==2.4.0+cu118
  } else {
    & $pythonExe -m pip install --upgrade pip setuptools wheel
    & $pythonExe -m pip install torch==2.4.0+cu118 torchvision==0.19.0+cu118 torchaudio==2.4.0+cu118 --index-url https://download.pytorch.org/whl/cu118 --extra-index-url https://pypi.org/simple
  }
  $upstreamRequirements = Join-Path $sourceRoot "requirements.txt"
  if (-not (Test-Path -LiteralPath $upstreamRequirements)) { throw "Pinned YingMusic source is missing requirements.txt." }
  $filteredRequirements = Join-Path $staging "requirements.magicbox.in.txt"
  Get-Content -LiteralPath $upstreamRequirements | Where-Object { $_ -notmatch '^\s*(torch|torchvision|torchaudio)\b' -and $_ -notmatch '^\s*gradio\b' -and $_ -notmatch '^\s*torch\s+--pre' -and $_ -notmatch '^\s*(resemblyzer|webrtcvad)\b' } | Set-Content -LiteralPath $filteredRequirements -Encoding UTF8
  if ($Offline) { & $pythonExe -m pip install --no-index --find-links $WheelhousePath -r $filteredRequirements } else { & $pythonExe -m pip install -r $filteredRequirements }
  $lockPath = Join-Path $staging "requirements.lock.txt"
  & $pythonExe -m pip freeze | Set-Content -LiteralPath $lockPath -Encoding UTF8
  $env:MAGICBOX_YINGMUSIC_RUNTIME_READY = "1"
  $env:MAGICBOX_YINGMUSIC_SOURCE_ROOT = $sourceRoot
  $env:MAGICBOX_YINGMUSIC_RUNNER = Join-Path $staging "integration\magicbox_yingmusic_runner.py"
  $env:MAGICBOX_YINGMUSIC_CHECKPOINT = Join-Path $assetsRoot "YingMusic-SVC-full.pth"
  $env:MAGICBOX_YINGMUSIC_CONFIG = Join-Path $assetsRoot "YingMusic-SVC.yml"
  # Keep the isolated model cache outside staging so a failed smoke can be
  # retried without re-downloading multi-gigabyte model assets. The service
  # resolver uses this same per-engine cache directory after activation.
  $env:MAGICBOX_YINGMUSIC_CACHE_ROOT = $cacheRoot
  New-Item -ItemType Directory -Force -Path $env:MAGICBOX_YINGMUSIC_CACHE_ROOT | Out-Null
  $healthRequest = '{"requestId":"install-health","command":"health"}'
  $healthOutput = $healthRequest | & $pythonExe (Join-Path $staging "integration\magicbox_yingmusic_worker.py") 2>&1
  Write-InstallLog "health-output" (($healthOutput | ForEach-Object { [string]$_ }) -join "`n")
  $health = $healthOutput | Select-Object -Last 1 | ConvertFrom-Json
  if (-not $health.ready) { throw "YingMusic runtime health smoke failed: $($health | ConvertTo-Json -Compress). CUDA and all pinned runtime assets must be available before activation." }
  $smokeArgsProvided = @($SmokeInputPath, $SmokeReferencePath) | Where-Object { $_ }
  if ($smokeArgsProvided.Count -gt 0 -and $smokeArgsProvided.Count -ne 2) { throw "YingMusic smoke requires -SmokeInputPath and -SmokeReferencePath together." }
  $smokePassed = $false
  $smokeFixtureHash = ""
  $smokeOutputHash = ""
  if ($smokeArgsProvided.Count -eq 2) {
    $smokeOutput = Join-Path $staging "yingmusic-smoke-output.wav"
    $requests = @(
      (@{ requestId = "smoke-load"; command = "load_model"; model = @{ audioPath = (Resolve-Path $SmokeReferencePath).Path } } | ConvertTo-Json -Compress),
      (@{ requestId = "smoke-infer"; command = "infer"; inputPath = (Resolve-Path $SmokeInputPath).Path; outputPath = $smokeOutput; seed = 0; settings = @{ diffusionSteps = 30; cfgRate = 0.7; autoF0Adjust = $true; maxShiftSemitones = 12; fp16 = $true } } | ConvertTo-Json -Compress),
      (@{ requestId = "smoke-shutdown"; command = "shutdown" } | ConvertTo-Json -Compress)
    ) -join "`n"
    # The pinned upstream prints progress to stderr during normal model loading;
    # capture it without letting PowerShell 5.1 turn that progress into a
    # terminating NativeCommandError under the installer-wide Stop policy.
    $smokeErrorAction = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      $smokeOutputLines = $requests | & $pythonExe (Join-Path $staging "integration\magicbox_yingmusic_worker.py") 2>&1
    } finally {
      $ErrorActionPreference = $smokeErrorAction
    }
    Write-InstallLog "smoke-output" (($smokeOutputLines | ForEach-Object { [string]$_ }) -join "`n")
    $smokeResult = $smokeOutputLines | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} } | Where-Object { $_.requestId -eq "smoke-infer" } | Select-Object -Last 1
    if (-not $smokeResult.ok -or -not (Test-Path -LiteralPath $smokeOutput)) { throw "YingMusic smoke failed; runtime will not be activated." }
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
  if ($BigVGANRevision -eq "record-separately") {
    $bigVganSnapshots = Get-ChildItem -LiteralPath (Join-Path $sourceRoot "checkpoints\hf_cache\models--nvidia--bigvgan_v2_44khz_128band_512x\snapshots") -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $bigVganSnapshots) { throw "YingMusic BigVGAN checkpoint revision was not downloaded during smoke." }
    $BigVGANRevision = $bigVganSnapshots.Name
  }
  if ($WhisperRevision -eq "record-separately") {
    $whisperRef = Join-Path $env:MAGICBOX_YINGMUSIC_CACHE_ROOT "models--openai--whisper-small\refs\main"
    if (-not (Test-Path -LiteralPath $whisperRef)) { throw "YingMusic Whisper revision was not downloaded during smoke." }
    $WhisperRevision = (Get-Content -Raw -LiteralPath $whisperRef).Trim()
  }
  if ($CAMPPlusHash -eq "record-separately") {
    $campPlus = Get-ChildItem -LiteralPath (Join-Path $env:MAGICBOX_YINGMUSIC_CACHE_ROOT "models--funasr--campplus\snapshots") -Recurse -File -Filter "campplus_cn_common.bin" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $campPlus) { throw "YingMusic CAMPPlus asset was not downloaded during smoke." }
    $CAMPPlusHash = (Get-FileHash -LiteralPath $campPlus.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  if ($RMVPEHash -eq "record-separately") {
    $rmvpe = Get-ChildItem -LiteralPath (Join-Path $env:MAGICBOX_YINGMUSIC_CACHE_ROOT "models--lj1995--VoiceConversionWebUI\snapshots") -Recurse -File -Filter "rmvpe.pt" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $rmvpe) { throw "YingMusic RMVPE asset was not downloaded during smoke." }
    $RMVPEHash = (Get-FileHash -LiteralPath $rmvpe.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $smokeCompletedAt = if ($smokePassed) { (Get-Date).ToUniversalTime().ToString("o") } else { $null }
  $active = Join-Path $engineRoot "active.json"
  $finalDir = Join-Path $engineRoot "versions\$version"
  Move-Item -LiteralPath $staging -Destination $finalDir -Force
  $manifest = [ordered]@{
    schemaVersion = 1; engineId = "yingmusic-svc-zero-shot-v1"; displayName = "YingMusic-SVC"; runtimeVersion = $version
    sourceRepository = "GiantAILab/YingMusic-SVC"; sourceRevision = $SourceRevision; sourceArchiveSha256 = $SourceArchiveSha256; patchedTreeHash = $PatchedTreeHash
    sourceRoot = (Join-Path $finalDir "source"); pythonVersion = $pythonVersion; pythonExecutable = (Join-Path $finalDir ".venv\Scripts\python.exe"); pythonLibraryBin = $pythonLibraryBin; torchOpenMpDllSha256 = $TorchOpenMpDllSha256
    workerEntry = (Join-Path $finalDir "integration\magicbox_yingmusic_worker.py"); runnerEntry = (Join-Path $finalDir "integration\magicbox_yingmusic_runner.py")
    checkpointPath = (Join-Path $finalDir "assets\YingMusic-SVC-full.pth"); configPath = (Join-Path $finalDir "assets\YingMusic-SVC.yml")
    checkpointSha256 = $CheckpointSha256; configSha256 = $ConfigSha256; cacheRoot = $cacheRoot; BigVGANRevision = $BigVGANRevision; WhisperRevision = $WhisperRevision; CAMPPlusHash = $CAMPPlusHash; RMVPEHash = $RMVPEHash
    requirementsLock = (Join-Path $finalDir "requirements.lock.txt"); requirementsLockSha256 = $requirementsLockSha256; installedAt = (Get-Date).ToUniversalTime().ToString("o"); verifiedHardware = $verifiedHardware; smokeTest = @{ passed = $smokePassed; fixtureHash = $smokeFixtureHash; outputHash = $smokeOutputHash; completedAt = $smokeCompletedAt }
    license = @{ code = "MIT"; modelWeights = "record-separately" }
  }
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $finalDir "runtime-manifest.json") -Encoding UTF8
  if ($smokePassed) {
    @{ activeVersion = $version; updatedAt = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $active -Encoding UTF8
    Write-Output "YingMusic-SVC runtime installed and activated after health/model smoke."
  } else {
    Write-Output "YingMusic-SVC runtime installed but not activated: provide model smoke inputs before writing active.json."
  }
} catch {
  Write-InstallLog "failure" $_.Exception.ToString()
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  throw
} finally {
  Remove-Item Env:MAGICBOX_YINGMUSIC_RUNTIME_READY -ErrorAction SilentlyContinue
  Remove-Item Env:MAGICBOX_YINGMUSIC_SOURCE_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:MAGICBOX_YINGMUSIC_RUNNER -ErrorAction SilentlyContinue
  Remove-Item Env:MAGICBOX_YINGMUSIC_CHECKPOINT -ErrorAction SilentlyContinue
  Remove-Item Env:MAGICBOX_YINGMUSIC_CONFIG -ErrorAction SilentlyContinue
  Remove-Item Env:MAGICBOX_YINGMUSIC_CACHE_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:MAGICBOX_YINGMUSIC_PYTHON_LIBRARY_BIN -ErrorAction SilentlyContinue
}
