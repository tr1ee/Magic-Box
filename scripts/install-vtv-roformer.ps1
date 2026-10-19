[CmdletBinding()]
param(
    [string]$ModelRoot = "",
    [switch]$SkipDownload
)

$ErrorActionPreference = "Stop"
if (-not $ModelRoot) {
    $ModelRoot = Join-Path $PSScriptRoot "..\MagicBoxData\voice_clone\voice_engine\seed-vc\models\vtv-separators\bs-roformer"
}
$ModelRoot = [IO.Path]::GetFullPath($ModelRoot)
New-Item -ItemType Directory -Force -Path $ModelRoot | Out-Null

$artifacts = @(
    [ordered]@{
        file = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
        url = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/model_bs_roformer_ep_317_sdr_12.9755.ckpt"
        sha256 = "5b84f37e8d444c8cb30c79d77f613a41c05868ff9c9ac6c7049c00aefae115aa"
    },
    [ordered]@{
        file = "model_bs_roformer_ep_317_sdr_12.9755.yaml"
        url = "https://raw.githubusercontent.com/ZFTurbo/Music-Source-Separation-Training/main/configs/viperx/model_bs_roformer_ep_317_sdr_12.9755.yaml"
        sha256 = "42e5635ceab7287b83d9591c9880966f0b61cff26a0a40a29d236bacb32e5f2c"
    }
)

foreach ($artifact in $artifacts) {
    $target = Join-Path $ModelRoot $artifact.file
    $currentHash = if (Test-Path -LiteralPath $target) { (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant() } else { "" }
    if ($currentHash -ne $artifact.sha256) {
        if ($SkipDownload) {
            throw "Missing or hash-mismatched VTV separator artifact: $target"
        }
        Invoke-WebRequest -Uri $artifact.url -OutFile $target -UseBasicParsing
        $currentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
        if ($currentHash -ne $artifact.sha256) {
            throw "VTV separator artifact hash mismatch for $target. Expected $($artifact.sha256), got $currentHash."
        }
    }
}

$manifest = [ordered]@{
    schemaVersion = "vtv-separator-install-v1"
    modelId = "bs-roformer-viperx-ep317-sdr12.9755"
    modelRoot = $ModelRoot
    artifacts = $artifacts
    license = "MIT"
    installedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $ModelRoot ".install-manifest.json") -Encoding utf8
Write-Host "Installed and verified pinned VTV separator at $ModelRoot"
