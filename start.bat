@echo off
REM Кодировка файла: UTF-8 без BOM (BOM ломает разбор первой строки в cmd.exe)
chcp 65001 >nul
title NetMonitor
cd /d "%~dp0"

echo === NetMonitor ===
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден в PATH.
  echo Установите Node.js 18 или новее: https://nodejs.org/
  pause
  exit /b 1
)

node -e "process.exit(parseInt(process.versions.node.split('.')[0],10) < 18 ? 1 : 0)"
if errorlevel 1 (
  echo [ОШИБКА] Установлена слишком старая версия Node.js.
  node -v
  echo Нужен Node.js 18 или новее: https://nodejs.org/
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] npm не найден. Переустановите Node.js.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Зависимости не найдены — устанавливаю ^(npm install^)...
  call npm install
  if errorlevel 1 (
    echo [ОШИБКА] npm install завершился с ошибкой.
    pause
    exit /b 1
  )
) else (
  echo Зависимости уже установлены
)

if not exist data\certs\cert.pem (
  where openssl >nul 2>nul
  if not errorlevel 1 (
    echo Сертификат не найден — генерирую самоподписанный автоматически...
    call make-cert.bat auto
  ) else (
    echo Сертификат не найден, openssl не установлен — сервер запустится по обычному HTTP.
    echo Чтобы включить HTTPS, установите openssl и запустите make-cert.bat
  )
)

set PROTO=http
if exist data\certs\cert.pem set PROTO=https
set OPEN_PORT=%PORT%
if "%OPEN_PORT%"=="" set OPEN_PORT=9222
set OPEN_URL=%PROTO%://localhost:%OPEN_PORT%

if not "%NO_BROWSER%"=="1" (
  start "" /min cmd /c "timeout /t 2 >nul & start %OPEN_URL%"
)

echo.
echo Запускаю сервер...
echo Открою в браузере: %OPEN_URL%  (чтобы не открывать автоматически: set NO_BROWSER=1)
echo Порт можно поменять: set PORT=8080 ^&^& start.bat
echo Если сертификат есть - сервер сам поднимет ещё и редирект с http на https ^(порт 80^).
echo.
call npm start
pause
