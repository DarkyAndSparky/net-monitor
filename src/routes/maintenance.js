'use strict';

/**
 * src/routes/maintenance.js — Maintenance windows
 *
 * Maintenance window = период когда мониторинг идёт, но алерты НЕ отправляются.
 * Используется при плановых работах, перезагрузках, бэкапах.
 *
 * API:
 *   GET    /api/maintenance          — список окон
 *   POST   /api/maintenance          — создать окно
 *   DELETE /api/maintenance/:id      — удалить окно
 *   GET    /api/maintenance/active   — активные прямо сейчас (для планировщика)
 */

const express = require('express');
const { db, newId } = require('../db');
const { requireAuth, requireOperator, logAudit } = require('../middleware/auth');
const log = require('../services/logger');

const router = express.Router();

// Таблица maintenance_windows создаётся в src/db/index.js

// ── Вспомогательные функции ───────────────────────────────────────────
function mwRow(r) {
  return {
    id:         r.id,
    name:       r.name,
    deviceIds:  JSON.parse(r.device_ids || '[]'),
    allDevices: !!r.all_devices,
    startTs:    r.start_ts,
    endTs:      r.end_ts,
    createdBy:  r.created_by,
    createdAt:  r.created_at,
    note:       r.note,
    active:     r.start_ts <= Date.now() && r.end_ts > Date.now(),
  };
}

// Автоочистка истёкших окон (старше 7 дней)
function cleanup() {
  const cut = Date.now() - 7 * 86400 * 1000;
  const n = db.prepare('DELETE FROM maintenance_windows WHERE end_ts < ?').run(cut).changes;
  if (n > 0) log.debug({ deleted: n }, 'Очистка истёкших maintenance windows');
}
setInterval(cleanup, 6 * 60 * 60 * 1000); // раз в 6 часов

// ── GET /api/maintenance ──────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM maintenance_windows ORDER BY start_ts DESC').all();
  res.json(rows.map(mwRow));
});

// ── GET /api/maintenance/active ───────────────────────────────────────
// Используется планировщиком — не требует auth (внутренний вызов)
// Но expose его через API тоже — полезно для отладки
router.get('/active', requireAuth, (req, res) => {
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM maintenance_windows WHERE start_ts <= ? AND end_ts > ?').all(now, now);
  res.json(rows.map(mwRow));
});

// ── POST /api/maintenance ─────────────────────────────────────────────
router.post('/', requireOperator, (req, res) => {
  const b = req.body || {};

  // Валидация
  const startTs = Number(b.startTs);
  const endTs   = Number(b.endTs);
  if (!startTs || !endTs) return res.status(400).json({ error: 'start_end_required', message: 'Укажите начало и конец окна' });
  if (endTs <= startTs)   return res.status(400).json({ error: 'invalid_range', message: 'Конец должен быть позже начала' });
  const durationMs = endTs - startTs;
  if (durationMs > 30 * 24 * 60 * 60 * 1000) return res.status(400).json({ error: 'too_long', message: 'Максимальная длительность — 30 дней' });

  const allDevices = !!b.allDevices;
  const deviceIds  = allDevices ? [] : (Array.isArray(b.deviceIds) ? b.deviceIds : []);
  if (!allDevices && !deviceIds.length) return res.status(400).json({ error: 'devices_required', message: 'Выберите устройства или включите «Все устройства»' });

  const id = newId('mw');
  db.prepare(`INSERT INTO maintenance_windows (id, name, device_ids, all_devices, start_ts, end_ts, created_by, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    b.name || 'Плановые работы',
    JSON.stringify(deviceIds),
    allDevices ? 1 : 0,
    startTs, endTs,
    req.session?.userId || '—',
    b.note || ''
  );

  const row = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id);
  log.info({ id, name: b.name, startTs, endTs }, 'Maintenance window создано');
  logAudit(req, 'maintenance.create', `${b.name || 'Плановые работы'} до ${new Date(endTs).toISOString()}`);
  res.json(mwRow(row));
});

// ── DELETE /api/maintenance/:id ───────────────────────────────────────
router.delete('/:id', requireOperator, (req, res) => {
  const row = db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(req.params.id);
  log.info({ id: req.params.id }, 'Maintenance window удалено');
  logAudit(req, 'maintenance.delete', row.name);
  res.json({ ok: true });
});

// ── Экспортируем функцию проверки — используется в scheduler.js ───────
function isInMaintenance(deviceId) {
  const now = Date.now();
  const active = db.prepare(
    'SELECT * FROM maintenance_windows WHERE start_ts <= ? AND end_ts > ?'
  ).all(now, now);

  return active.some(w => {
    if (w.all_devices) return true;
    const ids = JSON.parse(w.device_ids || '[]');
    return ids.includes(deviceId);
  });
}

module.exports = router;
module.exports.isInMaintenance = isInMaintenance;
