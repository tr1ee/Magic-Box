param(
    [string]$VoiceEngineRoot = "",
    [switch]$SkipPythonInstall,
    [switch]$SkipPackageInstall,
    [switch]$SkipModelDownload,
    [switch]$CpuOnly,
    [switch]$CudaRepair,
    [switch]$AllowCpuFallback,
    [string]$SeedVcCommit = "51383efd921027683c89e5348211d93ff12ac2a8"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptRoot "..")
if (-not $VoiceEngineRoot) {
    $VoiceEngineRoot = Join-Path $repoRoot "voice_clone\voice_engine"
}
$VoiceEngineRoot = [System.IO.Path]::GetFullPath($VoiceEngineRoot)

$engineRoot = Join-Path $VoiceEngineRoot "seed-vc"
$runtimeDir = Join-Path $engineRoot "runtime"
$pythonDir = Join-Path $runtimeDir "python"
$seedRepoDir = Join-Path $runtimeDir "seed-vc"
$modelVersion = "seed-vc-svc-v1"
$modelDir = Join-Path $engineRoot "models\$modelVersion"
$downloadsDir = Join-Path $modelDir "downloads"
$pythonExe = Join-Path $pythonDir "python.exe"
$siblingPythonDir = Join-Path $VoiceEngineRoot "runtime\python"
$workerSource = Join-Path $repoRoot "server\voice_engine_worker_seed_vc.py"
$workerTarget = Join-Path $runtimeDir "seed_vc_worker.py"
$inferenceWrapperSource = Join-Path $repoRoot "server\seed_vc_inference_wrapper.py"
$inferenceWrapperTarget = Join-Path $runtimeDir "seed_vc_inference_wrapper.py"
$installStatePath = Join-Path $engineRoot "install_state.json"
$safeSeedRepoDir = $seedRepoDir.Replace("\", "/")
$pythonInstallerUrl = "https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe"
$pythonInstallerPath = Join-Path $downloadsDir "python-3.10.11-amd64.exe"
$seedRepoZipUrl = "https://github.com/Plachtaa/seed-vc/archive/$SeedVcCommit.zip"
$seedRepoZipPath = Join-Path $downloadsDir "seed-vc-$SeedVcCommit.zip"
$cudaWheelDir = Join-Path $downloadsDir "pytorch-cu121"
$cudaWheels = @(
    [ordered]@{
        Name = "torch"
        Url = "https://download.pytorch.org/whl/cu121/torch-2.4.0%2Bcu121-cp310-cp310-win_amd64.whl"
        Path = Join-Path $cudaWheelDir "torch-2.4.0+cu121-cp310-cp310-win_amd64.whl"
        Bytes = 2441947262
    },
    [ordered]@{
        Name = "torchvision"
        Url = "https://download.pytorch.org/whl/cu121/torchvision-0.19.0%2Bcu121-cp310-cp310-win_amd64.whl"
        Path = Join-Path $cudaWheelDir "torchvision-0.19.0+cu121-cp310-cp310-win_amd64.whl"
        Bytes = 5783832
    },
    [ordered]@{
        Name = "torchaudio"
        Url = "https://download.pytorch.org/whl/cu121/torchaudio-2.4.0%2Bcu121-cp310-cp310-win_amd64.whl"
        Path = Join-Path $cudaWheelDir "torchaudio-2.4.0+cu121-cp310-cp310-win_amd64.whl"
        Bytes = 4112771
    }
)

function Write-Step($Message) {
    Write-Host ""
    Write-Host "== $Message =="
}

function Download-File($Url, $OutFile, [long]$ExpectedBytes = 0) {
    New-Item -ItemType Directory -Path (Split-Path $OutFile) -Force | Out-Null
    if ((Test-Path $OutFile) -and ((Get-Item $OutFile).Length -gt 0) -and ($ExpectedBytes -le 0 -or (Get-Item $OutFile).Length -eq $ExpectedBytes)) {
        Write-Host "Using existing file: $OutFile"
        return
    }
    Write-Host "Downloading $Url"
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source --silent --show-error --location --fail --retry 8 --retry-delay 5 --retry-all-errors --continue-at - --output $OutFile $Url
        if ($LASTEXITCODE -ne 0) {
            throw "curl failed with exit code $LASTEXITCODE while downloading $Url"
        }
    } else {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    }
    if ($ExpectedBytes -gt 0 -and (Get-Item $OutFile).Length -ne $ExpectedBytes) {
        throw "Downloaded file has $((Get-Item $OutFile).Length) bytes; expected $ExpectedBytes bytes: $OutFile"
    }
}

function Test-CudaTorch($PythonExe) {
    $cudaCheck = & $PythonExe -c "import sys, torch; ok=bool(torch.version.cuda and torch.cuda.is_available()); print(torch.__version__, torch.version.cuda, torch.cuda.is_available()); sys.exit(0 if ok else 1)"
    $cudaCheckExitCode = $LASTEXITCODE
    if ($cudaCheck) {
        Write-Host $cudaCheck
    }
    return $cudaCheckExitCode -eq 0
}

if ($CudaRepair -and $CpuOnly) {
    throw "CudaRepair and CpuOnly cannot be used together."
}

New-Item -ItemType Directory -Path $engineRoot, $runtimeDir, $modelDir, $downloadsDir -Force | Out-Null

Write-Step "Installing managed Python 3.10 for high-quality VTV"
if ($SkipPythonInstall -and -not (Test-Path $pythonExe)) {
    throw "SkipPythonInstall was set, but $pythonExe does not exist."
}
if ((-not (Test-Path $pythonExe)) -and (Test-Path (Join-Path $siblingPythonDir "python.exe"))) {
    Write-Host "Copying existing managed Python runtime from $siblingPythonDir"
    Copy-Item -Path $siblingPythonDir -Destination $runtimeDir -Recurse -Force
}
if (-not (Test-Path $pythonExe)) {
    Download-File $pythonInstallerUrl $pythonInstallerPath
    $arguments = @(
        "/quiet",
        "InstallAllUsers=0",
        "TargetDir=$pythonDir",
        "Include_pip=1",
        "Include_test=0",
        "Include_launcher=0",
        "PrependPath=0",
        "Shortcuts=0"
    )
    $process = Start-Process -FilePath $pythonInstallerPath -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "Python installer failed with exit code $($process.ExitCode)."
    }
}
if (-not (Test-Path $pythonExe)) {
    throw "Managed Python was not installed at $pythonExe."
}
& $pythonExe --version

Write-Step "Copying Magic Box Seed-VC worker"
Copy-Item -Path $workerSource -Destination $workerTarget -Force
Copy-Item -Path $inferenceWrapperSource -Destination $inferenceWrapperTarget -Force

Write-Step "Installing Seed-VC source"
if (-not (Test-Path (Join-Path $seedRepoDir "inference.py"))) {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($git) {
        & $git.Source clone --filter=blob:none https://github.com/Plachtaa/seed-vc.git $seedRepoDir
        if ($LASTEXITCODE -ne 0) {
            throw "git clone for Seed-VC failed."
        }
        & $git.Source -c "safe.directory=$safeSeedRepoDir" -C $seedRepoDir fetch --depth 1 origin $SeedVcCommit
        if ($LASTEXITCODE -ne 0) {
            throw "Seed-VC pinned commit fetch failed: $SeedVcCommit"
        }
        & $git.Source -c "safe.directory=$safeSeedRepoDir" -C $seedRepoDir checkout --detach $SeedVcCommit
        if ($LASTEXITCODE -ne 0) {
            throw "Seed-VC pinned commit checkout failed: $SeedVcCommit"
        }
    } else {
        throw "git.exe is required to install the pinned Seed-VC commit $SeedVcCommit; an archive without verifiable git lineage is not accepted."
    }
}
$resolvedSeedVcCommit = ""
$gitForVerification = Get-Command git.exe -ErrorAction SilentlyContinue
if ($gitForVerification -and (Test-Path (Join-Path $seedRepoDir ".git"))) {
    $resolvedSeedVcCommit = (& $gitForVerification.Source -c "safe.directory=$safeSeedRepoDir" -C $seedRepoDir rev-parse HEAD).Trim()
}
if ($resolvedSeedVcCommit -ne $SeedVcCommit) {
    throw "Seed-VC runtime commit is not pinned. Expected $SeedVcCommit, got '$resolvedSeedVcCommit'."
}

$env:MAGIC_BOX_SEED_VC_REPO = $seedRepoDir
$env:MAGIC_BOX_VOICE_ENGINE_MODEL_DIR = $modelDir
$env:HF_HOME = Join-Path $seedRepoDir "checkpoints\hf_home"
$env:HF_HUB_CACHE = Join-Path $seedRepoDir "checkpoints\hf_cache"
$env:HF_HUB_DISABLE_XET = "1"
$env:HF_HUB_DOWNLOAD_TIMEOUT = "300"
$env:TRANSFORMERS_CACHE = Join-Path $env:HF_HUB_CACHE "transformers"
$env:TORCH_HOME = Join-Path $modelDir "cache\torch"
New-Item -ItemType Directory -Path $env:HF_HOME, $env:HF_HUB_CACHE, $env:TRANSFORMERS_CACHE, $env:TORCH_HOME -Force | Out-Null

Write-Step "Installing Seed-VC, Demucs, and PyTorch"
if (-not $SkipPackageInstall) {
    if (-not $CudaRepair) {
        & $pythonExe -m pip install --upgrade pip wheel "setuptools<81"
        if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed." }
    }

    & $pythonExe -c "import torch, torchaudio; print(torch.__version__, torchaudio.__version__)" 2>$null
    $existingTorchReady = $LASTEXITCODE -eq 0
    $hasNvidiaGpu = (-not $CpuOnly) -and ($null -ne (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue))
    $torchInstalled = $CpuOnly -and $existingTorchReady
    if ($torchInstalled) {
        Write-Host "Using the existing CPU PyTorch runtime because CpuOnly was requested."
    }
    if ($hasNvidiaGpu) {
        $torchInstalled = Test-CudaTorch $pythonExe
        if (-not $torchInstalled) {
            Write-Step "Downloading resumable CUDA 12.1 PyTorch wheels"
            foreach ($wheel in $cudaWheels) {
                Download-File $wheel.Url $wheel.Path $wheel.Bytes
            }
            Write-Step "Installing CUDA 12.1 PyTorch"
            $cudaWheelPaths = @($cudaWheels | ForEach-Object { $_.Path })
            & $pythonExe -m pip install --force-reinstall --no-deps @cudaWheelPaths
            $torchInstalled = ($LASTEXITCODE -eq 0) -and (Test-CudaTorch $pythonExe)
        }
        if (-not $torchInstalled) {
            if (-not $AllowCpuFallback) {
                throw "An NVIDIA GPU was found, but the CUDA PyTorch runtime could not be installed. The partial wheel remains cached and the next install attempt will resume it."
            }
            Write-Warning "CUDA PyTorch installation failed. AllowCpuFallback was requested, so the existing CPU runtime may be used."
        }
    }
    if ((-not $torchInstalled) -and $existingTorchReady) {
        Write-Warning "Using the existing CPU PyTorch runtime after the preferred install failed."
        $torchInstalled = $true
    }
    if (-not $torchInstalled) {
        $torchIndex = "https://download.pytorch.org/whl/cpu"
        Write-Host "Installing CPU PyTorch from $torchIndex"
        & $pythonExe -m pip install --retries 8 --timeout 120 --index-url $torchIndex torch==2.4.0 torchvision==0.19.0 torchaudio==2.4.0
        if ($LASTEXITCODE -ne 0) { throw "PyTorch install failed for both the preferred and CPU runtimes." }
    }

    $requirements = Join-Path $seedRepoDir "requirements.txt"
    if ((-not $CudaRepair) -and (Test-Path $requirements)) {
        $filteredRequirements = Join-Path $downloadsDir "requirements-magicbox-vtv.txt"
        Get-Content -LiteralPath $requirements |
            Where-Object {
                ($_ -notmatch '^\s*torch(?:vision|audio)?(?:\s|=|<|>|$)') -and
                ($_ -notmatch '^\s*gradio(?:\s|=|<|>|$)') -and
                ($_ -notmatch '^\s*FreeSimpleGUI(?:\s|=|<|>|$)') -and
                ($_ -notmatch '^\s*sounddevice(?:\s|=|<|>|$)') -and
                ($_ -notmatch '^\s*modelscope(?:\s|=|<|>|$)') -and
                ($_ -notmatch '^\s*funasr(?:\s|=|<|>|$)') -and
                ($_ -notmatch '^\s*resemblyzer(?:\s|=|<|>|$)') -and
                ($_ -notmatch '^\s*jiwer(?:\s|=|<|>|$)')
            } |
            Set-Content -Path $filteredRequirements -Encoding UTF8
        & $pythonExe -m pip install -r $filteredRequirements
        if ($LASTEXITCODE -ne 0) { throw "Seed-VC requirements install failed." }
    }
    if (-not $CudaRepair) {
        & $pythonExe -m pip install "demucs==4.0.1"
        if ($LASTEXITCODE -ne 0) { throw "Demucs install failed." }
        # torchfcpe currently declares an unconstrained torch dependency. Installing
        # it with the normal resolver can silently replace the pinned CUDA torch /
        # torchaudio stack above. Keep the evaluator dependency set explicit and
        # install it without dependency resolution so the managed runtime contract
        # remains torch==2.4.0+cu121 (or the already validated CPU variant).
        $fcpePackages = @(
            "einops==0.8.2",
            "torch-einops-utils==0.1.21",
            "hyper-connections==0.4.11",
            "local-attention==1.11.2",
            "rotary-embedding-torch==0.8.9",
            "torchfcpe==0.0.4"
        )
        & $pythonExe -m pip install --no-deps @fcpePackages
        if ($LASTEXITCODE -ne 0) { throw "FCPE install failed without altering the pinned PyTorch stack." }
    }
}

if ((-not $SkipModelDownload) -and (-not $CudaRepair)) {
    Write-Step "Downloading Seed-VC and Demucs model weights"
    $prefetchScript = Join-Path $repoRoot "scripts\prefetch-seed-vc-models.py"
    if (-not (Test-Path $prefetchScript)) {
        throw "Seed-VC model prefetch helper was not found at $prefetchScript."
    }
    Push-Location $seedRepoDir
    try {
        & $pythonExe $prefetchScript
        if ($LASTEXITCODE -ne 0) { throw "Seed-VC model download failed." }
        & $pythonExe -c "from demucs.pretrained import get_model; get_model('htdemucs'); print('Demucs htdemucs ready')"
        if ($LASTEXITCODE -ne 0) { throw "Demucs model download failed." }
    } finally {
        Pop-Location
    }
}

Write-Step "Checking high-quality VTV worker health"
$healthRequest = @{ id = "health"; action = "health"; engine = "seed-vc-svc-local"; modelDir = $modelDir; repoDir = $seedRepoDir } | ConvertTo-Json -Compress
$healthOutput = $healthRequest | & $pythonExe $workerTarget
if ($LASTEXITCODE -ne 0 -or -not ($healthOutput -match '"ok":\s*true')) {
    throw "Seed-VC worker health check failed: $healthOutput"
}
$healthResponse = $healthOutput | Select-Object -Last 1 | ConvertFrom-Json
if (-not $healthResponse.ok -or -not $healthResponse.result.runtimeReady) {
    throw "Seed-VC worker health check failed."
}
$healthResult = $healthResponse.result

Write-Step "Writing high-quality VTV install state"
$state = [ordered]@{
    engine = "seed-vc-svc-local"
    modelVersion = $modelVersion
    installed = [bool]$healthResult.installed
    runtimeReady = [bool]$healthResult.runtimeReady
    conversionReady = [bool]$healthResult.conversionReady
    separationReady = [bool]$healthResult.separationReady
    fcpeReady = [bool]$healthResult.fcpeReady
    roformerReady = [bool]$healthResult.roformerReady
    modelsReady = [bool]$healthResult.modelsReady
    workerSource = "managed"
    pythonPath = $pythonExe
    workerPath = $workerTarget
    repoDir = $seedRepoDir
    modelDir = $modelDir
    runtimeDir = $runtimeDir
    cacheDir = Join-Path $modelDir "cache"
    gpuAvailable = [bool]$healthResult.gpuAvailable
    device = $healthResult.device
    source = "Plachtaa/seed-vc + facebookresearch/demucs"
    seedVcCommit = $resolvedSeedVcCommit
    seedVcCommitPinned = ($resolvedSeedVcCommit -eq $SeedVcCommit)
    license = "GPL-3.0"
    separationLicense = "MIT"
    warnings = @("Seed-VC is GPL-3.0 software installed as a separate local runtime.")
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$stateJson = $state | ConvertTo-Json -Depth 8
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($installStatePath, $stateJson, $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $modelDir ".ready.json"), $stateJson, $utf8NoBom)

Write-Host ""
Write-Host "Installed high-quality VTV runtime under:"
Write-Host "  $engineRoot"
