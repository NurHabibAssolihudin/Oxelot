# Oxelot containerized dev workflow.
# Usage: .\scripts\d.ps1 <command>
# Requires: Docker Desktop running (the script starts it if needed).

param(
  [Parameter(Position = 0)]
  [string]$Command = "help"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Start-DockerDesktopIfNeeded {
  $null = docker info 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[d] Docker daemon tidak jalan - memulai Docker Desktop..." -ForegroundColor Cyan
    Start-Process "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
    $deadline = (Get-Date).AddMinutes(5)
    do {
      Start-Sleep -Seconds 3
      $null = docker info 2>&1
    } while ($LASTEXITCODE -ne 0 -and (Get-Date) -lt $deadline)
    if ($LASTEXITCODE -ne 0) { throw "[d] Docker Desktop gagal siap dalam 5 menit." }
    Write-Host "[d] Docker siap." -ForegroundColor Green
  }
}

function Invoke-Dev {
  param([string]$Script)
  docker compose run --rm dev bash -c "set -e; $Script"
  exit $LASTEXITCODE
}

Start-DockerDesktopIfNeeded

switch ($Command) {
  "shell" {
    docker compose run --rm dev
    exit $LASTEXITCODE
  }

  "install" { Invoke-Dev "npm ci" }
  "build"   { Invoke-Dev "npm ci && npm run build" }

  "lint"    { Invoke-Dev "npm run lint && npm run depcruise && npm run typecheck" }
  "test"    { Invoke-Dev "npm test" }
  "quality" { Invoke-Dev "npm run build && npm run lint && npm run depcruise && npm run typecheck && npm test && node scripts/size-check.mjs" }

  # Build the WASM SQLite artifact inside the container. The .wasm lands on
  # the host via the bind mount (packages/core/dist/wasm/), unlocking the
  # SQLite-dependent smoke/e2e tests everywhere.
  "wasm"    { Invoke-Dev "npm run build:wasm" }

  # Full default Playwright suite on Chromium. Browsers download once into
  # the oxelot_playwright volume using the repo's OWN playwright version
  # (idempotent + revision-exact); wasm is built first because smoke needs it.
  "e2e"     { Invoke-Dev "npx playwright install chromium && npm run build:wasm && npm run test:e2e" }

  # Playground dev server on http://localhost:5199 (Ctrl+C to stop).
  "dev"     {
    docker compose run --rm --service-ports dev bash -c "npm run build && npx playwright install chromium && npm run dev"
    exit $LASTEXITCODE
  }

  # Nuke everything container-side: volumes (node_modules, cargo target,
  # browsers) and the image. The host repo is untouched.
  "clean"   {
    docker compose down --remove-orphans --volumes
    docker rmi oxelot-dev:latest 2>$null
    Write-Host "[d] Container state dibersihkan." -ForegroundColor Green
  }

  "help" {
    Write-Host @"
Oxelot dev container:
  .\scripts\d.ps1 shell     # bash di dalam container (semua toolchain)
  .\scripts\d.ps1 install   # npm ci
  .\scripts\d.ps1 build     # npm ci + build semua workspace
  .\scripts\d.ps1 lint      # eslint + depcruise + typecheck
  .\scripts\d.ps1 test      # vitest unit
  .\scripts\d.ps1 quality   # build + lint + depcruise + typecheck + test + size gate
  .\scripts\d.ps1 wasm      # build WASM SQLite -> packages/core/dist/wasm/
  .\scripts\d.ps1 e2e       # full default suite Chromium (+wasm otomatis)
  .\scripts\d.ps1 dev       # playground di http://localhost:5199
  .\scripts\d.ps1 clean     # hapus volume + image (host tak tersentuh)

Perintah lain diteruskan apa adanya ke dalam container,
contoh: .\scripts\d.ps1 "cargo clippy --manifest-path wasm/Cargo.toml"
"@
  }

  default {
    # Pass-through: any other string runs verbatim inside the container.
    Invoke-Dev $Command
  }
}

