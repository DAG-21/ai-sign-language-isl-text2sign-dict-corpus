# Start the Yap & Render dev server with the ISLRTC dictionary wired in.  Usage:  .\scripts\dev-islrtc.ps1 [-Port 3000]
param(
  [int]$Port = 3000,
  [string]$DataDir = "C:\Dhiren\internship\islrtc",
  [string]$IndexDir = "C:\Dhiren\internship\ai-sign-language\data\islrtc"
)
$env:ISLRTC_DATA_DIR  = $DataDir
$env:ISLRTC_MANIFEST  = Join-Path $IndexDir "manifest.json"
$env:ISLRTC_MAPPINGS  = Join-Path $IndexDir "approved_mappings.json"
$env:ISLRTC_TRANSCODE = "1"          # browsers without HEVC get a cached H.264 copy of each clip on first use
$env:ISLRTC_CACHE_DIR = Join-Path (Split-Path $PSScriptRoot -Parent) ".cache\islrtc"
foreach ($p in @($env:ISLRTC_DATA_DIR, $env:ISLRTC_MANIFEST)) { if (-not (Test-Path $p)) { Write-Error "Not found: $p"; exit 1 } }
Write-Host "ISLRTC dictionary: $($env:ISLRTC_DATA_DIR)  |  open http://localhost:$Port/demo"
npx next dev -p $Port
