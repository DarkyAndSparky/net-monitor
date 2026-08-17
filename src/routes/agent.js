'use strict';

/**
 * src/routes/agent.js — приём метрик от агента (CPU/RAM/disk с самих машин)
 *
 * Отличается от остального API: агент — не браузер, у него нет сессии/cookie.
 * Авторизация — по токену устройства (Bearer <token> в заголовке Authorization).
 *
 * POST /api/agent/report            — агент отправляет снапшот метрик (публичный, токен в заголовке)
 * GET  /api/devices/:id/agent/token — сгенерировать/показать токен (admin/operator)
 * POST /api/devices/:id/agent/reset — перевыпустить токен, старый становится недействителен
 * GET  /api/devices/:id/agent/metrics?range=1h|24h|7d — история метрик для UI
 */

const express = require('express');
const crypto  = require('crypto');
const { db }  = require('../db');
const { requireAuth, requireOperator, logAudit } = require('../middleware/auth');
const log = require('../services/logger');

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

// ── POST /api/agent/report — приём метрик (публичный, авторизация токеном) ──
router.post('/agent/report', (req, res) => {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer (.+)$/.exec(auth);
  if (!m) return res.status(401).json({ error: 'missing_token' });
  const token = m[1];

  const device = db.prepare('SELECT id, name FROM devices WHERE agent_token = ?').get(token);
  if (!device) return res.status(401).json({ error: 'invalid_token' });

  const b = req.body || {};
  // Базовая валидация — не роняем запрос из-за отсутствующих полей, просто пишем что есть
  const row = {
    cpuPct:      isFinite(b.cpu_pct) ? Number(b.cpu_pct) : null,
    ramPct:      isFinite(b.ram_pct) ? Number(b.ram_pct) : null,
    ramUsedMb:   isFinite(b.ram_used_mb) ? Math.round(Number(b.ram_used_mb)) : null,
    ramTotalMb:  isFinite(b.ram_total_mb) ? Math.round(Number(b.ram_total_mb)) : null,
    diskPct:     isFinite(b.disk_pct) ? Number(b.disk_pct) : null,
    diskUsedGb:  isFinite(b.disk_used_gb) ? Number(b.disk_used_gb) : null,
    diskTotalGb: isFinite(b.disk_total_gb) ? Number(b.disk_total_gb) : null,
    uptimeSec:   isFinite(b.uptime_sec) ? Math.round(Number(b.uptime_sec)) : null,
    hostname:    typeof b.hostname === 'string' ? b.hostname.slice(0, 100) : null,
    os:          typeof b.os === 'string' ? b.os.slice(0, 100) : null,
  };

  db.prepare(`INSERT INTO agent_metrics
    (device_id, ts, cpu_pct, ram_pct, ram_used_mb, ram_total_mb, disk_pct, disk_used_gb, disk_total_gb, uptime_sec, hostname, os)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    device.id, Date.now(), row.cpuPct, row.ramPct, row.ramUsedMb, row.ramTotalMb,
    row.diskPct, row.diskUsedGb, row.diskTotalGb, row.uptimeSec, row.hostname, row.os
  );

  // Живое обновление UI без перезапроса
  try {
    const { broadcast } = require('./sse');
    broadcast('agent', { deviceId: device.id, ...row, ts: Date.now() });
  } catch {}

  res.json({ ok: true });
});

// ── GET /api/devices/:id/agent/token — показать/сгенерировать токен ─────────
router.get('/devices/:id/agent/token', requireOperator, (req, res) => {
  const device = db.prepare('SELECT id, agent_token FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'not_found' });

  let token = device.agent_token;
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE devices SET agent_token = ? WHERE id = ?').run(token, device.id);
    logAudit(req, 'agent.token_generate', device.id);
  }
  res.json({ token });
});

// ── POST /api/devices/:id/agent/reset — перевыпустить токен ─────────────────
router.post('/devices/:id/agent/reset', requireOperator, (req, res) => {
  const device = db.prepare('SELECT id FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'not_found' });

  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE devices SET agent_token = ? WHERE id = ?').run(token, device.id);
  logAudit(req, 'agent.token_reset', device.id);
  log.info({ deviceId: device.id }, 'Токен агента перевыпущен');
  res.json({ token });
});

// ── DELETE /api/devices/:id/agent — отвязать агента (удалить токен) ─────────
router.delete('/devices/:id/agent', requireOperator, (req, res) => {
  const device = db.prepare('SELECT id FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'not_found' });

  db.prepare('UPDATE devices SET agent_token = NULL WHERE id = ?').run(device.id);
  logAudit(req, 'agent.unlink', device.id);
  res.json({ ok: true });
});

// ── GET /api/devices/:id/agent/metrics — последний снапшот + история ────────
router.get('/devices/:id/agent/metrics', requireAuth, (req, res) => {
  const device = db.prepare('SELECT id, agent_token FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'not_found' });

  const latest = db.prepare('SELECT * FROM agent_metrics WHERE device_id = ? ORDER BY ts DESC LIMIT 1').get(device.id);

  const range  = RANGE_MS[req.query.range] || RANGE_MS['24h'];
  const cutoff = Date.now() - range;
  const history = db.prepare(
    'SELECT ts, cpu_pct, ram_pct, disk_pct FROM agent_metrics WHERE device_id = ? AND ts >= ? ORDER BY ts'
  ).all(device.id, cutoff);

  res.json({
    linked: !!device.agent_token,
    latest: latest ? {
      ts: latest.ts, cpuPct: latest.cpu_pct, ramPct: latest.ram_pct,
      ramUsedMb: latest.ram_used_mb, ramTotalMb: latest.ram_total_mb,
      diskPct: latest.disk_pct, diskUsedGb: latest.disk_used_gb, diskTotalGb: latest.disk_total_gb,
      uptimeSec: latest.uptime_sec, hostname: latest.hostname, os: latest.os,
    } : null,
    history: downsample(history.map(h => ({ t: h.ts, cpu: h.cpu_pct, ram: h.ram_pct, disk: h.disk_pct }))),
  });
});

module.exports = router;
