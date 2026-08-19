#!/usr/bin/env bash
# Установка net-monitor агента как systemd-сервиса (Linux)
#
# Использование:
#   sudo bash install-linux.sh --server https://netmonitor.local:9221 --token <ТОКЕН>
#
set -e

case "$(locale charmap 2>/dev/null)" in
  UTF-8|utf-8|UTF8|utf8) ;;
  *)
    echo "[!] Локаль консоли не UTF-8 - русский текст ниже может отображаться некорректно."
    echo "    Решение: export LANG=C.UTF-8 (или ru_RU.UTF-8), затем запустите скрипт заново."
    echo ""
    ;;
esac

SERVER=""
TOKEN=""
INSECURE=""
INTERVAL="60"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --insecure) INSECURE="--insecure"; shift ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) echo "Неизвестный параметр: $1"; exit 1 ;;
  esac
done

if [ -z "$SERVER" ] || [ -z "$TOKEN" ]; then
  echo "Использование: sudo bash install-linux.sh --server <URL> --token <ТОКЕН> [--insecure]"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите с sudo: sudo bash install-linux.sh ..."
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "[ОШИБКА] python3 не найден. Установите его (например: sudo apt install python3)."
  exit 1
fi

AGENT_SRC="$(dirname "$0")/netmonitor-agent.py"
if [ ! -f "$AGENT_SRC" ]; then
  echo "[ОШИБКА] Файл netmonitor-agent.py не найден рядом со скриптом."
  echo "         Запускайте install-linux.sh из папки agent/."
  exit 1
fi

INSTALL_DIR="/opt/netmonitor-agent"
mkdir -p "$INSTALL_DIR"
cp "$AGENT_SRC" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/netmonitor-agent.py"

cat > /etc/systemd/system/netmonitor-agent.service << EOF
[Unit]
Description=net-monitor agent (CPU/RAM/disk metrics)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 $INSTALL_DIR/netmonitor-agent.py --server $SERVER --token $TOKEN --interval $INTERVAL $INSECURE
Restart=on-failure
RestartSec=15
User=nobody

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable netmonitor-agent
systemctl restart netmonitor-agent

echo ""
echo "Готово. Статус: systemctl status netmonitor-agent"
echo "Логи:            journalctl -u netmonitor-agent -f"
