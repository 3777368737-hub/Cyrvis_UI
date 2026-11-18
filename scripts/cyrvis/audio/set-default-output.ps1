param(
  [ValidateSet("headset", "speaker")]
  [string]$Kind = "speaker",
  [string]$Match,
  [switch]$List
)

# Switch the Windows default render endpoint for CYRVIS modes.
# headset: Bluetooth A2DP endpoint (the headset itself)
# speaker: Realtek analog speaker (host speakers), excluding S/PDIF/ToDesk
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY {
  public Guid fmtid;
  public int pid;
}

[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
public class PolicyConfigClient {}

[ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfig {
  int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr ppFormat);
  int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, bool bDefault, IntPtr ppFormat);
  int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName);
  int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr pEndpointFormat, IntPtr MixFormat);
  int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, bool bDefault, IntPtr pmftDefaultPeriod, IntPtr pmftMinimumPeriod);
  int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr pmftPeriod);
  int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr pMode);
  int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr mode);
  int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, bool bFxStore, ref PROPERTYKEY key, IntPtr pv);
  int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, bool bFxStore, ref PROPERTYKEY key, IntPtr pv);
  int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int role);
  int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, bool bVisible);
}

public static class AudioPolicy {
  public static int SetDefault(string deviceId, int role) {
    var type = Type.GetTypeFromCLSID(new Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9"));
    var client = (IPolicyConfig)Activator.CreateInstance(type);
    return client.SetDefaultEndpoint(deviceId, role);
  }
}
"@

$endpoints = Get-PnpDevice -Class AudioEndpoint -Status OK -ErrorAction SilentlyContinue |
  Where-Object { $_.InstanceId -like 'SWD\MMDEVAPI\{0.0.0.*' } |
  ForEach-Object {
    [pscustomobject]@{
      FriendlyName = $_.FriendlyName
      EndpointId = $_.InstanceId.Substring('SWD\MMDEVAPI\'.Length)
    }
  }

if ($List) {
  $endpoints | Sort-Object FriendlyName | Format-Table -AutoSize
  exit 0
}

$render = $endpoints |
  Where-Object { $_.FriendlyName -notlike '*Hands-Free*' }

if ($Match) {
  $target = $render | Where-Object { $_.FriendlyName -like "*$Match*" } |
    Select-Object -First 1
} elseif ($Kind -eq "headset") {
  $target = $render | Where-Object { $_.FriendlyName -like '*cc ultimate*' } |
    Select-Object -First 1
  if (-not $target) {
    $target = $render |
      Where-Object {
        $_.FriendlyName -notlike '*Realtek*' -and
        $_.FriendlyName -notlike '*NVIDIA*' -and
        $_.FriendlyName -notlike '*ToDesk*' -and
        $_.FriendlyName -notlike '*Digital*'
      } |
      Select-Object -First 1
  }
} else {
  $target = $render |
    Where-Object {
      $_.FriendlyName -like '*Realtek*' -and
      $_.FriendlyName -notlike '*Digital*' -and
      $_.FriendlyName -notlike '*ToDesk*'
    } |
    Select-Object -First 1
}

if (-not $target) {
  Write-Error "No matching render endpoint for Kind=$Kind Match=$Match"
  exit 1
}

$results = @()
# In speaker mode, leave the *communications* role on the headset. Setting all
# three roles to Realtek makes Windows tear down the Bluetooth HFP microphone,
# so the next capture restart finds "No physical microphone".
$roles = if ($Kind -eq "speaker" -and -not $Match) { @(0, 1) } else { @(0, 1, 2) }
foreach ($role in $roles) {
  $hr = [AudioPolicy]::SetDefault($target.EndpointId, $role)
  $results += "role=$role hr=$hr"
}
if ($Kind -eq "speaker" -and -not $Match) {
  $comm = $render | Where-Object { $_.FriendlyName -like '*cc ultimate*' } |
    Select-Object -First 1
  if (-not $comm) {
    $comm = $render |
      Where-Object {
        $_.FriendlyName -notlike '*Realtek*' -and
        $_.FriendlyName -notlike '*NVIDIA*' -and
        $_.FriendlyName -notlike '*ToDesk*' -and
        $_.FriendlyName -notlike '*Digital*'
      } |
      Select-Object -First 1
  }
  if ($comm) {
    $hr = [AudioPolicy]::SetDefault($comm.EndpointId, 2)
    $results += "role=2 (comm/headset) hr=$hr target=$($comm.FriendlyName)"
  }
}
Write-Output ("target: " + $target.FriendlyName)
Write-Output ("endpoint: " + $target.EndpointId)
$results | ForEach-Object { Write-Output $_ }
