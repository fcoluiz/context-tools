$ErrorActionPreference = 'Stop'

if (Test-Path (Join-Path $PSScriptRoot 'setup.mjs')) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js 18 or later was not found on PATH.'
    Read-Host 'Press Enter to close this window'
    exit 1
  }
  $scriptPath = Join-Path $PSScriptRoot 'setup.mjs'
  & node $scriptPath --guided --keep-open @args
} else {
  if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Write-Error 'npm/npx was not found. Install Node.js 18 or later.'
    Read-Host 'Press Enter to close this window'
    exit 1
  }
  & npx --yes --package github:fcoluiz/context-tools context-tools-setup-all --guided --keep-open @args
}
exit $LASTEXITCODE
