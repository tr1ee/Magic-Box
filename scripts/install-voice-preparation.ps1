param(
    [string]$VoiceEngineRoot = "",
    [switch]$SkipPythonInstall,
    [switch]$SkipPackageInstall,
    [switch]$SkipModelDownload,
    [switch]$CpuOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptRoot "..")
if (-not $VoiceEngineRoot) {
    $VoiceEngineRoot = Join-Path $repoRoot "voice_clone\voice_engine"
}
$VoiceEngineRoot = [System.IO.Path]::GetFullPath($VoiceEngineRoot)

$engineRoot = Join-Path $VoiceEngineRoot "preparation"
$runtimeDir = Join-Path $engineRoot "runtime"
$pythonDir = Join-Path $runtimeDir "python"
$modelVersion = "voice-preparation-v1"
$modelDir = Join-Path $engineRoot "models\$modelVersion"
$downloadsDir = Join-Path $modelDir "downloads"
$cacheDir = Join-Path $modelDir "cache"
$pythonExe = Join-Path $pythonDir "python.exe"
$workerSource = Join-Path $repoRoot "server\voice_engine_worker_preparation.py"
$workerTarget = Join-Path $runtimeDir "voice_preparation_worker.py"
$installStatePath = Join-Path $engineRoot "install_state.json"
$readyMarkerPath = Join-Path $modelDir ".models-ready.json"
$pythonInstallerUrl = "https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe"
$pythonInstallerPath = Join-Path $downloadsDir "python-3.10.11-amd64.exe"
$cudaWheelDir = @(
    (Join-Path $VoiceEngineRoot "gpt-sovits\models\gpt-sovits-managed-v1\downloads\pytorch-cu121"),
    (Join-Path $VoiceEngineRoot "seed-vc\models\seed-vc-svc-v1\downloads\pytorch-cu121")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cudaWheelDir) {
    $cudaWheelDir = Join-Path $downloadsDir "pytorch-cu121"
}
$cudaTorchWheel = Join-Path $cudaWheelDir "torch-2.4.0+cu121-cp310-cp310-win_amd64.whl"
$cudaTorchaudioWheel = Join-Path $cudaWheelDir "torchaudio-2.4.0+cu121-cp310-cp310-win_amd64.whl"

function Write-Step($Message) {
    Write-Host ""
    Write-Host "== $Message =="
}

function Download-File($Url, $OutFile) {
    New-Item -ItemType Directory -Path (Split-Path $OutFile) -Force | Out-Null
    if ((Test-Path $OutFile) -and ((Get-Item $OutFile).Length -gt 0)) {
        Write-Host "Using existing download: $OutFile"
        return
    }
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source --silent --show-error --location --fail --retry 8 --retry-delay 5 --retry-all-errors --continue-at - --output $OutFile $Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed for $Url" }
        return
    }
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
}

function Test-TorchRuntime($PythonExe) {
    $torchCheck = & $PythonExe -c "import torch; print(torch.__version__)" 2>$null
    $torchCheckExitCode = $LASTEXITCODE
    if ($torchCheck) {
        Write-Host "PyTorch runtime: $torchCheck"
    }
    return $torchCheckExitCode -eq 0
}

function Test-CudaTorch($PythonExe) {
    $cudaCheck = & $PythonExe -c "import sys, torch; ok=bool(torch.version.cuda and torch.cuda.is_available()); print(torch.__version__, torch.version.cuda, torch.cuda.is_available()); sys.exit(0 if ok else 1)" 2>$null
    $cudaCheckExitCode = $LASTEXITCODE
    if ($cudaCheck) {
        Write-Host "PyTorch CUDA check: $cudaCheck"
    }
    return $cudaCheckExitCode -eq 0
}

function Install-CpuTorch($PythonExe) {
    $torchIndex = "https://download.pytorch.org/whl/cpu"
    & $PythonExe -m pip install --upgrade --force-reinstall --retries 8 --timeout 120 --index-url $torchIndex torch==2.4.0 torchaudio==2.4.0
    if ($LASTEXITCODE -ne 0 -or -not (Test-TorchRuntime $PythonExe)) {
        throw "CPU PyTorch install failed. Voice Preparation cannot continue without a usable local PyTorch runtime."
    }
}

New-Item -ItemType Directory -Path $engineRoot, $runtimeDir, $modelDir, $downloadsDir, $cacheDir -Force | Out-Null

Write-Step "Preparing the local Voice Preparation Python runtime"
if ($SkipPythonInstall -and -not (Test-Path $pythonExe)) {
    throw "SkipPythonInstall was set, but the managed Python runtime is missing."
}
if (-not (Test-Path $pythonExe)) {
    $sharedPython = @(
        (Join-Path $VoiceEngineRoot "runtime\python"),
        (Join-Path $VoiceEngineRoot "gpt-sovits\runtime\python"),
        (Join-Path $VoiceEngineRoot "seed-vc\runtime\python")
    ) | Where-Object { Test-Path (Join-Path $_ "python.exe") } | Select-Object -First 1
    if ($sharedPython) {
        Copy-Item -LiteralPath $sharedPython -Destination $runtimeDir -Recurse -Force
    }
}
if (-not (Test-Path $pythonExe)) {
    Download-File $pythonInstallerUrl $pythonInstallerPath
    $process = Start-Process -FilePath $pythonInstallerPath -ArgumentList @(
        "/quiet", "InstallAllUsers=0", "TargetDir=$pythonDir", "Include_pip=1",
        "Include_test=0", "Include_launcher=0", "PrependPath=0", "Shortcuts=0"
    ) -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Python installer failed with exit code $($process.ExitCode)." }
}
if (-not (Test-Path $pythonExe)) { throw "Managed Python was not installed at $pythonExe." }
& $pythonExe --version

Write-Step "Copying the local Voice Preparation worker"
if (-not (Test-Path $workerSource)) { throw "Voice Preparation worker source is missing: $workerSource" }
Copy-Item -LiteralPath $workerSource -Destination $workerTarget -Force

$env:MAGIC_BOX_VOICE_ENGINE_MODEL_DIR = $modelDir
$env:MAGIC_BOX_FFMPEG_PATH = $env:MAGIC_BOX_FFMPEG_PATH
$env:HF_HOME = Join-Path $cacheDir "huggingface"
$env:HF_HUB_CACHE = Join-Path $env:HF_HOME "hub"
$env:TRANSFORMERS_CACHE = Join-Path $env:HF_HOME "transformers"
$env:TORCH_HOME = Join-Path $cacheDir "torch"
$env:PYTHONUTF8 = "1"
# CTranslate2 and ONNX Runtime load separate OpenMP runtimes on some Windows
# builds. The preparation worker applies the same process-local compatibility
# setting before running VAD or transcription.
$env:KMP_DUPLICATE_LIB_OK = "TRUE"
New-Item -ItemType Directory -Path $env:HF_HOME, $env:HF_HUB_CACHE, $env:TRANSFORMERS_CACHE, $env:TORCH_HOME -Force | Out-Null

Write-Step "Installing local separation and speech-review dependencies"
$hasNvidiaGpu = $false
$cudaFallbackUsed = $false
$setupWarnings = @()
if (-not $SkipPackageInstall) {
    & $pythonExe -m pip install --upgrade pip wheel "setuptools<81"
    if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed." }
    $hasNvidiaGpu = (-not $CpuOnly) -and ($null -ne (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue))
    $torchReady = Test-TorchRuntime $pythonExe
    if ($CpuOnly) {
        Write-Host "CpuOnly was requested; installing the managed CPU PyTorch runtime."
        Install-CpuTorch $pythonExe
    } elseif ($hasNvidiaGpu) {
        if (-not (Test-CudaTorch $pythonExe)) {
            Write-Step "Upgrading Voice Preparation to CUDA PyTorch"
            $cudaInstallError = ""
            try {
                if ((Test-Path $cudaTorchWheel) -and (Test-Path $cudaTorchaudioWheel)) {
                    Write-Host "Reusing cached CUDA PyTorch wheels from $cudaWheelDir"
                    & $pythonExe -m pip install --upgrade --force-reinstall --no-deps $cudaTorchWheel $cudaTorchaudioWheel
                } else {
                    & $pythonExe -m pip install --upgrade --force-reinstall --retries 8 --timeout 120 --index-url https://download.pytorch.org/whl/cu121 torch==2.4.0 torchaudio==2.4.0
                }
                if ($LASTEXITCODE -ne 0 -or -not (Test-CudaTorch $pythonExe)) {
                    $cudaInstallError = "CUDA PyTorch did not pass its local availability check."
                }
            } catch {
                $cudaInstallError = $_.Exception.Message
            }
            if ($cudaInstallError) {
                $cudaFallbackUsed = $true
                $setupWarnings += "CUDA setup was unavailable ($cudaInstallError). Voice Preparation was installed with the slower CPU fallback."
                Write-Warning "CUDA PyTorch could not be used. Continuing with the CPU fallback instead."
                if (-not (Test-TorchRuntime $pythonExe)) {
                    Install-CpuTorch $pythonExe
                } else {
                    Write-Host "Keeping the existing usable PyTorch runtime for CPU fallback."
                }
            }
        }
    } elseif (-not $torchReady) {
        Write-Host "No NVIDIA GPU was detected; installing CPU PyTorch for Voice Preparation."
        Install-CpuTorch $pythonExe
    }
    & $pythonExe -m pip install --retries 8 --timeout 120 "demucs==4.0.1" "faster-whisper>=1.1,<2" "pypinyin>=0.50,<1" "cn2an>=0.5.22,<1" numpy
    if ($LASTEXITCODE -ne 0) { throw "Voice Preparation dependency install failed." }
}

if ($SkipModelDownload) {
    Remove-Item -LiteralPath $readyMarkerPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $modelDir ".ready.json") -Force -ErrorAction SilentlyContinue
    $incompleteState = [ordered]@{
        engine = "voice-preparation-local"
        modelVersion = $modelVersion
        installed = $false
        runtimeReady = $true
        separationReady = $false
        asrReady = $false
        modelsReady = $false
        workerSource = "managed"
        pythonPath = $pythonExe
        workerPath = $workerTarget
        modelDir = $modelDir
        runtimeDir = $runtimeDir
        cacheDir = $cacheDir
        warnings = @("Model download was skipped. Voice Preparation remains unavailable until Demucs and faster-whisper models are downloaded and verified.")
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($installStatePath, ($incompleteState | ConvertTo-Json -Depth 8), $utf8NoBom)
    Write-Host "Voice Preparation dependencies are present, but model download was skipped. Run setup again without -SkipModelDownload before preparing sources."
    exit 0
}

Write-Step "Downloading local separation and ASR models"
& $pythonExe -c "from demucs.pretrained import get_model; get_model('htdemucs'); print('Demucs htdemucs ready')"
if ($LASTEXITCODE -ne 0) { throw "Demucs model download failed." }
& $pythonExe -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8', download_root=r'$cacheDir\faster-whisper'); print('faster-whisper small ready')"
if ($LASTEXITCODE -ne 0) { throw "faster-whisper model download failed." }

$marker = [ordered]@{
    engine = "voice-preparation-local"
    modelVersion = $modelVersion
    modelsReady = $true
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($readyMarkerPath, ($marker | ConvertTo-Json -Depth 6), $utf8NoBom)

Write-Step "Checking local Voice Preparation health"
$healthRequest = @{ id = "health"; action = "health"; engine = "voice-preparation-local"; modelDir = $modelDir } | ConvertTo-Json -Compress
$healthOutput = $healthRequest | & $pythonExe $workerTarget
if ($LASTEXITCODE -ne 0 -or -not ($healthOutput -match '"ok":\s*true')) {
    Remove-Item -LiteralPath $readyMarkerPath -Force -ErrorAction SilentlyContinue
    throw "Voice Preparation worker health check failed."
}
$healthResponse = $healthOutput | Select-Object -Last 1 | ConvertFrom-Json
if (-not $healthResponse.ok -or -not $healthResponse.result.runtimeReady -or -not $healthResponse.result.separationReady -or -not $healthResponse.result.asrReady -or -not $healthResponse.result.modelsReady) {
    Remove-Item -LiteralPath $readyMarkerPath -Force -ErrorAction SilentlyContinue
    throw "Voice Preparation worker is not ready after setup."
}

$state = [ordered]@{
    engine = "voice-preparation-local"
    modelVersion = $modelVersion
    installed = $true
    runtimeReady = [bool]$healthResponse.result.runtimeReady
    separationReady = [bool]$healthResponse.result.separationReady
    asrReady = [bool]$healthResponse.result.asrReady
    modelsReady = [bool]$healthResponse.result.modelsReady
    device = [string]$healthResponse.result.device
    gpuAvailable = [bool]$healthResponse.result.gpuAvailable
    gpuName = [string]$healthResponse.result.gpuName
    torchVersion = [string]$healthResponse.result.torchVersion
    cudaFallbackUsed = [bool]$cudaFallbackUsed
    workerSource = "managed"
    pythonPath = $pythonExe
    workerPath = $workerTarget
    modelDir = $modelDir
    runtimeDir = $runtimeDir
    cacheDir = $cacheDir
    source = "facebookresearch/demucs + SYSTRAN/faster-whisper"
    license = "MIT"
    warnings = @("All separation and transcription run locally. Original profile sources are retained and never used as a preparation fallback.") + $setupWarnings
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
}
[System.IO.File]::WriteAllText($installStatePath, ($state | ConvertTo-Json -Depth 8), $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $modelDir ".ready.json"), ($state | ConvertTo-Json -Depth 8), $utf8NoBom)

Write-Host "Voice Preparation is ready under $engineRoot"
