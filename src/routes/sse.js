'use strict';

/**
 * src/routes/sse.js — Server-Sent Events
 *
 * GET /api/events  — браузер подписывается один раз после логина,
 * сервер пушит события при смене статуса устройства.
 *
 * Формат события:
 *   event: status
 *   data: {"id":"d-xxx","online":true,"lastChecked":1234567890}
 *
 *   event: ping
 *   data: {"ts":1234567890}   ← keepalive каждые 25 сек
 *
 *   event: snapshot
 *   data: [{"id":...,"online":...}]  ← полный статус при подключении
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router  = express.Router();
const clients = new Set();

// ── Отправить событие всем подключённым клиентам ─────────────────────
function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(payload); } catch { clients.delete(res); }
  });
}

// ── Количество активных соединений (для /api/health) ─────────────────
function clientCount() { return clients.size; }

// ── SSE endpoint ──────────────────────────────────────────────────────
router.get('/events', requireAuth, (req, res) => {
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',  // nginx: отключить буферизацию
  });
  res.flushHeaders();

  // Снимок текущего статуса сразу при подключении
  try {
    const { statusCache } = require('../services/scheduler');
    const snapshot = Object.entries(statusCache).map(([id, s]) => ({
      id, online: s.online, lastChecked: s.lastChecked,
    }));
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  } catch {}

  clients.add(res);

  // Keepalive каждые 25 сек — браузер/прокси иначе закрывает соединение
  const keepalive = setInterval(() => {
    try { res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`); }
    catch { clearInterval(keepalive); clients.delete(res); }
  }, 25000);

  req.on('close', () => { clearInterval(keepalive); clients.delete(res); });
});

module.exports = router;
module.exports.broadcast    = broadcast;
module.exports.clientCount  = clientCount;
