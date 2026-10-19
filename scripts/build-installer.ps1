param([switch]$Basic)
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\build-hash.ps1"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$portableDir = if ($Basic) { Join-Path $repoRoot "release\windows-basic\MagicBox" } else { Join-Path $repoRoot "release\chromium\MagicBox" }
$installerRoot = Join-Path $repoRoot "release\installer"
$packageDir = Join-Path $installerRoot "MagicBox"
$setupStub = Join-Path $installerRoot "MagicBoxSetup.stub.exe"
$payloadZip = Join-Path $installerRoot "MagicBox.payload.zip"
$version = (Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
$setupExe = Join-Path $installerRoot $(if ($Basic) { "MagicBox-Setup-$version-windows-x64-basic.exe" } else { "MagicBox-Setup-$version.exe" })
$webViewBootstrapper = Join-Path $repoRoot "vendor\MicrosoftEdgeWebView2Setup.exe"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path $csc)) {
    throw "The .NET Framework C# compiler was not found at $csc."
}
if (-not (Test-Path (Join-Path $portableDir "MagicBox.exe"))) {
    throw "The portable desktop build is missing. Run npm.cmd run desktop:webview2 first."
}
if (-not (Test-Path (Join-Path $portableDir "node.exe")) -or -not (Test-Path (Join-Path $portableDir "node_modules"))) {
    throw "The portable desktop build does not contain its Node.js runtime. Rebuild it before creating the installer."
}
if (-not (Test-Path $webViewBootstrapper)) {
    throw "The Microsoft WebView2 bootstrapper is missing at $webViewBootstrapper."
}

New-Item -ItemType Directory -Path $installerRoot -Force | Out-Null
foreach ($target in @($packageDir, $setupStub, $payloadZip, $setupExe)) {
    $resolvedParent = [IO.Path]::GetFullPath((Split-Path $target -Parent))
    if (-not $resolvedParent.StartsWith([IO.Path]::GetFullPath($installerRoot), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean an installer path outside $installerRoot."
    }
    if (Test-Path $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}
New-Item -ItemType Directory -Path $packageDir -Force | Out-Null

$payloadFiles = @(
    "MagicBox.exe",
    "MagicBox.FileOps.exe",
    "Microsoft.Web.WebView2.Core.dll",
    "Microsoft.Web.WebView2.WinForms.dll",
    "WebView2Loader.dll",
    "node.exe",
    "app-icon.ico",
    "app-icon.png",
    "package.json",
    "package-lock.json",
    "README.md"
)
if ($Basic) { $payloadFiles += @("basic-package.json", "assistant-package-manifest.json") }
foreach ($name in $payloadFiles) {
    $source = Join-Path $portableDir $name
    if (-not (Test-Path $source)) {
        throw "Required installer file is missing: $source"
    }
    Copy-Item -LiteralPath $source -Destination $packageDir -Force
}

$payloadDirectories = @("dist", "server", "shared", "scripts", "node_modules", "vendor", "docs")
if (-not $Basic) { $payloadDirectories += "artifacts" }
foreach ($name in $payloadDirectories) {
    $source = Join-Path $portableDir $name
    if (-not (Test-Path $source)) {
        throw "Required installer directory is missing: $source"
    }
    Copy-Item -LiteralPath $source -Destination $packageDir -Recurse -Force
}

& $csc `
    /nologo `
    /target:winexe `
    /platform:x64 `
    /win32icon:"$repoRoot\desktop\assets\app-icon.ico" `
    /out:"$packageDir\MagicBoxUninstall.exe" `
    /r:System.dll `
    /r:System.Core.dll `
    /r:System.Windows.Forms.dll `
    "$repoRoot\desktop\installer\MagicBoxUninstall.cs"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

[IO.File]::WriteAllText((Join-Path $packageDir "MagicBox.install"), "installed`r`n", [Text.Encoding]::ASCII)
$setupAssets = Join-Path $packageDir "_setup"
New-Item -ItemType Directory -Path $setupAssets -Force | Out-Null
Copy-Item -LiteralPath $webViewBootstrapper -Destination (Join-Path $setupAssets "MicrosoftEdgeWebView2Setup.exe") -Force
if ($Basic) {
    & (Join-Path $portableDir "node.exe") (Join-Path $repoRoot "scripts\verify-public-package.mjs") $packageDir
    if ($LASTEXITCODE -ne 0) { throw "Installer payload contains disallowed model/private-data assets." }
}

& $csc `
    /nologo `
    /target:winexe `
    /platform:x64 `
    /win32icon:"$repoRoot\desktop\assets\app-icon.ico" `
    /out:"$setupStub" `
    /r:System.dll `
    /r:System.Core.dll `
    /r:System.Drawing.dll `
    /r:System.IO.Compression.dll `
    /r:System.IO.Compression.FileSystem.dll `
    /r:System.Windows.Forms.dll `
    /r:Microsoft.CSharp.dll `
    "$repoRoot\desktop\installer\MagicBoxSetup.cs"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory(
    $packageDir,
    $payloadZip,
    [IO.Compression.CompressionLevel]::Optimal,
    $false
)

$output = [IO.File]::Open($setupExe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $stub = [IO.File]::OpenRead($setupStub)
    try { $stub.CopyTo($output) } finally { $stub.Dispose() }
    $payloadOffset = $output.Position
    $zip = [IO.File]::OpenRead($payloadZip)
    try {
        $payloadLength = $zip.Length
        $zip.CopyTo($output)
    } finally {
        $zip.Dispose()
    }
    $writer = New-Object IO.BinaryWriter($output, [Text.Encoding]::ASCII, $true)
    try {
        $writer.Write([Text.Encoding]::ASCII.GetBytes("MBXSETUP2026"))
        $writer.Write([Int64]$payloadOffset)
        $writer.Write([Int64]$payloadLength)
        $writer.Flush()
    } finally {
        $writer.Dispose()
    }
} finally {
    $output.Dispose()
}

Remove-Item -LiteralPath $setupStub, $payloadZip -Force
$setupItem = Get-Item -LiteralPath $setupExe
$hash = Get-BuildSha256 $setupExe
$setupSizeMb = $setupItem.Length / 1MB
Remove-Item -LiteralPath $packageDir -Recurse -Force
Write-Host "Built single-file installer: $setupExe"
Write-Host ("Size: {0:N1} MB" -f $setupSizeMb)
Write-Host "SHA256: $hash"
Write-Host "Removed temporary installer staging files."
