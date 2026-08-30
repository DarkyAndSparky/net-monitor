'use strict';

/**
 * src/db/index.js
 * Использует встроенный node:sqlite (Node.js >= 22.5.0, стабилен в v26+)
 * Никаких нативных зависимостей — не нужны Python, Build Tools, node-gyp.
 */

const { DatabaseSync } = require('node:sqlite');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH  = process.env.NETMONITOR_DB_PATH || path.join(DATA_DIR, 'netmonitor.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// Ограничиваем права по умолчанию для файлов, которые SQLite создаст сам
// (WAL/SHM-файлы появляются позже, при первой записи в WAL-режиме — их не
// поймать разовым chmodSync). Безопасно вызывать повторно, если это уже
// сделал server.js — идемпотентно.
process.umask(0o077);

const db = new DatabaseSync(DB_PATH);
try { fs.chmodSync(DB_PATH, 0o600); } catch { /* не критично, если недоступно (напр. read-only FS) */ }

// Эмулируем .pragma() через exec
db.pragma = (str) => db.exec(`PRAGMA ${str}`);

// node:sqlite не имеет .transaction() — создаём совместимый враппер
// Поведение: BEGIN → fn() → COMMIT, при ошибке → ROLLBACK
db.transaction = (fn) => {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  };
};

// Инициализация
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#6b7280',
    sort  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sites (
    id      TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    color   TEXT NOT NULL DEFAULT '#6b7280',
    address TEXT NOT NULL DEFAULT '',
    sort    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS devices (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL DEFAULT 'Без имени',
    ip             TEXT NOT NULL DEFAULT '',
    mac            TEXT NOT NULL DEFAULT '',
    location       TEXT NOT NULL DEFAULT '',
    site_id        TEXT,
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
    snmp_if_index  INTEGER,               -- индекс интерфейса для мониторинга трафика (ifOctets), NULL = не задан
    agent_token    TEXT,                  -- токен доступа для агента (метрики CPU/RAM/disk), NULL = агент не привязан
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
    role     TEXT NOT NULL DEFAULT 'admin',
    must_change_password INTEGER NOT NULL DEFAULT 0,
    source   TEXT NOT NULL DEFAULT 'local'
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS maintenance_windows (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT 'Плановые работы',
    device_ids  TEXT NOT NULL DEFAULT '[]',
    all_devices INTEGER NOT NULL DEFAULT 0,
    start_ts    INTEGER NOT NULL,
    end_ts      INTEGER NOT NULL,
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
    note        TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_mw_end ON maintenance_windows(end_ts);

  CREATE TABLE IF NOT EXISTS traffic_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,   -- 'device' (SNMP ifOctets) | 'router' (MikroTik interface)
    source_id  TEXT NOT NULL,    -- device.id либо mikrotik router.id
    iface      TEXT NOT NULL DEFAULT '',  -- имя/индекс интерфейса (для router — имя, для device — обычно пусто)
    ts         INTEGER NOT NULL,
    rx_bps     REAL NOT NULL DEFAULT 0,
    tx_bps     REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_traffic_source_ts ON traffic_history(source_type, source_id, iface, ts);

  CREATE TABLE IF NOT EXISTS agent_metrics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    cpu_pct     REAL,
    ram_pct     REAL,
    ram_used_mb INTEGER,
    ram_total_mb INTEGER,
    disk_pct    REAL,
    disk_used_gb REAL,
    disk_total_gb REAL,
    uptime_sec  INTEGER,
    hostname    TEXT,
    os          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agent_metrics_dev_ts ON agent_metrics(device_id, ts);
`);

// ── Миграция: колонка users.source для уже существующих БД ─────────────
// (CREATE TABLE IF NOT EXISTS не добавляет новые колонки в существующую
// таблицу — на старых установках без переустановки её нужно добавить руками)
try { db.exec("ALTER TABLE users ADD COLUMN source TEXT NOT NULL DEFAULT 'local'"); } catch { /* уже есть */ }
try { db.exec("ALTER TABLE devices ADD COLUMN site_id TEXT"); } catch { /* уже есть */ }

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
    webhook:  { enabled: false, url: '' },
    escalation: { enabled: false, afterMinutes: 60, telegramChatId: '' }
  },
  features: { snmp: false, portChecks: false, incidents: false, auditLog: false, traffic: false },
  branding: { appName: 'NetMonitor', accentColor: '#3b82f6', defaultTheme: 'dark' },
};
Object.entries(DEF_SETTINGS).forEach(([k, v]) => { if (getSetting(k) === null) setSetting(k, v); });

function getFeatures() { return getSetting('features') || DEF_SETTINGS.features; }

// ── Пользователи ──────────────────────────────────────────────────────
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash));
}
const DEFAULT_ADMIN_PASSWORD = 'admin0000';
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const { salt, hash } = hashPassword(DEFAULT_ADMIN_PASSWORD);
  db.prepare('INSERT INTO users (username,salt,hash,role,must_change_password) VALUES (?,?,?,?,1)').run('admin', salt, hash, 'admin');
  process.stdout.write(`[WARN] Создан пользователь по умолчанию: admin / ${DEFAULT_ADMIN_PASSWORD} — смена пароля потребуется при первом входе\n`);
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

function deviceRow(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, ip: r.ip, mac: r.mac,
    location: r.location, site: r.site_id, type: r.type, category: r.category_id,
    comment: r.comment, key: !!r.is_key, monitored: !!r.monitored,
    checkInterval: r.check_interval, alertsEnabled: !!r.alerts_enabled,
    source: r.source,
    snmp: { enabled: !!r.snmp_enabled, community: r.snmp_community, port: r.snmp_port, ifIndex: r.snmp_if_index ?? null },
    portChecks: JSON.parse(r.port_checks || '[]'),
    agentEnabled: !!r.agent_token,
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

// ── Сжатие/очистка истории трафика ──────────────────────────────────
// Трафик снимается реже пинга (раз в 30-60 сек), но данные всё равно накапливаются.
// Правило: сырые точки старше 7 дней агрегируются в 10-минутные средние (rx/tx bps),
// точки старше 30 дней — удаляются полностью (для длинных трендов лучше Prometheus/Grafana).
function compressTraffic() {
  const now  = Date.now();
  const cut7d  = now - 7  * 86400 * 1000;
  const cut30d = now - 30 * 86400 * 1000;
  const INTERVAL = 10 * 60 * 1000; // 10 минут

  db.prepare('DELETE FROM traffic_history WHERE ts < ?').run(cut30d);

  const keys = db.prepare('SELECT DISTINCT source_type, source_id, iface FROM traffic_history').all();
  keys.forEach(({ source_type, source_id, iface }) => {
    db.transaction(() => {
      const pts = db.prepare(
        'SELECT id, ts, rx_bps, tx_bps FROM traffic_history WHERE source_type=? AND source_id=? AND iface=? AND ts<? ORDER BY ts'
      ).all(source_type, source_id, iface, cut7d);
      if (pts.length < 2) return;

      const buckets = {};
      pts.forEach(p => {
        const b = Math.floor(p.ts / INTERVAL) * INTERVAL;
        if (!buckets[b]) buckets[b] = { rxSum: 0, txSum: 0, count: 0, ids: [] };
        buckets[b].rxSum += p.rx_bps; buckets[b].txSum += p.tx_bps;
        buckets[b].count++; buckets[b].ids.push(p.id);
      });

      const del = db.prepare('DELETE FROM traffic_history WHERE id=?');
      const ins = db.prepare('INSERT INTO traffic_history (source_type,source_id,iface,ts,rx_bps,tx_bps) VALUES (?,?,?,?,?,?)');
      Object.entries(buckets).forEach(([bucket, b]) => {
        if (b.count < 2) return;
        b.ids.forEach(id => del.run(id));
        ins.run(source_type, source_id, iface, Number(bucket), b.rxSum / b.count, b.txSum / b.count);
      });
    })();
  });
}
setInterval(compressTraffic, 60 * 60 * 1000);

// ── Очистка метрик агента ───────────────────────────────────────────
// Метрики агента снимаются раз в минуту (частота задаётся на стороне агента,
// не сервером). Без downsampling — просто удаляем старше 30 дней раз в час.
function cleanupAgentMetrics() {
  const cutoff = Date.now() - 30 * 86400 * 1000;
  db.prepare('DELETE FROM agent_metrics WHERE ts < ?').run(cutoff);
}
setInterval(cleanupAgentMetrics, 60 * 60 * 1000);

module.exports = { db, newId, slugify, csvCell, deviceRow, getSetting, setSetting, getFeatures, hashPassword, verifyPassword };
