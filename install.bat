@echo off
chcp 65001 >nul
title net-monitor installer
cd /d "%~dp0"

echo.
echo  net-monitor - Installation
echo  ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Download from https://nodejs.org/ (LTS, version 22+^)
  pause & exit /b 1
)

for /f "tokens=*" %%v in ('node -e "process.stdout.write(process.version)"') do set NODEVER=%%v
echo [OK] Node.js: %NODEVER%

echo.
echo [1/2] Installing npm dependencies...
npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause & exit /b 1
)
echo [OK] Dependencies installed.

echo.
echo [2/2] Checking TLS certificate...
if not exist "data\certs\cert.pem" (
  echo Certificate not found, generating...
  call make-cert.bat
) else (
  echo [OK] Certificate already exists.
)

echo.
echo  Installation complete! Run start.bat to launch.
echo.
pause
