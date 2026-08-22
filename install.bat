@echo off
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo === NetMonitor - установка ===
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден на этом компьютере.
  echo Установите Node.js версии 22.5 или новее с https://nodejs.org
  echo и запустите install.bat снова.
  pause
  exit /b 1
)

node -e "process.exit(parseInt(process.versions.node.split('.')[0],10)<22?1:0)" 2>nul
if errorlevel 1 (
  echo Обновите Node.js на https://nodejs.org и запустите install.bat снова.
  echo Установленная версия:
  node -v
  pause
  exit /b 1
)

echo Устанавливаю зависимости сервера...
echo ЭТО МОЖЕТ ЗАНЯТЬ МИНУТУ-ДВЕ ^(особенно первый раз^) - НЕ ЗАКРЫВАЙТЕ ОКНО,
echo даже если кажется, что ничего не происходит.
echo.
call npm install
if errorlevel 1 (
  echo Установка зависимостей не удалась. Проверьте сообщение выше.
  pause
  exit /b 1
)

echo.
echo Проверяю TLS-сертификат...
if not exist "data\certs\cert.pem" (
  echo Сертификат не найден, генерирую...
  call make-cert.bat
) else (
  echo Сертификат уже есть.
)

echo.
echo Готово! Теперь запустите start.bat, чтобы открыть сайт.
pause
