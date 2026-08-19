'use strict';
/**
 * src/services/eventWebhook.js — Webhook на любое событие (не только алерты)
 *
 * Независим от features.auditLog: срабатывает по каждому вызову logAudit(),
 * даже если сам аудит-лог в UI отключён. Настройки хранятся отдельно от
 * alerting.webhook (тот — только для down/up алертов устройств).
 */
const log = require('./logger');
const { getSetting } = require('../db');

async function fireEvent(action, details, meta) {
  let cfg;
  try { cfg = getSetting('eventWebhook') || {}; } catch { return; }
  if (!cfg.enabled || !cfg.url) return;
  if (Array.isArray(cfg.events) && cfg.events.length && !cfg.events.includes(action)) return;

  const payload = {
    event: action,
    details: details || '',
    user: meta?.username || '—',
    ip: meta?.ip || '',
    time: new Date().toISOString()
  };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.secret) headers['X-Netmonitor-Secret'] = cfg.secret;
    await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (e) {
    log.debug({ err: e, action }, 'Event webhook failed');
  }
}

module.exports = { fireEvent };
