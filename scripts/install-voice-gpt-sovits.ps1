param(
    [string]$VoiceEngineRoot = "",
    [switch]$SkipPythonInstall,
    [switch]$SkipPackageInstall,
    [switch]$SkipModelDownload,
    [switch]$CpuOnly,
    [switch]$CudaRepair,
    [switch]$AllowCpuFallback,
    [ValidateSet("ModelScope", "HF", "HF-Mirror")]
    [string]$ModelSource = "ModelScope"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptRoot "..")
if (-not $VoiceEngineRoot) {
    $VoiceEngineRoot = Join-Path $repoRoot "voice_clone\voice_engine"
}
$VoiceEngineRoot = [System.IO.Path]::GetFullPath($VoiceEngineRoot)

$engineRoot = Join-Path $VoiceEngineRoot "gpt-sovits"
$runtimeDir = Join-Path $engineRoot "runtime"
$pythonDir = Join-Path $runtimeDir "python"
$repoDir = Join-Path $runtimeDir "GPT-SoVITS"
$modelVersion = "gpt-sovits-managed-v1"
$modelDir = Join-Path $engineRoot "models\$modelVersion"
$downloadsDir = Join-Path $modelDir "downloads"
$pythonExe = Join-Path $pythonDir "python.exe"
$siblingPythonDir = Join-Path $VoiceEngineRoot "runtime\python"
$workerSource = Join-Path $repoRoot "server\voice_engine_worker_gpt_sovits.py"
$workerTarget = Join-Path $runtimeDir "gpt_sovits_worker.py"
$installStatePath = Join-Path $engineRoot "install_state.json"
$pythonInstallerUrl = "https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe"
$pythonInstallerPath = Join-Path $downloadsDir "python-3.10.11-amd64.exe"
$repoZipUrl = "https://github.com/RVC-Boss/GPT-SoVITS/archive/refs/heads/main.zip"
$repoZipPath = Join-Path $downloadsDir "GPT-SoVITS-main.zip"
$sharedCudaWheelDir = Join-Path $VoiceEngineRoot "seed-vc\models\seed-vc-svc-v1\downloads\pytorch-cu121"
$cudaWheelDir = if (Test-Path $sharedCudaWheelDir) { $sharedCudaWheelDir } else { Join-Path $downloadsDir "pytorch-cu121" }
$cudaWheels = @(
    [ordered]@{ Name = "torch"; Url = "https://download.pytorch.org/whl/cu121/torch-2.4.0%2Bcu121-cp310-cp310-win_amd64.whl"; Path = Join-Path $cudaWheelDir "torch-2.4.0+cu121-cp310-cp310-win_amd64.whl"; Bytes = 2441947262 },
    [ordered]@{ Name = "torchvision"; Url = "https://download.pytorch.org/whl/cu121/torchvision-0.19.0%2Bcu121-cp310-cp310-win_amd64.whl"; Path = Join-Path $cudaWheelDir "torchvision-0.19.0+cu121-cp310-cp310-win_amd64.whl"; Bytes = 5783832 },
    [ordered]@{ Name = "torchaudio"; Url = "https://download.pytorch.org/whl/cu121/torchaudio-2.4.0%2Bcu121-cp310-cp310-win_amd64.whl"; Path = Join-Path $cudaWheelDir "torchaudio-2.4.0+cu121-cp310-cp310-win_amd64.whl"; Bytes = 4112771 }
)

function Get-ModelSourceConfig($Source) {
    switch ($Source) {
        "HF" {
            return @{
                Name = "HF"
                PretrainedUrl = "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/pretrained_models.zip"
                G2PWUrl = "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/G2PWModel.zip"
            }
        }
        "HF-Mirror" {
            return @{
                Name = "HF-Mirror"
                PretrainedUrl = "https://hf-mirror.com/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/pretrained_models.zip"
                G2PWUrl = "https://hf-mirror.com/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/G2PWModel.zip"
            }
        }
        default {
            return @{
                Name = "ModelScope"
                PretrainedUrl = "https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master/pretrained_models.zip"
                G2PWUrl = "https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master/G2PWModel.zip"
            }
        }
    }
}

function Get-ModelSources($PreferredSource) {
    $orderedNames = @($PreferredSource, "ModelScope", "HF", "HF-Mirror") | Select-Object -Unique
    return $orderedNames | ForEach-Object { Get-ModelSourceConfig $_ }
}

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
    if ($cudaCheck) { Write-Host $cudaCheck }
    return $cudaCheckExitCode -eq 0
}

if ($CudaRepair -and $CpuOnly) {
    throw "CudaRepair and CpuOnly cannot be used together."
}

function Get-DirectModelUrls($RelativePath) {
    $encodedPath = ($RelativePath -replace "\\", "/")
    $hf = "https://huggingface.co/lj1995/GPT-SoVITS/resolve/main/$encodedPath"
    $hfMirror = "https://hf-mirror.com/lj1995/GPT-SoVITS/resolve/main/$encodedPath"
    if ($ModelSource -eq "HF-Mirror") {
        return @($hfMirror, $hf)
    }
    return @($hf, $hfMirror)
}

function Download-FileWithSizeCheck($Url, $OutFile, $ExpectedBytes) {
    New-Item -ItemType Directory -Path (Split-Path $OutFile) -Force | Out-Null
    if ((Test-Path $OutFile) -and ((Get-Item $OutFile).Length -ge $ExpectedBytes)) {
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
    $actualBytes = (Get-Item $OutFile).Length
    if ($actualBytes -lt $ExpectedBytes) {
        throw "Downloaded file is incomplete: $OutFile ($actualBytes bytes, expected at least $ExpectedBytes bytes)."
    }
}

function Install-DirectModelFile($RelativePath, $ExpectedBytes) {
    $destination = Join-Path (Join-Path $repoDir "GPT_SoVITS\pretrained_models") $RelativePath
    if ((Test-Path $destination) -and ((Get-Item $destination).Length -ge $ExpectedBytes)) {
        Write-Host "GPT-SoVITS model file already present: $RelativePath"
        return
    }
    $lastError = $null
    foreach ($url in (Get-DirectModelUrls $RelativePath)) {
        try {
            Download-FileWithSizeCheck $url $destination $ExpectedBytes
            return
        } catch {
            $lastError = $_
            Write-Warning "Direct model file download failed for $RelativePath from $url`: $($_.Exception.Message)"
        }
    }
    throw "Failed to download GPT-SoVITS model file $RelativePath. Last error: $lastError"
}

function Install-DirectPretrainedModels {
    $requiredFiles = @(
        @{ Path = "chinese-hubert-base\config.json"; Bytes = 1449 },
        @{ Path = "chinese-hubert-base\preprocessor_config.json"; Bytes = 212 },
        @{ Path = "chinese-hubert-base\pytorch_model.bin"; Bytes = 188811417 },
        @{ Path = "chinese-roberta-wwm-ext-large\config.json"; Bytes = 963 },
        @{ Path = "chinese-roberta-wwm-ext-large\tokenizer.json"; Bytes = 268962 },
        @{ Path = "chinese-roberta-wwm-ext-large\pytorch_model.bin"; Bytes = 651225145 },
        @{ Path = "gsv-v2final-pretrained\s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"; Bytes = 155315150 },
        @{ Path = "gsv-v2final-pretrained\s2G2333k.pth"; Bytes = 106035259 }
    )
    foreach ($file in $requiredFiles) {
        Install-DirectModelFile $file.Path $file.Bytes
    }
}

function Get-G2PWUrls {
    $hf = "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/G2PWModel.zip"
    $hfMirror = "https://hf-mirror.com/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/G2PWModel.zip"
    $modelScope = "https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master/G2PWModel.zip"
    if ($ModelSource -eq "ModelScope") {
        return @($modelScope, $hf, $hfMirror)
    }
    if ($ModelSource -eq "HF-Mirror") {
        return @($hfMirror, $hf, $modelScope)
    }
    return @($hf, $hfMirror, $modelScope)
}

function Install-G2PWModel {
    $readyPath = Join-Path $repoDir "GPT_SoVITS\text\G2PWModel"
    if (Test-Path $readyPath) {
        Write-Host "GPT-SoVITS Chinese G2PW model already present: $readyPath"
        return
    }
    $archivePath = Join-Path $downloadsDir "G2PWModel.zip"
    $lastError = $null
    foreach ($url in (Get-G2PWUrls)) {
        try {
            Download-FileWithSizeCheck $url $archivePath 588856634
            Expand-DownloadedZip $archivePath (Join-Path $repoDir "GPT_SoVITS\text")
            if (Test-Path $readyPath) {
                return
            }
            throw "G2PW archive did not produce expected path: $readyPath"
        } catch {
            $lastError = $_
            Write-Warning "G2PW model download failed from $url`: $($_.Exception.Message)"
        }
    }
    throw "Failed to install GPT-SoVITS Chinese G2PW model. Last error: $lastError"
}

function Expand-DownloadedZip($ZipPath, $DestinationPath) {
    New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $DestinationPath -Force
}

function Install-ModelArchive($Name, $DestinationPath, $ReadyPath, $UrlPropertyName, $ArchiveFileName) {
    if (Test-Path $ReadyPath) {
        Write-Host "$Name already present: $ReadyPath"
        return
    }
    $archivePath = Join-Path $downloadsDir $ArchiveFileName
    $lastError = $null
    foreach ($source in (Get-ModelSources $ModelSource)) {
        $url = $source[$UrlPropertyName]
        try {
            Write-Host "Downloading $Name from $($source.Name)"
            Download-File $url $archivePath
            Expand-DownloadedZip $archivePath $DestinationPath
            if (Test-Path $ReadyPath) {
                Write-Host "$Name installed from $($source.Name)"
                return
            }
            throw "$Name archive did not produce expected path: $ReadyPath"
        } catch {
            $lastError = $_
            Write-Warning "$Name download from $($source.Name) failed: $($_.Exception.Message)"
            if (Test-Path $archivePath) {
                Remove-Item -LiteralPath $archivePath -Force
            }
        }
    }
    throw "$Name installation failed. Last error: $lastError"
}

New-Item -ItemType Directory -Path $engineRoot, $runtimeDir, $modelDir, $downloadsDir -Force | Out-Null

Write-Step "Installing managed Python 3.10 for GPT-SoVITS"
if ($SkipPythonInstall -and -not (Test-Path $pythonExe)) {
    throw "SkipPythonInstall was set, but $pythonExe does not exist."
}
if ((-not (Test-Path $pythonExe)) -and (Test-Path (Join-Path $siblingPythonDir "python.exe"))) {
    Write-Host "Copying existing managed Python runtime from $siblingPythonDir"
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
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

Write-Step "Copying Magic Box GPT-SoVITS worker"
Copy-Item -Path $workerSource -Destination $workerTarget -Force

Write-Step "Installing GPT-SoVITS source"
if (-not (Test-Path (Join-Path $repoDir "api_v2.py"))) {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($git) {
        & $git.Source clone --depth 1 https://github.com/RVC-Boss/GPT-SoVITS.git $repoDir
        if ($LASTEXITCODE -ne 0) {
            throw "git clone for GPT-SoVITS failed."
        }
    } else {
        Download-File $repoZipUrl $repoZipPath
        $extractRoot = Join-Path $downloadsDir "gpt-sovits-source"
        if (Test-Path $extractRoot) {
            Remove-Item -LiteralPath $extractRoot -Recurse -Force
        }
        Expand-Archive -LiteralPath $repoZipPath -DestinationPath $extractRoot -Force
        $expanded = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
        if (-not $expanded) {
            throw "GPT-SoVITS zip extraction did not produce a source folder."
        }
        Move-Item -LiteralPath $expanded.FullName -Destination $repoDir -Force
    }
}

$env:MAGIC_BOX_GPT_SOVITS_REPO = $repoDir
$env:MAGIC_BOX_VOICE_ENGINE_MODEL_DIR = $modelDir
$env:HF_HOME = Join-Path $modelDir "cache\huggingface"
$env:HF_HUB_CACHE = Join-Path $env:HF_HOME "hub"
$env:TRANSFORMERS_CACHE = Join-Path $env:HF_HOME "transformers"
$env:TORCH_HOME = Join-Path $modelDir "cache\torch"
$env:NLTK_DATA = Join-Path $modelDir "cache\nltk_data"
New-Item -ItemType Directory -Path $env:HF_HOME, $env:HF_HUB_CACHE, $env:TRANSFORMERS_CACHE, $env:TORCH_HOME, $env:NLTK_DATA -Force | Out-Null

Write-Step "Installing GPT-SoVITS Python packages"
if (-not $SkipPackageInstall) {
    if (-not $CudaRepair) {
        & $pythonExe -m pip install --upgrade pip wheel "setuptools<81"
        if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed." }
    }

    $hasNvidiaGpu = (-not $CpuOnly) -and ($null -ne (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue))
    $torchInstalled = $false
    if ($hasNvidiaGpu) {
        $torchInstalled = Test-CudaTorch $pythonExe
        if (-not $torchInstalled) {
            Write-Step "Installing CUDA 12.1 PyTorch for GPT-SoVITS"
            foreach ($wheel in $cudaWheels) {
                Download-File $wheel.Url $wheel.Path $wheel.Bytes
            }
            $cudaWheelPaths = @($cudaWheels | ForEach-Object { $_.Path })
            & $pythonExe -m pip install --force-reinstall --no-deps @cudaWheelPaths
            $torchInstalled = ($LASTEXITCODE -eq 0) -and (Test-CudaTorch $pythonExe)
        }
        if (-not $torchInstalled -and -not $AllowCpuFallback) {
            throw "An NVIDIA GPU was found, but CUDA PyTorch could not be installed for GPT-SoVITS. Cached wheels will be reused on the next attempt."
        }
    }
    if (-not $torchInstalled) {
        & $pythonExe -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.2.2 torchaudio==2.2.2
        if ($LASTEXITCODE -ne 0) { throw "PyTorch install failed." }
        $torchInstalled = $true
    }

    $requirements = Join-Path $repoDir "requirements.txt"
    if ((-not $CudaRepair) -and (Test-Path $requirements)) {
        $filteredRequirements = Join-Path $downloadsDir "requirements-magicbox-runtime.txt"
        Get-Content -LiteralPath $requirements |
            Where-Object {
                ($_ -notmatch '^\s*pyopenjtalk') -and
                ($_ -notmatch '^\s*onnxruntime-gpu') -and
                ($_ -notmatch '^\s*python_mecab_ko') -and
                ($_ -notmatch '^\s*jieba_fast') -and
                ($_ -notmatch '^\s*opencc')
            } |
            Set-Content -Path $filteredRequirements -Encoding UTF8
        & $pythonExe -m pip install -r $filteredRequirements
        if ($LASTEXITCODE -ne 0) { throw "GPT-SoVITS requirements install failed." }
        & $pythonExe -m pip install opencc-python-reimplemented
        if ($LASTEXITCODE -ne 0) { Write-Warning "Optional pure-Python OpenCC fallback install failed." }
        & $pythonExe -m pip install onnxruntime
        if ($LASTEXITCODE -ne 0) { Write-Warning "Optional onnxruntime install failed; Chinese TTS may still work without ASR tooling." }
        & $pythonExe -m pip install "transformers==4.43.4" "tokenizers<0.20,>=0.19"
        if ($LASTEXITCODE -ne 0) { throw "GPT-SoVITS transformers compatibility pin failed." }
        & $pythonExe -m pip install "peft==0.11.1"
        if ($LASTEXITCODE -ne 0) { throw "GPT-SoVITS peft compatibility pin failed." }
    }
}

Write-Step "Installing GPT-SoVITS English text resources"
& $pythonExe -m nltk.downloader -d $env:NLTK_DATA averaged_perceptron_tagger averaged_perceptron_tagger_eng cmudict
if ($LASTEXITCODE -ne 0) {
    throw "GPT-SoVITS NLTK resource download failed."
}
& $pythonExe -c "import nltk, os; nltk.data.path.insert(0, os.environ['NLTK_DATA']); nltk.data.find('taggers/averaged_perceptron_tagger_eng'); nltk.data.find('corpora/cmudict'); print('GPT-SoVITS NLTK resources ready')"
if ($LASTEXITCODE -ne 0) {
    throw "GPT-SoVITS NLTK resources were downloaded but could not be loaded."
}

Write-Step "Installing GPT-SoVITS pretrained models"
if ((-not $SkipModelDownload) -and (-not $CudaRepair)) {
    $pretrainedReadyPath = Join-Path $repoDir "GPT_SoVITS\pretrained_models\gsv-v2final-pretrained\s2G2333k.pth"
    try {
        Install-DirectPretrainedModels
    } catch {
        Write-Warning "Direct GPT-SoVITS model downloads failed: $($_.Exception.Message)"
        Install-ModelArchive "GPT-SoVITS pretrained models" (Join-Path $repoDir "GPT_SoVITS") $pretrainedReadyPath "PretrainedUrl" "pretrained_models.zip"
    }
    Install-G2PWModel
}

Write-Step "Checking GPT-SoVITS worker health"
$healthRequest = @{ id = "health"; action = "health"; engine = "gpt-sovits-local"; modelDir = $modelDir } | ConvertTo-Json -Compress
$healthOutput = $healthRequest | & $pythonExe $workerTarget
if ($LASTEXITCODE -ne 0 -or -not ($healthOutput -match '"ok":\s*true')) {
    throw "GPT-SoVITS worker health check failed: $healthOutput"
}
$healthResponse = $healthOutput | ConvertFrom-Json
if (-not $healthResponse.ok -or -not $healthResponse.result.runtimeReady) {
    $missing = @($healthResponse.result.missingModelPaths) -join "; "
    throw "GPT-SoVITS worker health check failed. Missing model files: $missing"
}
$healthResult = $healthResponse.result

Write-Step "Writing Magic Box GPT-SoVITS install state"
$state = [ordered]@{
    engine = "gpt-sovits-local"
    modelVersion = $modelVersion
    installed = [bool]$healthResult.installed
    runtimeReady = [bool]$healthResult.runtimeReady
    workerSource = "managed"
    pythonPath = $pythonExe
    workerPath = $workerTarget
    repoDir = $repoDir
    modelDir = $modelDir
    runtimeDir = $runtimeDir
    cacheDir = Join-Path $modelDir "cache"
    modelSource = $ModelSource
    missingModelPaths = @($healthResult.missingModelPaths)
    gpuAvailable = [bool]$healthResult.cudaAvailable
    device = $healthResult.device
    gpuName = $healthResult.gpuName
    gpuMemoryGB = $healthResult.gpuMemoryGB
    torchVersion = $healthResult.torchVersion
    cudaVersion = $healthResult.cudaVersion
    warnings = @()
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$stateJson = $state | ConvertTo-Json -Depth 8
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($installStatePath, $stateJson, $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $modelDir ".ready.json"), $stateJson, $utf8NoBom)

Write-Host ""
Write-Host "Installed GPT-SoVITS local runtime under:"
Write-Host "  $engineRoot"
