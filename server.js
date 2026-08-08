'use strict';

const express  = require('express');
const session  = require('express-session');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const http     = require('http');
const https    = require('https');

// ── Инициализация БД и планировщика ───────────────────────────────────
// (require запускает код модуля: создаёт БД, схему, дефолтные данные)
require('./src/db');
require('./src/services/scheduler');

const app      = express();
const PORT     = process.env.PORT || 9222;
const DATA_DIR = path.join(__dirname, 'data');

const CERT_FILE   = process.env.TLS_CERT_FILE || path.join(DATA_DIR, 'certs', 'cert.pem');
const KEY_FILE    = process.env.TLS_KEY_FILE  || path.join(DATA_DIR, 'certs', 'key.pem');
const USE_HTTPS   = fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
const COOKIE_SECURE = USE_HTTPS || process.env.COOKIE_SECURE === 'true';

// ── Секрет сессии (генерируется один раз при первом запуске) ──────────
const SECRET_FILE = path.join(DATA_DIR, '.session-secret');
let sessionSecret;
if (fs.existsSync(SECRET_FILE)) {
  sessionSecret = fs.readFileSync(SECRET_FILE, 'utf-8').trim();
} else {
  sessionSecret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, sessionSecret, { mode: 0o600 });
}

// ── Middleware ────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(session({
  secret: sessionSecret, resave: false, saveUninitialized: false,
  cookie: { maxAge: 1000*60*60*12, httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE }
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (USE_HTTPS) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// ── Health check (без авторизации) ────────────────────────────────────
const APP_VERSION = (() => { try { return require('./package.json').version; } catch { return '0.0.0'; } })();
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', version: APP_VERSION, uptimeSec: Math.round(process.uptime()), time: new Date().toISOString() })
);

// ── Роуты ────────────────────────────────────────────────────────────
app.use('/api', require('./src/routes/auth'));
app.use('/api', require('./src/routes/settings'));
app.use('/api/devices', require('./src/routes/devices'));
app.use('/api', require('./src/routes/monitoring'));
app.use('/api', require('./src/routes/integrations'));
app.use('/api/discovery', require('./src/routes/discovery'));
app.use(require('./src/routes/metrics'));
app.use('/api', require('./src/routes/sse'));

// ── Статика ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Запуск сервера ────────────────────────────────────────────────────
if (USE_HTTPS) {
  const tlsOpts = { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
  https.createServer(tlsOpts, app).listen(PORT, () =>
    console.log(`NetMonitor запущен по HTTPS: https://localhost:${PORT}`)
  );
  const redirectPort = process.env.HTTP_REDIRECT_PORT != null ? Number(process.env.HTTP_REDIRECT_PORT) : 80;
  if (redirectPort > 0) {
    const srv = http.createServer((req, res) => {
      res.writeHead(301, { Location: `https://${(req.headers.host||'').split(':')[0]}:${PORT}${req.url}` });
      res.end();
    });
    srv.on('error', err => {
      if (err.code === 'EACCES') console.log(`⚠ Редирект с порта ${redirectPort} недоступен (нет прав)`);
      else if (err.code !== 'EADDRINUSE') console.log(`⚠ Редирект: ${err.message}`);
    });
    srv.listen(redirectPort, () => console.log(`HTTP→HTTPS редирект: порт ${redirectPort}`));
  }
} else {
  app.listen(PORT, () => console.log(`NetMonitor запущен: http://localhost:${PORT}`));
}
