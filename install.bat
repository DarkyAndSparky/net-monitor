@echo off
chcp 65001 >nul
title net-monitor installer
cd /d "%~dp0"

echo.
echo  net-monitor - Установка
echo  ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден.
  echo Скачайте с https://nodejs.org/ ^(LTS, версия 22+^)
  pause & exit /b 1
)

for /f "tokens=*" %%v in ('node -e "process.stdout.write(process.version)"') do set NODEVER=%%v
echo [OK] Node.js: %NODEVER%

echo.
echo [1/2] Устанавливаю npm-зависимости...
call npm install --no-audit --no-fund
if not exist "node_modules\express" (
  echo [ОШИБКА] npm install не смог поставить основные зависимости.
  pause & exit /b 1
)
if errorlevel 1 (
  echo [ПРЕДУПРЕЖДЕНИЕ] npm вернул код ошибки ^(обычно из-за необязательного
  echo        нативного модуля, например cpu-features у ssh2 - не собрался^),
  echo        но основные зависимости установлены успешно - продолжаю.
)
echo [OK] Зависимости установлены.

echo.
echo [2/2] Проверяю TLS-сертификат...
if not exist "data\certs\cert.pem" (
  echo Сертификат не найден, генерирую...
  call make-cert.bat
) else (
  echo [OK] Сертификат уже есть.
)

echo.
echo  Установка завершена! Запустите start.bat для старта.
echo.
pause
