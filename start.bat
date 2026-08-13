@echo off
chcp 65001 >nul
title net-monitor
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Download from https://nodejs.org/
  pause & exit /b 1
)

node -e "process.exit(parseInt(process.versions.node.split('.')[0],10)<22?1:0)" 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 22+ required. Current:
  node -v
  pause & exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause & exit /b 1
  )
)

if not exist "data\certs\cert.pem" (
  where openssl >nul 2>nul
  if not errorlevel 1 (
    echo Generating self-signed certificate...
    call make-cert.bat auto
  ) else (
    echo [WARN] openssl not found - starting without HTTPS.
    echo        Run make-cert.bat after installing openssl to enable HTTPS.
  )
)

set HTTPS_PORT=9221
set HTTP_PORT=9222
if not "%PORT%"=="" set HTTPS_PORT=%PORT%

if exist "data\certs\cert.pem" (
  set OPEN_URL=https://localhost:%HTTPS_PORT%
) else (
  set OPEN_URL=http://localhost:%HTTP_PORT%
)

if not "%NO_BROWSER%"=="1" (
  start "" /min cmd /c "timeout /t 2 >nul & start %OPEN_URL%"
)

npm start
pause
