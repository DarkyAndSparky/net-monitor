'use strict';

const express  = require('express');
const session  = require('express-session');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const http     = require('http');
const https    = require('https');
const os       = require('os');

// ── Инициализация БД и планировщика ──────────────────────────────────
require('./src/db');
require('./src/services/scheduler');

const log = require('./src/services/logger');
const app = express();

// ── Порты: HTTPS 9221, HTTP→HTTPS редирект 9222 ──────────────────────
const HTTPS_PORT    = Number(process.env.PORT)         || 9221;
const REDIRECT_PORT = Number(process.env.HTTP_REDIRECT_PORT) || 9222;

const DATA_DIR    = path.join(__dirname, 'data');
const CERT_FILE   = process.env.TLS_CERT_FILE || path.join(DATA_DIR, 'certs', 'cert.pem');
const KEY_FILE    = process.env.TLS_KEY_FILE  || path.join(DATA_DIR, 'certs', 'key.pem');
const USE_HTTPS   = fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
const COOKIE_SECURE = USE_HTTPS || process.env.COOKIE_SECURE === 'true';

// ── Секрет сессии ────────────────────────────────────────────────────
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
app.use(log.httpLogger);
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

// ── Health check ──────────────────────────────────────────────────────
const APP_VERSION = (() => { try { return require('./package.json').version; } catch { return '0.0.0'; } })();
// Зависимости с актуальными версиями из node_modules
function getDeps() {
  const names = ['express','express-session','pino','pino-pretty','pino-roll','node-routeros','net-snmp','ssh2'];
  const deps = {};
  names.forEach(name => {
    try {
      const pkg = require(`${name}/package.json`);
      deps[name] = pkg.version;
    } catch { deps[name] = '—'; }
  });
  deps['node:sqlite'] = 'built-in';
  return deps;
}

app.get('/api/health', (req, res) =>
  res.json({
    status: 'ok',
    version: APP_VERSION,
    nodeVersion: process.version,
    uptimeSec: Math.round(process.uptime()),
    time: new Date().toISOString(),
    deps: getDeps(),
  })
);

// Скачать LICENSE как txt
app.get('/api/license', (req, res) => {
  const licPath = path.join(__dirname, 'LICENSE');
  if (fs.existsSync(licPath)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="LICENSE.txt"');
    res.sendFile(licPath);
  } else {
    res.status(404).json({ error: 'not_found' });
  }
});

// ── Роуты ─────────────────────────────────────────────────────────────
app.use('/api',              require('./src/routes/auth'));
app.use('/api',              require('./src/routes/settings'));
app.use('/api/devices',      require('./src/routes/devices'));
app.use('/api',              require('./src/routes/monitoring'));
app.use('/api',              require('./src/routes/integrations'));
app.use('/api/discovery',    require('./src/routes/discovery'));
app.use(                     require('./src/routes/metrics'));
app.use('/api',              require('./src/routes/sse'));
app.use('/api/maintenance',  require('./src/routes/maintenance'));
app.use(express.static(path.join(__dirname, 'public')));

// ── Определяем локальный IP ───────────────────────────────────────────
function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of (ifaces || [])) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

// ── Красивый стартовый экран ──────────────────────────────────────────
function printBanner(useHttps, httpsPort, httpPort, localIP) {
  const line  = '─'.repeat(52);
  const proto = useHttps ? 'https' : 'http';
  const port  = useHttps ? httpsPort : httpPort;

  process.stdout.write('\n');
  process.stdout.write(`  🚀  net-monitor — сервер запущен\n`);
  process.stdout.write(`  ${line}\n`);
  process.stdout.write(`  Протокол:   ${useHttps ? 'HTTPS' : 'HTTP'}\n`);
  process.stdout.write(`  Локально:   ${proto}://localhost:${port}\n`);
  if (useHttps) {
    process.stdout.write(`  По сети:    https://${localIP}:${httpsPort}\n`);
    process.stdout.write(`  Редирект:   http://localhost:${httpPort} → HTTPS\n`);
  } else {
    process.stdout.write(`  По сети:    http://${localIP}:${port}\n`);
  }
  process.stdout.write(`  База данных: ${path.join(process.cwd(), 'data', 'netmonitor.db')}\n`);
  process.stdout.write(`  Версия:     v${APP_VERSION}  (Node.js ${process.version})\n`);
  process.stdout.write(`  ${line}\n`);
  if (useHttps) {
    process.stdout.write(`  ⚠  Браузер покажет предупреждение о самоподписанном сертификате.\n`);
    process.stdout.write(`     Нажми «Дополнительно» → «Перейти на сайт»\n`);
    process.stdout.write(`  📄 Сертификат: ${CERT_FILE}\n`);
  } else {
    process.stdout.write(`  💡 Для HTTPS запусти make-cert.bat и перезапусти сервер.\n`);
  }
  process.stdout.write(`  ${line}\n\n`);
}

// ── Запуск ────────────────────────────────────────────────────────────
const localIP = getLocalIP();

if (USE_HTTPS) {
  const tlsOpts = { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };

  https.createServer(tlsOpts, app).listen(HTTPS_PORT, () => {
    // HTTP → HTTPS редирект
    if (REDIRECT_PORT > 0) {
      const redir = http.createServer((req, res) => {
        const host = (req.headers.host || '').split(':')[0];
        res.writeHead(301, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
        res.end();
      });
      redir.on('error', err => {
        if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES')
          log.warn({ err }, 'HTTP редирект: ошибка');
      });
      redir.listen(REDIRECT_PORT, () => {
        printBanner(true, HTTPS_PORT, REDIRECT_PORT, localIP);
        log.info({ httpsPort: HTTPS_PORT, httpPort: REDIRECT_PORT }, 'NetMonitor запущен (HTTPS)');
      });
    } else {
      printBanner(true, HTTPS_PORT, 0, localIP);
      log.info({ httpsPort: HTTPS_PORT }, 'NetMonitor запущен (HTTPS, без редиректа)');
    }
  });
} else {
  app.listen(REDIRECT_PORT, () => {
    printBanner(false, 0, REDIRECT_PORT, localIP);
    log.info({ port: REDIRECT_PORT }, 'NetMonitor запущен (HTTP)');
  });
}
