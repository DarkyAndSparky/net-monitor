#!/usr/bin/env bash
# Генерирует самоподписанный TLS-сертификат для NetMonitor (Linux/macOS).
# После этого server.js сам обнаружит сертификат и запустится по HTTPS.
set -e
cd "$(dirname "$0")"

if ! command -v openssl &> /dev/null; then
  echo "[ERROR] openssl не найден. Установите его (обычно уже есть в Linux/macOS; в Ubuntu: sudo apt install openssl)."
  exit 1
fi

# Пытаемся определить IP этой машины в локальной сети, чтобы сразу вписать его в сертификат
AUTO_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$AUTO_IP" ] && AUTO_IP=$(ipconfig getifaddr en0 2>/dev/null)
[ -z "$AUTO_IP" ] && AUTO_IP="127.0.0.1"

HOST_OR_IP="${1:-$AUTO_IP}"

mkdir -p data/certs

echo "=== Генерация самоподписанного сертификата ==="
echo "CN / SAN: $HOST_OR_IP"
echo "(чтобы указать другой адрес/домен: ./make-cert.sh 192.168.1.50  или  ./make-cert.sh mynetmonitor.local)"
echo ""

openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout data/certs/key.pem \
  -out data/certs/cert.pem \
  -days 825 \
  -subj "/CN=${HOST_OR_IP}" \
  -addext "subjectAltName=IP:${HOST_OR_IP},DNS:localhost,DNS:${HOST_OR_IP}"

chmod 600 data/certs/key.pem

echo ""
echo "[OK] Готово: data/certs/cert.pem и data/certs/key.pem"
echo "Перезапустите сервер (./start.sh) — он сам обнаружит сертификат и включит HTTPS."
echo ""
echo "[!] Это самоподписанный сертификат — браузер один раз покажет предупреждение"
echo "    «соединение не защищено» / «сертификату не доверяют». Это нормально для"
echo "    локальной сети без внешнего домена — просто подтвердите переход один раз"
echo "    (или добавьте cert.pem в доверенные на устройствах, если хотите убрать предупреждение)."
