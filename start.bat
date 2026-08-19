@echo off
chcp 65001 >nul
title net-monitor
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден. Скачайте с https://nodejs.org/
  pause & exit /b 1
)

node -e "process.exit(parseInt(process.versions.node.split('.')[0],10)<22?1:0)" 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Требуется Node.js 22+. Установлена версия:
  node -v
  pause & exit /b 1
)

if not exist node_modules (
  echo Устанавливаю зависимости...
  call npm install --no-audit --no-fund
  if not exist "node_modules\express" (
    echo [ОШИБКА] npm install не смог поставить основные зависимости.
    echo Проверьте вывод выше и попробуйте снова.
    pause & exit /b 1
  )
  if errorlevel 1 (
    echo [ПРЕДУПРЕЖДЕНИЕ] npm вернул код ошибки ^(обычно из-за необязательного
    echo        нативного модуля, например cpu-features у ssh2 - не собрался^),
    echo        но основные зависимости установлены успешно - продолжаю.
  )
)

if not exist "data\certs\cert.pem" (
  where openssl >nul 2>nul
  if not errorlevel 1 (
    echo Генерирую самоподписанный сертификат...
    call make-cert.bat auto
  ) else (
    echo [ПРЕДУПРЕЖДЕНИЕ] openssl не найден - запуск без HTTPS.
    echo        Запустите make-cert.bat после установки openssl, чтобы включить HTTPS.
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
  where curl >nul 2>nul
  if not errorlevel 1 (
    start "" /min cmd /c "for /L %%i in (1,1,60) do (curl -k -s -o nul --max-time 2 %OPEN_URL% >nul 2>&1 && (start "" %OPEN_URL% & exit /b) || timeout /t 1 >nul)"
  ) else (
    echo [ПРЕДУПРЕЖДЕНИЕ] curl не найден - открою браузер через фиксированную паузу в 4с.
    start "" /min cmd /c "timeout /t 4 >nul & start %OPEN_URL%"
  )
)

npm start
pause
