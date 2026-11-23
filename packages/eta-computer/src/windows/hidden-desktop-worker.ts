/**
 * The PowerShell worker a hidden-desktop session runs in.
 *
 * One long-lived `powershell.exe` per realm holds the Win32 handles (the created desktop, the
 * target's window) and the UI Automation objects, so a realm does not pay for a fresh process
 * on every observation. It speaks one JSON object per line on stdin and answers one JSON object
 * per line on stdout.
 *
 * What it does, and deliberately does not do:
 * - `CreateDesktopW` + `STARTUPINFO.lpDesktop`, never `SwitchDesktop`: the desktop is never made
 *   the input desktop, so nothing appears on the user's screen and focus never moves.
 * - `PrintWindow(PW_RENDERFULLCONTENT)` for frames: measured on this machine, a Windows 11
 *   Notepad on a non-active desktop captures with its real pixels (not black).
 * - Input through UI Automation (`ValuePattern` for text) and posted window messages
 *   (`WM_LBUTTONDOWN`/`WM_LBUTTONUP`, `WM_CHAR`, `WM_KEYDOWN`), never global `SendInput`.
 * - No clipboard: `Ctrl+C`/`Ctrl+V` are answered from the realm's own VirtualClipboard by the
 *   driver, so the host clipboard is never read or written.
 */
export const HIDDEN_DESKTOP_WORKER_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# stdin/stdout are redirected pipes, so the console codepage (an OEM one) would mangle any
# non-ASCII text in requests and replies. Both ends are UTF-8, so read and write explicitly.
$utf8 = New-Object System.Text.UTF8Encoding $false
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class EtaDesktop {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr OpenDesktopW(string name, int flags, bool inherit, uint access);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenInputDesktop(int flags, bool inherit, uint access);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SwitchDesktop(IntPtr desktop);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumDesktopWindows(IntPtr desktop, EnumProc cb, IntPtr lparam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ScreenToClient(IntPtr hwnd, ref POINT pt);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int max);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder name, int max);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    /// The name of the desktop the screen is on right now, or "" when it cannot be read.
    public static string InputDesktopName() {
        IntPtr desk = OpenInputDesktop(0, false, 0x0100);
        if (desk == IntPtr.Zero) { return ""; }
        try {
            var name = new StringBuilder(256);
            int needed;
            if (!GetUserObjectInformationW(desk, 2, name, name.Capacity * 2, out needed)) { return ""; }
            return name.ToString();
        } finally {
            CloseDesktop(desk);
        }
    }

    [DllImport("kernel32.dll")]
    public static extern bool TerminateProcess(IntPtr process, uint code);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);

    public static IntPtr LargestWindow(IntPtr desktop, int preferredPid) {
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        IntPtr bestOwned = IntPtr.Zero;
        long bestOwnedArea = 0;
        EnumDesktopWindows(desktop, delegate(IntPtr hwnd, IntPtr lparam) {
            RECT r;
            if (!GetWindowRect(hwnd, out r)) return true;
            long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
            if (area < 2500) return true;
            // Helper windows (splash screens, DPI stubs such as "__wgLDummyWindowFodder", launcher
            // shadows) are often the largest thing on a freshly attached desktop; adopting one would
            // stream a blank picture and send every click to a window the app does not use.
            if (!IsWindowVisible(hwnd)) return true;
            var title = new StringBuilder(512);
            GetWindowTextW(hwnd, title, 512);
            var text = title.ToString();
            if (text.Length == 0) return true;
            if (text.StartsWith("__wg", StringComparison.Ordinal)) return true;
            if (text.IndexOf("Dummy", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (area > bestArea) { bestArea = area; best = hwnd; }
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (preferredPid != 0 && (int)pid == preferredPid && area > bestOwnedArea) {
                bestOwnedArea = area;
                bestOwned = hwnd;
            }
            return true;
        }, IntPtr.Zero);
        return bestOwned != IntPtr.Zero ? bestOwned : best;
    }

    public static string Describe(IntPtr hwnd) {
        var cls = new StringBuilder(256);
        GetClassNameW(hwnd, cls, 256);
        var title = new StringBuilder(512);
        GetWindowTextW(hwnd, title, 512);
        return cls.ToString() + "\u0001" + title.ToString();
    }

    public static bool FitToViewport(IntPtr hwnd, int width, int height) {
        if (width < 200 || height < 200) return false;
        // Restore from maximized/minimized before positioning so the entire window fits inside the
        // requested viewport instead of being silently cropped by PrintWindow.
        ShowWindow(hwnd, 9); // SW_RESTORE
        // SWP_NOZORDER (0x0004) | SWP_NOACTIVATE (0x0010)
        return SetWindowPos(hwnd, IntPtr.Zero, 0, 0, width, height, 0x0014);
    }

    public static POINT WindowToClient(IntPtr hwnd, int winX, int winY) {
        RECT r;
        if (!GetWindowRect(hwnd, out r)) {
            POINT raw; raw.X = winX; raw.Y = winY; return raw;
        }
        POINT pt;
        pt.X = r.Left + winX;
        pt.Y = r.Top + winY;
        ScreenToClient(hwnd, ref pt);
        return pt;
    }

    public static void ActivateWindow(IntPtr hwnd) {
        PostMessageW(hwnd, 0x0006, (IntPtr)1, IntPtr.Zero);                      // WM_ACTIVATE (WA_ACTIVE)
        PostMessageW(hwnd, 0x0007, IntPtr.Zero, IntPtr.Zero);                    // WM_SETFOCUS
    }

    public static bool Move(IntPtr hwnd, int winX, int winY) {
        POINT pt = WindowToClient(hwnd, winX, winY);
        IntPtr lp = (IntPtr)((pt.Y << 16) | (pt.X & 0xFFFF));
        return PostMessageW(hwnd, 0x0200, IntPtr.Zero, lp);                      // WM_MOUSEMOVE
    }

    public static bool Click(IntPtr hwnd, int winX, int winY, string button, bool doubleClick) {
        POINT pt = WindowToClient(hwnd, winX, winY);
        IntPtr lp = (IntPtr)((pt.Y << 16) | (pt.X & 0xFFFF));
        ActivateWindow(hwnd);
        if (!PostMessageW(hwnd, 0x0200, IntPtr.Zero, lp)) return false;          // WM_MOUSEMOVE
        uint down = 0x0201; uint up = 0x0202; uint dbl = 0x0203; int wp = 1;
        if (button == "right") { down = 0x0204; up = 0x0205; dbl = 0x0206; wp = 2; }
        else if (button == "middle") { down = 0x0207; up = 0x0208; dbl = 0x0209; wp = 16; }
        if (!PostMessageW(hwnd, down, (IntPtr)wp, lp)) return false;
        if (!PostMessageW(hwnd, up, IntPtr.Zero, lp)) return false;
        if (doubleClick) {
            if (!PostMessageW(hwnd, dbl, (IntPtr)wp, lp)) return false;
            return PostMessageW(hwnd, up, IntPtr.Zero, lp);
        }
        return true;
    }

    public static bool CharTo(IntPtr hwnd, int ch) {
        return PostMessageW(hwnd, 0x0102, (IntPtr)ch, IntPtr.Zero);              // WM_CHAR
    }

    public static bool KeyTo(IntPtr hwnd, int vk) {
        PostMessageW(hwnd, 0x0100, (IntPtr)vk, IntPtr.Zero);                     // WM_KEYDOWN
        return PostMessageW(hwnd, 0x0101, (IntPtr)vk, IntPtr.Zero);              // WM_KEYUP
    }

    public static bool KeyChord(IntPtr hwnd, int[] mods, int vk) {
        ActivateWindow(hwnd);
        foreach (int m in mods) { PostMessageW(hwnd, 0x0100, (IntPtr)m, IntPtr.Zero); }
        PostMessageW(hwnd, 0x0100, (IntPtr)vk, IntPtr.Zero);
        bool ok = PostMessageW(hwnd, 0x0101, (IntPtr)vk, IntPtr.Zero);
        for (int i = mods.Length - 1; i >= 0; i--) { PostMessageW(hwnd, 0x0101, (IntPtr)mods[i], IntPtr.Zero); }
        return ok;
    }

    public static bool Wheel(IntPtr hwnd, int delta) {
        IntPtr wp = (IntPtr)((delta & 0xFFFF) << 16);
        return PostMessageW(hwnd, 0x020A, wp, IntPtr.Zero);                      // WM_MOUSEWHEEL
    }
}
"@

function Write-Reply($obj) {
  $obj["id"] = $script:currentId
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  $stdout.WriteLine($json)
  $stdout.Flush()
}

function Get-Editable([IntPtr]$hwnd) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) { return $null }
  foreach ($type in @([System.Windows.Automation.ControlType]::Edit, [System.Windows.Automation.ControlType]::Document)) {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
    $found = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($null -ne $found) { return $found }
  }
  return $null
}

$state = @{ desktop = [IntPtr]::Zero; hwnd = [IntPtr]::Zero; process = [IntPtr]::Zero; pid = 0; name = ""; width = 1280; height = 800; overlay = [IntPtr]::Zero; returnDesktop = [IntPtr]::Zero; selectAll = $false }

while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq "") { continue }
  try {
    $request = $line | ConvertFrom-Json
  } catch {
    Write-Reply @{ ok = $false; error = "bad_request" }
    continue
  }
  $script:currentId = $request.id

  try {
    switch ($request.cmd) {
      "launch" {
        $state.name = [string]$request.desktop
        $state.width = [int]$request.width
        $state.height = [int]$request.height
        $desktop = [EtaDesktop]::CreateDesktopW($state.name, [IntPtr]::Zero, [IntPtr]::Zero, 0, 0x10000000, [IntPtr]::Zero)
        if ($desktop -eq [IntPtr]::Zero) {
          Write-Reply @{ ok = $false; error = "create_desktop_failed"; code = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
          continue
        }
        $state.desktop = $desktop
        $si = New-Object EtaDesktop+STARTUPINFO
        $si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
        $si.lpDesktop = $state.name
        $si.dwFlags = 0x00000001
        $si.wShowWindow = 1
        $pi = New-Object EtaDesktop+PROCESS_INFORMATION
        $target = [string]$request.target
        # A bare name has to be looked up first: CreateProcessW takes the application path, not a
        # PATH search, and an empty working directory is itself invalid (Win32 123).
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
          $found = Get-Command -Name $target -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
          if ($null -ne $found) {
            $target = $found.Source
          } else {
            # Also check Windows App Paths registry and common Program Files install locations so
            # desktop apps not on PATH (e.g. blender.exe) launch directly by bare name.
            $exeName = if ($target.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) { $target } else { "$target.exe" }
            foreach ($hive in @("HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exeName", "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exeName")) {
              if (Test-Path -LiteralPath $hive) {
                $val = (Get-ItemProperty -LiteralPath $hive -ErrorAction SilentlyContinue).'(default)'
                if ($val -and (Test-Path -LiteralPath $val -PathType Leaf)) { $target = $val; break }
              }
            }
            if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
              $stem = [System.IO.Path]::GetFileNameWithoutExtension($exeName)
              $pf86 = [System.Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
              foreach ($root in @($env:ProgramFiles, $pf86, (Join-Path $env:LOCALAPPDATA "Programs"))) {
                if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
                $match = Get-ChildItem -LiteralPath $root -Directory -Filter "*$stem*" -ErrorAction SilentlyContinue |
                  ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter $exeName -Recurse -Depth 2 -ErrorAction SilentlyContinue } |
                  Select-Object -First 1
                if ($null -ne $match) { $target = $match.FullName; break }
              }
            }
          }
        }
        $workingDirectory = Split-Path -Parent $target
        if ([string]::IsNullOrEmpty($workingDirectory)) { $workingDirectory = $env:SystemRoot }
        $arguments = @($request.args)
        $quotedArgs = @()
        foreach ($a in $arguments) {
          $s = [string]$a
          if ($s -match '[\s"]') {
            $quotedArgs += '"' + ($s -replace '"', '\"') + '"'
          } else {
            $quotedArgs += $s
          }
        }
        $cmdLine = if ($quotedArgs.Count -gt 0) { '"' + $target + '" ' + ($quotedArgs -join " ") } else { $null }
        $created = [EtaDesktop]::CreateProcessW($target, $cmdLine, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0x00000010, [IntPtr]::Zero, $workingDirectory, [ref]$si, [ref]$pi)
        if (-not $created) {
          Write-Reply @{ ok = $false; error = "create_process_failed"; code = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
          continue
        }
        $state.process = $pi.hProcess
        $state.pid = $pi.dwProcessId
        $hwnd = [IntPtr]::Zero
        for ($i = 0; $i -lt 60 -and $hwnd -eq [IntPtr]::Zero; $i++) {
          Start-Sleep -Milliseconds 200
          $hwnd = [EtaDesktop]::LargestWindow($state.desktop, $state.pid)
        }
        if ($hwnd -eq [IntPtr]::Zero) {
          Write-Reply @{ ok = $false; error = "window_not_found"; pid = $state.pid }
          continue
        }
        $state.hwnd = $hwnd
        $null = [EtaDesktop]::FitToViewport($hwnd, $state.width, $state.height)
        Start-Sleep -Milliseconds 150
        $parts = [EtaDesktop]::Describe($hwnd).Split([char]1)
        $rect = New-Object EtaDesktop+RECT
        $null = [EtaDesktop]::GetWindowRect($hwnd, [ref]$rect)
        Write-Reply @{
          ok = $true; pid = $state.pid; hwnd = [int64]$hwnd
          className = $parts[0]; title = $parts[1]
          width = [math]::Max($rect.Right - $rect.Left, 1); height = [math]::Max($rect.Bottom - $rect.Top, 1)
        }
      }
      "attach" {
        # Adopt a desktop and the app still running on it, after the host that launched them lost
        # the realm (a host restart, a crash). Nothing is created and nothing is ended: the window
        # that keeps the user's unsaved work simply gets its realm back.
        $state.name = [string]$request.desktop
        $state.width = [int]$request.width
        $state.height = [int]$request.height
        $desktop = [EtaDesktop]::OpenDesktopW($state.name, 0, $false, 0x00000001 -bor 0x00000002 -bor 0x00000008 -bor 0x00000100)
        if ($desktop -eq [IntPtr]::Zero) {
          Write-Reply @{ ok = $false; error = "open_desktop_failed"; code = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
          continue
        }
        $state.desktop = $desktop
        $hwnd = [EtaDesktop]::LargestWindow($state.desktop, 0)
        if ($hwnd -eq [IntPtr]::Zero) {
          $null = [EtaDesktop]::CloseDesktop($state.desktop)
          $state.desktop = [IntPtr]::Zero
          Write-Reply @{ ok = $false; error = "window_gone" }
          continue
        }
        $ownerPid = 0
        $null = [EtaDesktop]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
        $state.hwnd = $hwnd
        $state.pid = [int]$ownerPid
        $parts = [EtaDesktop]::Describe($hwnd).Split([char]1)
        $rect = New-Object EtaDesktop+RECT
        $null = [EtaDesktop]::GetWindowRect($hwnd, [ref]$rect)
        Write-Reply @{
          ok = $true; pid = $state.pid; hwnd = [int64]$hwnd
          className = $parts[0]; title = $parts[1]
          width = [math]::Max($rect.Right - $rect.Left, 1); height = [math]::Max($rect.Bottom - $rect.Top, 1)
        }
      }
      "capture" {
        if ($state.hwnd -eq [IntPtr]::Zero -or -not [EtaDesktop]::IsWindow($state.hwnd)) {
          $state.hwnd = [EtaDesktop]::LargestWindow($state.desktop, $state.pid)
          if ($state.hwnd -eq [IntPtr]::Zero) { Write-Reply @{ ok = $false; error = "window_gone" }; continue }
        }
        $rect = New-Object EtaDesktop+RECT
        $null = [EtaDesktop]::GetWindowRect($state.hwnd, [ref]$rect)
        $w = [math]::Max($rect.Right - $rect.Left, 1)
        $h = [math]::Max($rect.Bottom - $rect.Top, 1)
        # If the app opened larger than requested (e.g. maximized 2560x1600), resize it once to fit
        # the viewport so PrintWindow never silently crops the right/bottom edges.
        if ($w -gt $state.width -or $h -gt $state.height) {
          $null = [EtaDesktop]::FitToViewport($state.hwnd, $state.width, $state.height)
          Start-Sleep -Milliseconds 80
          $null = [EtaDesktop]::GetWindowRect($state.hwnd, [ref]$rect)
          $w = [math]::Max($rect.Right - $rect.Left, 1)
          $h = [math]::Max($rect.Bottom - $rect.Top, 1)
        }
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        $painted = [EtaDesktop]::PrintWindow($state.hwnd, $hdc, 2)
        $g.ReleaseHdc($hdc)
        $g.Dispose()
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $base64 = [Convert]::ToBase64String($ms.ToArray())
        $parts = [EtaDesktop]::Describe($state.hwnd).Split([char]1)
        Write-Reply @{ ok = $true; base64 = $base64; width = $w; height = $h; painted = $painted; title = $parts[1] }
      }
      "type" {
        $text = [string]$request.text
        $edit = Get-Editable $state.hwnd
        $editHwnd = [IntPtr]::Zero
        $isDocument = $false
        if ($null -ne $edit) {
          try { $editHwnd = [IntPtr]$edit.Current.NativeWindowHandle } catch { $editHwnd = [IntPtr]::Zero }
          try { $isDocument = ($edit.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) } catch { $isDocument = $false }
        }
        $how = "none"
        $enterHandled = $false
        if ($null -ne $edit) {
          $pattern = $null
          if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
            $current = ""
            if (-not $state.selectAll) {
              try { $current = [string]$pattern.Current.Value } catch { $current = "" }
            }
            $state.selectAll = $false
            $payload = $text
            # A document control takes text, not keystrokes: an Enter it is asked to end with
            # belongs inside the value. Posting VK_RETURN to the frame leaves Notepad on one line.
            if ($request.submit -and $isDocument) {
              $payload = $text + [string][char]13 + [string][char]10
              $enterHandled = $true
            }
            $pattern.SetValue($current + $payload)
            $how = "value"
          }
        }
        if ($how -eq "none") {
          $state.selectAll = $false
          $child = [EtaDesktop]::FindWindowExW($state.hwnd, [IntPtr]::Zero, "Edit", $null)
          if ($child -eq [IntPtr]::Zero) { $child = [EtaDesktop]::FindWindowExW($state.hwnd, [IntPtr]::Zero, "RichEdit20W", $null) }
          if ($child -ne [IntPtr]::Zero) {
            foreach ($ch in $text.ToCharArray()) { $null = [EtaDesktop]::CharTo($child, [int][char]$ch) }
            $how = "wm_char"
            if ($editHwnd -eq [IntPtr]::Zero) { $editHwnd = $child }
          }
        }
        if ($request.submit -and -not $enterHandled) {
          # Other controls read a line break as a keystroke; a document's own hwnd takes the
          # character, so try that first and fall back to the frame.
          if ($editHwnd -ne [IntPtr]::Zero -and [EtaDesktop]::CharTo($editHwnd, 13)) {
            $enterHandled = $true
          } else {
            $null = [EtaDesktop]::KeyTo($state.hwnd, 13)
          }
        }
        Write-Reply @{ ok = ($how -ne "none"); how = $how }
      }
      "overlay" {
        # The in-realm overlay (switch back + quick chat) is its own STA process on the realm
        # desktop, so a WinForms message loop never competes with this worker's command loop.
        $overlayScript = [string]$request.script
        $exe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
        $overlayArgs = @("-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", ('"' + $overlayScript + '"'))
        if ($request.chatFile) { $overlayArgs += @("-ChatFile", ('"' + [string]$request.chatFile + '"')) }
        if ($request.statusFile) { $overlayArgs += @("-StatusFile", ('"' + [string]$request.statusFile + '"')) }
        if ($request.readyFile) { $overlayArgs += @("-ReadyFile", ('"' + [string]$request.readyFile + '"')) }
        if ($request.title) { $overlayArgs += @("-Title", ('"' + [string]$request.title + '"')) }
        $overlayCmd = '"' + $exe + '" ' + ($overlayArgs -join " ")
        $osi = New-Object EtaDesktop+STARTUPINFO
        $osi.cb = [Runtime.InteropServices.Marshal]::SizeOf($osi)
        $osi.lpDesktop = $state.name
        $osi.dwFlags = 0x00000001
        $osi.wShowWindow = 1
        $opi = New-Object EtaDesktop+PROCESS_INFORMATION
        $started = [EtaDesktop]::CreateProcessW($exe, $overlayCmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0x00000010, [IntPtr]::Zero, $env:SystemRoot, [ref]$osi, [ref]$opi)
        if (-not $started) {
          Write-Reply @{ ok = $false; error = "overlay_failed"; code = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
          continue
        }
        $state.overlay = $opi.hProcess
        Write-Reply @{ ok = $true; pid = $opi.dwProcessId }
      }
      "promote" {
        # Never put the user in front of a desktop whose app has died: the overlay would be the only
        # thing on screen, with nothing to show and no way to use it.
        if ($state.hwnd -eq [IntPtr]::Zero -or -not [EtaDesktop]::IsWindow($state.hwnd)) {
          Write-Reply @{ ok = $false; error = "window_gone" }
          continue
        }
        # Remember the desktop the user is on now, so demote returns them exactly there.
        $current = [EtaDesktop]::OpenInputDesktop(0, $false, 0x10000000)
        if ($current -ne [IntPtr]::Zero) { $state.returnDesktop = $current }
        $switched = [EtaDesktop]::SwitchDesktop($state.desktop)
        if (-not $switched) {
          $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
          Write-Reply @{ ok = $false; error = "switch_desktop_failed"; code = $code }
          continue
        }
        # SwitchDesktop only says the request was accepted. Read the input desktop back, so a
        # listener that was not really moved is reported instead of honoured: the panel claims
        # "Shown on your screen" from this reply.
        $null = Start-Sleep -Milliseconds 150
        $live = [EtaDesktop]::InputDesktopName()
        if ($live -ne $state.name) {
          Write-Reply @{ ok = $false; error = "switch_not_visible"; actual = $live }
          continue
        }
        Write-Reply @{ ok = $true }
      }
      "demote" {
        $back = $state.returnDesktop
        if ($back -eq [IntPtr]::Zero) { $back = [EtaDesktop]::OpenDesktopW("Default", 0, $false, 0x10000000) }
        if ($back -eq [IntPtr]::Zero) {
          Write-Reply @{ ok = $false; error = "open_default_failed"; code = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
          continue
        }
        $switched = [EtaDesktop]::SwitchDesktop($back)
        if ($state.returnDesktop -ne [IntPtr]::Zero) {
          $null = [EtaDesktop]::CloseDesktop($state.returnDesktop)
          $state.returnDesktop = [IntPtr]::Zero
        } else {
          $null = [EtaDesktop]::CloseDesktop($back)
        }
        if (-not $switched) {
          Write-Reply @{ ok = $false; error = "switch_back_failed"; code = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
          continue
        }
        Write-Reply @{ ok = $true }
      }
      "close_overlay" {
        $killed = $false
        if ($state.overlay -ne [IntPtr]::Zero) {
          try {
            $null = [EtaDesktop]::TerminateProcess($state.overlay, 0)
            $killed = $true
          } catch { $killed = $false }
          $null = [EtaDesktop]::CloseHandle($state.overlay)
          $state.overlay = [IntPtr]::Zero
        }
        Write-Reply @{ ok = $true; killed = $killed }
      }
      "key" {
        $map = @{
          "enter" = 13; "return" = 13; "tab" = 9; "escape" = 27; "esc" = 27; "space" = 32;
          "backspace" = 8; "delete" = 46; "up" = 38; "down" = 40; "left" = 37; "right" = 39;
          "home" = 36; "end" = 35; "pageup" = 33; "pagedown" = 34;
          "f1" = 112; "f2" = 113; "f3" = 114; "f4" = 115; "f5" = 116; "f6" = 117;
          "f7" = 118; "f8" = 119; "f9" = 120; "f10" = 121; "f11" = 122; "f12" = 123
        }
        $raw = ([string]$request.key).Trim()
        $name = $raw.ToLowerInvariant()
        $hasCtrl = ($name -match "(^|\+)(control|ctrl|meta)\+")
        $hasShift = ($name -match "(^|\+)shift\+")
        $hasAlt = ($name -match "(^|\+)alt\+")
        $shortcut = $raw -replace "(?i)(control|ctrl|meta|alt|shift)\+", ""
        $shortLower = $shortcut.ToLowerInvariant()

        $edit = Get-Editable $state.hwnd
        $pattern = $null
        $hasValue = ($null -ne $edit -and $edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern))
        $editHwnd = [IntPtr]::Zero
        if ($null -ne $edit) {
          try { $editHwnd = [IntPtr]$edit.Current.NativeWindowHandle } catch { $editHwnd = [IntPtr]::Zero }
        }

        if ($hasCtrl -and -not $hasShift -and -not $hasAlt -and $shortLower -eq "a") {
          $state.selectAll = $true
          if ($editHwnd -ne [IntPtr]::Zero) {
            # EM_SETSEL (0x00B1), wParam=0, lParam=-1 selects all text visually in Edit/RichEdit.
            $null = [EtaDesktop]::PostMessageW($editHwnd, 0x00B1, [IntPtr]::Zero, [IntPtr](-1))
          }
          Write-Reply @{ ok = $true; how = "select_all" }
          continue
        }

        if ($hasCtrl -and -not $hasShift -and -not $hasAlt -and $shortLower -eq "x" -and $hasValue) {
          $pattern.SetValue("")
          $state.selectAll = $false
          Write-Reply @{ ok = $true; how = "cut_clear" }
          continue
        }

        if (-not $hasCtrl -and -not $hasShift -and -not $hasAlt -and ($shortLower -eq "backspace" -or $shortLower -eq "delete")) {
          if ($hasValue) {
            $current = ""
            try { $current = [string]$pattern.Current.Value } catch { $current = "" }
            if ($state.selectAll) {
              $pattern.SetValue("")
              $state.selectAll = $false
            } elseif ($current.Length -gt 0 -and $shortLower -eq "backspace") {
              $pattern.SetValue($current.Substring(0, $current.Length - 1))
            }
            Write-Reply @{ ok = $true; how = "value_delete" }
            continue
          }
        }

        $state.selectAll = $false
        $vk = $map[$name]
        if ($null -eq $vk) { $vk = $map[$shortLower] }
        if ($null -eq $vk -and $shortcut.Length -eq 1) { $vk = [int][char]$shortcut.ToUpperInvariant() }
        if ($null -eq $vk) { Write-Reply @{ ok = $false; error = "unknown_key" }; continue }

        # When modifiers are present on a text-editable control (e.g. Ctrl+Z in Notepad), avoid
        # posting bare WM_KEYDOWN letters into the text editor; for non-text apps (e.g. Blender
        # Shift+A, Ctrl+N), post explicit modifier keydown/keyup around the target VK.
        if ($hasCtrl -and $hasValue) {
          Write-Reply @{ ok = $true; how = "ctrl_noop"; key = $raw }
          continue
        }

        $sent = $false
        if ($hasCtrl -or $hasShift -or $hasAlt) {
          $mods = New-Object System.Collections.Generic.List[int]
          if ($hasCtrl) { $mods.Add(0x11) }
          if ($hasShift) { $mods.Add(0x10) }
          if ($hasAlt) { $mods.Add(0x12) }
          $targetHwnd = if ($editHwnd -ne [IntPtr]::Zero) { $editHwnd } else { $state.hwnd }
          $sent = [EtaDesktop]::KeyChord($targetHwnd, $mods.ToArray(), $vk)
        } elseif ($vk -eq 13) {
          if ($hasValue -and $edit.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) {
            $current = ""
            try { $current = [string]$pattern.Current.Value } catch { $current = "" }
            $pattern.SetValue($current + [string][char]13 + [string][char]10)
            $sent = $true
          } elseif ($editHwnd -ne [IntPtr]::Zero) {
            $sent = [EtaDesktop]::CharTo($editHwnd, 13)
          }
        }
        if (-not $sent) {
          $targetHwnd = if ($editHwnd -ne [IntPtr]::Zero) { $editHwnd } else { $state.hwnd }
          $sent = [EtaDesktop]::KeyTo($targetHwnd, $vk)
        }
        Write-Reply @{ ok = $sent; vk = $vk }
      }
      "move" {
        $x = [int]$request.x; $y = [int]$request.y
        $sent = [EtaDesktop]::Move($state.hwnd, $x, $y)
        Write-Reply @{ ok = [bool]$sent; how = "wm_mousemove" }
      }
      "click" {
        $x = [int]$request.x; $y = [int]$request.y
        $button = if ($request.button) { [string]$request.button } else { "left" }
        $dbl = [bool]$request.doubleClick
        # Always convert full-window coordinates (matching PrintWindow) into client coordinates via
        # ScreenToClient so titlebar/border offsets never mis-click menus or buttons.
        $sent = [EtaDesktop]::Click($state.hwnd, $x, $y, $button, $dbl)
        Write-Reply @{ ok = [bool]$sent; how = $(if ($sent) { "click" } else { "none" }) }
      }
      "scroll" {
        $delta = [int]$request.deltaY
        $sent = [EtaDesktop]::Wheel($state.hwnd, (-1 * $delta))
        Write-Reply @{ ok = $sent }
      }
      "close" {
        # Let go of the desktop and the process handle without ending the app: a Computer Use app may
        # hold work that was never saved, so only the user, through an explicit confirmation, may end
        # it (the "terminate" command below).
        if ($state.process -ne [IntPtr]::Zero) { $null = [EtaDesktop]::CloseHandle($state.process) }
        if ($state.desktop -ne [IntPtr]::Zero) { $null = [EtaDesktop]::CloseDesktop($state.desktop) }
        $state.desktop = [IntPtr]::Zero
        $state.hwnd = [IntPtr]::Zero
        $state.process = [IntPtr]::Zero
        Write-Reply @{ ok = $true; ended = $false }
        break
      }
      "terminate" {
        $ended = $false
        if ($state.process -ne [IntPtr]::Zero) {
          $ended = [bool][EtaDesktop]::TerminateProcess($state.process, 0)
          $null = [EtaDesktop]::CloseHandle($state.process)
        }
        if ($state.desktop -ne [IntPtr]::Zero) { $null = [EtaDesktop]::CloseDesktop($state.desktop) }
        $state.desktop = [IntPtr]::Zero
        $state.hwnd = [IntPtr]::Zero
        $state.process = [IntPtr]::Zero
        Write-Reply @{ ok = $true; ended = $ended }
        break
      }
      default { Write-Reply @{ ok = $false; error = "unknown_command" } }
    }
  } catch {
    Write-Reply @{ ok = $false; error = "exception"; message = $_.Exception.Message }
  }
  if ($request.cmd -eq "close") { break }
}
`;
