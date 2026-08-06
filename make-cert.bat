@echo off
REM Кодировка файла: UTF-8 без BOM (BOM ломает разбор первой строки в cmd.exe)
chcp 65001 >nul
REM Генерация самоподписанного TLS-сертификата для NetMonitor (Windows).
REM Требует openssl (есть в комплекте Git for Windows — обычно уже в PATH после его установки,
REM либо ставится отдельно: https://slproweb.com/products/Win32OpenSSL.html)
cd /d "%~dp0"

set SILENT=0
set HOST_OR_IP=%1

if "%HOST_OR_IP%"=="auto" (
  set SILENT=1
  set HOST_OR_IP=localhost
)
if "%HOST_OR_IP%"=="" set HOST_OR_IP=127.0.0.1

where openssl >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] openssl не найден в PATH.
  echo Вариант 1: установите Git for Windows ^(в нём есть openssl^) и запустите этот скрипт из Git Bash: ./make-cert.sh
  echo Вариант 2: установите openssl отдельно: https://slproweb.com/products/Win32OpenSSL.html
  if not "%SILENT%"=="1" pause
  exit /b 1
)

if not exist data\certs mkdir data\certs

echo === Генерация самоподписанного сертификата ===
echo CN / SAN: %HOST_OR_IP%, localhost, 127.0.0.1
if not "%SILENT%"=="1" echo (чтобы указать другой адрес/домен для локальной сети: make-cert.bat 192.168.1.50)
echo.

openssl req -x509 -nodes -newkey rsa:2048 -keyout data\certs\key.pem -out data\certs\cert.pem -days 825 -subj "/CN=%HOST_OR_IP%" -addext "subjectAltName=DNS:%HOST_OR_IP%,DNS:localhost,IP:127.0.0.1"
if errorlevel 1 (
  echo [ОШИБКА] Не удалось сгенерировать сертификат.
  if not "%SILENT%"=="1" pause
  exit /b 1
)

echo.
echo Готово: data\certs\cert.pem и data\certs\key.pem
if "%SILENT%"=="1" (
  echo HTTPS будет включён автоматически при запуске сервера.
) else (
  echo Перезапустите сервер ^(start.bat^) — он сам обнаружит сертификат и включит HTTPS.
  echo.
  echo ВНИМАНИЕ: это самоподписанный сертификат — браузер один раз покажет предупреждение
  echo "соединение не защищено". Это нормально для локальной сети — просто подтвердите переход.
  echo Если заходите не через localhost, а по IP из локальной сети — сгенерируйте сертификат
  echo с этим IP явно: make-cert.bat 192.168.1.50 — иначе браузер будет ругаться ещё и на
  echo несовпадение имени хоста.
  pause
)
