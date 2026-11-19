# Bring the default browser window to the foreground after search_web opens a
# result page. Windows often opens the URL in an existing, minimized or
# background browser window without activating it.
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FocusBrowser {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$progId = ''
$userChoice = 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice'
try {
  if (Test-Path $userChoice) {
    $progId = (Get-ItemProperty $userChoice -ErrorAction SilentlyContinue).ProgId
  }
} catch {
  $progId = ''
}

$browserMap = @{
  'MSEdgeHTM'   = 'msedge'
  'ChromeHTML'  = 'chrome'
  'FirefoxURL'  = 'firefox'
  'BraveHTML'   = 'brave'
  'OperaStable' = 'opera'
  'VivaldiHTML' = 'vivaldi'
}
$preferred = $browserMap[$progId]
$processNames = @()
if ($preferred) {
  $processNames += $preferred
}
foreach ($name in @('msedge', 'chrome', 'firefox', 'brave', 'opera', 'vivaldi')) {
  if ($name -ne $preferred) {
    $processNames += $name
  }
}

$preferredPids = @()
$allPids = @()
foreach ($name in $processNames) {
  foreach ($proc in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
    $allPids += $proc.Id
    if ($name -eq $preferred) {
      $preferredPids += $proc.Id
    }
  }
}

$windows = New-Object System.Collections.ArrayList
$callback = {
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  $pidValue = 0
  [FocusBrowser]::GetWindowThreadProcessId($hWnd, [ref]$pidValue) | Out-Null
  if ($allPids -contains [int]$pidValue) {
    $title = New-Object System.Text.StringBuilder 512
    [FocusBrowser]::GetWindowText($hWnd, $title, 512) | Out-Null
    $rect = New-Object FocusBrowser+RECT
    [FocusBrowser]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
    [void]$windows.Add([pscustomobject]@{
      Handle = $hWnd
      Pid = [int]$pidValue
      Visible = [FocusBrowser]::IsWindowVisible($hWnd)
      Minimized = [FocusBrowser]::IsIconic($hWnd)
      Title = $title.ToString()
      Width = $rect.Right - $rect.Left
      Height = $rect.Bottom - $rect.Top
    })
  }
  return $true
}
[FocusBrowser]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null

$candidates = $windows | Where-Object {
  ($_.Visible -or $_.Minimized) -and
  $_.Title -and
  $_.Title -notlike '*GDI+*' -and
  $_.Title -notlike '*IME*' -and
  $_.Title -notlike '*MSCTFIME*'
}
if ($preferred) {
  # Do not focus a different browser while the default one is still starting.
  $target = $candidates | Where-Object { $preferredPids -contains $_.Pid } |
    Select-Object -First 1
} else {
  $target = $candidates | Select-Object -First 1
}
if (-not $target) {
  Write-Output '{"ok":false,"reason":"no-browser-window"}'
  exit 1
}

# Spoken searches should fill the screen. Restore first if the browser was
# minimized, then maximize; SW_MAXIMIZE is a no-op for an already maximized
# window, so this does not fight the user's existing layout.
if ([FocusBrowser]::IsIconic($target.Handle)) {
  [FocusBrowser]::ShowWindow($target.Handle, 9) | Out-Null
}
[FocusBrowser]::ShowWindow($target.Handle, 3) | Out-Null
[FocusBrowser]::BringWindowToTop($target.Handle) | Out-Null
$currentThread = [FocusBrowser]::GetCurrentThreadId()
$foreground = [FocusBrowser]::GetForegroundWindow()
$fgPid = 0
$targetPid = 0
$fgThread = [FocusBrowser]::GetWindowThreadProcessId($foreground, [ref]$fgPid)
$targetThread = [FocusBrowser]::GetWindowThreadProcessId($target.Handle, [ref]$targetPid)
[FocusBrowser]::AttachThreadInput($currentThread, $fgThread, $true) | Out-Null
[FocusBrowser]::AttachThreadInput($currentThread, $targetThread, $true) | Out-Null
$activated = [FocusBrowser]::SetForegroundWindow($target.Handle)
[FocusBrowser]::AttachThreadInput($currentThread, $targetThread, $false) | Out-Null
[FocusBrowser]::AttachThreadInput($currentThread, $fgThread, $false) | Out-Null

Start-Sleep -Milliseconds 150
$now = [FocusBrowser]::GetForegroundWindow()
$nowPid = 0
[FocusBrowser]::GetWindowThreadProcessId($now, [ref]$nowPid) | Out-Null
$ok = ($nowPid -eq $targetPid)
Write-Output ("{`"ok`":$($ok.ToString().ToLower()),`"activated`":$($activated.ToString().ToLower()),`"pid`":$targetPid,`"foregroundPid`":$nowPid,`"title`":$(ConvertTo-Json $target.Title -Compress)}")
if (-not $ok) {
  exit 1
}
