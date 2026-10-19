param(
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path.TrimEnd('\')
$removedBytes = [Int64]0
$removedItems = 0

function Assert-SafeWorkspacePath([string]$Path) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $prefix = $repoRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a path outside the workspace: $fullPath"
    }
    return $fullPath
}

function Measure-PathBytes([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        return [Int64](Get-Item -LiteralPath $Path).Length
    }
    if (Test-Path -LiteralPath $Path -PathType Container) {
        $measurement = Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum
        $sum = if ($null -eq $measurement.Sum) { 0 } else { $measurement.Sum }
        return [Int64]$sum
    }
    return [Int64]0
}

function Remove-GeneratedPath([string]$Path) {
    $safePath = Assert-SafeWorkspacePath $Path
    if (-not (Test-Path -LiteralPath $safePath)) {
        return
    }
    $script:removedBytes += Measure-PathBytes $safePath
    $script:removedItems += 1
    if ($WhatIf) {
        Write-Host "Would remove $safePath"
        return
    }
    Remove-Item -LiteralPath $safePath -Recurse -Force
    Write-Host "Removed $safePath"
}

$generatedDirectories = @(
    "cache",
    "tmp-fine-output",
    "tmp-gpt-sovits-real",
    "tmp-vtv-analysis",
    "tmp-vtv-smoke",
    "release\installer\MagicBox"
)
foreach ($relativePath in $generatedDirectories) {
    Remove-GeneratedPath (Join-Path $repoRoot $relativePath)
}

$installerRoot = Join-Path $repoRoot "release\installer"
if (Test-Path -LiteralPath $installerRoot) {
    Get-ChildItem -LiteralPath $installerRoot -Force | Where-Object {
        $_.Name -like ".MagicBox-installing-*" -or
        $_.Name -like ".MagicBox-backup-*" -or
        $_.Name -like "*-smoke-install" -or
        $_.Name -eq "test-install"
    } | ForEach-Object { Remove-GeneratedPath $_.FullName }
}

Get-ChildItem -LiteralPath $repoRoot -Force -File | Where-Object {
    $_.Name -like "tmp-*.wav" -or $_.Name -like "magicbox-*.log"
} | ForEach-Object { Remove-GeneratedPath $_.FullName }

$verb = if ($WhatIf) { "Would reclaim" } else { "Reclaimed" }
Write-Host ("{0} {1:N1} MB from {2} generated path(s)." -f $verb, ($removedBytes / 1MB), $removedItems)
Write-Host "Preserved downloads, backups, node_modules, the final installer, voice profiles, and installed voice models."
