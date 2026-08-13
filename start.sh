#!/usr/bin/env bash
cd "$(dirname "$0")"

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
  npm install --silent
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
