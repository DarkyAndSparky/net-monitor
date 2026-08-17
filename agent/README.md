# net-monitor agent

Лёгкий скрипт (Python, только stdlib — без зависимостей) для сбора CPU/RAM/disk
метрик с машины и отправки их в NetMonitor. Ping видит только «жив/мёртв»,
агент даёт заглянуть внутрь — на что расходуется ресурс.

## Быстрый старт

### 1. Получите токен устройства

В NetMonitor: карточка устройства → вкладка **Агент** → **Показать токен**.
Если устройства ещё нет в реестре — сначала добавьте его.

### 2. Установите агент

**Linux (systemd):**
```bash
sudo bash install-linux.sh --server https://netmonitor.local:9221 --token <ТОКЕН>
```

**Windows (Планировщик заданий):**
```cmd
install-windows.bat https://netmonitor.local:9221 <ТОКЕН>
```

**Вручную (любая ОС с Python 3.6+):**
```bash
python3 netmonitor-agent.py --server https://netmonitor.local:9221 --token <ТОКЕН>
```

### 3. Проверка

Через минуту в NetMonitor на детальной странице устройства появится
блок «Агент» с текущими CPU/RAM/disk и графиком.

## Параметры

| Флаг | Переменная окружения | По умолчанию | Описание |
|---|---|---|---|
| `--server` | `NETMONITOR_SERVER` | — | URL сервера NetMonitor |
| `--token` | `NETMONITOR_TOKEN` | — | Токен устройства |
| `--interval` | `NETMONITOR_INTERVAL` | 60 | Интервал отправки, сек |
| `--disk-path` | `NETMONITOR_DISK_PATH` | `/` (или `C:\` на Windows) | Какой диск мониторить |
| `--insecure` | — | выкл | Не проверять TLS-сертификат (для самоподписанного сертификата NetMonitor) |
| `--once` | — | выкл | Отправить один раз и выйти (для отладки/cron) |

## Самоподписанный сертификат

Если NetMonitor использует автосгенерированный сертификат (`make-cert.bat`/`.sh`),
агент по умолчанию откажется подключаться из-за непроверенного TLS. Добавьте
`--insecure` или переменную окружения `NETMONITOR_INSECURE=1`:

```bash
python3 netmonitor-agent.py --server https://netmonitor.local:9221 --token <ТОКЕН> --insecure
```

## Проверка вручную (без установки службы)

```bash
python3 netmonitor-agent.py --server https://netmonitor.local:9221 --token <ТОКЕН> --once
```

Выведет `OK — cpu=12.3% ram=45.1% disk=67.8%` при успехе, либо код ошибки.

## Управление (Linux)

```bash
systemctl status netmonitor-agent    # статус
journalctl -u netmonitor-agent -f    # логи в реальном времени
systemctl restart netmonitor-agent   # перезапуск (после смены токена)
systemctl disable --now netmonitor-agent && rm /etc/systemd/system/netmonitor-agent.service  # удаление
```

## Управление (Windows)

```cmd
schtasks /query /tn "NetMonitorAgent"     REM статус
schtasks /end /tn "NetMonitorAgent"       REM остановить
schtasks /run /tn "NetMonitorAgent"       REM запустить
schtasks /delete /tn "NetMonitorAgent" /f REM удалить
```

## Безопасность

- Токен даёт право писать метрики только для одного конкретного устройства — не полный доступ к API
- Перевыпуск токена (карточка устройства → Агент → «Перевыпустить») мгновенно делает старый токен недействительным
- Трафик метрик — обычный JSON по HTTPS, не более пары КБ раз в минуту

## Точность метрик без сторонних библиотек

Скрипт читает `/proc/stat`, `/proc/meminfo` на Linux; `GetSystemTimes`,
`GlobalMemoryStatusEx`, `GetTickCount64` через ctypes на Windows;
`vm_stat`/`sysctl` на macOS — без установки `psutil` или других pip-пакетов.

CPU% точный на **Linux и Windows** (прямое чтение системных счётчиков времени).
На **macOS** CPU% — приближение через `loadavg` (может быть неточным при малом
числе ядер); для точных цифр на macOS добавьте `psutil` в окружение и форкните
`get_cpu_percent()`.
