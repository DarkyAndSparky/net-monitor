#!/usr/bin/env bash
cd "$(dirname "$0")"

case "$(locale charmap 2>/dev/null)" in
  UTF-8|utf-8|UTF8|utf8) ;;
  *)
    echo "[!] Локаль консоли не UTF-8 - русский текст ниже может отображаться некорректно."
    echo "    Решение: export LANG=C.UTF-8 (или ru_RU.UTF-8), затем запустите скрипт заново."
    echo ""
    ;;
esac

echo ""
echo " ╔══════════════════════════════════════════╗"
echo " ║           net-monitor v0.9               ║"
echo " ╚══════════════════════════════════════════╝"
echo ""

# Проверяем Node.js
if ! command -v node &>/dev/null; then
  echo " [ОШИБКА] Node.js не найден. Установите >= 22.5.0"
  exit 1
fi
NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo " [ОШИБКА] Требуется Node.js 22+. Установлена: $(node -v)"
  exit 1
fi

# Зависимости
if [ ! -d node_modules ]; then
  echo " Устанавливаю зависимости..."
  npm install --silent --no-audit --no-fund
  if [ ! -d "node_modules/express" ]; then
    echo " [ОШИБКА] npm install не смог поставить основные зависимости."
    exit 1
  fi
  echo " [OK] Зависимости установлены."
  echo ""
fi

# Сертификат
if [ ! -f "data/certs/cert.pem" ]; then
  if command -v openssl &>/dev/null; then
    echo " Генерирую самоподписанный сертификат..."
    bash make-cert.sh auto
    echo ""
  else
    echo " [!] openssl не найден — запуск по HTTP."
    echo "     Для HTTPS: установите openssl и запустите make-cert.sh"
    echo ""
  fi
fi

npm start
