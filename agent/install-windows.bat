@echo off
REM Установка net-monitor агента как задачи Планировщика Windows
REM
REM Использование:
REM   install-windows.bat <SERVER_URL> <TOKEN>
REM
REM Пример:
REM   install-windows.bat https://netmonitor.local:9221 abc123...

setlocal

if "%~1"=="" (
  echo Использование: install-windows.bat SERVER_URL TOKEN
  echo Пример: install-windows.bat https://netmonitor.local:9221 abc123token
  exit /b 1
)
if "%~2"=="" (
  echo Использование: install-windows.bat SERVER_URL TOKEN
  exit /b 1
)

set SERVER=%~1
set TOKEN=%~2
set INSTALL_DIR=%ProgramFiles%\NetMonitorAgent

where python >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Python не найден. Установите с https://python.org
  echo          При установке отметьте "Add Python to PATH"
  exit /b 1
)

echo Копирую агент в %INSTALL_DIR% ...
mkdir "%INSTALL_DIR%" 2>nul
copy /Y "%~dp0netmonitor-agent.py" "%INSTALL_DIR%\netmonitor-agent.py" >nul

echo Создаю задачу в Планировщике заданий...
schtasks /create /tn "NetMonitorAgent" /tr "python \"%INSTALL_DIR%\netmonitor-agent.py\" --server %SERVER% --token %TOKEN%" /sc onstart /ru SYSTEM /f

echo Запускаю задачу сейчас...
schtasks /run /tn "NetMonitorAgent"

echo.
echo Готово. Агент запущен и добавлен в автозагрузку.
echo Проверить: schtasks /query /tn "NetMonitorAgent"
echo Удалить:   schtasks /delete /tn "NetMonitorAgent" /f
echo.
pause
