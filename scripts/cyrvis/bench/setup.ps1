param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("L1", "L4", "L5", "R1")]
  [string]$Task
)

$ErrorActionPreference = "Stop"
$bench = "D:\temp\cyrvis-bench"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profile = Join-Path $bench "chrome-profile"
$profileReal = Join-Path $bench "chrome-profile-real"
$server = "http://127.0.0.1:8765"

New-Item -ItemType Directory -Force -Path $bench | Out-Null

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class BenchFocus {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@

function Focus-Chrome {
  # AppActivate is often blocked by the foreground lock; clicking Chrome's
  # empty tab-strip area reliably gives it focus. Chrome is launched at 80,80.
  [void][BenchFocus]::SetCursorPos(400, 100)
  [BenchFocus]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [BenchFocus]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 700
}

function Reset-Fixture {
  try {
    Invoke-RestMethod -Uri "$server/reset" -TimeoutSec 5 | Out-Null
  } catch {
    throw "Fixture server is not running at $server. Start server.js first."
  }
}

function Stop-BenchChrome {
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -like "*cyrvis-bench*chrome-profile*" -or
      $_.CommandLine -like "*cyrvis-bench*chrome-profile-real*"
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  Start-Sleep -Milliseconds 900
}

function Start-Chrome([string]$ProfileDir, [string]$Url) {
  $args = @(
    "--user-data-dir=$ProfileDir",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--disable-extensions",
    "--disable-notifications",
    "--window-size=1200,900",
    "--window-position=80,80",
    $Url
  )
  Start-Process -FilePath $chrome -ArgumentList $args | Out-Null
  Start-Sleep -Seconds 2
}

function Focus-Window([string]$TitleLike) {
  $p = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -like "*$TitleLike*" } |
    Select-Object -First 1
  if (-not $p) {
    throw "Window not found: $TitleLike"
  }
  $ws = New-Object -ComObject WScript.Shell
  $null = $ws.AppActivate($p.Id)
  Start-Sleep -Milliseconds 700
  return $ws
}

switch ($Task) {
  "L1" {
    Set-Content -Path "$bench\l1-notepad.txt" -Value "PRE " -NoNewline
    Start-Process notepad.exe "$bench\l1-notepad.txt" | Out-Null
    Start-Sleep -Milliseconds 1600
    $ws = Focus-Window "l1-notepad.txt"
    $ws.SendKeys("^{END}")
    Start-Sleep -Milliseconds 500
  }
  "L4" {
    Reset-Fixture
    Stop-BenchChrome
    Start-Chrome $profile "$server/search.html"
    Focus-Chrome
  }
  "L5" {
    Reset-Fixture
    Stop-BenchChrome
    Set-Content -Path "$bench\code-target.txt" -Value "" -NoNewline
    Start-Process notepad.exe "$bench\code-target.txt" | Out-Null
    Start-Sleep -Milliseconds 1200
    Start-Chrome $profile "$server/code.html"
    Focus-Chrome
  }
  "R1" {
    Stop-BenchChrome
    Start-Chrome $profileReal "https://www.ctrip.com/"
    Start-Sleep -Seconds 2
    Focus-Chrome
  }
}

Write-Output "setup $Task done"
