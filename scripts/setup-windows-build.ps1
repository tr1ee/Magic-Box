$ErrorActionPreference = "Stop"
. "$PSScriptRoot\build-hash.ps1"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$cacheDir = Join-Path $repoRoot ".cache\windows-build"
New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null

function Get-VerifiedDownload($Url, $Destination, $Sha256) {
    if (-not (Test-Path -LiteralPath $Destination)) {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile ($Destination + ".download")
        Move-Item -LiteralPath ($Destination + ".download") -Destination $Destination -Force
    }
    if ((Get-BuildSha256 $Destination) -ne $Sha256) {
        throw "Download checksum mismatch: $Destination"
    }
}

$sdk = Join-Path $repoRoot "vendor\Microsoft.Web.WebView2\1.0.4022.49"
if (-not (Test-Path (Join-Path $sdk "lib\net462\Microsoft.Web.WebView2.Core.dll"))) {
    $sdkZip = Join-Path $cacheDir "webview2-sdk.zip"
    Get-VerifiedDownload "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4022.49/microsoft.web.webview2.1.0.4022.49.nupkg" $sdkZip "ee9de67e5bb9ef3a96c5689b2efc8188e2df160a0e79234c0404243782fde5fb"
    Expand-Archive -LiteralPath $sdkZip -DestinationPath $sdk -Force
}
$catalog = Get-Content (Join-Path $repoRoot "server\assistant\model-catalog.json") -Raw | ConvertFrom-Json
$runtime = Join-Path $repoRoot "vendor\llama\b9637"
$runtimeValid = $true
foreach ($file in $catalog.runtime.requiredFiles.PSObject.Properties) {
    $target = Join-Path $runtime $file.Name
    if (-not (Test-Path $target) -or (Get-BuildSha256 $target) -ne $file.Value) { $runtimeValid = $false; break }
}
if (-not $runtimeValid) {
    $llamaZip = Join-Path $cacheDir "llama-b9637.zip"
    Get-VerifiedDownload $catalog.runtime.source $llamaZip $catalog.runtime.sha256
    Expand-Archive -LiteralPath $llamaZip -DestinationPath $runtime -Force
    foreach ($file in $catalog.runtime.requiredFiles.PSObject.Properties) {
        if ((Get-BuildSha256 (Join-Path $runtime $file.Name)) -ne $file.Value) { throw "Inference runtime verification failed: $($file.Name)" }
    }
}
$videoDir = Join-Path $repoRoot "vendor\python\bin"
New-Item -ItemType Directory -Path $videoDir -Force | Out-Null
Get-VerifiedDownload "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe" (Join-Path $videoDir "yt-dlp.exe") "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a"

$bootstrapper = Join-Path $repoRoot "vendor\MicrosoftEdgeWebView2Setup.exe"
if (-not (Test-Path $bootstrapper)) {
    Invoke-WebRequest -UseBasicParsing "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $bootstrapper
}
$signature = Get-AuthenticodeSignature -LiteralPath $bootstrapper
if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "Microsoft Corporation") { throw "WebView2 bootstrapper is not signed by Microsoft." }
Write-Host "Windows basic build prerequisites are ready. No model weights were downloaded."
