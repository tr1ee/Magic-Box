[CmdletBinding()]
param(
    [switch]$Wait,
    [switch]$ValidateOnly,
    [string]$DataRoot
)

$scriptContainer = Split-Path -Parent $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $scriptContainer "MagicBox.exe") -PathType Leaf) {
    # The script is being run from the copied packaged directory.
    $packageRoot = $scriptContainer
    $workspaceRoot = Split-Path (Split-Path (Split-Path $packageRoot -Parent) -Parent) -Parent
} else {
    # The script is being run from the source workspace.
    $workspaceRoot = Split-Path -Parent $PSScriptRoot
    $packageRoot = Join-Path $workspaceRoot "release\chromium\MagicBox"
}
$executablePath = Join-Path $packageRoot "MagicBox.exe"
$candidateDataRoot = if ($DataRoot) { [System.IO.Path]::GetFullPath($DataRoot) } else { Join-Path $workspaceRoot "artifacts\private-agent-candidate-data" }
$candidateModelId = "qwen2.5-1.5b-instruct-q4-k-m"
$candidateModelRoot = Join-Path $candidateDataRoot "models\$candidateModelId"

if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw "Packaged Magic Box executable was not found: $executablePath"
}
if (-not (Test-Path -LiteralPath $candidateModelRoot -PathType Container)) {
    throw "The disposable candidate data root is missing: $candidateModelRoot"
}

# This launcher is intentionally opt-in. It leaves the default packaged data root and active 9B model untouched.
$env:MAGIC_BOX_ASSISTANT_DATA_DIR = $candidateDataRoot
$env:ASSISTANT_VOICE_MODEL_ID = $candidateModelId

Write-Host "Launching the explicit voice-candidate configuration."
Write-Host "Data root: $candidateDataRoot"
Write-Host "Voice generation model: $candidateModelId"
Write-Host "Default packaged configuration is unchanged."

if ($ValidateOnly) {
    exit 0
}

if ($Wait) {
    & $executablePath
    exit $LASTEXITCODE
}

Start-Process -FilePath $executablePath -WorkingDirectory $packageRoot
