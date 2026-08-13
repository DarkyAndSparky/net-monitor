'use strict';

/**
 * src/services/logger.js — Структурированные логи через pino
 *
 * Использование:
 *   const log = require('../services/logger');
 *   log.info('Сервер запущен');
 *   log.warn({ port: 9222 }, 'Порт занят');
 *   log.error({ err }, 'Ошибка подключения');
 *
 * Уровни (LOG_LEVEL): trace | debug | info (default) | warn | error | fatal
 * Формат: в production — JSON, в dev — pino-pretty (если установлен)
 * Файл: data/logs/app.log (ротация раз в сутки, хранится 7 дней)
 */

const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, '../../data');
const LOG_DIR  = path.join(DATA_DIR, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const IS_PROD   = process.env.NODE_ENV === 'production';

// Fallback если pino не установлен
let pino;
try { pino = require('pino'); } catch {
  const noop = () => {};
  const lvls = ['trace','debug','info','warn','error','fatal'];
  const cur  = lvls.indexOf(LOG_LEVEL);
  const makeLogger = () => {
    const l = {};
    lvls.forEach((lv, i) => {
      const fn = lv === 'trace' || lv === 'debug' ? console.debug
               : lv === 'info'  ? console.log
               : lv === 'warn'  ? console.warn : console.error;
      l[lv] = i >= cur ? fn.bind(console) : noop;
    });
    l.child = () => makeLogger();
    l.httpLogger = (req, res, next) => next();
    return l;
  };
  console.warn('[logger] pino не установлен → console.*. Запустите: npm install pino pino-roll pino-pretty');
  module.exports = makeLogger();
  return;
}

// Транспорты
const targets = [];

// Файловый лог
try {
  require.resolve('pino-roll');
  targets.push({
    target: 'pino-roll',
    level: LOG_LEVEL,
    options: {
      file: path.join(LOG_DIR, 'app.log'),
      frequency: 'daily',
      limit: { count: 7 },
      mkdir: true,
    },
  });
} catch {
  targets.push({
    target: 'pino/file',
    level: LOG_LEVEL,
    options: { destination: path.join(LOG_DIR, 'app.log'), mkdir: true },
  });
}

// Консоль
if (!IS_PROD) {
  try {
    require.resolve('pino-pretty');
    targets.push({
      target: 'pino-pretty',
      level: LOG_LEVEL,
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
    });
  } catch {
    targets.push({ target: 'pino/file', level: LOG_LEVEL, options: { destination: 1 } });
  }
} else {
  targets.push({ target: 'pino/file', level: LOG_LEVEL, options: { destination: 1 } });
}

const logger = pino(
  {
    level: LOG_LEVEL,
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
  },
  pino.transport({ targets })
);

// HTTP access log middleware
logger.httpLogger = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms  = Date.now() - start;
    const lvl = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    logger[lvl]({ method: req.method, url: req.url, status: res.statusCode, ms }, 'HTTP');
  });
  next();
};

module.exports = logger;
