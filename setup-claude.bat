@echo off
setlocal
if exist "%~dp0setup-claude.mjs" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo Node.js nao foi encontrado no PATH.
    echo Instale Node.js 18 ou superior e execute este arquivo novamente.
    pause
    exit /b 1
  )
  node "%~dp0setup-claude.mjs" --guided --keep-open %*
) else (
  where npx >nul 2>&1
  if errorlevel 1 (
    echo npm/npx nao foi encontrado.
    echo Instale Node.js 18 ou superior e execute este arquivo novamente.
    pause
    exit /b 1
  )
  npx --yes --package github:fcoluiz/context-tools context-tools-setup-claude --guided --keep-open %*
)
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo.&echo A instalacao falhou. Consulte a mensagem acima.
exit /b %RESULT%
