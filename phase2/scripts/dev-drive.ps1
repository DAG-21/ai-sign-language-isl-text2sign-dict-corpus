param(
  [string]$DataDir = 'G:\My Drive\islrtc',
  [int]$Port = 3000
)

# Start the dev server against the ISLRTC dictionary on Google Drive (Drive for Desktop, "Stream files" mode).
# Calls Next.js directly with node: `npm run` breaks when the project folder name contains "&", as this one does.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-drive.ps1
#   (first time, or after the dictionary changes) build the manifest:
#   node node_modules/vite-node/vite-node.mjs scripts/build-manifest.ts -- --data-dir "G:\My Drive\islrtc"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$manifest = Join-Path $root 'data\islrtc\manifest.json'
if (-not (Test-Path $manifest)) { throw "No manifest at $manifest. Run scripts/build-manifest.ts first (see the comment at the top of this file)." }
if (-not (Test-Path $DataDir)) { throw "Dictionary folder not found: $DataDir (is Google Drive for Desktop running?)" }

$env:ISLRTC_DATA_DIR = $DataDir
$env:ISLRTC_MANIFEST = $manifest
$env:ISLRTC_MAPPINGS = Join-Path $root 'data\islrtc\approved_mappings.json'
$env:ISLRTC_TRANSCODE = '1'   # H.264 copies of requested clips, only used by browsers that cannot decode HEVC

node node_modules/next/dist/bin/next dev -p $Port
