'use strict';

/**
 * src/services/logger.js — структурированные логи через pino
 *
 * Использование:
 *   const log = require('../services/logger');
 *   log.info('Сервер запущен');
 *   log.warn({ deviceId: 'd-...' }, 'Устройство недоступно');
 *   log.error({ err }, 'Ошибка подключения к MikroTik');
 *
 * Файлы: data/logs/app.log (текущий), app.log.1..5 (архив)
 * Ротация: 10MB или ежесуточно, хранится 5 файлов
 */

const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, '../../data');
const LOG_DIR  = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── Fallback если pino не установлен ─────────────────────────────────
function makeFallback() {
  const fmt = (level, obj, msg) => {
    const ts  = new Date().toISOString();
    const line = JSON.stringify({ time: ts, level, msg: msg || obj, ...(typeof obj === 'object' && msg ? obj : {}) });
    fs.appendFileSync(LOG_FILE, line + '\n');
    if (level === 'error' || level === 'fatal') console.error(`[${level.toUpperCase()}]`, msg || obj);
    else if (level === 'warn')  console.warn(`[WARN]`, msg || obj);
    else if (level !== 'debug') console.log(`[${level.toUpperCase()}]`, msg || obj);
  };
  const make = (level) => (obj, msg) => fmt(level, obj, msg);
  return { info: make('info'), warn: make('warn'), error: make('error'), debug: make('debug'), fatal: make('fatal'), child: () => module.exports };
}

let pino, pinoRoll;
try { pino = require('pino'); }     catch { module.exports = makeFallback(); return; }
try { pinoRoll = require('pino-roll'); } catch { pinoRoll = null; }

// ── Destination ───────────────────────────────────────────────────────
let dest;
try {
  if (pinoRoll) {
    dest = pinoRoll.createWriteStream({
      file: LOG_FILE, size: '10m', frequency: 'daily',
      limit: { count: 5 }, mkdir: true,
    });
  } else {
    dest = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  }
} catch {
  dest = fs.createWriteStream(LOG_FILE, { flags: 'a' });
}

// ── Logger ────────────────────────────────────────────────────────────
const isDev = process.env.NODE_ENV !== 'production';
let logger;

try {
  if (isDev) {
    // Dev: консоль (pretty) + файл
    let prettyTransport;
    try {
      prettyTransport = pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' }
      });
    } catch { prettyTransport = null; }

    if (prettyTransport) {
      logger = pino(
        { level: LOG_LEVEL, base: null },
        pino.multistream([
          { level: LOG_LEVEL, stream: prettyTransport },
          { level: LOG_LEVEL, stream: dest },
        ])
      );
    } else {
      logger = pino({ level: LOG_LEVEL, base: null, timestamp: pino.stdTimeFunctions.isoTime }, dest);
    }
  } else {
    // Prod: только файл, максимальная скорость
    logger = pino({ level: LOG_LEVEL, base: null, timestamp: pino.stdTimeFunctions.isoTime }, dest);
  }
} catch {
  module.exports = makeFallback();
  return;
}

module.exports = logger;
