param(
    [string]$VoiceEngineRoot = "",
    [switch]$SkipPythonInstall,
    [switch]$SkipPackageInstall,
    [switch]$SkipModelDownload
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptRoot "..")
if (-not $VoiceEngineRoot) { $VoiceEngineRoot = Join-Path $repoRoot "voice_clone\voice_engine" }
$VoiceEngineRoot = [System.IO.Path]::GetFullPath($VoiceEngineRoot)

$conversationRoot = Join-Path $VoiceEngineRoot "conversation"
$runtimeDir = Join-Path $conversationRoot "runtime"
$pythonDir = Join-Path $runtimeDir "python"
$pythonExe = Join-Path $pythonDir "python.exe"
$downloadsDir = Join-Path $conversationRoot "downloads"
$repositoryDir = Join-Path $runtimeDir "CosyVoice"
$workerSource = Join-Path $repoRoot "server\live_voice_worker.py"
$workerTarget = Join-Path $runtimeDir "live_voice_worker.py"
$tensorRtBuilder = Join-Path $repoRoot "scripts\build-cosyvoice-tensorrt.py"
$ttsVersion = "fun-cosyvoice3-0.5b-2512-29e01c4"
$asrVersion = "whisper-large-v3-turbo-0a363e9"
$ttsModelDir = Join-Path $conversationRoot "tts\models\$ttsVersion"
$asrModelDir = Join-Path $conversationRoot "asr\models\$asrVersion"
$fallbackModelDir = Join-Path $conversationRoot "asr\models\whisper-small-536b066"
$ttsStatePath = Join-Path $conversationRoot "tts\install_state.json"
$asrStatePath = Join-Path $conversationRoot "asr\install_state.json"
$pythonInstaller = Join-Path $downloadsDir "python-3.10.11-amd64.exe"
$pythonInstallerUrl = "https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe"
$cosyRevision = "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc"
$cosyModelRevision = "29e01c4e8d000f4bcd70751be16fa94bf3d85a18"
$whisperRevision = "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"
$fallbackRevision = "536b0662742c02347bc0e980a01041f333bce120"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Write-Step([string]$Message) { Write-Host ""; Write-Host "== $Message ==" }
function Download-File([string]$Url, [string]$OutFile) {
    New-Item -ItemType Directory -Path (Split-Path $OutFile) -Force | Out-Null
    if ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 0) { return }
    & curl.exe --silent --show-error --location --fail --retry 8 --retry-delay 5 --output $OutFile $Url
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    }
    if (-not (Test-Path $OutFile) -or (Get-Item $OutFile).Length -eq 0) { throw "Download failed for $Url" }
}
function Write-ChecksumManifest([string]$Root, [string]$OutputPath) {
    $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $files = Get-ChildItem -LiteralPath $Root -File -Recurse | Where-Object {
        $_.FullName -ne $OutputPath -and $_.Name -ne ".ready.json" -and $_.FullName -notmatch '[\\/]\.cache[\\/]'
    } | Sort-Object FullName
    $entries = foreach ($file in $files) {
        $resolvedFile = [System.IO.Path]::GetFullPath($file.FullName)
        if (-not $resolvedFile.StartsWith($resolvedRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Checksum file is outside the model root: $resolvedFile"
        }
        [ordered]@{
            path = $resolvedFile.Substring($resolvedRoot.Length + 1).Replace('\', '/')
            bytes = $file.Length
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    [System.IO.File]::WriteAllText($OutputPath, (@{ files = @($entries); createdAt = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json -Depth 5), $utf8NoBom)
}

New-Item -ItemType Directory -Path $conversationRoot, $runtimeDir, $downloadsDir, $ttsModelDir, $asrModelDir, $fallbackModelDir -Force | Out-Null
$env:HF_HUB_DISABLE_XET = "1"
$env:HF_HUB_ENABLE_HF_TRANSFER = "0"
$env:HF_HUB_DOWNLOAD_TIMEOUT = "300"
$env:HF_HUB_ETAG_TIMEOUT = "60"
$env:PYTHONUTF8 = "1"

Write-Step "Preparing pinned Python 3.10.11 runtime"
if (-not (Test-Path $pythonExe)) {
    $compatiblePythonDir = @(
        (Join-Path $VoiceEngineRoot "gpt-sovits\runtime\python"),
        (Join-Path $VoiceEngineRoot "preparation\runtime\python"),
        (Join-Path $VoiceEngineRoot "seed-vc\runtime\python"),
        (Join-Path $VoiceEngineRoot "runtime\python")
    ) | Where-Object {
        $candidateExe = Join-Path $_ "python.exe"
        (Test-Path $candidateExe) -and ((& $candidateExe -c "import platform; print(platform.python_version())" 2>$null).Trim() -eq "3.10.11")
    } | Select-Object -First 1
    if ($compatiblePythonDir) {
        Write-Host "Reusing the existing pinned Python 3.10.11 runtime from $compatiblePythonDir"
        Copy-Item -LiteralPath $compatiblePythonDir -Destination $runtimeDir -Recurse -Force
    }
}
if (-not (Test-Path $pythonExe)) {
    if ($SkipPythonInstall) { throw "The pinned Python 3.10.11 runtime is missing." }
    Download-File $pythonInstallerUrl $pythonInstaller
    $install = Start-Process -FilePath $pythonInstaller -ArgumentList @(
        "/quiet", "InstallAllUsers=0", "TargetDir=$pythonDir", "Include_pip=1",
        "Include_test=0", "Include_launcher=0", "PrependPath=0", "Shortcuts=0"
    ) -Wait -PassThru
    if ($install.ExitCode -ne 0) { throw "Python 3.10.11 installer failed with exit code $($install.ExitCode)." }
}
$pythonVersion = (& $pythonExe -c "import platform; print(platform.python_version())").Trim()
if ($pythonVersion -ne "3.10.11") { throw "Streaming voice requires Python 3.10.11, found $pythonVersion." }

Write-Step "Installing the pinned local inference runtime"
if (-not $SkipPackageInstall) {
    & $pythonExe -m pip install --upgrade pip wheel "setuptools<81"
    if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed." }
    & $pythonExe -c "import sys, torch, torchaudio; sys.exit(0 if torch.cuda.is_available() else 1)"
    if ($LASTEXITCODE -ne 0) {
        & $pythonExe -m pip install --index-url https://download.pytorch.org/whl/cu121 "torch==2.4.0" "torchaudio==2.4.0"
        if ($LASTEXITCODE -ne 0) { throw "CUDA PyTorch installation failed." }
    } else {
        Write-Host "Keeping the existing verified CUDA PyTorch runtime."
    }
    & $pythonExe -m pip install "faster-whisper==1.2.1" "huggingface-hub==0.35.3" "silero-vad==6.2.0" "numpy<2.1"
    if ($LASTEXITCODE -ne 0) { throw "Streaming ASR dependencies failed to install." }
    & $pythonExe -m pip install --no-build-isolation "openai-whisper==20231117"
    if ($LASTEXITCODE -ne 0) { throw "CosyVoice mel frontend dependency failed to install." }
    & $pythonExe -m pip install "lightning==2.2.4"
    if ($LASTEXITCODE -ne 0) { throw "CosyVoice Matcha runtime dependency failed to install." }
    & $pythonExe -m pip install "gdown==5.1.0"
    if ($LASTEXITCODE -ne 0) { throw "CosyVoice Matcha utility dependency failed to install." }
    & $pythonExe -m pip install "pyarrow==18.1.0"
    if ($LASTEXITCODE -ne 0) { throw "CosyVoice configuration dependency failed to install." }
    & $pythonExe -m pip install "tensorrt-cu12==10.13.3.9"
    if ($LASTEXITCODE -ne 0) { throw "The pinned Windows TensorRT runtime failed to install." }
}

Write-Step "Checking out the pinned CosyVoice runtime"
if (-not (Test-Path (Join-Path $repositoryDir ".git"))) {
    & git clone --recursive https://github.com/QwenAudio/CosyVoice.git $repositoryDir
    if ($LASTEXITCODE -ne 0) { throw "CosyVoice repository download failed." }
}
$currentRevision = (& git -c "safe.directory=$($repositoryDir.Replace('\', '/'))" -C $repositoryDir rev-parse HEAD).Trim()
if ($currentRevision -ne $cosyRevision) {
    & git -c "safe.directory=$($repositoryDir.Replace('\', '/'))" -C $repositoryDir fetch --recurse-submodules origin $cosyRevision
    if ($LASTEXITCODE -ne 0) { throw "CosyVoice revision fetch failed." }
    & git -c "safe.directory=$($repositoryDir.Replace('\', '/'))" -C $repositoryDir checkout --detach $cosyRevision
    if ($LASTEXITCODE -ne 0) { throw "CosyVoice revision checkout failed." }
}
if (-not (Test-Path (Join-Path $repositoryDir "third_party\Matcha-TTS\.git"))) {
    & git -c "safe.directory=$($repositoryDir.Replace('\', '/'))" -C $repositoryDir submodule update --init --recursive
    if ($LASTEXITCODE -ne 0) { throw "CosyVoice submodule setup failed." }
}
if (-not $SkipPackageInstall) {
    $filteredRequirements = Join-Path $downloadsDir "cosyvoice-requirements-no-torch.txt"
    Get-Content (Join-Path $repositoryDir "requirements.txt") | Where-Object {
        $_ -notmatch '^(torch|torchaudio|fastapi|fastapi-cli|gdown|gradio|grpcio|grpcio-tools|lightning|matplotlib|modelscope|openai-whisper|pyarrow|tensorboard|uvicorn|wetext)=='
    } | Set-Content -LiteralPath $filteredRequirements -Encoding utf8
    & $pythonExe -m pip install --retries 8 --timeout 120 -r $filteredRequirements
    if ($LASTEXITCODE -ne 0) { throw "CosyVoice dependency installation failed." }
}

Copy-Item -LiteralPath $workerSource -Destination $workerTarget -Force
if ($SkipModelDownload) {
    $requiredModelFiles = @(
        (Join-Path $ttsModelDir "cosyvoice3.yaml"),
        (Join-Path $ttsModelDir "llm.pt"),
        (Join-Path $ttsModelDir "flow.pt"),
        (Join-Path $ttsModelDir "hift.pt"),
        (Join-Path $asrModelDir "model.bin"),
        (Join-Path $fallbackModelDir "model.bin")
    )
    $missingModelFiles = @($requiredModelFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
    if ($missingModelFiles.Count -gt 0) {
        throw "Streaming voice cannot be marked ready because required model files are missing: $($missingModelFiles -join ', ')"
    }
} else {
    Write-Step "Downloading pinned multilingual models"
    $downloadCode = @"
import os, shutil
from huggingface_hub import snapshot_download
snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B-2512', revision='$cosyModelRevision', local_dir=r'$ttsModelDir', ignore_patterns=['llm.rl.pt', 'flow.decoder.estimator.fp32.onnx'], max_workers=1)
snapshot_download('mobiuslabsgmbh/faster-whisper-large-v3-turbo', revision='$whisperRevision', local_dir=r'$asrModelDir', max_workers=1)
snapshot_download('Systran/faster-whisper-small', revision='$fallbackRevision', local_dir=r'$fallbackModelDir', max_workers=1)
shutil.rmtree(os.path.join(r'$ttsModelDir', '.cache'), ignore_errors=True)
shutil.rmtree(os.path.join(r'$asrModelDir', '.cache'), ignore_errors=True)
shutil.rmtree(os.path.join(r'$fallbackModelDir', '.cache'), ignore_errors=True)
"@
    & $pythonExe -c $downloadCode
    if ($LASTEXITCODE -ne 0) { throw "Pinned streaming model download failed." }
}

Write-Step "Building the validated RTX TensorRT streaming estimator"
if (-not (Test-Path -LiteralPath $tensorRtBuilder -PathType Leaf)) {
    throw "The managed TensorRT builder is missing: $tensorRtBuilder"
}
& $pythonExe $tensorRtBuilder --repository-dir $repositoryDir --model-dir $ttsModelDir
if ($LASTEXITCODE -ne 0) { throw "CosyVoice TensorRT export, validation, or engine build failed." }
$requiredTensorRtFiles = @(
    (Join-Path $ttsModelDir "flow.decoder.estimator.fp32.onnx"),
    (Join-Path $ttsModelDir "flow.decoder.estimator.fp16.mygpu.plan"),
    (Join-Path $ttsModelDir "flow.decoder.estimator.fp16.mygpu.json")
)
$missingTensorRtFiles = @($requiredTensorRtFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) -or (Get-Item -LiteralPath $_).Length -eq 0 })
if ($missingTensorRtFiles.Count -gt 0) {
    throw "The managed TensorRT streaming artifacts are incomplete: $($missingTensorRtFiles -join ', ')"
}

Remove-Item -LiteralPath (Join-Path $ttsModelDir ".cache") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $asrModelDir ".cache") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $fallbackModelDir ".cache") -Recurse -Force -ErrorAction SilentlyContinue

Write-Step "Creating offline checksum manifests"
$ttsChecksums = Join-Path $ttsModelDir "checksums.json"
$asrChecksums = Join-Path $asrModelDir "checksums.json"
$fallbackChecksums = Join-Path $fallbackModelDir "checksums.json"
Write-ChecksumManifest $ttsModelDir $ttsChecksums
Write-ChecksumManifest $asrModelDir $asrChecksums
Write-ChecksumManifest $fallbackModelDir $fallbackChecksums

$common = [ordered]@{
    installed = $true
    runtimeReady = $true
    pythonVersion = $pythonVersion
    pythonPath = $pythonExe
    workerPath = $workerTarget
    runtimeDir = $runtimeDir
    repositoryDir = $repositoryDir
    repositoryRevision = $cosyRevision
    licenseAcceptedAt = (Get-Date).ToUniversalTime().ToString("o")
    privacy = "offline-after-install"
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$ttsState = [ordered]@{
    engine = "cosyvoice3-stream-local"; modelVersion = $ttsVersion; modelRevision = $cosyModelRevision
    modelDir = $ttsModelDir; checksumManifest = $ttsChecksums; license = "Apache-2.0"
    accelerator = "TensorRT"; acceleratorVersion = "10.13.3.9"; acceleratorLicense = "NVIDIA TensorRT EULA"
} + $common
$asrState = [ordered]@{
    engine = "whisper-turbo-stream-local"; modelVersion = $asrVersion; modelRevision = $whisperRevision
    modelDir = $asrModelDir; checksumManifest = $asrChecksums; fallbackModelDir = $fallbackModelDir
    fallbackRevision = $fallbackRevision; fallbackChecksumManifest = $fallbackChecksums; license = "MIT"
} + $common
[System.IO.File]::WriteAllText($ttsStatePath, ($ttsState | ConvertTo-Json -Depth 8), $utf8NoBom)
[System.IO.File]::WriteAllText($asrStatePath, ($asrState | ConvertTo-Json -Depth 8), $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $ttsModelDir ".ready.json"), ($ttsState | ConvertTo-Json -Depth 8), $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $asrModelDir ".ready.json"), ($asrState | ConvertTo-Json -Depth 8), $utf8NoBom)

Write-Host "Unified multilingual streaming voice installed and checksum manifests created."
