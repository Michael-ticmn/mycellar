# Launcher for cellar27-watcher, used by the "cellar27-watcher" scheduled task (at logon).
# Runs node in the foreground so the task tracks it. The task's restart-on-failure does NOT
# cover the wrapper being killed later (2026-09-20: exit 0xC000013A, down until a manual
# restart on 09-25); only the next logon starts it again.
# Manual restarts can still use the Start-Process recipe in README.md.

$ErrorActionPreference = 'Stop'
$watcherDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = 'C:\Program Files\nodejs\node.exe'
$script = Join-Path $watcherDir 'src\index.js'
$outLog = Join-Path $watcherDir 'watcher.out.log'
$errLog = Join-Path $watcherDir 'watcher.err.log'

# Don't double-start if a watcher is already running (e.g. started by hand).
# Match THIS repo's script by full path: myvinyl's and mycabinet's watchers also run
# `node src/index.js`, and a relative match took either one for cellar27's.
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$script*" }
if ($running) { exit 0 }

# Start-Process truncates its redirect targets, so keep the previous run's logs.
# (Don't use PowerShell's >> here: 5.1 appends as UTF-16 and mangles the file.)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($log in @($outLog, $errLog)) {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 0)) {
    Move-Item $log "$log.$stamp.bak"
  }
  # Keep the 10 most recent rotations.
  Get-ChildItem "$log.*.bak" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 10 |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

$p = Start-Process -FilePath $node -ArgumentList "`"$script`"" `
  -WorkingDirectory $watcherDir -NoNewWindow -Wait -PassThru `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog
exit $p.ExitCode
