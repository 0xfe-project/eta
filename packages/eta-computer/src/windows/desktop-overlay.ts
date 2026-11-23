/**
 * The overlay that lives *on* the realm's desktop, shown when a realm is brought to the user's
 * screen. It is the only way back that does not depend on the ETA window the user just lost sight
 * of, so it is deliberately tiny and always on top: one button to switch the screen back, one box
 * to talk to the agent without leaving the desktop.
 *
 * It runs as its own `-STA` PowerShell process created onto the realm desktop (WinForms needs an
 * STA message loop, which the JSON-lines worker cannot provide) and talks to the host through two
 * files: it appends `{"text": "..."}` lines to the chat file, and reads a one-line status file.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_WATCHDOG_SCRIPT } from "./desktop-watchdog";

// A plain template literal, not `String.raw`: Bun's transpiler escapes non-ASCII characters into
// `\uXXXX` inside raw templates, and `String.raw` keeps those escapes literal, so the CJK labels
// would reach PowerShell as the text "\u72EC\u7ACB..." instead of 独立. The script has no `${`,
// backslash or backtick of its own, so nothing here needs raw treatment.
export const DESKTOP_OVERLAY_SCRIPT = `
param(
  [Parameter(Mandatory = $true)][string]$ChatFile,
  [Parameter(Mandatory = $true)][string]$StatusFile,
  [Parameter(Mandatory = $true)][string]$ReadyFile,
  [string]$Title = "ETA"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class EtaOverlayDesk {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr OpenDesktopW(string name, int flags, bool inherit, uint access);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SwitchDesktop(IntPtr desktop);


    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr desktop);

    public static bool BackToUserDesktop() {
        IntPtr desk = OpenDesktopW("Default", 0, false, 0x10000000);
        if (desk == IntPtr.Zero) return false;
        bool ok = SwitchDesktop(desk);
        CloseDesktop(desk);
        return ok;
    }
}
"@

function Write-ChatLine([string]$text) {
  $json = @{ text = $text; at = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json -Compress
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::AppendAllText($ChatFile, $json + [char]10, $utf8)
}


function Send-Back {
  # Tell the host first: it closes this overlay and releases the realm. Then switch the screen
  # ourselves, so the user is never stuck if the host is slow or gone.
  if ($script:leaving) { return }
  $script:leaving = $true
  try {
    # Outside the overlay's own directory, so it survives the host removing that directory.
    $log = Join-Path $env:TEMP "eta-cu-overlay-events.log"
    $line = "{0:o} send-back after {1}ms" -f (Get-Date).ToUniversalTime(), $script:uptime.ElapsedMilliseconds
    [System.IO.File]::AppendAllText($log, $line + [char]10, (New-Object System.Text.UTF8Encoding $false))
  } catch { }
  try { Write-ChatLine "__switch_back__" } catch { }
  $null = [EtaOverlayDesk]::BackToUserDesktop()
  [System.Windows.Forms.Application]::Exit()
}

$script:folded = $false
$script:leaving = $false
$script:controller = "user"
$fullWidth = 440
$fullHeight = 166
$foldedHeight = 44

$form = New-Object System.Windows.Forms.Form
$form.Text = "ETA · $Title"
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.BackColor = [System.Drawing.Color]::FromArgb(18, 20, 23)
$form.ForeColor = [System.Drawing.Color]::FromArgb(230, 232, 235)
$form.ClientSize = New-Object System.Drawing.Size($fullWidth, $fullHeight)
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
# Bottom centre, not the top-right corner: the corner is where people click to close windows and
# tabs, and an overlay that lands there collects clicks aimed at whatever was underneath it.
$form.Location = New-Object System.Drawing.Point(([int](($screen.Width - $fullWidth) / 2) + $screen.Left), ($screen.Bottom - ($fullHeight + 96)))

$header = New-Object System.Windows.Forms.Label
$header.Text = "ETA 独立桌面 · $Title"
$header.Font = New-Object System.Drawing.Font("Segoe UI", 9.5, [System.Drawing.FontStyle]::Bold)
$header.AutoSize = $false
$header.SetBounds(12, 11, 210, 22)
$form.Controls.Add($header)

$quickBack = New-Object System.Windows.Forms.Button
$quickBack.Text = "回主桌面"
$quickBack.SetBounds(226, 8, 152, 26)
$quickBack.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$quickBack.BackColor = [System.Drawing.Color]::FromArgb(46, 52, 60)
$quickBack.ForeColor = [System.Drawing.Color]::FromArgb(240, 242, 245)
$form.Controls.Add($quickBack)

$foldBtn = New-Object System.Windows.Forms.Button
$foldBtn.Text = "收起"
$foldBtn.SetBounds(384, 8, 44, 26)
$foldBtn.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$foldBtn.BackColor = [System.Drawing.Color]::FromArgb(30, 34, 40)
$foldBtn.ForeColor = [System.Drawing.Color]::FromArgb(180, 186, 194)
$form.Controls.Add($foldBtn)

$status = New-Object System.Windows.Forms.Label
$status.Text = "读取状态…"
$status.AutoSize = $false
$status.ForeColor = [System.Drawing.Color]::FromArgb(156, 163, 175)
$status.SetBounds(12, 42, 416, 18)
$form.Controls.Add($status)

$replyLabel = New-Object System.Windows.Forms.Label
$replyLabel.Text = "Agent 回复将显示在这里"
$replyLabel.AutoSize = $false
$replyLabel.ForeColor = [System.Drawing.Color]::FromArgb(205, 212, 222)
$replyLabel.BackColor = [System.Drawing.Color]::FromArgb(24, 27, 32)
$replyLabel.Padding = New-Object System.Windows.Forms.Padding(6, 4, 6, 4)
$replyLabel.SetBounds(12, 64, 416, 26)
$form.Controls.Add($replyLabel)

$messageBox = New-Object System.Windows.Forms.TextBox
$messageBox.SetBounds(12, 98, 314, 26)
$messageBox.BackColor = [System.Drawing.Color]::FromArgb(27, 31, 36)
$messageBox.ForeColor = [System.Drawing.Color]::FromArgb(230, 232, 235)
$messageBox.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$form.Controls.Add($messageBox)

$send = New-Object System.Windows.Forms.Button
$send.Text = "发给 Agent"
$send.SetBounds(332, 97, 96, 28)
$send.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$send.BackColor = [System.Drawing.Color]::FromArgb(37, 42, 48)
$send.ForeColor = [System.Drawing.Color]::FromArgb(230, 232, 235)
$form.Controls.Add($send)

$toggleControl = New-Object System.Windows.Forms.Button
$toggleControl.Text = "交给 Agent 操作"
$toggleControl.SetBounds(12, 132, 136, 26)
$toggleControl.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$toggleControl.BackColor = [System.Drawing.Color]::FromArgb(37, 42, 48)
$toggleControl.ForeColor = [System.Drawing.Color]::FromArgb(230, 232, 235)
$form.Controls.Add($toggleControl)

$pauseBtn = New-Object System.Windows.Forms.Button
$pauseBtn.Text = "暂停"
$pauseBtn.SetBounds(154, 132, 72, 26)
$pauseBtn.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$pauseBtn.BackColor = [System.Drawing.Color]::FromArgb(37, 42, 48)
$pauseBtn.ForeColor = [System.Drawing.Color]::FromArgb(230, 232, 235)
$form.Controls.Add($pauseBtn)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = "Enter 发送 · 随时可回主桌面"
$hint.ForeColor = [System.Drawing.Color]::FromArgb(120, 126, 134)
$hint.AutoSize = $false
$hint.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
$hint.SetBounds(230, 134, 198, 22)
$form.Controls.Add($hint)

$bodyControls = @($status, $replyLabel, $messageBox, $send, $toggleControl, $pauseBtn, $hint)

$sendChat = {
  $text = $messageBox.Text.Trim()
  if ($text -ne "") {
    try { Write-ChatLine $text } catch { }
    $messageBox.Text = ""
    $status.Text = "已发送给 Agent…"
  }
}

$send.Add_Click($sendChat)
$messageBox.Add_KeyDown({ param($sender, $e) if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Enter) { & $sendChat; $e.SuppressKeyPress = $true } })
$quickBack.Add_Click({
  $cursor = [System.Windows.Forms.Cursor]::Position
  try {
    $log = Join-Path $env:TEMP "eta-cu-overlay-events.log"
    $line = "{0:o} back-button clicked at ({1},{2}) after {3}ms" -f (Get-Date).ToUniversalTime(), $cursor.X, $cursor.Y, $script:uptime.ElapsedMilliseconds
    [System.IO.File]::AppendAllText($log, $line + [char]10, (New-Object System.Text.UTF8Encoding $false))
  } catch { }
  # A click that was already travelling when the screen switched lands on this window; give it a
  # moment before the button means anything.
  if ($script:uptime.ElapsedMilliseconds -lt 1500) { return }
  Send-Back
})

$toggleControl.Add_Click({
  if ($script:controller -eq "user") {
    try { Write-ChatLine "__release__" } catch { }
    $status.Text = "正在交还给 Agent…"
  } else {
    try { Write-ChatLine "__takeover__" } catch { }
    $status.Text = "正在接管…"
  }
})

$pauseBtn.Add_Click({
  if ($script:controller -eq "paused") {
    try { Write-ChatLine "__resume__" } catch { }
    $status.Text = "正在恢复…"
  } else {
    try { Write-ChatLine "__pause__" } catch { }
    $status.Text = "正在暂停…"
  }
})

$foldBtn.Add_Click({
  $script:folded = -not $script:folded
  foreach ($ctrl in $bodyControls) { $ctrl.Visible = -not $script:folded }
  if ($script:folded) {
    $foldBtn.Text = "展开"
    $form.ClientSize = New-Object System.Drawing.Size($fullWidth, $foldedHeight)
  } else {
    $foldBtn.Text = "收起"
    $form.ClientSize = New-Object System.Drawing.Size($fullWidth, $fullHeight)
  }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 700
$script:uptime = [Diagnostics.Stopwatch]::StartNew()
$timer.Add_Tick({
  try {
    if (Test-Path -LiteralPath $StatusFile) {
      $raw = [System.IO.File]::ReadAllText($StatusFile, (New-Object System.Text.UTF8Encoding $false)).Trim()
      if ($raw.StartsWith("{")) {
        $parsed = $raw | ConvertFrom-Json
        if ($parsed.status) { $status.Text = [string]$parsed.status }
        if ($parsed.reply) { $replyLabel.Text = "Agent: " + [string]$parsed.reply }
        if ($parsed.controller) {
          $script:controller = [string]$parsed.controller
          if ($script:controller -eq "user") {
            $toggleControl.Text = "交给 Agent 操作"
          } else {
            $toggleControl.Text = "我来接管"
          }
          if ($script:controller -eq "paused") {
            $pauseBtn.Text = "继续"
          } else {
            $pauseBtn.Text = "暂停"
          }
        }
      } elseif ($raw -ne "") {
        $status.Text = $raw
      }
    }
  } catch { }
})
$timer.Start()

$form.Add_Shown({
  # The ready file is the host's proof that the overlay is actually on screen, so it is written
  # before anything that could throw. Without it the host refuses to switch the desktop.
  $null = New-Item -ItemType File -Path $ReadyFile -Force
  try { $messageBox.Focus() } catch { }
})

$form.Add_FormClosed({
  try {
    $log = Join-Path $env:TEMP "eta-cu-overlay-events.log"
    $line = "{0:o} form closed leaving={1} after {2}ms" -f (Get-Date).ToUniversalTime(), $script:leaving, $script:uptime.ElapsedMilliseconds
    [System.IO.File]::AppendAllText($log, $line + [char]10, (New-Object System.Text.UTF8Encoding $false))
  } catch { }
})

[System.Windows.Forms.Application]::Run($form)
`;

/** Files the in-realm overlay uses: its script, and the chat/status/ready channels beside it. */
export interface DesktopOverlayPaths {
  script: string;
  chatFile: string;
  statusFile: string;
  readyFile: string;
  /** Touched by the host while promoted; a watchdog switches back when it goes stale. */
  beatFile: string;
  /** The watchdog script, started detached next to the overlay. */
  watchdogScript: string;
}

/**
 * Write the overlay script to a temp file and reserve its channel files. Windows PowerShell reads a
 * BOM-less script as ANSI, and the script carries CJK text, so the BOM is not optional.
 */
export function prepareDesktopOverlay(title: string): DesktopOverlayPaths {
  const dir = mkdtempSync(join(tmpdir(), "eta-cu-overlay-"));
  const paths: DesktopOverlayPaths = {
    script: join(dir, "overlay.ps1"),
    chatFile: join(dir, "chat.jsonl"),
    statusFile: join(dir, "status.txt"),
    readyFile: join(dir, "ready.txt"),
    beatFile: join(dir, "beat.txt"),
    watchdogScript: join(dir, "watchdog.ps1"),
  };
  writeFileSync(paths.script, `\uFEFF${DESKTOP_OVERLAY_SCRIPT}`, "utf8");
  writeFileSync(
    paths.watchdogScript,
    `\uFEFF${DESKTOP_WATCHDOG_SCRIPT}`,
    "utf8",
  );
  writeFileSync(paths.chatFile, "", "utf8");
  writeFileSync(paths.statusFile, `${title}\n`, "utf8");
  rmSync(paths.readyFile, { force: true });
  return paths;
}
