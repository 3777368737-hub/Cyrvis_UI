param(
  [ValidateSet('edge', 'chrome')]
  [string]$Browser = 'edge',
  [int]$Port = 9222,
  [string]$ProfileDirectory = "$env:LOCALAPPDATA\CYRVIS\browser-profile"
)

$ErrorActionPreference = 'Stop'

if ($Port -lt 1024 -or $Port -gt 65535) {
  throw "Port must be between 1024 and 65535."
}

$endpoint = "http://127.0.0.1:$Port"
try {
  $existing = Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2
  Write-Output "Browser debugging already available: $($existing.Browser)"
  exit 0
} catch {
  # Start the browser below.
}

$candidates = if ($Browser -eq 'edge') {
  @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  )
} else {
  @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
}

$executable = $candidates |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
  Select-Object -First 1

if (-not $executable) {
  throw "Could not find the requested browser executable."
}

New-Item -ItemType Directory -Path $ProfileDirectory -Force | Out-Null
$arguments = @(
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=$Port",
  "--user-data-dir=$ProfileDirectory",
  'about:blank'
)

Start-Process -FilePath $executable -ArgumentList $arguments

for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  Start-Sleep -Milliseconds 250
  try {
    $version = Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 1
    Write-Output "Browser debugging ready: $($version.Browser)"
    Write-Output "CYRVIS_BROWSER_DEBUG_URL=$endpoint"
    exit 0
  } catch {
    # Keep waiting for the DevTools endpoint.
  }
}

throw "Browser started but the DevTools endpoint did not become available."
