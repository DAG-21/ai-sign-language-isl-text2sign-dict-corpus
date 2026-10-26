param(
  [string]$Phase1Dir = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'phase1'),
  [int]$Phase1Port = 8765,
  [string]$DataDir = 'G:\My Drive\islrtc',
  [int]$Port = 3000
)

# Start the whole pipeline: Phase 1 (transcript cleaning, YouTube, LLM + spaCy gloss) on 127.0.0.1:$Phase1Port, then this app (resolver + avatar) on $Port.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-all.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-all.ps1 -Phase1Dir "D:\path\to\phase1"
#
# Phase 1 keeps its own .env (GROQ_API_KEY) and its own virtual environment; this app never reads that key.

$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $Phase1Dir '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { throw "Phase 1 virtual environment not found at $python. Pass -Phase1Dir with the phase1 folder." }

$env:PHASE1_URL = "http://127.0.0.1:$Phase1Port"

$listening = Get-NetTCPConnection -LocalPort $Phase1Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host "Phase 1 is already listening on port $Phase1Port; reusing it."
} else {
  # Its own window, so its log stays visible and closing it stops Phase 1.
  Start-Process -FilePath $python -ArgumentList @('run_webui.py', '--port', "$Phase1Port") -WorkingDirectory $Phase1Dir | Out-Null
  Write-Host "Started Phase 1 at $env:PHASE1_URL (folder: $Phase1Dir)"
}

& (Join-Path $PSScriptRoot 'dev-drive.ps1') -DataDir $DataDir -Port $Port
