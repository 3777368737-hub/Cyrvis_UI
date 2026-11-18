# Start the local CYRVIS voiceprint sidecar on 127.0.0.1:8100.
$ErrorActionPreference = "Stop"
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"
$python = Join-Path $PSScriptRoot "..\..\..\..\showui-env\Scripts\python.exe"
if (-not (Test-Path $python)) {
  throw "Python environment not found: $python"
}
& $python (Join-Path $PSScriptRoot "app.py")
