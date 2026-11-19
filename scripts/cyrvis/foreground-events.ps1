Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class CyrvisForegroundEvents {
  public delegate void WinEventDelegate(
    IntPtr hWinEventHook,
    uint eventType,
    IntPtr hwnd,
    int idObject,
    int idChild,
    uint dwEventThread,
    uint dwmsEventTime
  );

  [DllImport("user32.dll")]
  public static extern IntPtr SetWinEventHook(
    uint eventMin,
    uint eventMax,
    IntPtr hmodWinEventProc,
    WinEventDelegate lpfnWinEventProc,
    uint idProcess,
    uint idThread,
    uint dwFlags
  );

  [DllImport("user32.dll")]
  public static extern bool UnhookWinEvent(IntPtr hWinEventHook);
}
"@

$script:lastHandle = [IntPtr]::Zero
$script:callback = [CyrvisForegroundEvents+WinEventDelegate]{
  param(
    [IntPtr]$hook,
    [uint32]$eventType,
    [IntPtr]$hwnd,
    [int]$idObject,
    [int]$idChild,
    [uint32]$thread,
    [uint32]$time
  )
  if ($eventType -eq 3 -and $idObject -eq 0 -and $idChild -eq 0) {
    if ($hwnd -ne $script:lastHandle) {
      $script:lastHandle = $hwnd
      [Console]::Out.WriteLine("foreground:$($hwnd.ToInt64())")
      [Console]::Out.Flush()
    }
  }
}

$script:hook = [CyrvisForegroundEvents]::SetWinEventHook(
  3,
  3,
  [IntPtr]::Zero,
  $script:callback,
  0,
  0,
  0
)
if ($script:hook -eq [IntPtr]::Zero) {
  throw 'SetWinEventHook failed'
}

$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.Opacity = 0
$form.Width = 1
$form.Height = 1
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Location = New-Object System.Drawing.Point(-10000, -10000)
[System.Windows.Forms.Application]::Run($form)
