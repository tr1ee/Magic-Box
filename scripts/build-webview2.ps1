param([switch]$Basic)
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$releaseDir = if ($Basic) { Join-Path $repoRoot "release\windows-basic\MagicBox" } else { Join-Path $repoRoot "release\chromium\MagicBox" }
$webView2Dir = Join-Path $repoRoot "vendor\Microsoft.Web.WebView2\1.0.4022.49"
$webView2Lib = Join-Path $webView2Dir "lib\net462"
$webView2Loader = Join-Path $webView2Dir "build\native\x64\WebView2Loader.dll"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$speechAssembly = Get-ChildItem (Join-Path $env:WINDIR "Microsoft.NET\assembly\GAC_MSIL\System.Speech") -Recurse -Filter "System.Speech.dll" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName

if (-not (Test-Path $csc)) {
    throw "The .NET Framework C# compiler was not found at $csc."
}

if (-not (Test-Path $webView2Lib) -or -not (Test-Path $webView2Loader)) {
    throw "The WebView2 SDK files are missing. Expected them under $webView2Dir."
}
if (-not $speechAssembly -or -not (Test-Path $speechAssembly)) {
    throw "Windows offline speech recognition is unavailable because System.Speech.dll was not found."
}

New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null

# Detect a running package before deleting any of its assets. Rebuilding under
# a live server can otherwise leave it mixing old code with new dependencies.
foreach ($binary in @("MagicBox.exe", "node.exe")) {
    $binaryPath = Join-Path $releaseDir $binary
    if (Test-Path -LiteralPath $binaryPath) {
        try {
            $probe = [IO.File]::Open($binaryPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $probe.Dispose()
        } catch {
            throw "Close MagicBox and its packaged server before rebuilding. The existing package was preserved: $binaryPath"
        }
    }
}

# All replaced trees must resolve inside the intended package, without junctions.
foreach ($relativePath in @("dist", "server", "node_modules", "shared", "scripts", "voice_clone\voice_engine\quality-evaluators", "vendor\python", "vendor\llama", "vendor\webview2-fixed")) {
    $targetPath = [IO.Path]::GetFullPath((Join-Path $releaseDir $relativePath))
    if (-not $targetPath.StartsWith(([IO.Path]::GetFullPath($releaseDir).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Package replacement escaped the release directory: $targetPath"
    }
    $currentPath = $targetPath
    while ($currentPath -and -not $currentPath.Equals($repoRoot.Path, [StringComparison]::OrdinalIgnoreCase)) {
        if ((Test-Path -LiteralPath $currentPath) -and ((Get-Item -LiteralPath $currentPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Package replacement rejects links: $currentPath"
        }
        $currentPath = Split-Path -Parent $currentPath
    }
}

$releaseDist = Join-Path $releaseDir "dist"
$releaseServer = Join-Path $releaseDir "server"
if (Test-Path $releaseDist) {
    Remove-Item -LiteralPath $releaseDist -Recurse -Force
}
if (Test-Path $releaseServer) {
    Remove-Item -LiteralPath $releaseServer -Recurse -Force
}
New-Item -ItemType Directory -Path $releaseDist -Force | Out-Null
New-Item -ItemType Directory -Path $releaseServer -Force | Out-Null

& $csc `
    /nologo `
    /target:winexe `
    /platform:x64 `
    /win32icon:"$repoRoot\desktop\assets\app-icon.ico" `
    /out:"$releaseDir\MagicBox.exe" `
    /r:System.Windows.Forms.dll `
    /r:System.Drawing.dll `
    /r:System.dll `
    /r:System.Core.dll `
    /r:"$speechAssembly" `
    /r:"$webView2Lib\Microsoft.Web.WebView2.Core.dll" `
    /r:"$webView2Lib\Microsoft.Web.WebView2.WinForms.dll" `
    "$repoRoot\desktop\WebView2Launcher.cs" `
    "$repoRoot\desktop\LauncherLogWriter.cs"

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& $csc `
    /nologo `
    /target:exe `
    /platform:x64 `
    /out:"$releaseDir\MagicBox.FileOps.exe" `
    /r:System.dll `
    /r:System.Core.dll `
    "$repoRoot\desktop\FileOps.cs"

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Copy-Item -Path `
    "$webView2Lib\Microsoft.Web.WebView2.Core.dll", `
    "$webView2Lib\Microsoft.Web.WebView2.WinForms.dll", `
    $webView2Loader `
    -Destination $releaseDir `
    -Force

$releaseDocs = Join-Path $releaseDir "docs"
New-Item -ItemType Directory -Path $releaseDocs -Force | Out-Null
foreach ($guide in @("USER_GUIDE.md", "DEVELOPMENT.md", "THIRD_PARTY.md", "macos.md")) {
    Copy-Item -LiteralPath (Join-Path $repoRoot "docs\$guide") -Destination $releaseDocs -Force
}

Copy-Item -Path "$repoRoot\dist\*" -Destination $releaseDist -Recurse -Force
Copy-Item -Path "$repoRoot\server\*" -Destination $releaseServer -Recurse -Force

# The evaluator weights and offline model assets are application assets, not
# per-user voice data. Package them beside the managed voice-engine runtimes so
# the server's default quality-evaluator path remains valid in a portable build.
$qualityEvaluatorSource = Join-Path $repoRoot "MagicBoxData\voice_clone\voice_engine\quality-evaluators"
$qualityEvaluatorTarget = Join-Path $releaseDir "voice_clone\voice_engine\quality-evaluators"
if (-not $Basic -and -not (Test-Path $qualityEvaluatorSource)) {
    throw "Voice quality evaluator assets are missing: $qualityEvaluatorSource"
}
if (-not $Basic -and (Test-Path $qualityEvaluatorTarget)) {
    Remove-Item -LiteralPath $qualityEvaluatorTarget -Recurse -Force
}
if (-not $Basic) {
    New-Item -ItemType Directory -Path (Split-Path $qualityEvaluatorTarget) -Force | Out-Null
    Copy-Item -LiteralPath $qualityEvaluatorSource -Destination (Split-Path $qualityEvaluatorTarget) -Recurse -Force
}

# The packaged server resolves release evidence relative to its own root. Keep
# the validated voice benchmark in the portable package so the health endpoint
# does not downgrade an otherwise ready local voice to Windows system voice.
$releaseArtifacts = Join-Path $releaseDir "artifacts"
if (-not $Basic) { New-Item -ItemType Directory -Path $releaseArtifacts -Force | Out-Null }
$voiceBenchmark = Join-Path $repoRoot "artifacts\live-voice-benchmark.json"
if (-not $Basic -and -not (Test-Path $voiceBenchmark)) {
    throw "The validated live voice benchmark is missing: $voiceBenchmark"
}
if (-not $Basic) { Copy-Item -LiteralPath $voiceBenchmark -Destination (Join-Path $releaseArtifacts "live-voice-benchmark.json") -Force }

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand -or -not (Test-Path $nodeCommand.Source)) {
    throw "Node.js was not found. Install Node.js before building the desktop package."
}
Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $releaseDir "node.exe") -Force

$sourceNodeModules = Join-Path $repoRoot "node_modules"
$releaseNodeModules = Join-Path $releaseDir "node_modules"
if (-not (Test-Path $sourceNodeModules)) {
    throw "node_modules is missing. Run npm.cmd install before building the desktop package."
}
& $nodeCommand.Source (Join-Path $repoRoot "scripts\copy-production-dependencies.mjs") $repoRoot $releaseDir
if ($LASTEXITCODE -ne 0) {
    throw "Production dependency packaging failed."
}

if (Test-Path "$repoRoot\shared") {
    if (Test-Path "$releaseDir\shared") {
        Remove-Item -Path "$releaseDir\shared" -Recurse -Force
    }
    Copy-Item -Path "$repoRoot\shared" -Destination $releaseDir -Recurse -Force
}
if (Test-Path "$repoRoot\scripts") {
    if (Test-Path "$releaseDir\scripts") {
        Remove-Item -Path "$releaseDir\scripts" -Recurse -Force
    }
    Copy-Item -Path "$repoRoot\scripts" -Destination $releaseDir -Recurse -Force
}

$managedWorkerCopies = @(
    @{
        Source = Join-Path $repoRoot "server\voice_engine_worker_openvoice.py"
        Target = Join-Path $releaseDir "voice_clone\voice_engine\runtime\openvoice_worker.py"
    },
    @{
        Source = Join-Path $repoRoot "server\voice_engine_worker_gpt_sovits.py"
        Target = Join-Path $releaseDir "voice_clone\voice_engine\gpt-sovits\runtime\gpt_sovits_worker.py"
    },
    @{
        Source = Join-Path $repoRoot "server\voice_engine_worker_seed_vc.py"
        Target = Join-Path $releaseDir "voice_clone\voice_engine\seed-vc\runtime\seed_vc_worker.py"
    },
      @{
          Source = Join-Path $repoRoot "server\voice_engine_worker_preparation.py"
          Target = Join-Path $releaseDir "voice_clone\voice_engine\preparation\runtime\voice_preparation_worker.py"
      },
      @{
          Source = Join-Path $repoRoot "server\live_voice_worker.py"
          Target = Join-Path $releaseDir "voice_clone\voice_engine\conversation\runtime\live_voice_worker.py"
      },
    @{
        Source = Join-Path $repoRoot "server\seed_vc_inference_wrapper.py"
        Target = Join-Path $releaseDir "voice_clone\voice_engine\seed-vc\runtime\seed_vc_inference_wrapper.py"
    }
)
foreach ($copy in $managedWorkerCopies) {
    if (-not $Basic -and (Test-Path $copy.Source)) {
        New-Item -ItemType Directory -Path (Split-Path $copy.Target) -Force | Out-Null
        Copy-Item -Path $copy.Source -Destination $copy.Target -Force
    }
}

if (-not $Basic -and (Test-Path "$repoRoot\vendor\python")) {
    New-Item -ItemType Directory -Path (Join-Path $releaseDir "vendor") -Force | Out-Null
    if (Test-Path "$releaseDir\vendor\python") {
        Remove-Item -Path "$releaseDir\vendor\python" -Recurse -Force
    }
    Copy-Item -Path "$repoRoot\vendor\python" -Destination (Join-Path $releaseDir "vendor") -Recurse -Force
}

$runtimeNames = if ($Basic) { @("llama") } else { @("llama", "webview2-fixed") }
foreach ($runtimeName in $runtimeNames) {
    $sourceRuntime = Join-Path $repoRoot "vendor\$runtimeName"
    if (-not (Test-Path $sourceRuntime)) {
        throw "Required Assistant runtime is missing: $sourceRuntime"
    }
    $releaseVendor = Join-Path $releaseDir "vendor"
    $releaseRuntime = Join-Path $releaseVendor $runtimeName
    New-Item -ItemType Directory -Path $releaseVendor -Force | Out-Null
    if (Test-Path $releaseRuntime) {
        Remove-Item -LiteralPath $releaseRuntime -Recurse -Force
    }
    Copy-Item -LiteralPath $sourceRuntime -Destination $releaseVendor -Recurse -Force
}

if ($Basic) {
    $ytDlpSource = Join-Path $repoRoot "vendor\python\bin\yt-dlp.exe"
    if (-not (Test-Path $ytDlpSource)) { throw "Standalone yt-dlp is missing. Run scripts/setup-windows-build.ps1 first." }
    $ytDlpTarget = Join-Path $releaseDir "vendor\python\bin"
    New-Item -ItemType Directory -Path $ytDlpTarget -Force | Out-Null
    Copy-Item -LiteralPath $ytDlpSource -Destination $ytDlpTarget -Force
    & $nodeCommand.Source (Join-Path $repoRoot "scripts\verify-public-package.mjs") $releaseDir --clean-caches
    if ($LASTEXITCODE -ne 0) { throw "Basic package model/private-data verification failed." }
    [IO.File]::WriteAllText((Join-Path $releaseDir "basic-package.json"), '{"edition":"basic","modelsBundled":false,"personalDataBundled":false}')
}

$ffmpegSource = Join-Path $repoRoot "node_modules\ffmpeg-static\ffmpeg.exe"
$ffprobeSource = Join-Path $repoRoot "node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe"
if (-not (Test-Path $ffprobeSource)) {
    $ffprobeSource = Join-Path $repoRoot "node_modules\ffprobe-static\bin\win32\ia32\ffprobe.exe"
}
if ((Test-Path $ffmpegSource) -and (Test-Path $ffprobeSource)) {
    $ffmpegBinDir = Join-Path $releaseDir "vendor\ffmpeg\bin"
    New-Item -ItemType Directory -Path $ffmpegBinDir -Force | Out-Null
    Copy-Item -Path $ffmpegSource -Destination (Join-Path $ffmpegBinDir "ffmpeg.exe") -Force
    Copy-Item -Path $ffprobeSource -Destination (Join-Path $ffmpegBinDir "ffprobe.exe") -Force
}

Copy-Item -Path `
    "$repoRoot\package.json", `
    "$repoRoot\package-lock.json", `
    "$repoRoot\README.md", `
    "$repoRoot\public\app-icon.ico", `
    "$repoRoot\public\app-icon.png" `
    -Destination $releaseDir `
    -Force

& (Join-Path $releaseDir "node.exe") (Join-Path $releaseDir "scripts\verify-production-dependencies.mjs") $releaseDir
if ($LASTEXITCODE -ne 0) {
    throw "Packaged production dependency verification failed."
}

& (Join-Path $releaseDir "node.exe") (Join-Path $repoRoot "scripts\generate-package-manifest.mjs") $releaseDir
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "Built WebView2 desktop app at $releaseDir\MagicBox.exe"
