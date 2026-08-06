#!/usr/bin/env bash
# Установка зависимостей NetMonitor (Linux/macOS)
set -e
cd "$(dirname "$0")"

echo "=== NetMonitor: установка зависимостей ==="

if ! command -v node &> /dev/null; then
  echo "❌ Node.js не найден. Установите Node.js 18+: https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Найден Node.js $(node -v), а нужен 18 или новее (используется встроенный fetch)."
  echo "   Обновите Node.js: https://nodejs.org/"
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo "❌ npm не найден. Обычно ставится вместе с Node.js — переустановите Node.js."
  exit 1
fi

echo "✔ Node.js $(node -v), npm $(npm -v)"
echo "Устанавливаю зависимости (npm install)..."
npm install

echo ""
echo "✅ Готово. Теперь можно запустить сервер:"
echo "   ./start.sh      (Linux/macOS)"
echo "   start.bat        (Windows)"
