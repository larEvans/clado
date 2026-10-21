# launch.ps1 - Start TradingView (CDP-enabled), the trading bot + dashboard, and optionally Claude Code
#
# Usage:
#   .\launch.ps1               -- launches TradingView + bot + dashboard
#   .\launch.ps1 -WithClaude   -- also opens Claude Code

param([switch]$WithClaude)

$ROOT           = $PSScriptRoot
$CDP_PORT       = 9222
$DASHBOARD_PORT = "3000"

# Read .env only for the values this script needs (port, dashboard token).
# Deliberately NOT copied into the process environment: bot-stream.js and
# dashboard.js load .env themselves via dotenv, which never overrides an
# already-set variable - exporting here would freeze .env at launch time, so
# later edits wouldn't apply when start.js restarts a child.
$dotenv  = @{}
$envFile = Join-Path $ROOT ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match "^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$") {
      $v = $matches[2].Trim()
      if ($v -match '^"([^"]*)"' -or $v -match "^'([^']*)'") { $v = $matches[1] }  # quoted value
      else { $v = ($v -replace '\s+#.*$', '').Trim() }                              # strip inline comment
      $dotenv[$matches[1]] = $v
    }
  }
}
if ($dotenv["DASHBOARD_PORT"]) { $DASHBOARD_PORT = $dotenv["DASHBOARD_PORT"] }
$DASHBOARD_TOKEN = $dotenv["DASHBOARD_TOKEN"]

$DASHBOARD_URL = "http://localhost:$DASHBOARD_PORT/dashboard.html"
# The token in the URL makes the server set its auth cookie, so the page loads
# instead of returning 401.
$DASHBOARD_OPEN_URL = if ($DASHBOARD_TOKEN) { "http://localhost:$DASHBOARD_PORT/?token=$([uri]::EscapeDataString($DASHBOARD_TOKEN))" } else { $DASHBOARD_URL }

Write-Host ""
Write-Host "  Trading Dashboard Launcher" -ForegroundColor White

# ---- 1. Find TradingView -------------------------------------------------------
Write-Host ""
Write-Host "  [1/4] Locating TradingView..." -ForegroundColor Cyan

$tvExe = $null

# Windows Store / MSIX via AppX registry (no ACL restrictions)
$pkg = Get-AppxPackage -Name "*TradingView*" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pkg) {
  $c = Join-Path $pkg.InstallLocation "TradingView.exe"
  if (Test-Path $c) { $tvExe = $c }
}

# Direct-download locations
if (-not $tvExe) {
  $candidates = @(
    "$env:LOCALAPPDATA\TradingView\TradingView.exe",
    "$env:LOCALAPPDATA\Programs\TradingView\TradingView.exe",
    "$env:LOCALAPPDATA\Programs\tradingview\TradingView.exe",
    "$env:APPDATA\TradingView\TradingView.exe",
    "$env:ProgramFiles\TradingView\TradingView.exe"
  )
  foreach ($p in $candidates) {
    if (Test-Path $p) {
      $tvExe = $p
      break
    }
  }
}

# Scan LocalAppData\Programs
if (-not $tvExe) {
  $f = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Filter "TradingView.exe" -Recurse -ErrorAction SilentlyContinue |
       Select-Object -First 1
  if ($f) { $tvExe = $f.FullName }
}

# Start Menu shortcut
if (-not $tvExe) {
  $lnk = Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu" -Recurse -Filter "TradingView*.lnk" -ErrorAction SilentlyContinue |
         Select-Object -First 1
  if ($lnk) {
    try {
      $sh = New-Object -ComObject WScript.Shell
      $t  = $sh.CreateShortcut($lnk.FullName).TargetPath
      if ($t -and (Test-Path $t)) { $tvExe = $t }
    } catch {
      $tvExe = $null
    }
  }
}

if ($tvExe) {
  Write-Host "  Found: $tvExe" -ForegroundColor Green
} else {
  Write-Host "  TradingView not found. Download from tradingview.com/desktop/" -ForegroundColor Yellow
  Write-Host "  Or launch manually with: --remote-debugging-port=$CDP_PORT" -ForegroundColor Yellow
}

# ---- 2. Launch TradingView with CDP -------------------------------------------
Write-Host ""
Write-Host "  [2/4] Starting TradingView (CDP port $CDP_PORT)..." -ForegroundColor Cyan

$tv = Get-Process -Name "TradingView" -ErrorAction SilentlyContinue
if ($tv) {
  Write-Host "  Stopping existing TradingView..." -ForegroundColor Yellow
  $tv | Stop-Process -Force
  Start-Sleep -Milliseconds 1500
}

if ($tvExe) {
  Start-Process -FilePath $tvExe -ArgumentList "--remote-debugging-port=$CDP_PORT"
  Write-Host "  TradingView launched with CDP on port $CDP_PORT." -ForegroundColor Green
  Start-Sleep -Milliseconds 2000
}

# ---- 3. Start bot + dashboard -------------------------------------------------
# start.js runs BOTH bot-stream.js (the trading engine) and dashboard.js as
# children sharing one filesystem, and restarts either if it crashes.
# (Starting dashboard.js alone gives you a dashboard that never trades.)
Write-Host ""
Write-Host "  [3/4] Starting trading bot + dashboard (port $DASHBOARD_PORT)..." -ForegroundColor Cyan

if (-not (Test-Path (Join-Path $ROOT "node_modules"))) {
  Write-Host "  node_modules missing - running npm install..." -ForegroundColor Yellow
  Push-Location $ROOT; npm install; Pop-Location
}

# Stop only a previous run of THIS bot (node processes launched from this
# folder) - never unrelated Node apps on the machine.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($ROOT) } |
  ForEach-Object {
    Write-Host "  Stopping previous bot process (PID $($_.ProcessId))..." -ForegroundColor Yellow
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Milliseconds 500

Write-Host "  If this bot is ALSO deployed on Railway, stop the Railway service first -" -ForegroundColor Yellow
Write-Host "  two copies on one Alpaca account will both place every trade." -ForegroundColor Yellow

$botProc = Start-Process -FilePath "node" `
  -ArgumentList "`"$(Join-Path $ROOT 'start.js')`"" `
  -WorkingDirectory $ROOT `
  -PassThru `
  -WindowStyle Normal

Write-Host "  Bot + dashboard started (PID $($botProc.Id)) - watch that window for [Router] / [Bot] logs." -ForegroundColor Green
Start-Sleep -Milliseconds 2500

# ---- 4. Claude Code (optional) ------------------------------------------------
Write-Host ""
if ($WithClaude) {
  Write-Host "  [4/4] Launching Claude Code..." -ForegroundColor Cyan
  $cc = Get-Command "claude" -ErrorAction SilentlyContinue
  if ($cc) {
    Start-Process -FilePath $cc.Source -WorkingDirectory $ROOT
    Write-Host "  Claude Code launched." -ForegroundColor Green
  } else {
    Write-Host "  'claude' not found in PATH - open it manually." -ForegroundColor Yellow
  }
} else {
  Write-Host "  [4/4] Skipping Claude Code (use -WithClaude to include it)." -ForegroundColor DarkGray
}

# ---- Open browser -------------------------------------------------------------
Write-Host ""
Write-Host "  Opening dashboard at $DASHBOARD_URL" -ForegroundColor Cyan
Start-Process $DASHBOARD_OPEN_URL

Write-Host ""
Write-Host "  Dashboard : $DASHBOARD_URL" -ForegroundColor White
Write-Host "  CDP port  : $CDP_PORT  (TradingView inject)" -ForegroundColor White
Write-Host ""
