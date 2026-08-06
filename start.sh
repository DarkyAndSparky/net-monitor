#!/usr/bin/env bash
# Запуск NetMonitor (Linux/macOS). Сам проверяет и, если нужно, ставит зависимости.
set -e
cd "$(dirname "$0")"

echo "=== NetMonitor ==="

if ! command -v node &> /dev/null; then
  echo "❌ Node.js не найден. Установите Node.js 18+: https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Найден Node.js $(node -v), а нужен 18 или новее (используется встроенный fetch для алертов)."
  echo "   Обновите Node.js: https://nodejs.org/"
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo "❌ npm не найден. Обычно ставится вместе с Node.js — переустановите Node.js."
  exit 1
fi

NEED_INSTALL=0
if [ ! -d node_modules ]; then
  NEED_INSTALL=1
elif [ package.json -nt node_modules ]; then
  # package.json менялся после последней установки — зависимости могли поменяться
  NEED_INSTALL=1
elif [ ! -f node_modules/.install-stamp ]; then
  NEED_INSTALL=1
fi

if [ "$NEED_INSTALL" -eq 1 ]; then
  echo "Зависимости не найдены или устарели — устанавливаю (npm install)..."
  npm install
  touch node_modules/.install-stamp
else
  echo "✔ Зависимости уже установлены"
fi

if [ ! -f data/certs/cert.pem ] || [ ! -f data/certs/key.pem ]; then
  if command -v openssl &> /dev/null; then
    echo "Сертификат не найден — генерирую самоподписанный автоматически..."
    ./make-cert.sh || echo "⚠ Не удалось сгенерировать сертификат, сервер запустится по обычному HTTP."
  else
    echo "ℹ Сертификат не найден, openssl не установлен — сервер запустится по обычному HTTP."
    echo "  Чтобы включить HTTPS: установите openssl и запустите ./make-cert.sh"
  fi
fi

PROTO="http"
[ -f data/certs/cert.pem ] && PROTO="https"
OPEN_PORT="${PORT:-9222}"
URL="$PROTO://localhost:$OPEN_PORT"

if [ "$NO_BROWSER" != "1" ]; then
  (
    sleep 2
    if command -v xdg-open &> /dev/null; then xdg-open "$URL" &> /dev/null
    elif command -v open &> /dev/null; then open "$URL" &> /dev/null
    fi
  ) &
fi

echo ""
echo "Запускаю сервер..."
echo "Открою в браузере: $URL  (чтобы не открывать автоматически: NO_BROWSER=1 ./start.sh)"
echo "Порт можно поменять переменной окружения: PORT=8080 ./start.sh"
echo ""
npm start
