'use strict';

/**
 * src/routes/device-detail.js
 * Детальная страница устройства — агрегированные данные для /device/:id
 *
 * GET /api/device/:id/detail  — полный профиль устройства
 */

const express = require('express');
const { db, getSetting } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/:id/detail', requireAuth, (req, res) => {
  const device = db.prepare(`
    SELECT d.*, c.name as cat_name, c.color as cat_color
    FROM devices d
    LEFT JOIN categories c ON c.id = d.category_id
    WHERE d.id = ?
  `).get(req.params.id);

  if (!device) return res.status(404).json({ error: 'not_found' });

  const now   = Date.now();
  const cut1h  = now - 3600 * 1000;
  const cut24h = now - 86400 * 1000;
  const cut7d  = now - 7 * 86400 * 1000;
  const cut30d = now - 30 * 86400 * 1000;

  // ── История для графика (последние 7 дней, макс 500 точек) ──────────
  const historyRaw = db.prepare(
    'SELECT ts, online FROM history WHERE device_id=? AND ts>=? ORDER BY ts'
  ).all(device.id, cut7d);

  // Downsampling до 200 точек для графика
  const history = downsample(historyRaw, 200);

  // ── Аптайм ────────────────────────────────────────────────────────────
  const calcUptime = (cutoff) => {
    const rows = db.prepare('SELECT online FROM history WHERE device_id=? AND ts>=?').all(device.id, cutoff);
    if (!rows.length) return null;
    return Math.round((rows.filter(r => r.online).length / rows.length) * 1000) / 10;
  };

  // ── Статистика пингов за 24ч ──────────────────────────────────────────
  const pings24h = db.prepare('SELECT online FROM history WHERE device_id=? AND ts>=?').all(device.id, cut24h);
  const totalChecks = pings24h.length;
  const successChecks = pings24h.filter(r => r.online).length;
  const failChecks = totalChecks - successChecks;

  // ── Последние инциденты ────────────────────────────────────────────────
  const features = getSetting('features') || {};
  const incidents = features.incidents
    ? db.prepare(`
        SELECT * FROM incidents
        WHERE device_id = ?
        ORDER BY start_ts DESC
        LIMIT 20
      `).all(device.id).map(i => ({
        id:          i.id,
        start:       i.start_ts,
        end:         i.end_ts,
        durationSec: i.end_ts
          ? i.duration_sec
          : Math.round((now - i.start_ts) / 1000),
        open:        !i.end_ts,
        escalated:   !!i.escalated,
      }))
    : [];

  // ── Связи топологии ────────────────────────────────────────────────────
  const edges = db.prepare(`
    SELECT e.*, 
      df.name as from_name, df.ip as from_ip,
      dt.name as to_name,   dt.ip as to_ip
    FROM topology_edges e
    LEFT JOIN devices df ON df.id = e.from_id
    LEFT JOIN devices dt ON dt.id = e.to_id
    WHERE e.from_id = ? OR e.to_id = ?
  `).all(device.id, device.id).map(e => ({
    id:       e.id,
    from:     { id: e.from_id, name: e.from_name, ip: e.from_ip },
    to:       { id: e.to_id,   name: e.to_name,   ip: e.to_ip   },
    label:    e.label,
    iface:    e.iface,
    manual:   !!e.manual,
  }));

  // ── Последние записи аудита по устройству ─────────────────────────────
  const auditEntries = features.auditLog
    ? db.prepare(`
        SELECT ts, username, action, details FROM audit_log
        WHERE details LIKE ? OR details LIKE ?
        ORDER BY ts DESC LIMIT 10
      `).all(`%${device.name}%`, `%${device.ip}%`).map(e => ({
        t:      e.ts,
        user:   e.username,
        action: e.action,
        detail: e.details,
      }))
    : [];

  res.json({
    device: {
      id:            device.id,
      name:          device.name,
      ip:            device.ip,
      mac:           device.mac,
      location:      device.location,
      type:          device.type,
      category:      device.category_id,
      categoryName:  device.cat_name,
      categoryColor: device.cat_color,
      comment:       device.comment,
      key:           !!device.is_key,
      monitored:     !!device.monitored,
      checkInterval: device.check_interval,
      alertsEnabled: !!device.alerts_enabled,
      source:        device.source,
      portChecks:    JSON.parse(device.port_checks || '[]'),
      snmp: {
        enabled:   !!device.snmp_enabled,
        community: device.snmp_community,
        port:      device.snmp_port,
      },
      createdAt: device.created_at,
      updatedAt: device.updated_at,
    },
    uptime: {
      h1:  calcUptime(cut1h),
      h24: calcUptime(cut24h),
      d7:  calcUptime(cut7d),
      d30: calcUptime(cut30d),
    },
    stats24h: {
      totalChecks,
      successChecks,
      failChecks,
      successRate: totalChecks ? Math.round((successChecks / totalChecks) * 1000) / 10 : null,
    },
    history,
    incidents,
    topology: { edges },
    audit:    auditEntries,
  });
});

// Downsampling: схлопываем массив до maxPoints равномерно
function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points.map(p => ({ t: p.ts, online: !!p.online }));
  const step = points.length / maxPoints;
  const result = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(Math.round(i * step), points.length - 1);
    result.push({ t: points[idx].ts, online: !!points[idx].online });
  }
  return result;
}

module.exports = router;
