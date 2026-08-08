'use strict';

/**
 * GET /metrics — Prometheus text exposition format (v0.0.4)
 * Подключается в server.js: app.use(require('./src/routes/metrics'))
 *
 * Пример Prometheus scrape config:
 *   scrape_configs:
 *     - job_name: 'net-monitor'
 *       scrape_interval: 30s
 *       static_configs:
 *         - targets: ['your-server:9222']
 *       metrics_path: /metrics
 *       # Если нужна авторизация — добавь Bearer token:
 *       # bearer_token: 'ваш_токен'
 *
 * Доступные метрики:
 *   netmonitor_device_up                  — 1/0 онлайн/оффлайн
 *   netmonitor_device_uptime_pct_24h      — аптайм за 24ч в процентах
 *   netmonitor_device_uptime_pct_7d       — аптайм за 7 дней в процентах
 *   netmonitor_device_rtt_ms              — последний RTT (если есть в истории)
 *   netmonitor_incidents_open_total       — кол-во открытых инцидентов
 *   netmonitor_incidents_total_24h        — инцидентов за 24ч
 *   netmonitor_devices_total              — всего устройств
 *   netmonitor_devices_monitored_total    — отслеживается
 *   netmonitor_devices_online_total       — онлайн прямо сейчас
 *   netmonitor_devices_offline_total      — оффлайн прямо сейчас
 *   netmonitor_build_info                 — версия приложения
 */

const express = require('express');
const { db, getSetting } = require('../db');

const router = express.Router();

// ── Опциональная защита токеном ───────────────────────────────────────
// Установи METRICS_TOKEN=секрет в окружении чтобы закрыть эндпоинт.
// Prometheus передаёт его как: Authorization: Bearer <token>
function metricsAuth(req, res, next) {
  const token = process.env.METRICS_TOKEN;
  if (!token) return next(); // без токена — открытый эндпоинт
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${token}`) return next();
  res.status(401).set('WWW-Authenticate', 'Bearer realm="metrics"').end();
}

// ── Хелперы форматирования ────────────────────────────────────────────
function labels(obj) {
  const parts = Object.entries(obj).map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
  return parts.length ? '{' + parts.join(',') + '}' : '';
}

function gauge(name, help, rows) {
  // rows: [{ labels: {}, value: number }]
  const lines = [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} gauge`,
    ...rows.map(r => `${name}${labels(r.labels)} ${r.value}`),
  ];
  return lines.join('\n') + '\n';
}

function counter(name, help, rows) {
  const lines = [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} counter`,
    ...rows.map(r => `${name}${labels(r.labels)} ${r.value}`),
  ];
  return lines.join('\n') + '\n';
}

// ── Endpoint ──────────────────────────────────────────────────────────
router.get('/metrics', metricsAuth, (req, res) => {
  try {
    const { statusCache } = require('../services/scheduler');
    const now    = Date.now();
    const cut24  = now - 86400 * 1000;
    const cut7d  = now - 7 * 86400 * 1000;

    const devices    = db.prepare('SELECT d.*, c.name as cat_name FROM devices d LEFT JOIN categories c ON c.id = d.category_id').all();
    const features   = getSetting('features') || {};

    // ── Вычисляем аптайм для каждого устройства ───────────────────────
    function calcUptime(deviceId, cutoff) {
      const rows = db.prepare('SELECT online FROM history WHERE device_id=? AND ts>=?').all(deviceId, cutoff);
      if (!rows.length) return -1; // нет данных
      return Math.round((rows.filter(r => r.online).length / rows.length) * 1000) / 10;
    }

    // ── Метрики по устройствам ────────────────────────────────────────
    const upRows       = [];
    const up24Rows     = [];
    const up7dRows     = [];
    let onlineCount    = 0;
    let offlineCount   = 0;
    let monitoredCount = 0;

    for (const d of devices) {
      const lbl = {
        id:       d.id,
        name:     d.name,
        ip:       d.ip       || '',
        category: d.cat_name || d.category_id || '',
        location: d.location || '',
      };

      if (d.monitored) {
        monitoredCount++;
        const s = statusCache[d.id];
        const up = s ? (s.online ? 1 : 0) : -1;
        if (up === 1) onlineCount++;
        if (up === 0) offlineCount++;
        if (up !== -1) upRows.push({ labels: lbl, value: up });

        const u24 = calcUptime(d.id, cut24);
        const u7d = calcUptime(d.id, cut7d);
        if (u24 >= 0) up24Rows.push({ labels: lbl, value: u24 });
        if (u7d >= 0) up7dRows.push({ labels: lbl, value: u7d });
      }
    }

    // ── Инциденты ─────────────────────────────────────────────────────
    const openIncidents = features.incidents
      ? db.prepare("SELECT COUNT(*) as c FROM incidents WHERE end_ts IS NULL").get().c
      : 0;
    const inc24h = features.incidents
      ? db.prepare("SELECT COUNT(*) as c FROM incidents WHERE start_ts>=? AND end_ts IS NOT NULL").get(cut24).c
      : 0;

    // ── Сборка ответа ─────────────────────────────────────────────────
    const version = (() => { try { return require('../../package.json').version; } catch { return '0.0.0'; } })();

    let out = '';

    // build_info
    out += gauge('netmonitor_build_info', 'NetMonitor build info', [
      { labels: { version }, value: 1 }
    ]);

    // Сводные счётчики
    out += gauge('netmonitor_devices_total',           'Total devices in registry',        [{ labels: {}, value: devices.length }]);
    out += gauge('netmonitor_devices_monitored_total', 'Monitored devices count',          [{ labels: {}, value: monitoredCount }]);
    out += gauge('netmonitor_devices_online_total',    'Devices currently online',         [{ labels: {}, value: onlineCount }]);
    out += gauge('netmonitor_devices_offline_total',   'Devices currently offline',        [{ labels: {}, value: offlineCount }]);

    // Статус по устройствам
    if (upRows.length)   out += gauge('netmonitor_device_up',             'Device online status (1=up, 0=down)', upRows);
    if (up24Rows.length) out += gauge('netmonitor_device_uptime_pct_24h', 'Device uptime % over last 24h',       up24Rows);
    if (up7dRows.length) out += gauge('netmonitor_device_uptime_pct_7d',  'Device uptime % over last 7d',        up7dRows);

    // Инциденты
    out += gauge('netmonitor_incidents_open_total', 'Currently open incidents',        [{ labels: {}, value: openIncidents }]);
    out += gauge('netmonitor_incidents_total_24h',  'Incidents closed in last 24h',    [{ labels: {}, value: inc24h }]);

    // process uptime сервера
    out += gauge('netmonitor_server_uptime_seconds', 'NetMonitor server uptime in seconds', [
      { labels: {}, value: Math.round(process.uptime()) }
    ]);

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(out);

  } catch (err) {
    console.error('[metrics]', err.message);
    res.status(500).set('Content-Type', 'text/plain').send(`# ERROR: ${err.message}\n`);
  }
});

module.exports = router;
