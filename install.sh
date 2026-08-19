#!/usr/bin/env bash
set -e

case "$(locale charmap 2>/dev/null)" in
  UTF-8|utf-8|UTF8|utf8) ;;
  *)
    echo "[!] Локаль консоли не UTF-8 - русский текст ниже может отображаться некорректно."
    echo "    Решение: export LANG=C.UTF-8 (или ru_RU.UTF-8), затем запустите скрипт заново."
    echo ""
    ;;
esac

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
set +e
npm install --no-audit --no-fund
set -e
if [ ! -d "node_modules/express" ]; then
    echo "[ОШИБКА] npm install не смог поставить основные зависимости."
    echo "         Проверьте вывод выше."
    exit 1
fi

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
