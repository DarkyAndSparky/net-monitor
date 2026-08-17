'use strict';

/**
 * src/routes/traffic.js — API для трафика (SNMP-устройства + MikroTik-роутеры)
 *
 * GET /api/traffic/current                — текущие (последние) значения по всем источникам
 * GET /api/traffic/device/:id?range=1h|24h|7d  — история трафика устройства
 * GET /api/traffic/router/:routerId/:iface?range=...  — история интерфейса роутера
 */

const express = require('express');
const { db, getSetting } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const RANGE_MS = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };

function downsample(points, maxPoints = 200) {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const result = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(Math.round(i * step), points.length - 1);
    result.push(points[idx]);
  }
  return result;
}

// ── Текущие значения по всем активным источникам ──────────────────────
router.get('/current', requireAuth, (req, res) => {
  const features = getSetting('features') || {};
  if (!features.traffic) return res.json({ enabled: false, devices: [], routers: [] });

  // Последняя точка по каждому device
  const devices = db.prepare(`
    SELECT d.id, d.name, d.ip, t.rx_bps, t.tx_bps, t.ts
    FROM devices d
    JOIN traffic_history t ON t.source_type='device' AND t.source_id=d.id
    WHERE t.ts = (SELECT MAX(ts) FROM traffic_history WHERE source_type='device' AND source_id=d.id)
      AND d.snmp_if_index IS NOT NULL
  `).all();

  // Последняя точка по каждому роутеру+интерфейсу
  const routerRows = db.prepare(`
    SELECT source_id, iface, rx_bps, tx_bps, ts
    FROM traffic_history t1
    WHERE source_type='router' AND ts = (
      SELECT MAX(ts) FROM traffic_history t2
      WHERE t2.source_type='router' AND t2.source_id=t1.source_id AND t2.iface=t1.iface
    )
  `).all();

  const mikrotiks = getSetting('mikrotiks') || [];
  const routers = routerRows.map(r => {
    const cfg = mikrotiks.find(m => m.id === r.source_id);
    return { routerId: r.source_id, routerName: cfg?.name || r.source_id, iface: r.iface, rxBps: r.rx_bps, txBps: r.tx_bps, ts: r.ts };
  });

  res.json({
    enabled: true,
    devices: devices.map(d => ({ id: d.id, name: d.name, ip: d.ip, rxBps: d.rx_bps, txBps: d.tx_bps, ts: d.ts })),
    routers,
  });
});

// ── История трафика устройства ─────────────────────────────────────────
router.get('/device/:id', requireAuth, (req, res) => {
  const range  = RANGE_MS[req.query.range] || RANGE_MS['24h'];
  const cutoff = Date.now() - range;
  const rows = db.prepare(
    'SELECT ts, rx_bps, tx_bps FROM traffic_history WHERE source_type=? AND source_id=? AND ts>=? ORDER BY ts'
  ).all('device', req.params.id, cutoff);
  res.json(downsample(rows.map(r => ({ t: r.ts, rx: r.rx_bps, tx: r.tx_bps }))));
});

// ── История трафика интерфейса роутера ─────────────────────────────────
router.get('/router/:routerId/:iface', requireAuth, (req, res) => {
  const range  = RANGE_MS[req.query.range] || RANGE_MS['24h'];
  const cutoff = Date.now() - range;
  const rows = db.prepare(
    'SELECT ts, rx_bps, tx_bps FROM traffic_history WHERE source_type=? AND source_id=? AND iface=? AND ts>=? ORDER BY ts'
  ).all('router', req.params.routerId, req.params.iface, cutoff);
  res.json(downsample(rows.map(r => ({ t: r.ts, rx: r.rx_bps, tx: r.tx_bps }))));
});

module.exports = router;
