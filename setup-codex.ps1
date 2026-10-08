$ErrorActionPreference = 'Stop'

if (Test-Path (Join-Path $PSScriptRoot 'setup-codex.mjs')) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js 18 ou superior nao foi encontrado no PATH.'
    Read-Host 'Pressione Enter para fechar esta janela'
    exit 1
  }
  $scriptPath = Join-Path $PSScriptRoot 'setup-codex.mjs'
  & node $scriptPath --guided --keep-open @args
} else {
  if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Write-Error 'npm/npx nao foi encontrado. Instale Node.js 18 ou superior.'
    Read-Host 'Pressione Enter para fechar esta janela'
    exit 1
  }
  & npx --yes --package github:fcoluiz/context-tools context-tools-setup --guided --keep-open @args
}
exit $LASTEXITCODE
