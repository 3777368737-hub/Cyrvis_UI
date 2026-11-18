$ErrorActionPreference = "Stop"
$env:PYTHONIOENCODING = "utf-8"
$env:SHOWUI_MODEL_DIR = "D:\Desktop\project\CYRVIS\models\ShowUI-2B"
$env:SHOWUI_PORT = "8000"
$env:SHOWUI_MAX_STEPS = "20"

$python = "D:\Desktop\project\CYRVIS\showui-env\Scripts\python.exe"
$app = Join-Path $PSScriptRoot "app.py"

Write-Host "ShowUI sidecar: $python $app"
& $python $app
