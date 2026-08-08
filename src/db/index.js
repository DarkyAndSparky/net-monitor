'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH  = path.join(DATA_DIR, 'netmonitor.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#6b7280',
    sort  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS devices (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL DEFAULT 'Без имени',
    ip             TEXT NOT NULL DEFAULT '',
    mac            TEXT NOT NULL DEFAULT '',
    location       TEXT NOT NULL DEFAULT '',
    type           TEXT NOT NULL DEFAULT '',
    category_id    TEXT NOT NULL DEFAULT 'other',
    comment        TEXT NOT NULL DEFAULT '',
    is_key         INTEGER NOT NULL DEFAULT 0,
    monitored      INTEGER NOT NULL DEFAULT 1,
    check_interval INTEGER NOT NULL DEFAULT 60,
    alerts_enabled INTEGER NOT NULL DEFAULT 1,
    source         TEXT NOT NULL DEFAULT 'manual',
    snmp_enabled   INTEGER NOT NULL DEFAULT 0,
    snmp_community TEXT NOT NULL DEFAULT 'public',
    snmp_port      INTEGER NOT NULL DEFAULT 161,
    port_checks    TEXT NOT NULL DEFAULT '[]',
    x              REAL NOT NULL DEFAULT 300,
    y              REAL NOT NULL DEFAULT 300,
    created_at     INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
    updated_at     INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    ts        INTEGER NOT NULL,
    online    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hist_dev_ts ON history(device_id, ts);

  CREATE TABLE IF NOT EXISTS topology_edges (
    id            TEXT PRIMARY KEY,
    from_id       TEXT NOT NULL,
    to_id         TEXT NOT NULL,
    label         TEXT NOT NULL DEFAULT '',
    iface         TEXT NOT NULL DEFAULT '',
    manual        INTEGER NOT NULL DEFAULT 0,
    via_router_id TEXT
  );

  CREATE TABLE IF NOT EXISTS incidents (
    id           TEXT PRIMARY KEY,
    device_id    TEXT NOT NULL,
    device_name  TEXT NOT NULL,
    start_ts     INTEGER NOT NULL,
    end_ts       INTEGER,
    duration_sec INTEGER,
    escalated    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_inc_dev   ON incidents(device_id);
  CREATE INDEX IF NOT EXISTS idx_inc_start ON incidents(start_ts);

  CREATE TABLE IF NOT EXISTS audit_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    ip       TEXT NOT NULL DEFAULT '',
    action   TEXT NOT NULL,
    details  TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    salt     TEXT NOT NULL,
    hash     TEXT NOT NULL,
    role     TEXT NOT NULL DEFAULT 'admin'
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ── Дефолтные категории ───────────────────────────────────────────────
const DEF_CATS = [
  { id: 'network',     name: 'Сетевое оборудование',       color: '#3b82f6', sort: 1 },
  { id: 'server',      name: 'Серверы',                    color: '#8b5cf6', sort: 2 },
  { id: 'workstation', name: 'Пользовательские устройства', color: '#10b981', sort: 3 },
  { id: 'cctv',        name: 'Видеонаблюдение',            color: '#f59e0b', sort: 4 },
  { id: 'other',       name: 'Прочее',                     color: '#6b7280', sort: 5 },
];
const _inscat = db.prepare('INSERT OR IGNORE INTO categories (id,name,color,sort) VALUES (?,?,?,?)');
db.transaction(() => DEF_CATS.forEach(c => _inscat.run(c.id, c.name, c.color, c.sort)))();

// ── Настройки ─────────────────────────────────────────────────────────
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(
    key, typeof value === 'string' ? value : JSON.stringify(value)
  );
}

const DEF_SETTINGS = {
  mikrotiks: [], unifiControllers: [], ciscoDevices: [], subnetRules: [],
  alerting: {
    enabled: false, failThreshold: 2, repeatMinutes: 30, notifyOnRecovery: true,
    telegram: { enabled: false, botToken: '', chatId: '' },
    webhook: { enabled: false, url: '' },
    escalation: { enabled: false, afterMinutes: 60, telegramChatId: '' }
  },
  features: { snmp: false, portChecks: false, incidents: false, auditLog: false },
  branding: { appName: 'NetMonitor', accentColor: '#3b82f6', defaultTheme: 'dark' },
};
Object.entries(DEF_SETTINGS).forEach(([k, v]) => { if (getSetting(k) === null) setSetting(k, v); });

function getFeatures() {
  return getSetting('features') || DEF_SETTINGS.features;
}

// ── Дефолтный пользователь ────────────────────────────────────────────
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash));
}
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const { salt, hash } = hashPassword('admin');
  db.prepare('INSERT INTO users (username,salt,hash,role) VALUES (?,?,?,?)').run('admin', salt, hash, 'admin');
  console.log('>>> Создан пользователь по умолчанию: admin / admin — ОБЯЗАТЕЛЬНО смените пароль <<<');
}

// ── Утилиты ───────────────────────────────────────────────────────────
function newId(prefix = '') { return prefix + crypto.randomUUID(); }

function slugify(name) {
  return (name.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'cat')
    + '-' + Math.random().toString(36).slice(2, 6);
}

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

// ── Преобразование строки БД в объект устройства ──────────────────────
function deviceRow(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, ip: r.ip, mac: r.mac,
    location: r.location, type: r.type, category: r.category_id,
    comment: r.comment, key: !!r.is_key, monitored: !!r.monitored,
    checkInterval: r.check_interval, alertsEnabled: !!r.alerts_enabled,
    source: r.source,
    snmp: { enabled: !!r.snmp_enabled, community: r.snmp_community, port: r.snmp_port },
    portChecks: JSON.parse(r.port_checks || '[]'),
    x: r.x, y: r.y,
  };
}

// ── Сжатие истории ────────────────────────────────────────────────────
function compressHistory() {
  const now  = Date.now();
  const cuts = [
    { older: now - 2  * 3600  * 1000, interval:  5 * 60   * 1000 },
    { older: now - 7  * 86400 * 1000, interval: 60 * 60   * 1000 },
    { older: now - 30 * 86400 * 1000, interval: 24 * 3600 * 1000 },
  ];
  const ids = db.prepare('SELECT DISTINCT device_id FROM history').all().map(r => r.device_id);
  ids.forEach(devId => {
    cuts.forEach(({ older, interval }) => {
      db.transaction(() => {
        const pts = db.prepare('SELECT id,ts,online FROM history WHERE device_id=? AND ts<? ORDER BY ts').all(devId, older);
        if (pts.length < 2) return;
        const buckets = {};
        pts.forEach(p => {
          const b = Math.floor(p.ts / interval) * interval;
          if (!buckets[b]) buckets[b] = { sum: 0, count: 0, ids: [] };
          buckets[b].sum += p.online; buckets[b].count++; buckets[b].ids.push(p.id);
        });
        const del = db.prepare('DELETE FROM history WHERE id=?');
        const ins = db.prepare('INSERT INTO history (device_id,ts,online) VALUES (?,?,?)');
        Object.entries(buckets).forEach(([bucket, b]) => {
          if (b.count < 2) return;
          b.ids.forEach(id => del.run(id));
          ins.run(devId, Number(bucket), b.sum / b.count >= 0.5 ? 1 : 0);
        });
      })();
    });
  });
}
setInterval(compressHistory, 60 * 60 * 1000);

module.exports = { db, newId, slugify, csvCell, deviceRow, getSetting, setSetting, getFeatures, hashPassword, verifyPassword };
