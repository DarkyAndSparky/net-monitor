@echo off
REM Кодировка файла: UTF-8 без BOM (BOM ломает разбор первой строки в cmd.exe)
chcp 65001 >nul
title NetMonitor - установка
cd /d "%~dp0"

echo === NetMonitor: установка зависимостей ===
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
  echo [ОШИБКА] npm не найден. Обычно ставится вместе с Node.js — переустановите Node.js.
  pause
  exit /b 1
)

echo Node.js и npm найдены:
node -v
npm -v
echo.
echo Устанавливаю зависимости (npm install)...
call npm install
if errorlevel 1 (
  echo [ОШИБКА] npm install завершился с ошибкой. Смотрите текст ошибки выше.
  pause
  exit /b 1
)

echo.
echo Готово. Теперь можно запустить сервер: start.bat
pause
