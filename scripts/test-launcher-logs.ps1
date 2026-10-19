$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    throw "The .NET Framework C# compiler was not found at $csc."
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("magic-box-launch-log-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
try {
    $harness = Join-Path $testRoot "LauncherLogWriterHarness.exe"
    & $csc `
        /nologo `
        /target:exe `
        /out:"$harness" `
        /r:System.dll `
        /r:System.Core.dll `
        "$repoRoot\desktop\LauncherLogWriter.cs" `
        "$repoRoot\test\LauncherLogWriterHarness.cs"
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    & $harness (Join-Path $testRoot "MagicBox-launch.log")
    if ($LASTEXITCODE -ne 0) {
        throw "Launcher log privacy harness failed with exit code $LASTEXITCODE."
    }
}
finally {
    if (Test-Path $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
