# launch.ps1 - Start TradingView (CDP-enabled), Dashboard, and optionally Claude Code
#
# Usage:
#   .\launch.ps1               -- launches TradingView + dashboard
#   .\launch.ps1 -WithClaude   -- also opens Claude Code

param([switch]$WithClaude)

$ROOT           = $PSScriptRoot
$CDP_PORT       = 9222
$DASHBOARD_PORT = "3000"

# Load .env
$envFile = Join-Path $ROOT ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match "^\s*([^#=]+?)\s*=\s*(.*)$") {
      $n = $matches[1].Trim()
      $v = $matches[2].Trim()
      if (-not [System.Environment]::GetEnvironmentVariable($n, "Process")) {
        [System.Environment]::SetEnvironmentVariable($n, $v, "Process")
      }
    }
  }
  if ($env:DASHBOARD_PORT) { $DASHBOARD_PORT = $env:DASHBOARD_PORT }
}

$DASHBOARD_URL = "http://localhost:$DASHBOARD_PORT/dashboard.html"

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

# ---- 3. Start dashboard server ------------------------------------------------
Write-Host ""
Write-Host "  [3/4] Starting dashboard server (port $DASHBOARD_PORT)..." -ForegroundColor Cyan

Get-Process -Name "node" -ErrorAction SilentlyContinue | ForEach-Object {
  try { $_.Kill() } catch { $_ = $null }
}
Start-Sleep -Milliseconds 500

$dashProc = Start-Process -FilePath "node" `
  -ArgumentList (Join-Path $ROOT "dashboard.js") `
  -WorkingDirectory $ROOT `
  -PassThru `
  -WindowStyle Normal

Write-Host "  Dashboard server started (PID $($dashProc.Id))." -ForegroundColor Green
Start-Sleep -Milliseconds 1500

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
Start-Process $DASHBOARD_URL

Write-Host ""
Write-Host "  Dashboard : $DASHBOARD_URL" -ForegroundColor White
Write-Host "  CDP port  : $CDP_PORT  (TradingView inject)" -ForegroundColor White
Write-Host ""
