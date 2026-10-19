param(
    [string]$ReleaseDir = "",
    [switch]$SkipPythonInstall,
    [switch]$SkipPackageInstall,
    [switch]$SkipModelDownload,
    [switch]$SkipTtsPrewarm
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not $ReleaseDir) {
    $ReleaseDir = Join-Path $repoRoot "release\chromium\MagicBox"
}
$ReleaseDir = (Resolve-Path $ReleaseDir).Path

$voiceEngineRoot = Join-Path $ReleaseDir "voice_clone\voice_engine"
$runtimeDir = Join-Path $voiceEngineRoot "runtime"
$pythonDir = Join-Path $runtimeDir "python"
$modelVersion = "openvoice-v2-0417"
$modelDir = Join-Path $voiceEngineRoot "models\$modelVersion"
$downloadsDir = Join-Path $modelDir "downloads"
$workerSource = Join-Path $repoRoot "server\voice_engine_worker_openvoice.py"
$workerTarget = Join-Path $runtimeDir "openvoice_worker.py"
$pythonExe = Join-Path $pythonDir "python.exe"
$installStatePath = Join-Path $voiceEngineRoot "install_state.json"

$pythonInstallerUrl = "https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe"
$pythonInstallerPath = Join-Path $downloadsDir "python-3.10.11-amd64.exe"
$checkpointDir = Join-Path $modelDir "checkpoints_v2"
$checkpointFiles = @(
    @{ Id = "converter-config"; RelativePath = "converter\config.json"; Url = "https://huggingface.co/myshell-ai/OpenVoiceV2/resolve/main/converter/config.json"; Required = $true },
    @{ Id = "converter-checkpoint"; RelativePath = "converter\checkpoint.pth"; Url = "https://huggingface.co/myshell-ai/OpenVoiceV2/resolve/main/converter/checkpoint.pth"; Required = $true },
    @{ Id = "base-speaker-en-newest"; RelativePath = "base_speakers\ses\en-newest.pth"; Url = "https://huggingface.co/myshell-ai/OpenVoiceV2/resolve/main/base_speakers/ses/en-newest.pth"; Required = $true },
    @{ Id = "base-speaker-en-us"; RelativePath = "base_speakers\ses\en-us.pth"; Url = "https://huggingface.co/myshell-ai/OpenVoiceV2/resolve/main/base_speakers/ses/en-us.pth"; Required = $false },
    @{ Id = "base-speaker-zh"; RelativePath = "base_speakers\ses\zh.pth"; Url = "https://huggingface.co/myshell-ai/OpenVoiceV2/resolve/main/base_speakers/ses/zh.pth"; Required = $true },
    @{ Id = "base-speaker-jp"; RelativePath = "base_speakers\ses\jp.pth"; Url = "https://huggingface.co/myshell-ai/OpenVoiceV2/resolve/main/base_speakers/ses/jp.pth"; Required = $true }
)
$meloFiles = @(
    @{ Id = "melotts-en-newest-config"; Language = "EN_NEWEST"; FileName = "config.json"; Url = "https://huggingface.co/myshell-ai/MeloTTS-English-v3/resolve/main/config.json"; Required = $true },
    @{ Id = "melotts-en-newest-checkpoint"; Language = "EN_NEWEST"; FileName = "checkpoint.pth"; Url = "https://huggingface.co/myshell-ai/MeloTTS-English-v3/resolve/main/checkpoint.pth"; Required = $true },
    @{ Id = "melotts-zh-config"; Language = "ZH"; FileName = "config.json"; Url = "https://huggingface.co/myshell-ai/MeloTTS-Chinese/resolve/main/config.json"; Required = $true },
    @{ Id = "melotts-zh-checkpoint"; Language = "ZH"; FileName = "checkpoint.pth"; Url = "https://huggingface.co/myshell-ai/MeloTTS-Chinese/resolve/main/checkpoint.pth"; Required = $true },
    @{ Id = "melotts-jp-config"; Language = "JP"; FileName = "config.json"; Url = "https://huggingface.co/myshell-ai/MeloTTS-Japanese/resolve/main/config.json"; Required = $true },
    @{ Id = "melotts-jp-checkpoint"; Language = "JP"; FileName = "checkpoint.pth"; Url = "https://huggingface.co/myshell-ai/MeloTTS-Japanese/resolve/main/checkpoint.pth"; Required = $true }
)
$bertFiles = @(
    @{ Id = "bert-multilingual-config"; Model = "bert-base-multilingual-uncased"; FileName = "config.json"; Url = "https://huggingface.co/bert-base-multilingual-uncased/resolve/main/config.json"; Required = $true },
    @{ Id = "bert-multilingual-weights"; Model = "bert-base-multilingual-uncased"; FileName = "pytorch_model.bin"; Url = "https://huggingface.co/bert-base-multilingual-uncased/resolve/main/pytorch_model.bin"; Required = $true },
    @{ Id = "bert-multilingual-vocab"; Model = "bert-base-multilingual-uncased"; FileName = "vocab.txt"; Url = "https://huggingface.co/bert-base-multilingual-uncased/resolve/main/vocab.txt"; Required = $true },
    @{ Id = "bert-multilingual-tokenizer"; Model = "bert-base-multilingual-uncased"; FileName = "tokenizer.json"; Url = "https://huggingface.co/bert-base-multilingual-uncased/resolve/main/tokenizer.json"; Required = $false },
    @{ Id = "bert-multilingual-tokenizer-config"; Model = "bert-base-multilingual-uncased"; FileName = "tokenizer_config.json"; Url = "https://huggingface.co/bert-base-multilingual-uncased/resolve/main/tokenizer_config.json"; Required = $false },
    @{ Id = "bert-japanese-config"; Model = "tohoku-nlp--bert-base-japanese-v3"; FileName = "config.json"; Url = "https://huggingface.co/tohoku-nlp/bert-base-japanese-v3/resolve/main/config.json"; Required = $true },
    @{ Id = "bert-japanese-weights"; Model = "tohoku-nlp--bert-base-japanese-v3"; FileName = "pytorch_model.bin"; Url = "https://huggingface.co/tohoku-nlp/bert-base-japanese-v3/resolve/main/pytorch_model.bin"; Required = $true },
    @{ Id = "bert-japanese-vocab"; Model = "tohoku-nlp--bert-base-japanese-v3"; FileName = "vocab.txt"; Url = "https://huggingface.co/tohoku-nlp/bert-base-japanese-v3/resolve/main/vocab.txt"; Required = $true },
    @{ Id = "bert-japanese-tokenizer-config"; Model = "tohoku-nlp--bert-base-japanese-v3"; FileName = "tokenizer_config.json"; Url = "https://huggingface.co/tohoku-nlp/bert-base-japanese-v3/resolve/main/tokenizer_config.json"; Required = $false },
    @{ Id = "bert-japanese-special-tokens"; Model = "tohoku-nlp--bert-base-japanese-v3"; FileName = "special_tokens_map.json"; Url = "https://huggingface.co/tohoku-nlp/bert-base-japanese-v3/resolve/main/special_tokens_map.json"; Required = $false }
)

function Write-Step($Message) {
    Write-Host ""
    Write-Host "== $Message =="
}

function Set-VoiceModelCache {
    $cacheDir = Join-Path $modelDir "cache"
    $hfHome = Join-Path $cacheDir "huggingface"
    $env:HF_HOME = $hfHome
    $env:HF_HUB_CACHE = Join-Path $hfHome "hub"
    $env:TRANSFORMERS_CACHE = Join-Path $hfHome "transformers"
    $env:TORCH_HOME = Join-Path $cacheDir "torch"
    $env:NLTK_DATA = Join-Path $cacheDir "nltk_data"
    $env:MAGIC_BOX_VOICE_ENGINE_MODEL_DIR = $modelDir
    $unidicLiteMecabrc = Join-Path $pythonDir "Lib\site-packages\unidic_lite\dicdir\mecabrc"
    if (Test-Path $unidicLiteMecabrc) {
        $env:MECABRC = $unidicLiteMecabrc
    }
    New-Item -ItemType Directory -Path $env:HF_HOME, $env:HF_HUB_CACHE, $env:TRANSFORMERS_CACHE, $env:TORCH_HOME, $env:NLTK_DATA -Force | Out-Null
}

function Ensure-UnidicLiteFallback {
    $sitePackages = Join-Path $pythonDir "Lib\site-packages"
    $unidicLiteDir = Join-Path $sitePackages "unidic_lite\dicdir"
    $unidicDir = Join-Path $sitePackages "unidic\dicdir"
    if ((Test-Path (Join-Path $unidicLiteDir "mecabrc")) -and -not (Test-Path (Join-Path $unidicDir "mecabrc"))) {
        New-Item -ItemType Directory -Path $unidicDir -Force | Out-Null
        Copy-Item -Path (Join-Path $unidicLiteDir "*") -Destination $unidicDir -Recurse -Force
    }
}

function Patch-MeloTextCleaner {
    $cleanerPath = Join-Path $pythonDir "Lib\site-packages\melo\text\cleaner.py"
    if (-not (Test-Path $cleanerPath)) {
        return
    }
    $lazyCleaner = @'
from importlib import import_module
from . import cleaned_text_to_sequence
import copy

language_module_name_map = {
    "ZH": "chinese",
    "JP": "japanese",
    "EN": "english",
    "ZH_MIX_EN": "chinese_mix",
    "KR": "korean",
    "FR": "french",
    "SP": "spanish",
    "ES": "spanish",
}
language_module_map = {}


def _language_module(language):
    module_name = language_module_name_map[language]
    if language not in language_module_map:
        language_module_map[language] = import_module(f".{module_name}", __package__)
    return language_module_map[language]


def clean_text(text, language):
    language_module = _language_module(language)
    norm_text = language_module.text_normalize(text)
    phones, tones, word2ph = language_module.g2p(norm_text)
    return norm_text, phones, tones, word2ph


def clean_text_bert(text, language, device=None):
    language_module = _language_module(language)
    norm_text = language_module.text_normalize(text)
    phones, tones, word2ph = language_module.g2p(norm_text)

    word2ph_bak = copy.deepcopy(word2ph)
    for i in range(len(word2ph)):
        word2ph[i] = word2ph[i] * 2
    word2ph[0] += 1
    bert = language_module.get_bert_feature(norm_text, word2ph, device=device)

    return norm_text, phones, tones, word2ph_bak, bert


def text_to_sequence(text, language):
    norm_text, phones, tones, word2ph = clean_text(text, language)
    return cleaned_text_to_sequence(phones, tones, language)
'@
    $lazyCleaner | Set-Content -Path $cleanerPath -Encoding UTF8
}


function Download-File($Url, $OutFile) {
    New-Item -ItemType Directory -Path (Split-Path $OutFile) -Force | Out-Null
    $expectedLength = $null
    try {
        $head = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -TimeoutSec 30
        $expectedLength = [int64]($head.Headers["Content-Length"])
    } catch {
        $expectedLength = $null
    }
    if ((Test-Path $OutFile) -and $expectedLength -and ((Get-Item $OutFile).Length -eq $expectedLength)) {
        Write-Host "Using existing file: $OutFile"
        return
    }
    if ((Test-Path $OutFile) -and -not $expectedLength -and ((Get-Item $OutFile).Length -gt 0)) {
        Write-Host "Using existing file: $OutFile"
        return
    }
    Write-Host "Downloading $Url"
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source --location --fail --retry 12 --retry-delay 5 --retry-all-errors --continue-at - --output $OutFile $Url
        if ($LASTEXITCODE -ne 0) {
            throw "curl failed with exit code $LASTEXITCODE while downloading $Url"
        }
    } else {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    }
    if ($expectedLength -and ((Get-Item $OutFile).Length -ne $expectedLength)) {
        throw "Downloaded file length did not match Content-Length for $Url."
    }
}

New-Item -ItemType Directory -Path $runtimeDir, $modelDir, $downloadsDir -Force | Out-Null
Set-VoiceModelCache

Write-Step "Installing managed Python 3.10"
if ($SkipPythonInstall -and -not (Test-Path $pythonExe)) {
    throw "SkipPythonInstall was set, but $pythonExe does not exist."
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
& $pythonExe --version

Write-Step "Copying Magic Box OpenVoice worker"
Copy-Item -Path $workerSource -Destination $workerTarget -Force

Write-Step "Installing Python packages"
if (-not $SkipPackageInstall) {
    & $pythonExe -m pip install --upgrade pip wheel "setuptools<81"
    if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed." }

    & $pythonExe -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.2.2 torchaudio==2.2.2
    if ($LASTEXITCODE -ne 0) { throw "PyTorch install failed." }

    & $pythonExe -m pip install `
        numpy==1.22.0 `
        librosa==0.9.1 `
        pydub==0.25.1 `
        wavmark==0.0.3 `
        eng_to_ipa==0.0.2 `
        inflect==7.0.0 `
        unidecode==1.3.7 `
        pypinyin==0.50.0 `
        cn2an==0.5.22 `
        jieba==0.42.1 `
        langid==1.1.6
    if ($LASTEXITCODE -ne 0) { throw "OpenVoice converter dependency install failed." }

    & $pythonExe -m pip install --no-deps "git+https://github.com/myshell-ai/OpenVoice.git"
    if ($LASTEXITCODE -ne 0) { throw "OpenVoice install failed." }

    & $pythonExe -m pip install "git+https://github.com/myshell-ai/MeloTTS.git"
    if ($LASTEXITCODE -ne 0) { throw "MeloTTS install failed." }
}
Ensure-UnidicLiteFallback
Patch-MeloTextCleaner

Write-Step "Installing OpenVoice V2 checkpoints"
if (-not $SkipModelDownload) {
    foreach ($file in $checkpointFiles) {
        $target = Join-Path $checkpointDir $file.RelativePath
        try {
            Download-File $file.Url $target
        } catch {
            if ($file.Required) {
                throw
            }
            Write-Warning "Optional checkpoint file failed to download: $($file.Id) - $($_.Exception.Message)"
        }
    }
}

Write-Step "Installing MeloTTS base models"
if (-not $SkipModelDownload) {
    foreach ($file in $meloFiles) {
        $target = Join-Path (Join-Path $modelDir "melotts\$($file.Language)") $file.FileName
        try {
            Download-File $file.Url $target
        } catch {
            if ($file.Required) {
                throw
            }
            Write-Warning "Optional MeloTTS file failed to download: $($file.Id) - $($_.Exception.Message)"
        }
    }
}

Write-Step "Installing MeloTTS CJK BERT models"
if (-not $SkipModelDownload) {
    foreach ($file in $bertFiles) {
        $target = Join-Path (Join-Path $modelDir "bert\$($file.Model)") $file.FileName
        try {
            Download-File $file.Url $target
        } catch {
            if ($file.Required) {
                throw
            }
            Write-Warning "Optional BERT file failed to download: $($file.Id) - $($_.Exception.Message)"
        }
    }
}

Write-Step "Prewarming MeloTTS base models"
if (-not $SkipModelDownload -and -not $SkipTtsPrewarm) {
    & $pythonExe -m nltk.downloader -d $env:NLTK_DATA averaged_perceptron_tagger averaged_perceptron_tagger_eng cmudict
    if ($LASTEXITCODE -ne 0) { throw "NLTK resource download failed." }

    $prewarm = @'
import os
import tempfile
from pathlib import Path
from melo.api import TTS
from transformers import AutoModelForMaskedLM, AutoTokenizer

model_root = Path(os.environ["MAGIC_BOX_VOICE_ENGINE_MODEL_DIR"])
bert_root = model_root / "bert"
bert_model_dirs = {
    "bert-base-multilingual-uncased": bert_root / "bert-base-multilingual-uncased",
    "tohoku-nlp/bert-base-japanese-v3": bert_root / "tohoku-nlp--bert-base-japanese-v3",
}
original_model_from_pretrained = AutoModelForMaskedLM.from_pretrained
original_tokenizer_from_pretrained = AutoTokenizer.from_pretrained

def _resolve_pretrained_path(value):
    local_dir = bert_model_dirs.get(str(value))
    if local_dir and local_dir.is_dir():
        return str(local_dir)
    return value

def _model_from_pretrained(value, *args, **kwargs):
    kwargs.setdefault("local_files_only", True)
    return original_model_from_pretrained(_resolve_pretrained_path(value), *args, **kwargs)

def _tokenizer_from_pretrained(value, *args, **kwargs):
    kwargs.setdefault("local_files_only", True)
    return original_tokenizer_from_pretrained(_resolve_pretrained_path(value), *args, **kwargs)

AutoModelForMaskedLM.from_pretrained = _model_from_pretrained
AutoTokenizer.from_pretrained = _tokenizer_from_pretrained

jobs = [
    ("EN_NEWEST", "Hello from Magic Box."),
    ("ZH", "\u4f60\u597d\uff0c\u9b54\u6cd5\u76d2\u3002"),
    ("JP", "\u3053\u3093\u306b\u3061\u306f\u3001\u30de\u30b8\u30c3\u30af\u30dc\u30c3\u30af\u30b9\u3002"),
]
for language, text in jobs:
    print(f"prewarming {language}", flush=True)
    model_dir = model_root / "melotts" / language
    model = TTS(
        language=language,
        device="cpu",
        config_path=str(model_dir / "config.json"),
        ckpt_path=str(model_dir / "checkpoint.pth"),
    )
    setattr(model.hps.data, "disable_bert", language == "EN_NEWEST")
    speaker_id = next(iter(model.hps.data.spk2id.values()))
    output = Path(tempfile.gettempdir()) / f"magicbox-prewarm-{language.lower()}.wav"
    model.tts_to_file(text, speaker_id, str(output), quiet=True)
print("prewarm complete", flush=True)
'@
    $prewarmPath = Join-Path $runtimeDir "prewarm_melotts.py"
    $prewarm | Set-Content -Path $prewarmPath -Encoding UTF8
    & $pythonExe $prewarmPath
    if ($LASTEXITCODE -ne 0) { throw "MeloTTS prewarm failed." }
}

Write-Step "Writing Magic Box voice engine install state"
$state = [ordered]@{
    engine = "openvoice-v2-local"
    modelVersion = $modelVersion
    installed = $true
    runtimeReady = $true
    workerSource = "managed"
    pythonPath = $pythonExe
    workerPath = $workerTarget
    modelDir = $modelDir
    runtimeDir = $runtimeDir
    checkpointDir = $checkpointDir
    cacheDir = Join-Path $modelDir "cache"
    artifacts = @(
        $checkpointFiles | ForEach-Object {
            [ordered]@{
            id = $_.Id
            fileName = $_.RelativePath
            path = (Join-Path $checkpointDir $_.RelativePath)
            extractedPath = $checkpointDir
            verified = $true
            }
        }
        $meloFiles | ForEach-Object {
            [ordered]@{
            id = $_.Id
            fileName = $_.FileName
            language = $_.Language
            path = (Join-Path (Join-Path $modelDir "melotts\$($_.Language)") $_.FileName)
            extractedPath = (Join-Path $modelDir "melotts\$($_.Language)")
            verified = $true
            }
        }
        $bertFiles | ForEach-Object {
            [ordered]@{
            id = $_.Id
            fileName = $_.FileName
            model = $_.Model
            path = (Join-Path (Join-Path $modelDir "bert\$($_.Model)") $_.FileName)
            extractedPath = (Join-Path $modelDir "bert\$($_.Model)")
            verified = $true
            }
        }
    )
    warnings = @()
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$stateJson = $state | ConvertTo-Json -Depth 8
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($installStatePath, $stateJson, $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $modelDir ".ready.json"), $stateJson, $utf8NoBom)

Write-Host ""
Write-Host "Installed OpenVoice V2 local runtime under:"
Write-Host "  $voiceEngineRoot"
