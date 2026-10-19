param(
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path.TrimEnd('\')
$removedBytes = [Int64]0
$removedItems = 0
$protectedRoots = @(
    (Join-Path $repoRoot "release\chromium\MagicBox\assistant"),
    (Join-Path $repoRoot "server\assistant"),
    (Join-Path $repoRoot "artifacts\private-agent-candidate-data")
) | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') }

function Assert-SafePath([string]$Path) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $prefix = $repoRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a path outside the workspace: $fullPath"
    }
    $currentPath = $fullPath
    while ($currentPath -and -not $currentPath.Equals($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $currentPath) {
            $item = Get-Item -LiteralPath $currentPath -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to clean through a link: $currentPath"
            }
        }
        $currentPath = Split-Path -Parent $currentPath
    }
    if (Test-Path -LiteralPath $fullPath -PathType Container) {
        $links = Get-ChildItem -LiteralPath $fullPath -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop
        if ($links) { throw "Refusing to clean a directory containing links: $fullPath" }
    }
    return $fullPath
}

function Measure-Bytes([string]$Path) {
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

function Queue-Removal([string]$Path) {
    $safePath = Assert-SafePath $Path
    $safePrefix = $safePath.TrimEnd('\') + [IO.Path]::DirectorySeparatorChar
    foreach ($protectedRoot in $protectedRoots) {
        $protectedPrefix = $protectedRoot + [IO.Path]::DirectorySeparatorChar
        $targetsProtectedRoot =
            $safePath.Equals($protectedRoot, [StringComparison]::OrdinalIgnoreCase) -or
            $safePath.StartsWith($protectedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            $protectedRoot.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase)
        if ($targetsProtectedRoot) {
            throw "Refusing to clean protected Private Agent assets: $safePath"
        }
    }
    if (-not (Test-Path -LiteralPath $safePath)) {
        return
    }
    $script:removedBytes += Measure-Bytes $safePath
    $script:removedItems += 1
    if ($WhatIf) {
        $sizeGb = [double](Measure-Bytes $safePath) / 1GB
        Write-Host ("Would remove {0} ({1:N2} GB)" -f $safePath, $sizeGb)
        return
    }
    Remove-Item -LiteralPath $safePath -Recurse -Force
    Write-Host "Removed $safePath"
}

# These are generated remnants of the retired desktop shells. The supported
# shell is desktop/WebView2Launcher.cs and the release package never consumes
# these files.
foreach ($relativePath in @(
    "release\winforms",
    "release\chromium\MagicBox\MagicBox-edge.exe",
    "release\chromium\MagicBox\FolderPicker.exe",
    "release\chromium\MagicBox\MagicBox-launch.log",
    "scripts\__pycache__",
    "server\__pycache__"
)) {
    Queue-Removal (Join-Path $repoRoot $relativePath)
}

# Voice caches can contain offline weights, and temp directories can belong to
# running workers. JSON alone cannot prove a training artifact is unreferenced
# now that profiles also use SQLite. Keep all voice data until an engine-aware,
# idle-only collector can establish reachability from every active store.

$verb = if ($WhatIf) { "Would reclaim" } else { "Reclaimed" }
Write-Host ("{0} {1:N2} GB from {2} generated/retired path(s)." -f $verb, ($removedBytes / 1GB), $removedItems)
Write-Host "Preserved all voice models, caches, downloads, temporary jobs, runtimes, and profile data (JSON and SQLite)."
Write-Host "Protected Private Agent databases, model weights, candidate data, and source modules from all cleanup targets."
