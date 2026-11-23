/**
 * The safety net for a promoted realm.
 *
 * While a realm's desktop is on the user's screen, the host is the only thing that can switch it
 * back. If the host crashes, is restarted, or simply stops answering, the user would be stranded on
 * a desktop with no shell and no taskbar. This watchdog is a separate process that watches a
 * heartbeat file the host refreshes every couple of seconds, and switches the screen back to
 * `Default` the moment the heartbeat stops.
 *
 * It is deliberately dumb: no JSON, no protocol, no dependency on the host being alive — one file's
 * timestamp and one Win32 call. It exits on its own as soon as the heartbeat file is gone, which is
 * what a normal `demote` does.
 */
export const DESKTOP_WATCHDOG_SCRIPT = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$BeatFile,
  [int]$TimeoutSeconds = 12
)

$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class EtaWatchdogDesk {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr OpenDesktopW(string name, int flags, bool inherit, uint access);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SwitchDesktop(IntPtr desktop);

    public static bool BackToDefault() {
        IntPtr desk = OpenDesktopW("Default", 0, false, 0x10000000);
        if (desk == IntPtr.Zero) return false;
        return SwitchDesktop(desk);
    }
}
"@

while ($true) {
  Start-Sleep -Seconds 2
  if (-not (Test-Path -LiteralPath $BeatFile)) { exit 0 }
  $age = (Get-Date) - (Get-Item -LiteralPath $BeatFile).LastWriteTime
  if ($age.TotalSeconds -gt $TimeoutSeconds) {
    $null = [EtaWatchdogDesk]::BackToDefault()
    exit 0
  }
}
`;
