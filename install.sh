#!/usr/bin/env bash
set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       net-monitor — Установка            ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Проверяем Node.js
if ! command -v node &>/dev/null; then
    echo "[ОШИБКА] Node.js не найден."
    echo "Установите через https://nodejs.org/ или:"
    echo "  Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs"
    exit 1
fi
echo "[OK] Node.js: $(node -v)"

# npm install
echo ""
echo "[1/3] Устанавливаем зависимости npm..."
npm install

# Проверяем better-sqlite3
echo ""
echo "[2/3] Проверяем better-sqlite3..."
if ! node -e "require('better-sqlite3')" &>/dev/null; then
    echo "[!] better-sqlite3 требует компиляции..."
    # Устанавливаем build tools если нужно
    if command -v apt-get &>/dev/null; then
        sudo apt-get install -y python3 make g++ 2>/dev/null || true
    elif command -v yum &>/dev/null; then
        sudo yum install -y python3 make gcc-c++ 2>/dev/null || true
    elif command -v brew &>/dev/null; then
        xcode-select --install 2>/dev/null || true
    fi
    npm rebuild better-sqlite3
fi
echo "[OK] better-sqlite3 готов."

# Сертификат
echo ""
echo "[3/3] Проверяем TLS сертификат..."
if [ ! -f "data/certs/cert.pem" ]; then
    echo "[!] Сертификат не найден, генерируем..."
    bash make-cert.sh
else
    echo "[OK] Сертификат уже есть."
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Установка завершена успешно!           ║"
echo "║   Запустите: bash start.sh               ║"
echo "╚══════════════════════════════════════════╝"
echo ""
