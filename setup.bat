@echo off
setlocal
if exist "%~dp0setup.mjs" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo Node.js was not found on PATH.
    echo Install Node.js 18 or later and run this file again.
    pause
    exit /b 1
  )
  node "%~dp0setup.mjs" --guided --keep-open %*
) else (
  where npx >nul 2>&1
  if errorlevel 1 (
    echo npm/npx was not found.
    echo Install Node.js 18 or later and run this file again.
    pause
    exit /b 1
  )
  npx --yes --package github:fcoluiz/context-tools context-tools-setup-all --guided --keep-open %*
)
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo.&echo Setup failed. See the message above.
exit /b %RESULT%
