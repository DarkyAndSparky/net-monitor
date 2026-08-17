#!/usr/bin/env python3
"""
netmonitor-agent.py — лёгкий агент сбора метрик для NetMonitor

Отправляет CPU/RAM/disk метрики на сервер NetMonitor раз в минуту.
Работает на чистом stdlib — Python не требует установки пакетов.

Использование:
    python3 netmonitor-agent.py --server https://netmonitor.local:9221 --token <ТОКЕН>

Или через переменные окружения:
    export NETMONITOR_SERVER=https://netmonitor.local:9221
    export NETMONITOR_TOKEN=<токен из карточки устройства>
    python3 netmonitor-agent.py

Токен генерируется в NetMonitor: карточка устройства → вкладка «Агент» →
«Показать токен» (или через API: GET /api/devices/:id/agent/token).

Требования: Python 3.6+. На Linux/macOS — обычно уже установлен.
На Windows — https://python.org (при установке отметить "Add to PATH").
"""

import argparse
import json
import os
import platform
import shutil
import socket
import ssl
import sys
import time
import urllib.request
import urllib.error

DEFAULT_INTERVAL = 60  # секунд между отправками


def get_cpu_percent(sample_sec=1.0):
    """CPU% без psutil — точное измерение на Linux и Windows,
    приближение через loadavg на macOS."""
    if sys.platform.startswith('linux'):
        def read_stat():
            with open('/proc/stat') as f:
                parts = f.readline().split()[1:8]
            return [int(x) for x in parts]
        a = read_stat()
        time.sleep(sample_sec)
        b = read_stat()
        idle_a, idle_b = a[3] + a[4], b[3] + b[4]
        total_a, total_b = sum(a), sum(b)
        total_delta = total_b - total_a
        idle_delta = idle_b - idle_a
        if total_delta <= 0:
            return None
        return round((1 - idle_delta / total_delta) * 100, 1)
    elif sys.platform == 'win32':
        # GetSystemTimes даёт idle/kernel/user время — точный расчёт без psutil
        try:
            import ctypes

            class FILETIME(ctypes.Structure):
                _fields_ = [('dwLowDateTime', ctypes.c_uint32), ('dwHighDateTime', ctypes.c_uint32)]

            def filetime_to_int(ft):
                return (ft.dwHighDateTime << 32) | ft.dwLowDateTime

            def read_times():
                idle, kernel, user = FILETIME(), FILETIME(), FILETIME()
                ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user))
                return filetime_to_int(idle), filetime_to_int(kernel), filetime_to_int(user)

            idle_a, kernel_a, user_a = read_times()
            time.sleep(sample_sec)
            idle_b, kernel_b, user_b = read_times()

            idle_delta = idle_b - idle_a
            total_delta = (kernel_b - kernel_a) + (user_b - user_a)  # kernel уже включает idle на Windows
            if total_delta <= 0:
                return None
            return round((1 - idle_delta / total_delta) * 100, 1)
        except Exception:
            return None
    else:
        # macOS без psutil — грубая оценка через loadavg (не идеально,
        # но лучше чем ничего; для точных цифр можно добавить psutil).
        try:
            load1, _, _ = os.getloadavg()
            cores = os.cpu_count() or 1
            return round(min(100.0, (load1 / cores) * 100), 1)
        except (OSError, AttributeError):
            return None


def get_ram_info():
    """Возвращает (used_mb, total_mb, pct) без psutil."""
    if sys.platform.startswith('linux'):
        info = {}
        with open('/proc/meminfo') as f:
            for line in f:
                key, val = line.split(':')
                info[key.strip()] = int(val.strip().split()[0])  # kB
        total_kb = info.get('MemTotal', 0)
        avail_kb = info.get('MemAvailable', info.get('MemFree', 0))
        used_kb = total_kb - avail_kb
        if total_kb == 0:
            return None, None, None
        return round(used_kb / 1024), round(total_kb / 1024), round(used_kb / total_kb * 100, 1)
    elif sys.platform == 'darwin':
        # macOS: используем vm_stat + sysctl (без внешних пакетов)
        try:
            import subprocess
            total_bytes = int(subprocess.check_output(['sysctl', '-n', 'hw.memsize']).strip())
            vm = subprocess.check_output(['vm_stat']).decode()
            page_size = 4096
            stats = {}
            for line in vm.splitlines():
                if ':' in line:
                    k, v = line.split(':')
                    stats[k.strip()] = int(v.strip().rstrip('.') or 0)
            free_pages = stats.get('Pages free', 0) + stats.get('Pages speculative', 0)
            used_bytes = total_bytes - free_pages * page_size
            total_mb = round(total_bytes / 1024 / 1024)
            used_mb = round(used_bytes / 1024 / 1024)
            return used_mb, total_mb, round(used_mb / total_mb * 100, 1) if total_mb else None
        except Exception:
            return None, None, None
    elif sys.platform == 'win32':
        try:
            import ctypes
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong),
                    ('ullTotalPhys', ctypes.c_ulonglong), ('ullAvailPhys', ctypes.c_ulonglong),
                    ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                    ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong),
                    ('ullAvailExtendedVirtual', ctypes.c_ulonglong),
                ]
            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            total_mb = round(stat.ullTotalPhys / 1024 / 1024)
            avail_mb = round(stat.ullAvailPhys / 1024 / 1024)
            used_mb = total_mb - avail_mb
            return used_mb, total_mb, round(used_mb / total_mb * 100, 1) if total_mb else None
        except Exception:
            return None, None, None
    return None, None, None


def get_disk_info(path='/'):
    """Диск, на котором лежит path (по умолчанию корень)."""
    try:
        total, used, free = shutil.disk_usage(path)
        total_gb = round(total / 1024**3, 1)
        used_gb = round(used / 1024**3, 1)
        pct = round(used / total * 100, 1) if total else None
        return used_gb, total_gb, pct
    except Exception:
        return None, None, None


def get_uptime_sec():
    if sys.platform.startswith('linux'):
        try:
            with open('/proc/uptime') as f:
                return int(float(f.readline().split()[0]))
        except Exception:
            return None
    elif sys.platform == 'darwin':
        try:
            import subprocess
            out = subprocess.check_output(['sysctl', '-n', 'kern.boottime']).decode()
            # формат: { sec = 1699999999, usec = 0 } ...
            sec = int(out.split('sec = ')[1].split(',')[0])
            return int(time.time() - sec)
        except Exception:
            return None
    elif sys.platform == 'win32':
        try:
            import ctypes
            millis = ctypes.windll.kernel32.GetTickCount64()
            return int(millis / 1000)
        except Exception:
            return None
    return None


def collect_metrics(disk_path):
    cpu_pct = get_cpu_percent()
    ram_used, ram_total, ram_pct = get_ram_info()
    disk_used, disk_total, disk_pct = get_disk_info(disk_path)
    uptime = get_uptime_sec()

    return {
        'cpu_pct': cpu_pct,
        'ram_pct': ram_pct,
        'ram_used_mb': ram_used,
        'ram_total_mb': ram_total,
        'disk_pct': disk_pct,
        'disk_used_gb': disk_used,
        'disk_total_gb': disk_total,
        'uptime_sec': uptime,
        'hostname': socket.gethostname(),
        'os': f'{platform.system()} {platform.release()}',
    }


def send_report(server, token, metrics, insecure=False):
    url = server.rstrip('/') + '/api/agent/report'
    data = json.dumps(metrics).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST', headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {token}',
    })
    ctx = None
    if insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
            return resp.status, None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', errors='replace')
    except Exception as e:
        return None, str(e)


def main():
    parser = argparse.ArgumentParser(description='NetMonitor agent — CPU/RAM/disk метрики')
    parser.add_argument('--server', default=os.environ.get('NETMONITOR_SERVER'), help='URL сервера NetMonitor, напр. https://netmonitor.local:9221')
    parser.add_argument('--token', default=os.environ.get('NETMONITOR_TOKEN'), help='Токен устройства (из карточки устройства → Агент)')
    parser.add_argument('--interval', type=int, default=int(os.environ.get('NETMONITOR_INTERVAL', DEFAULT_INTERVAL)), help='Интервал отправки в секундах (по умолчанию 60)')
    parser.add_argument('--disk-path', default=os.environ.get('NETMONITOR_DISK_PATH', '/'), help='Путь для мониторинга диска (по умолчанию корень / или C:\\ на Windows)')
    parser.add_argument('--insecure', action='store_true', default=os.environ.get('NETMONITOR_INSECURE', '').lower() in ('1', 'true', 'yes'), help='Не проверять TLS-сертификат (для самоподписанных сертификатов NetMonitor)')
    parser.add_argument('--once', action='store_true', help='Отправить один раз и выйти (для проверки/cron)')
    args = parser.parse_args()

    if not args.server or not args.token:
        print('ОШИБКА: нужны --server и --token (или переменные окружения NETMONITOR_SERVER / NETMONITOR_TOKEN)', file=sys.stderr)
        sys.exit(1)

    disk_path = args.disk_path
    if sys.platform == 'win32' and disk_path == '/':
        disk_path = 'C:\\'

    print(f'net-monitor agent запущен: {args.server} (интервал {args.interval}с)')

    while True:
        metrics = collect_metrics(disk_path)
        status, err = send_report(args.server, args.token, metrics, insecure=args.insecure)

        ts = time.strftime('%H:%M:%S')
        if status == 200:
            print(f'[{ts}] OK — cpu={metrics["cpu_pct"]}% ram={metrics["ram_pct"]}% disk={metrics["disk_pct"]}%')
        elif status == 401:
            print(f'[{ts}] ОШИБКА 401 — неверный токен. Проверьте --token', file=sys.stderr)
        elif status == 429:
            print(f'[{ts}] ОШИБКА 429 — слишком частая отправка, сервер ограничил', file=sys.stderr)
        else:
            print(f'[{ts}] ОШИБКА ({status}): {err}', file=sys.stderr)

        if args.once:
            sys.exit(0 if status == 200 else 1)

        time.sleep(args.interval)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nОстановлено')
        sys.exit(0)
