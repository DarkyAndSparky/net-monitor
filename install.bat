@echo off
chcp 65001 >nul
echo.
echo ╔══════════════════════════════════════════╗
echo ║       net-monitor — Установка            ║
echo ╚══════════════════════════════════════════╝
echo.

:: Проверяем Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ОШИБКА] Node.js не найден.
    echo Скачайте с https://nodejs.org/  (LTS версию^)
    pause & exit /b 1
)

for /f "tokens=1 delims=v" %%i in ('node -v') do set NODEVER=%%i
echo [OK] Node.js найден: %NODEVER%

:: Устанавливаем зависимости
echo.
echo [1/3] Устанавливаем зависимости npm...
npm install
if %errorlevel% neq 0 (
    echo [ОШИБКА] npm install завершился с ошибкой.
    pause & exit /b 1
)

:: Пробуем запустить — если better-sqlite3 не скомпилирован, пересобираем
echo.
echo [2/3] Проверяем better-sqlite3...
node -e "require('better-sqlite3')" >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] better-sqlite3 требует компиляции. Устанавливаем build tools...
    echo     Это займёт 2-5 минут...
    echo.
    npm install -g node-gyp >nul 2>&1
    npm install --global --production windows-build-tools 2>&1
    echo.
    echo [!] Пересобираем better-sqlite3...
    npm rebuild better-sqlite3
    if %errorlevel% neq 0 (
        echo.
        echo [ОШИБКА] Не удалось собрать better-sqlite3.
        echo Попробуйте запустить этот файл от имени Администратора
        echo (правая кнопка → "Запуск от имени администратора"^)
        pause & exit /b 1
    )
)
echo [OK] better-sqlite3 готов.

:: Генерируем сертификат если нет
echo.
echo [3/3] Проверяем TLS сертификат...
if not exist "data\certs\cert.pem" (
    echo [!] Сертификат не найден, генерируем...
    call make-cert.bat
) else (
    echo [OK] Сертификат уже есть.
)

echo.
echo ╔══════════════════════════════════════════╗
echo ║   Установка завершена успешно!           ║
echo ║   Запустите start.bat для старта         ║
echo ╚══════════════════════════════════════════╝
echo.
pause
