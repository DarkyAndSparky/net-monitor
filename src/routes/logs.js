'use strict';

/**
 * src/routes/logs.js — API для просмотра логов из UI
 *
 * GET /api/logs?lines=200&level=warn&search=MikroTik
 *   lines  — сколько последних строк вернуть (1–1000, по умолчанию 200)
 *   level  — фильтр по уровню: debug | info | warn | error | fatal
 *   search — поиск подстроки в поле msg или details (case-insensitive)
 *
 * GET /api/logs/files
 *   Список доступных файлов логов с размерами
 *
 * Требует роль admin.
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const readline = require('readline');
const { requireAdmin } = require('../middleware/auth');

const router   = express.Router();
const LOG_DIR  = path.join(__dirname, '../../data/logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const LEVEL_ORDER = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

// ── Читаем последние N строк файла эффективно (с конца) ──────────────
function readLastLines(filePath, maxLines) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) return resolve([]);
    const lines = [];
    const rl = readline.createInterface({ input: fs.createReadStream(filePath, 'utf-8'), crlfDelay: Infinity });
    rl.on('line', line => { if (line.trim()) lines.push(line); });
    rl.on('close', () => resolve(lines.slice(-maxLines)));
    rl.on('error', reject);
  });
}

// ── Парсим JSON-строку лога ───────────────────────────────────────────
function parseLine(raw) {
  try {
    const obj = JSON.parse(raw);
    return {
      time:  obj.time || obj.ts || null,
      level: obj.level || 'info',
      msg:   obj.msg || obj.message || '',
      ...obj,
    };
  } catch {
    // Не-JSON строка (например из fallback-логгера или pino-pretty)
    return { time: null, level: 'info', msg: raw, _raw: true };
  }
}

// ── GET /api/logs ─────────────────────────────────────────────────────
router.get('/', requireAdmin, async (req, res) => {
  try {
    const maxLines  = Math.min(1000, Math.max(1, Number(req.query.lines) || 200));
    const levelFilter = (req.query.level || '').toLowerCase();
    const search    = (req.query.search || '').toLowerCase();
    const minLevel  = LEVEL_ORDER[levelFilter] || 0;

    const rawLines = await readLastLines(LOG_FILE, maxLines * 3); // берём с запасом для фильтрации
    const entries  = rawLines
      .map(parseLine)
      .filter(e => {
        if (minLevel > 0) {
          const lvl = typeof e.level === 'number' ? e.level : (LEVEL_ORDER[e.level] || 30);
          if (lvl < minLevel) return false;
        }
        if (search && !JSON.stringify(e).toLowerCase().includes(search)) return false;
        return true;
      })
      .slice(-maxLines);

    res.json({ entries, total: entries.length, file: LOG_FILE });
  } catch (err) {
    res.status(500).json({ error: 'log_read_failed', message: err.message });
  }
});

// ── GET /api/logs/files ───────────────────────────────────────────────
router.get('/files', requireAdmin, (req, res) => {
  try {
    if (!fs.existsSync(LOG_DIR)) return res.json({ files: [] });
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('app.log'))
      .sort()
      .reverse()
      .map(f => {
        const fullPath = path.join(LOG_DIR, f);
        const stat = fs.statSync(fullPath);
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
      });
    res.json({ files, dir: LOG_DIR });
  } catch (err) {
    res.status(500).json({ error: 'log_list_failed', message: err.message });
  }
});

module.exports = router;
