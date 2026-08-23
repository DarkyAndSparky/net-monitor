'use strict';
/**
 * src/routes/logs.js — Просмотр системных логов (data/logs/*.log)
 *
 * Файлы пишет pino-roll: активный файл всегда называется `app.log`,
 * архивные после ротации — `app.log.1`, `app.log.2`, ... (без даты в имени,
 * ротация ежедневная/по размеру, хранится 7 файлов). Дата для UI выводится
 * из mtime файла — это единственный надёжный источник даты для архивов.
 *
 * Формат строки — JSON от pino: {level: <число>, time: <ISO>, msg, ...поля}.
 * Числовой level переводим в текстовый (10=TRACE...60=FATAL). Строки, которые
 * не парсятся как JSON (например вывод стороннего процесса), возвращаются
 * как level: 'RAW' с исходным текстом в msg — ничего не теряем.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAdmin, logAudit } = require('../middleware/auth');

const router = express.Router();
const LOG_DIR = path.join(__dirname, '../../data/logs');
const PINO_LEVELS = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const OMIT_FIELDS = new Set(['time', 'level', 'msg', 'pid', 'hostname', 'v']);

function listLogFiles() {
  if (!fs.existsSync(LOG_DIR)) return [];
  const files = fs.readdirSync(LOG_DIR)
    .filter(f => /^app\.log(\.\d+)?$/.test(f))
    .map(f => {
      const full = path.join(LOG_DIR, f);
      let stat;
      try { stat = fs.statSync(full); } catch { return null; }
      const m = /^app\.log\.(\d+)$/.exec(f);
      return {
        filename: f,
        num: m ? Number(m[1]) : -1, // 'app.log' без суффикса (на случай нестандартного транспорта) считаем самым старым
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        date: new Date(stat.mtimeMs).toISOString().slice(0, 10)
      };
    })
    .filter(Boolean);
  // pino-roll всегда нумерует файлы (app.log.1, app.log.2, ...) — новый файл получает
  // следующий по порядку номер, поэтому текущий активный — с наибольшим суффиксом,
  // а не файл без номера (такого файла pino-roll не создаёт).
  const maxNum = files.length ? Math.max(...files.map(f => f.num)) : null;
  return files
    .map(f => ({ ...f, isCurrent: f.num === maxNum }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function parseLine(line) {
  try {
    const obj = JSON.parse(line);
    if (typeof obj !== 'object' || obj === null) throw new Error('not an object');
    const extra = {};
    Object.entries(obj).forEach(([k, v]) => { if (!OMIT_FIELDS.has(k)) extra[k] = v; });
    return {
      ts: obj.time ? Date.parse(obj.time) : null,
      level: PINO_LEVELS[obj.level] || 'RAW',
      msg: obj.msg != null ? String(obj.msg) : '',
      ...extra
    };
  } catch {
    return { ts: null, level: 'RAW', msg: line };
  }
}

function readLogFile(fullPath, { level, search, lines }) {
  if (!fs.existsSync(fullPath)) return [];
  const raw = fs.readFileSync(fullPath, 'utf8');
  const rawLines = raw.split('\n').filter(Boolean);
  let parsed = rawLines.map(parseLine);
  if (level) parsed = parsed.filter(l => l.level === level.toUpperCase());
  if (search) {
    const needle = search.toLowerCase();
    parsed = parsed.filter(l => JSON.stringify(l).toLowerCase().includes(needle));
  }
  return parsed.slice(-lines);
}

function findFileByDate(date) {
  return listLogFiles().find(f => f.date === date);
}

function parseQueryOpts(req) {
  return {
    lines: Math.min(2000, Math.max(1, Number(req.query.lines) || 200)),
    level: (req.query.level || '').trim(),
    search: (req.query.search || '').trim()
  };
}

// Список архивных файлов (для выпадающего списка дат) — текущий активный файл
// не включаем, фронт уже жёстко кодирует "Сегодня" как отдельный пункт
router.get('/logs/files', requireAdmin, (req, res) => {
  const files = listLogFiles().filter(f => !f.isCurrent).map(f => ({ date: f.date, sizeBytes: f.sizeBytes }));
  res.json({ files });
});

// Последние строки из активного (текущего) файла
router.get('/logs', requireAdmin, (req, res) => {
  const opts = parseQueryOpts(req);
  const current = listLogFiles().find(f => f.isCurrent);
  const result = current ? readLogFile(path.join(LOG_DIR, current.filename), opts) : [];
  res.json({ date: current ? current.date : new Date().toISOString().slice(0, 10), count: result.length, lines: result });
});

// Строки из конкретного архивного файла по дате
router.get('/logs/file/:date', requireAdmin, (req, res) => {
  const target = findFileByDate(req.params.date);
  if (!target) return res.status(404).json({ error: 'not_found', message: 'Файл лога за эту дату не найден' });
  const opts = parseQueryOpts(req);
  const result = readLogFile(path.join(LOG_DIR, target.filename), opts);
  res.json({ date: target.date, count: result.length, lines: result });
});

// Скачать файл лога целиком (raw, без фильтрации)
router.get('/logs/file/:date/download', requireAdmin, (req, res) => {
  const target = findFileByDate(req.params.date);
  if (!target) return res.status(404).json({ error: 'not_found' });
  res.download(path.join(LOG_DIR, target.filename), `netmonitor-${target.date}.log`);
});

// Удалить архивный файл лога (текущий активный удалить нельзя — в него пишет процесс)
router.delete('/logs/file/:date', requireAdmin, (req, res) => {
  const target = findFileByDate(req.params.date);
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (target.isCurrent) return res.status(400).json({ error: 'cannot_delete_current', message: 'Нельзя удалить активный файл — в него сейчас идёт запись' });
  try {
    fs.unlinkSync(path.join(LOG_DIR, target.filename));
  } catch (e) {
    return res.status(500).json({ error: 'delete_failed', message: e.message });
  }
  logAudit(req, 'logs.delete', target.date);
  res.json({ ok: true });
});

// Живой tail активного файла лога через SSE — как `tail -f` / docker logs -f.
// Опрос вместо fs.watch: надёжнее кросс-платформенно (Windows/сетевые ФС),
// и проще корректно обработать ротацию файла (размер "уменьшился" → начинаем заново).
router.get('/logs/stream', requireAdmin, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(':ok\n\n');

  let watchedPath = null;
  let lastSize = 0;

  const poll = setInterval(() => {
    const current = listLogFiles().find(f => f.isCurrent);
    if (!current) return;
    const fullPath = path.join(LOG_DIR, current.filename);

    if (fullPath !== watchedPath) {
      // Первое подключение или переключение на новый файл после ротации:
      // не шлём весь бэклог, только фиксируем текущий размер и начинаем tail с этой точки.
      watchedPath = fullPath;
      try { lastSize = fs.statSync(fullPath).size; } catch { lastSize = 0; }
      return;
    }

    let stat;
    try { stat = fs.statSync(fullPath); } catch { return; }
    if (stat.size < lastSize) lastSize = 0; // файл был обрезан — читаем заново с начала
    if (stat.size === lastSize) return;

    let chunk;
    try {
      const fd = fs.openSync(fullPath, 'r');
      const buf = Buffer.alloc(stat.size - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
    } catch { return; }
    lastSize = stat.size;

    chunk.split('\n').filter(Boolean).forEach(line => {
      const parsed = parseLine(line);
      res.write(`data: ${JSON.stringify(parsed)}\n\n`);
    });
  }, 1500);

  const keepAlive = setInterval(() => { try { res.write(':keepalive\n\n'); } catch {} }, 25000);

  req.on('close', () => { clearInterval(poll); clearInterval(keepAlive); });
});

module.exports = router;
module.exports.parseLine = parseLine;
module.exports.listLogFiles = listLogFiles;
