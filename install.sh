#!/usr/bin/env bash
set -e
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       net-monitor — Установка            ║"
echo "╚══════════════════════════════════════════╝"
echo ""

if ! command -v node &>/dev/null; then
    echo "[ОШИБКА] Node.js не найден. Установите >= 22.5.0"
    exit 1
fi
echo "[OK] Node.js: $(node -v)"

echo ""
echo "[1/2] Устанавливаем зависимости npm..."
npm install

echo ""
echo "[2/2] Проверяем TLS сертификат..."
if [ ! -f "data/certs/cert.pem" ]; then
    echo "[!] Сертификат не найден, генерируем..."
    bash make-cert.sh
else
    echo "[OK] Сертификат уже есть."
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Установка завершена!                   ║"
echo "║   Запустите: bash start.sh               ║"
echo "╚══════════════════════════════════════════╝"
echo ""
