const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const os = require('os');
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const { RouterOSAPI } = require('node-routeros');

const app = express();
const PORT = process.env.PORT || 9222;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'devices.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const TOPOLOGY_FILE = path.join(DATA_DIR, 'topology.json');
const INCIDENTS_FILE = path.join(DATA_DIR, 'incidents.json');
const BRANDING_DIR = path.join(DATA_DIR, 'branding');
const OUI_FILE = path.join(DATA_DIR, 'oui.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
const SESSION_SECRET_FILE = path.join(DATA_DIR, '.session-secret');

const HISTORY_MAX_PER_DEVICE = 10080; // ~7 дней при проверке раз в минуту
const SCHEDULER_TICK_MS = 5000;       // как часто планировщик проверяет, кого пора опросить
const DEFAULT_CHECK_INTERVAL_SEC = 60;
const MIN_CHECK_INTERVAL_SEC = 10;
const MIN_PASSWORD_LENGTH = 8;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- HTTPS: если рядом лежит сертификат — сервер сам поднимется на HTTPS ----------
// По умолчанию ищем data/certs/cert.pem и data/certs/key.pem (см. make-cert.sh / make-cert.bat),
// либо путь можно задать переменными окружения TLS_CERT_FILE / TLS_KEY_FILE.
const CERT_FILE = process.env.TLS_CERT_FILE || path.join(DATA_DIR, 'certs', 'cert.pem');
const KEY_FILE = process.env.TLS_KEY_FILE || path.join(DATA_DIR, 'certs', 'key.pem');
const USE_HTTPS = fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
// Если работаем по HTTPS — включаем secure-cookie автоматически (плюс можно форсировать вручную через COOKIE_SECURE)
const COOKIE_SECURE = USE_HTTPS || process.env.COOKIE_SECURE === 'true';

// Секрет сессии — генерируется один раз при первом запуске и хранится локально,
// а не зашит в коде (иначе он был бы одинаковым у всех, кто скачал этот проект).
let sessionSecret;
if (fs.existsSync(SESSION_SECRET_FILE)) {
  sessionSecret = fs.readFileSync(SESSION_SECRET_FILE, 'utf-8').trim();
} else {
  sessionSecret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SESSION_SECRET_FILE, sessionSecret, { mode: 0o600 });
}

app.use(express.json({ limit: '5mb' })); // ограничиваем размер тела запроса (защита от DoS), но с запасом под бэкап/восстановление
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12, // 12 часов
    httpOnly: true,              // недоступна из JS в браузере — защита от кражи через XSS
    sameSite: 'lax',             // базовая защита от CSRF
    secure: COOKIE_SECURE        // включается автоматически при HTTPS
  }
}));

// Базовые заголовки безопасности (без лишних зависимостей)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (USE_HTTPS) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// ---------- Хранилища (JSON-файлы, без внешней БД) ----------
function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function defaultCategories() {
  return [
    { id: 'network', name: 'Сетевое оборудование', color: '#3b82f6' },
    { id: 'server', name: 'Серверы', color: '#8b5cf6' },
    { id: 'workstation', name: 'Пользовательские устройства', color: '#10b981' },
    { id: 'cctv', name: 'Видеонаблюдение', color: '#f59e0b' },
    { id: 'other', name: 'Прочее', color: '#6b7280' }
  ];
}

function readDB() { return readJSON(DB_FILE, { devices: [], categories: defaultCategories() }); }
function writeDB(db) { writeJSON(DB_FILE, db); }

// ---------- Пароли ----------
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash));
}

if (!fs.existsSync(USERS_FILE)) {
  const { salt, hash } = hashPassword('admin');
  writeJSON(USERS_FILE, {
    users: [{ username: 'admin', salt, hash, role: 'admin' }]
  });
  console.log('>>> Создан пользователь по умолчанию: admin / admin — ОБЯЗАТЕЛЬНО смените пароль в разделе «Настройки» <<<');
}

if (!fs.existsSync(SETTINGS_FILE)) {
  writeJSON(SETTINGS_FILE, {
    mikrotiks: [],
    unifiControllers: [],
    ciscoDevices: [],
    alerting: {
      enabled: false,
      failThreshold: 2,            // после скольких провалов подряд слать алерт "недоступно"
      repeatMinutes: 30,           // повторять уведомление, пока не восстановится (0 = не повторять)
      notifyOnRecovery: true,
      telegram: { enabled: false, botToken: '', chatId: '' },
      webhook: { enabled: false, url: '' },
      escalation: { enabled: false, afterMinutes: 60, telegramChatId: '' } // доп. канал, если не восстановилось долго
    },
    // Дополнительные модули — каждый включается отдельно, по умолчанию все выключены,
    // чтобы не грузить сеть/сервер тем, что не используется.
    features: {
      snmp: false,          // SNMP-опрос устройств (аптайм/CPU по SNMP)
      portChecks: false,    // проверка конкретных TCP-портов/сервисов (не только ping)
      incidents: false,     // журнал инцидентов (даунтаймов) + эскалация алертов
      auditLog: false       // журнал действий пользователей (кто что изменил)
    },
    // Правила подсетей для карты сети: устройства с IP из этого диапазона визуально
    // группируются в «облако» с подписью — полезно, когда нет реальной топологии портов
    // (неуправляемые свитчи), но есть чёткая сегментация по подсетям/VLAN.
    subnetRules: [],
    branding: {
      appName: 'NetMonitor',
      accentColor: '#3b82f6',
      defaultTheme: 'dark' // 'dark' | 'light' — тема по умолчанию для тех, кто ещё не выбрал свою
    }
  });
}

if (!fs.existsSync(HISTORY_FILE)) writeJSON(HISTORY_FILE, {});
if (!fs.existsSync(TOPOLOGY_FILE)) writeJSON(TOPOLOGY_FILE, { edges: [] });
if (!fs.existsSync(INCIDENTS_FILE)) writeJSON(INCIDENTS_FILE, { open: {}, closed: [] });
if (!fs.existsSync(AUDIT_FILE)) writeJSON(AUDIT_FILE, { entries: [] });

if (!fs.existsSync(DB_FILE)) {
  // Чистый билд: реестр устройств стартует пустым, без демо-данных.
  writeDB({ devices: [], categories: defaultCategories() });
}

// ---------- Auth middleware ----------
function getLiveUser(username) {
  const store = readJSON(USERS_FILE, { users: [] });
  return store.users.find(u => u.username === username);
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'auth_required' });
  // Сверяем с текущим users.json на каждый запрос — а не доверяем данным, закэшированным
  // в сессии при логине. Иначе удаление пользователя или понижение роли администратором
  // не подействует, пока у отозванного не истечёт сессия (до 12 часов).
  const user = getLiveUser(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'auth_required' });
  }
  req.session.role = user.role || 'admin'; // держим роль в сессии синхронизированной с текущими данными
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Требуются права администратора' });
    next();
  });
}

// Роль «Operator»: повседневная работа (устройства, карта, мониторинг, обнаружение сети,
// алерты, категории) — без доступа к чувствительным вещам уровня администратора
// (пользователи, брендинг, резервные копии, фиче-флаги, учётные данные интеграций, аудит-лог).
function requireOperator(req, res, next) {
  requireAuth(req, res, () => {
    if (req.session.role !== 'admin' && req.session.role !== 'operator') {
      return res.status(403).json({ error: 'forbidden', message: 'Недостаточно прав (нужна роль «Operator» или «Администратор»)' });
    }
    next();
  });
}

// ---------- Фиче-флаги дополнительных модулей ----------
function getFeatures() {
  const s = readJSON(SETTINGS_FILE, {});
  return s.features || { snmp: false, portChecks: false, incidents: false, auditLog: false };
}

// ---------- Аудит-лог: кто что изменил (пишется только если функция включена в настройках) ----------
const AUDIT_MAX_ENTRIES = 5000;
function logAudit(req, action, details) {
  if (!getFeatures().auditLog) return;
  try {
    const store = readJSON(AUDIT_FILE, { entries: [] });
    store.entries.push({
      t: Date.now(),
      user: (req.session && req.session.userId) || '—',
      ip: req.ip,
      action,
      details: details || ''
    });
    if (store.entries.length > AUDIT_MAX_ENTRIES) {
      store.entries = store.entries.slice(store.entries.length - AUDIT_MAX_ENTRIES);
    }
    writeJSON(AUDIT_FILE, store);
  } catch (e) { console.error('audit log error:', e.message); }
}

// ---------- Защита от подбора пароля (brute-force) ----------
const loginAttempts = {}; // ip -> { count, lockedUntil }

function isLockedOut(ip) {
  const rec = loginAttempts[ip];
  return rec && rec.lockedUntil && rec.lockedUntil > Date.now();
}
function registerFailedAttempt(ip) {
  const rec = loginAttempts[ip] || { count: 0, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    rec.count = 0;
  }
  loginAttempts[ip] = rec;
}
function clearAttempts(ip) { delete loginAttempts[ip]; }

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (isLockedOut(ip)) {
    const waitMin = Math.ceil((loginAttempts[ip].lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: 'too_many_attempts', message: `Слишком много неудачных попыток входа. Повторите через ~${waitMin} мин.` });
  }
  const { username, password } = req.body || {};
  const { users } = readJSON(USERS_FILE, { users: [] });
  const user = users.find(u => u.username === username);
  if (!user || !verifyPassword(password || '', user.salt, user.hash)) {
    registerFailedAttempt(ip);
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  clearAttempts(ip);
  const role = user.role || 'admin'; // старые пользователи (созданные до появления ролей) остаются админами
  req.session.userId = user.username;
  req.session.role = role;
  res.json({ ok: true, username: user.username, role });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.userId) return res.json({ username: req.session.userId, role: req.session.role || 'admin' });
  res.status(401).json({ error: 'auth_required' });
});

app.post('/api/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: 'weak_password', message: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов` });
  }
  const store = readJSON(USERS_FILE, { users: [] });
  const user = store.users.find(u => u.username === req.session.userId);
  if (!user || !verifyPassword(currentPassword || '', user.salt, user.hash)) {
    return res.status(401).json({ error: 'wrong_current_password' });
  }
  const { salt, hash } = hashPassword(newPassword);
  user.salt = salt; user.hash = hash;
  writeJSON(USERS_FILE, store);
  res.json({ ok: true });
});

// ---------- Управление пользователями (только для администраторов) ----------
app.get('/api/users', requireAdmin, (req, res) => {
  const store = readJSON(USERS_FILE, { users: [] });
  res.json(store.users.map(u => ({ username: u.username, role: u.role || 'admin' })));
});

const VALID_ROLES = ['admin', 'operator', 'viewer'];
function normalizeRole(role) { return VALID_ROLES.includes(role) ? role : 'viewer'; }

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'invalid_username', message: 'Логин: 3–32 символа, латиница/цифры/._-' });
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: 'weak_password', message: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов` });
  }
  const store = readJSON(USERS_FILE, { users: [] });
  if (store.users.find(u => u.username === username)) {
    return res.status(409).json({ error: 'already_exists', message: 'Пользователь с таким логином уже есть' });
  }
  const finalRole = normalizeRole(role);
  const { salt, hash } = hashPassword(password);
  store.users.push({ username, salt, hash, role: finalRole });
  writeJSON(USERS_FILE, store);
  logAudit(req, 'user.create', `${username} (${finalRole})`);
  res.json({ ok: true });
});

app.put('/api/users/:username/role', requireAdmin, (req, res) => {
  const store = readJSON(USERS_FILE, { users: [] });
  const user = store.users.find(u => u.username === req.params.username);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const newRole = normalizeRole(req.body.role);
  if ((user.role || 'admin') === 'admin' && newRole !== 'admin') {
    const admins = store.users.filter(u => (u.role || 'admin') === 'admin');
    if (admins.length <= 1) return res.status(400).json({ error: 'last_admin', message: 'Нельзя понизить последнего администратора' });
  }
  user.role = newRole;
  writeJSON(USERS_FILE, store);
  logAudit(req, 'user.role_change', `${req.params.username} -> ${newRole}`);
  res.json({ ok: true });
});

app.delete('/api/users/:username', requireAdmin, (req, res) => {
  const store = readJSON(USERS_FILE, { users: [] });
  if (req.params.username === req.session.userId) {
    return res.status(400).json({ error: 'cannot_delete_self', message: 'Нельзя удалить самого себя' });
  }
  const target = store.users.find(u => u.username === req.params.username);
  if (!target) return res.status(404).json({ error: 'not_found' });
  const admins = store.users.filter(u => (u.role || 'admin') === 'admin');
  if ((target.role || 'admin') === 'admin' && admins.length <= 1) {
    return res.status(400).json({ error: 'last_admin', message: 'Нельзя удалить последнего администратора' });
  }
  store.users = store.users.filter(u => u.username !== req.params.username);
  writeJSON(USERS_FILE, store);
  logAudit(req, 'user.delete', req.params.username);
  res.json({ ok: true });
});

// Статика: сама страница/JS/CSS отдаются без авторизации (чтобы показать форму логина),
// а вот все данные (API) закрыты требованием сессии.
// Health-check без авторизации — чтобы сам NetMonitor можно было мониторить извне
// (Uptime Kuma и подобные). Отдаёт только факт, что сервер жив, без чувствительных данных.
const APP_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')).version; }
  catch (e) { return '0.0.0'; }
})();

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: APP_VERSION, uptimeSec: Math.round(process.uptime()), time: new Date().toISOString() });
});

// ==================== БРЕНДИНГ (название, цвет, тема по умолчанию, логотип) ====================
// GET — без авторизации: нужно, чтобы название/логотип/цвет отображались уже на экране логина,
// до того как человек вошёл. Ничего чувствительного здесь нет.
app.get('/api/branding', (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  res.json(s.branding || { appName: 'NetMonitor', accentColor: '#3b82f6', defaultTheme: 'dark' });
});

app.post('/api/branding', requireAdmin, (req, res) => {
  const { appName, accentColor, defaultTheme } = req.body || {};
  const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  if (!appName || !appName.trim() || appName.trim().length > 40) {
    return res.status(400).json({ error: 'invalid_name', message: 'Название приложения: 1–40 символов' });
  }
  if (accentColor && !HEX_COLOR_RE.test(accentColor)) {
    return res.status(400).json({ error: 'invalid_color', message: 'Цвет должен быть в формате #RRGGBB' });
  }
  const s = readJSON(SETTINGS_FILE, {});
  s.branding = {
    appName: appName.trim(),
    accentColor: accentColor || (s.branding && s.branding.accentColor) || '#3b82f6',
    defaultTheme: defaultTheme === 'light' ? 'light' : 'dark'
  };
  writeJSON(SETTINGS_FILE, s);
  logAudit(req, 'branding.update', `${s.branding.appName}, ${s.branding.accentColor}, ${s.branding.defaultTheme}`);
  res.json(s.branding);
});

// Логотип хранится как файл (не в JSON) — так проще отдавать с правильным Content-Type и без
// раздувания settings.json. Принимаем data URL (base64) в JSON-теле, а не multipart — чтобы не
// тащить в зависимости multer ради одной формы загрузки файла.
const LOGO_MIME_TO_EXT = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg' };
const LOGO_MAX_BYTES = 1024 * 1024; // 1 МБ

app.post('/api/branding/logo', requireAdmin, (req, res) => {
  const { dataUrl } = req.body || {};
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return res.status(400).json({ error: 'invalid_file', message: 'Некорректный файл' });
  const [, mime, base64] = m;
  const ext = LOGO_MIME_TO_EXT[mime];
  if (!ext) return res.status(400).json({ error: 'unsupported_type', message: 'Разрешены только SVG, PNG или JPG' });

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > LOGO_MAX_BYTES) return res.status(400).json({ error: 'too_large', message: 'Файл больше 1 МБ' });

  // На всякий случай проверим содержимое SVG на потенциально опасные конструкции —
  // логотип отдаётся через <img src="">, где скрипты внутри SVG браузер не исполняет,
  // но лучше не хранить их на сервере вовсе.
  if (ext === 'svg') {
    const text = buffer.toString('utf-8');
    if (/<script/i.test(text) || /on[a-z]+\s*=/i.test(text)) {
      return res.status(400).json({ error: 'unsafe_svg', message: 'SVG со скриптами/обработчиками событий не принимается' });
    }
  }

  if (!fs.existsSync(BRANDING_DIR)) fs.mkdirSync(BRANDING_DIR, { recursive: true });
  // убираем логотипы других расширений от прошлых загрузок, чтобы не путаться, какой актуален
  Object.values(LOGO_MIME_TO_EXT).forEach(e => {
    const p = path.join(BRANDING_DIR, `logo.${e}`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  fs.writeFileSync(path.join(BRANDING_DIR, `logo.${ext}`), buffer);

  const s = readJSON(SETTINGS_FILE, {});
  if (!s.branding) s.branding = { appName: 'NetMonitor', accentColor: '#3b82f6', defaultTheme: 'dark' };
  s.branding.logoExt = ext;
  writeJSON(SETTINGS_FILE, s);
  logAudit(req, 'branding.logo-upload', `${ext}, ${buffer.length} байт`);
  res.json({ ok: true });
});

app.delete('/api/branding/logo', requireAdmin, (req, res) => {
  Object.values(LOGO_MIME_TO_EXT).forEach(e => {
    const p = path.join(BRANDING_DIR, `logo.${e}`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  const s = readJSON(SETTINGS_FILE, {});
  if (s.branding) delete s.branding.logoExt;
  writeJSON(SETTINGS_FILE, s);
  logAudit(req, 'branding.logo-reset', '');
  res.json({ ok: true });
});

const LOGO_CONTENT_TYPES = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg' };
app.get('/api/branding/logo', (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const ext = s.branding && s.branding.logoExt;
  if (ext && fs.existsSync(path.join(BRANDING_DIR, `logo.${ext}`))) {
    res.setHeader('Content-Type', LOGO_CONTENT_TYPES[ext]);
    res.setHeader('Cache-Control', 'no-cache'); // логотип можно сменить — не хотим залипший кэш браузера
    return res.sendFile(path.join(BRANDING_DIR, `logo.${ext}`));
  }
  // Дефолтный логотип — отдаём готовый favicon.svg из public/
  res.setHeader('Content-Type', 'image/svg+xml');
  res.sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ==================== OUI: ОПРЕДЕЛЕНИЕ ПРОИЗВОДИТЕЛЯ ПО MAC ====================
// База IEEE (первые 3 байта MAC → название производителя). Скачивается автоматически при
// старте, если локального кэша ещё нет или он старше 30 дней; при неудаче (например, нет
// интернета — сайт же для локальной сети) тихо продолжаем работать со старым кэшем, если он
// есть, либо вовсе без определения производителя — на остальной функционал это не влияет.
const OUI_URL = 'https://standards-oui.ieee.org/oui/oui.csv';
const OUI_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
let ouiTable = {};       // 'AABBCC' -> 'Vendor Name'
let ouiUpdatedAt = null;
let ouiLastError = null;

function loadOuiFromDisk() {
  if (!fs.existsSync(OUI_FILE)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(OUI_FILE, 'utf-8'));
    ouiTable = data.entries || {};
    ouiUpdatedAt = data.updatedAt || null;
    return true;
  } catch (e) {
    console.error('Не удалось прочитать кэш OUI:', e.message);
    return false;
  }
}

function parseOuiCsv(text) {
  const table = {};
  const lines = text.split('\n');
  // Формат IEEE: Registry,Assignment,Organization Name,Organization Address
  // Assignment — всегда 6 hex-символов без кавычек. Organization Name может быть в кавычках,
  // если внутри есть запятая (например 'IEEE REGISTRATION AUTHORITY, INC') — простой regex
  // с "[^\"]*" на таких строках ошибочно захватывал весь остаток строки, включая адрес.
  // Разбираем построчно вручную, а не одной регуляркой.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const prefixMatch = /^MA-L,([0-9A-Fa-f]{6}),/.exec(line);
    if (!prefixMatch) continue;
    const assignment = prefixMatch[1].toUpperCase();
    const rest = line.slice(prefixMatch[0].length);
    let org;
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      org = end === -1 ? rest.slice(1) : rest.slice(1, end);
    } else {
      const commaIdx = rest.indexOf(',');
      org = commaIdx === -1 ? rest : rest.slice(0, commaIdx);
    }
    org = org.trim();
    if (org) table[assignment] = org;
  }
  return table;
}

function downloadOui() {
  return new Promise((resolve, reject) => {
    https.get(OUI_URL, { timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} от ${OUI_URL}`));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Таймаут загрузки OUI')); });
  });
}

async function refreshOuiDatabase() {
  try {
    const csv = await downloadOui();
    const table = parseOuiCsv(csv);
    const count = Object.keys(table).length;
    if (count < 1000) throw new Error(`Похоже на неполные данные (${count} записей) — не сохраняю`);
    ouiTable = table;
    ouiUpdatedAt = Date.now();
    ouiLastError = null;
    writeJSON(OUI_FILE, { updatedAt: ouiUpdatedAt, entries: ouiTable });
    console.log(`OUI-база производителей обновлена: ${count} записей`);
    return { ok: true, count };
  } catch (err) {
    ouiLastError = err.message;
    console.error('⚠ Не удалось обновить OUI-базу производителей:', err.message,
      loadOuiFromDisk() ? '(продолжаю работать со старым кэшем)' : '(определение производителя пока недоступно)');
    return { ok: false, message: err.message };
  }
}

// Загружаем то, что есть на диске, сразу (не блокируя старт сервера), и докачиваем/обновляем
// в фоне, если кэша нет или он устарел.
loadOuiFromDisk();
if (!ouiUpdatedAt || Date.now() - ouiUpdatedAt > OUI_MAX_AGE_MS) {
  refreshOuiDatabase();
}

function lookupVendor(mac) {
  if (!mac) return null;
  const clean = mac.replace(/[:\-.]/g, '').toUpperCase();
  if (clean.length < 6) return null;
  return ouiTable[clean.slice(0, 6)] || null;
}

app.get('/api/oui/status', requireAuth, (req, res) => {
  res.json({
    entryCount: Object.keys(ouiTable).length,
    updatedAt: ouiUpdatedAt,
    stale: !ouiUpdatedAt || (Date.now() - ouiUpdatedAt > OUI_MAX_AGE_MS),
    lastError: ouiLastError
  });
});

app.post('/api/oui/refresh', requireOperator, async (req, res) => {
  const result = await refreshOuiDatabase();
  logAudit(req, 'oui.refresh', result.ok ? `${result.count} записей` : `ошибка: ${result.message}`);
  if (!result.ok) return res.status(502).json(result);
  res.json(result);
});

// ---------- Категории ----------
app.get('/api/categories', requireAuth, (req, res) => res.json(readDB().categories));

app.post('/api/categories', requireOperator, (req, res) => {
  const { categories } = req.body || {};
  if (!Array.isArray(categories) || !categories.length) {
    return res.status(400).json({ error: 'categories_required', message: 'Нужна хотя бы одна категория' });
  }
  const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const SAFE_ID_RE = /^[a-zA-Zа-яА-Я0-9_-]{1,64}$/;
  const db = readDB();
  const newIds = new Set();
  for (const c of categories) {
    if (!c.name || !c.name.trim()) return res.status(400).json({ error: 'invalid_category', message: 'У категории должно быть название' });
    if (c.color && !HEX_COLOR_RE.test(c.color)) {
      return res.status(400).json({ error: 'invalid_color', message: `Некорректный цвет: "${c.color}". Ожидается формат #RRGGBB` });
    }
    if (c.id && !SAFE_ID_RE.test(c.id)) {
      return res.status(400).json({ error: 'invalid_id', message: `Некорректный id категории: "${c.id}"` });
    }
    const id = c.id || slugify(c.name);
    if (newIds.has(id)) return res.status(400).json({ error: 'duplicate_id', message: `Повторяющийся id категории: ${id}` });
    newIds.add(id);
  }
  // Категории, которые удаляют, но на них ещё есть устройства — блокируем, чтобы не потерять привязку
  const usedIds = new Set(db.devices.map(d => d.category));
  const removedButUsed = [...usedIds].filter(id => !newIds.has(id));
  if (removedButUsed.length) {
    const names = removedButUsed.map(id => (db.categories.find(c => c.id === id) || { name: id }).name);
    return res.status(400).json({
      error: 'category_in_use',
      message: `Нельзя удалить категорию — на неё ещё ссылаются устройства: ${names.join(', ')}. Сначала перенесите устройства в другую категорию.`
    });
  }
  db.categories = categories.map(c => ({
    id: c.id || slugify(c.name),
    name: c.name.trim(),
    color: c.color || '#6b7280'
  }));
  writeDB(db);
  logAudit(req, 'categories.update', `${db.categories.length} категорий`);
  res.json(db.categories);
});

// Единая генерация id: crypto.randomUUID() практически исключает коллизии
// (в отличие от Date.now()+random, где при частых параллельных запросах в теории
// возможно совпадение id — это использовалось почти везде в коде раньше).
function newId(prefix) {
  return prefix + crypto.randomUUID();
}

function slugify(name) {
  const base = name.toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'category';
  return base + '-' + Math.random().toString(36).slice(2, 6);
}

// Безопасная ячейка CSV: экранирует кавычки И нейтрализует formula injection —
// если значение начинается с =, +, -, @ (или таба/CR), Excel/Sheets может исполнить
// его как формулу (в т.ч. DDE-эксплойты). Раз название/комментарий устройства — это
// свободный текст, который вводит любой admin (или он же приходит из CSV-импорта),
// на выходе в CSV-экспорте его обязательно нужно обезвреживать. Рекомендация OWASP:
// префиксовать такие значения одинарной кавычкой.
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

// ---------- Устройства ----------
app.get('/api/devices', requireAuth, (req, res) => {
  const devices = readDB().devices.map(d => ({ ...d, vendor: lookupVendor(d.mac) }));
  res.json(devices);
});

app.post('/api/devices', requireOperator, (req, res) => {
  const db = readDB();
  const device = {
    id: newId('d'),
    name: req.body.name || 'Без имени',
    ip: req.body.ip || '',
    mac: req.body.mac || '',
    location: req.body.location || '',
    type: req.body.type || '',
    category: req.body.category || 'other',
    comment: req.body.comment || '',
    key: !!req.body.key,
    monitored: req.body.monitored != null ? !!req.body.monitored : true,
    checkInterval: Math.max(MIN_CHECK_INTERVAL_SEC, Number(req.body.checkInterval) || DEFAULT_CHECK_INTERVAL_SEC),
    alertsEnabled: req.body.alertsEnabled != null ? !!req.body.alertsEnabled : true,
    source: req.body.source || 'manual',
    // Опциональные модули (работают только если включены в «Настройки» → «Функции»):
    snmp: req.body.snmp || { enabled: false, community: 'public', port: 161 },
    portChecks: Array.isArray(req.body.portChecks) ? req.body.portChecks : [],
    x: req.body.x != null ? req.body.x : 100 + Math.random() * 800,
    y: req.body.y != null ? req.body.y : 100 + Math.random() * 500
  };
  db.devices.push(device);
  writeDB(db);
  logAudit(req, 'device.create', `${device.name} (${device.ip})`);
  res.json(device);
});

// Поля, которые разрешено менять через PUT — та же логика allowlist, что и в bulk-update.
// НИКОГДА не спреим req.body напрямую в объект устройства: так можно записать любое
// незадокументированное поле (включая потенциально опасные вроде __proto__).
const DEVICE_EDITABLE_FIELDS = [
  'name', 'ip', 'mac', 'location', 'type', 'category', 'comment',
  'key', 'monitored', 'alertsEnabled', 'checkInterval', 'snmp', 'portChecks', 'x', 'y'
];

app.put('/api/devices/:id', requireOperator, (req, res) => {
  const db = readDB();
  const idx = db.devices.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });

  const patch = {};
  DEVICE_EDITABLE_FIELDS.forEach(f => { if (req.body[f] !== undefined) patch[f] = req.body[f]; });
  if (patch.checkInterval != null) {
    patch.checkInterval = Math.max(MIN_CHECK_INTERVAL_SEC, Number(patch.checkInterval) || DEFAULT_CHECK_INTERVAL_SEC);
  }
  if (patch.x != null) { const n = Number(patch.x); patch.x = Number.isFinite(n) ? n : db.devices[idx].x; }
  if (patch.y != null) { const n = Number(patch.y); patch.y = Number.isFinite(n) ? n : db.devices[idx].y; }

  db.devices[idx] = { ...db.devices[idx], ...patch, id: db.devices[idx].id };
  writeDB(db);
  // x/y меняются при обычном перетаскивании на карте — не засоряем аудит-лог каждым drag'ом
  const isJustPositionChange = Object.keys(patch).every(k => ['x', 'y'].includes(k));
  if (!isJustPositionChange) logAudit(req, 'device.update', `${db.devices[idx].name} (${db.devices[idx].ip})`);
  res.json(db.devices[idx]);
});

app.delete('/api/devices/:id', requireOperator, (req, res) => {
  const db = readDB();
  const target = db.devices.find(d => d.id === req.params.id);
  db.devices = db.devices.filter(d => d.id !== req.params.id);
  writeDB(db);
  const hist = readJSON(HISTORY_FILE, {});
  delete hist[req.params.id];
  writeJSON(HISTORY_FILE, hist);
  logAudit(req, 'device.delete', target ? `${target.name} (${target.ip})` : req.params.id);
  res.json({ ok: true });
});

// ---------- Массовые операции над устройствами ----------
app.post('/api/devices/bulk-delete', requireOperator, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids_required' });
  const db = readDB();
  const removed = db.devices.filter(d => ids.includes(d.id));
  db.devices = db.devices.filter(d => !ids.includes(d.id));
  writeDB(db);
  const hist = readJSON(HISTORY_FILE, {});
  ids.forEach(id => delete hist[id]);
  writeJSON(HISTORY_FILE, hist);
  logAudit(req, 'device.bulk-delete', `${removed.length} устройств: ${removed.map(d => d.name).join(', ')}`);
  res.json({ ok: true, deleted: removed.length });
});

// Разрешённые для массового изменения поля — чтобы случайно не затереть x/y, id и т.п.
const BULK_UPDATE_ALLOWED_FIELDS = ['category', 'monitored', 'alertsEnabled', 'key', 'checkInterval', 'location'];
app.post('/api/devices/bulk-update', requireOperator, (req, res) => {
  const { ids, patch } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids_required' });
  if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'patch_required' });
  const safePatch = {};
  BULK_UPDATE_ALLOWED_FIELDS.forEach(f => { if (patch[f] !== undefined) safePatch[f] = patch[f]; });
  if (!Object.keys(safePatch).length) return res.status(400).json({ error: 'no_valid_fields' });

  const db = readDB();
  let updated = 0;
  db.devices.forEach(d => {
    if (ids.includes(d.id)) { Object.assign(d, safePatch); updated++; }
  });
  writeDB(db);
  logAudit(req, 'device.bulk-update', `${updated} устройств, поля: ${Object.keys(safePatch).join(', ')}`);
  res.json({ ok: true, updated });
});

// ---------- Экспорт полного списка устройств в CSV ----------
app.get('/api/devices/export.csv', requireAuth, (req, res) => {
  const db = readDB();
  const header = ['name', 'ip', 'mac', 'location', 'type', 'category', 'comment', 'monitored', 'key'];
  const rows = db.devices.map(d => [
    d.name, d.ip, d.mac, d.location, d.type,
    (db.categories.find(c => c.id === d.category) || {}).name || d.category,
    d.comment, d.monitored ? 'да' : 'нет', d.key ? 'да' : 'нет'
  ].map(csvCell).join(','));
  const csv = '\uFEFF' + [header.join(','), ...rows].join('\r\n'); // BOM — чтобы Excel сразу понял UTF-8
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="netmonitor-devices-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// ---------- Пинг ----------
// Разрешаем только валидный IPv4/IPv6 или hostname (буквы/цифры/точки/дефисы/двоеточия) —
// это защита от command injection через поле IP устройства.
const SAFE_HOST_RE = /^[a-zA-Z0-9.:_-]+$/;

function pingHost(ip) {
  return new Promise((resolve) => {
    if (!ip || typeof ip !== 'string' || ip.length > 253 || !SAFE_HOST_RE.test(ip)) {
      return resolve(false);
    }
    const isWin = os.platform() === 'win32';
    const args = isWin ? ['-n', '1', '-w', '800', ip] : ['-c', '1', '-W', '1', ip];
    // execFile НЕ запускает shell и не интерпретирует спецсимволы — аргументы передаются как есть
    execFile('ping', args, { timeout: 3000 }, (error) => resolve(!error));
  });
}

// ---------- Планировщик контролируемого мониторинга ----------
// Опрашиваются ТОЛЬКО устройства с monitored=true, каждое — со своим интервалом (checkInterval, сек).
// Результаты кэшируются в памяти (statusCache) и пишутся в историю для графиков аптайма.
const statusCache = {}; // id -> { online, lastChecked }

// ---------- TCP-порт-чекер (опциональный модуль «Функции» → portChecks) ----------
// Проверяет не просто ping, а что конкретный сервис/порт отвечает (например 554 у камеры, 3389 у сервера).
const portCheckCache = {}; // id -> [{ port, label, open, lastChecked }]
function checkTcpPort(ip, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!ip || !port) return resolve(false);
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => { if (done) return; done = true; socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, ip);
  });
}
async function checkDevicePorts(device) {
  const results = [];
  for (const pc of device.portChecks) {
    const open = await checkTcpPort(device.ip, Number(pc.port));
    results.push({ port: pc.port, label: pc.label || '', open, lastChecked: Date.now() });
  }
  portCheckCache[device.id] = results;
}

// ---------- SNMP-опрос (опциональный модуль «Функции» → snmp) ----------
// Требует пакет net-snmp (добавлен в package.json). Если модуль не установлен — просто тихо
// выключается, ping/остальной функционал при этом не страдает.
let snmpLib = null;
try { snmpLib = require('net-snmp'); } catch (e) { /* пакет не установлен — SNMP просто недоступен */ }

// Требует пакет ssh2 (добавлен в package.json) — используется для подключения к Cisco по SSH,
// т.к. у Cisco IOS/IOS-XE нет простого REST/API-порта как у RouterOS. Если модуль не установлен —
// импорт с Cisco просто откажет с понятной ошибкой, остальной функционал не страдает.
let SSHClient = null;
try { SSHClient = require('ssh2').Client; } catch (e) { /* пакет не установлен — интеграция с Cisco недоступна */ }

const snmpCache = {}; // id -> { sysUptime, cpuLoad, lastChecked, error }
const SNMP_SYS_UPTIME_OID = '1.3.6.1.2.1.1.3.0';
const SNMP_MIKROTIK_CPU_OID = '1.3.6.1.4.1.14988.1.1.3.14.0'; // % загрузки CPU на RouterOS

function pollSnmp(device) {
  if (!snmpLib) {
    snmpCache[device.id] = { error: 'Пакет net-snmp не установлен (npm install)', lastChecked: Date.now() };
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const community = (device.snmp && device.snmp.community) || 'public';
    const port = (device.snmp && device.snmp.port) || 161;
    const session = snmpLib.createSession(device.ip, community, { port, timeout: 2000, retries: 0 });
    const oids = [SNMP_SYS_UPTIME_OID, SNMP_MIKROTIK_CPU_OID];
    session.get(oids, (error, varbinds) => {
      if (error) {
        snmpCache[device.id] = { error: 'Нет ответа по SNMP', lastChecked: Date.now() };
      } else {
        const uptimeVb = varbinds[0], cpuVb = varbinds[1];
        snmpCache[device.id] = {
          sysUptimeTicks: (uptimeVb && !snmpLib.isVarbindError(uptimeVb)) ? Number(uptimeVb.value) : null,
          cpuLoad: (cpuVb && !snmpLib.isVarbindError(cpuVb)) ? Number(cpuVb.value) : null,
          lastChecked: Date.now(),
          error: null
        };
      }
      session.close();
      resolve();
    });
  });
}

function intervalMsFor(d) {
  return Math.max(MIN_CHECK_INTERVAL_SEC, Number(d.checkInterval) || DEFAULT_CHECK_INTERVAL_SEC) * 1000;
}

// ---------- Алерты ----------
// Состояние по устройствам держим в памяти: сколько провалов подряд, когда последний раз слали уведомление.
const alertState = {}; // id -> { consecutiveFails, lastAlertSentAt, wasDown }

async function sendTelegram(cfg, text) {
  if (!cfg.telegram || !cfg.telegram.enabled || !cfg.telegram.botToken || !cfg.telegram.chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.telegram.chatId, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('Telegram alert error:', e.message); }
}

async function sendWebhook(cfg, payload) {
  if (!cfg.webhook || !cfg.webhook.enabled || !cfg.webhook.url) return;
  try {
    await fetch(cfg.webhook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) { console.error('Webhook alert error:', e.message); }
}

async function dispatchAlert(cfg, device, status, text) {
  await Promise.all([
    sendTelegram(cfg, text),
    sendWebhook(cfg, { device: { id: device.id, name: device.name, ip: device.ip, location: device.location }, status, message: text, time: new Date().toISOString() })
  ]);
}

async function evaluateAlert(device, online) {
  const s = readJSON(SETTINGS_FILE, {});
  const cfg = s.alerting || {};
  if (!cfg.enabled) return;
  if (device.alertsEnabled === false) return;

  const threshold = Math.max(1, Number(cfg.failThreshold) || 2);
  const repeatMs = Math.max(0, Number(cfg.repeatMinutes) || 0) * 60 * 1000;
  const now = Date.now();
  const st = alertState[device.id] || { consecutiveFails: 0, lastAlertSentAt: 0, wasDown: false, downSince: 0, escalated: false };

  if (online === false) {
    if (st.consecutiveFails === 0) st.downSince = now; // фиксируем начало простоя для эскалации
    st.consecutiveFails++;
    const justCrossed = st.consecutiveFails === threshold;
    const dueForRepeat = st.wasDown && repeatMs > 0 && (now - st.lastAlertSentAt) >= repeatMs;
    if (justCrossed || dueForRepeat) {
      const text = `🔴 <b>${device.name}</b> недоступно\nIP: ${device.ip || '—'}\nРасположение: ${device.location || '—'}\nПодряд неудачных проверок: ${st.consecutiveFails}`;
      await dispatchAlert(cfg, device, 'down', text);
      st.lastAlertSentAt = now;
      st.wasDown = true;
    }

    // Эскалация: устройство лежит дольше заданного порога и ещё не эскалировали — доп. канал
    const esc = cfg.escalation || {};
    if (getFeatures().incidents && esc.enabled && !st.escalated && st.downSince && (now - st.downSince) >= esc.afterMinutes * 60 * 1000) {
      st.escalated = true;
      const minutesDown = Math.round((now - st.downSince) / 60000);
      const text = `🆘 <b>ЭСКАЛАЦИЯ</b>: ${device.name} недоступно уже ${minutesDown} мин\nIP: ${device.ip || '—'}\nРасположение: ${device.location || '—'}`;
      if (esc.telegramChatId) {
        await sendTelegram({ telegram: { enabled: true, botToken: cfg.telegram?.botToken, chatId: esc.telegramChatId } }, text);
      }
      const incStore = readJSON(INCIDENTS_FILE, { open: {}, closed: [] });
      if (incStore.open[device.id]) { incStore.open[device.id].escalated = true; writeJSON(INCIDENTS_FILE, incStore); }
    }
  } else {
    if (st.wasDown && cfg.notifyOnRecovery) {
      const text = `🟢 <b>${device.name}</b> снова в сети\nIP: ${device.ip || '—'}\nРасположение: ${device.location || '—'}`;
      await dispatchAlert(cfg, device, 'up', text);
    }
    st.consecutiveFails = 0;
    st.wasDown = false;
    st.downSince = 0;
    st.escalated = false;
  }
  alertState[device.id] = st;
}

// ---------- Журнал инцидентов (даунтаймов) — работает, только если включён в «Настройках» → «Функции» ----------
function recordIncidentTransition(device, prevOnline, online) {
  if (!getFeatures().incidents) return;
  const store = readJSON(INCIDENTS_FILE, { open: {}, closed: [] });
  if (online === false && prevOnline !== false) {
    store.open[device.id] = { start: Date.now(), escalated: false };
    writeJSON(INCIDENTS_FILE, store);
  } else if (online === true && store.open[device.id]) {
    const inc = store.open[device.id];
    const end = Date.now();
    store.closed.push({
      deviceId: device.id, deviceName: device.name,
      start: inc.start, end, durationSec: Math.round((end - inc.start) / 1000),
      escalated: !!inc.escalated
    });
    delete store.open[device.id];
    if (store.closed.length > 5000) store.closed = store.closed.slice(store.closed.length - 5000);
    writeJSON(INCIDENTS_FILE, store);
  }
}

async function schedulerTick() {
  const db = readDB();
  const hist = readJSON(HISTORY_FILE, {});
  const now = Date.now();
  let historyChanged = false;

  for (const d of db.devices) {
    if (!d.monitored) continue;
    const prevStatus = statusCache[d.id];
    const last = prevStatus ? prevStatus.lastChecked : 0;
    if (now - last < intervalMsFor(d)) continue;

    const online = d.ip ? await pingHost(d.ip) : false;
    statusCache[d.id] = { online, lastChecked: now };

    if (!hist[d.id]) hist[d.id] = [];
    hist[d.id].push({ t: now, online });
    if (hist[d.id].length > HISTORY_MAX_PER_DEVICE) {
      hist[d.id] = hist[d.id].slice(hist[d.id].length - HISTORY_MAX_PER_DEVICE);
    }
    historyChanged = true;
    evaluateAlert(d, online); // не блокируем цикл ожиданием отправки уведомления
    recordIncidentTransition(d, prevStatus ? prevStatus.online : null, online);

    if (getFeatures().snmp && d.snmp && d.snmp.enabled) pollSnmp(d); // не блокируем цикл
    if (getFeatures().portChecks && Array.isArray(d.portChecks) && d.portChecks.length) checkDevicePorts(d); // не блокируем цикл
  }
  if (historyChanged) writeJSON(HISTORY_FILE, hist);
}
setInterval(schedulerTick, SCHEDULER_TICK_MS);
schedulerTick(); // первый прогон сразу при старте

// Статус для UI: кэшированный результат планировщика (не дёргает сеть при каждом открытии страницы)
app.get('/api/status', requireAuth, (req, res) => {
  const db = readDB();
  const results = db.devices.map(d => {
    if (!d.monitored) return { id: d.id, ip: d.ip, monitored: false, online: null, lastChecked: null };
    const s = statusCache[d.id];
    return {
      id: d.id, ip: d.ip, monitored: true, online: s ? s.online : null, lastChecked: s ? s.lastChecked : null,
      snmp: snmpCache[d.id] || null,
      ports: portCheckCache[d.id] || null
    };
  });
  res.json(results);
});

// Ручная мгновенная проверка одного устройства («Проверить сейчас»), вне зависимости от интервала
app.post('/api/status/:id/check', requireAuth, async (req, res) => {
  const db = readDB();
  const d = db.devices.find(d => d.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  const online = d.ip ? await pingHost(d.ip) : false;
  const now = Date.now();
  statusCache[d.id] = { online, lastChecked: now };
  if (d.monitored) {
    const hist = readJSON(HISTORY_FILE, {});
    if (!hist[d.id]) hist[d.id] = [];
    hist[d.id].push({ t: now, online });
    if (hist[d.id].length > HISTORY_MAX_PER_DEVICE) hist[d.id] = hist[d.id].slice(hist[d.id].length - HISTORY_MAX_PER_DEVICE);
    writeJSON(HISTORY_FILE, hist);
  }
  evaluateAlert(d, online);
  res.json({ id: d.id, online, lastChecked: now });
});

// Массовое включение/выключение мониторинга (для вкладки «Мониторинг»)
app.post('/api/monitoring/bulk', requireOperator, (req, res) => {
  const { ids, monitored } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids_required' });
  const db = readDB();
  db.devices.forEach(d => { if (ids.includes(d.id)) d.monitored = !!monitored; });
  writeDB(db);
  res.json({ ok: true, updated: ids.length });
});

app.get('/api/history/:id', requireAuth, (req, res) => {
  const hist = readJSON(HISTORY_FILE, {});
  const range = req.query.range || '24h';
  const ms = range === '7d' ? 7 * 24 * 3600 * 1000 : 24 * 3600 * 1000;
  const cutoff = Date.now() - ms;
  const arr = (hist[req.params.id] || []).filter(p => p.t >= cutoff);
  res.json(arr);
});

app.get('/api/uptime', requireAuth, (req, res) => {
  const hist = readJSON(HISTORY_FILE, {});
  const now = Date.now();
  const cut24 = now - 24 * 3600 * 1000;
  const cut7d = now - 7 * 24 * 3600 * 1000;
  const out = {};
  Object.keys(hist).forEach(id => {
    const points = hist[id];
    const calc = (cutoff) => {
      const pts = points.filter(p => p.t >= cutoff);
      if (!pts.length) return null;
      const up = pts.filter(p => p.online).length;
      return Math.round((up / pts.length) * 1000) / 10;
    };
    out[id] = { uptime24h: calc(cut24), uptime7d: calc(cut7d), samples: points.slice(-30) };
  });
  res.json(out);
});

// ---------- Настройки: Алерты ----------
app.get('/api/alert-settings', requireAuth, (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const cfg = s.alerting || {};
  const safe = {
    ...cfg,
    telegram: { ...cfg.telegram, botToken: cfg.telegram?.botToken ? '••••••••' : '' },
  };
  res.json(safe);
});

app.post('/api/alert-settings', requireOperator, (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const incoming = req.body || {};
  const prev = s.alerting || {};
  s.alerting = {
    enabled: !!incoming.enabled,
    failThreshold: Math.max(1, Number(incoming.failThreshold) || 2),
    repeatMinutes: Math.max(0, Number(incoming.repeatMinutes) || 0),
    notifyOnRecovery: incoming.notifyOnRecovery != null ? !!incoming.notifyOnRecovery : true,
    telegram: {
      enabled: !!incoming.telegram?.enabled,
      chatId: incoming.telegram?.chatId ?? prev.telegram?.chatId ?? '',
      botToken: (incoming.telegram?.botToken && incoming.telegram.botToken !== '••••••••')
        ? incoming.telegram.botToken : (prev.telegram?.botToken || '')
    },
    webhook: {
      enabled: !!incoming.webhook?.enabled,
      url: incoming.webhook?.url ?? prev.webhook?.url ?? ''
    },
    escalation: {
      enabled: !!incoming.escalation?.enabled,
      afterMinutes: Math.max(5, Number(incoming.escalation?.afterMinutes) || 60),
      telegramChatId: incoming.escalation?.telegramChatId ?? prev.escalation?.telegramChatId ?? ''
    }
  };
  writeJSON(SETTINGS_FILE, s);
  logAudit(req, 'alert_settings.update', '');
  res.json({ ok: true });
});

app.post('/api/alert-settings/test', requireOperator, async (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const cfg = s.alerting || {};
  await dispatchAlert(cfg, { id: 'test', name: 'Тестовое устройство', ip: '10.0.0.1', location: 'Тест' }, 'test',
    '🧪 Тестовое уведомление от NetMonitor. Если вы это видите — оповещения настроены верно.');
  res.json({ ok: true });
});

// ---------- Настройки: несколько MikroTik-роутеров ----------
app.get('/api/mikrotik/routers', requireAuth, (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const list = (s.mikrotiks || []).map(r => ({ ...r, password: r.password ? '••••••••' : '' }));
  res.json(list);
});

app.post('/api/mikrotik/routers', requireAdmin, (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  if (!s.mikrotiks) s.mikrotiks = [];
  const router = {
    id: newId('r'),
    name: req.body.name || req.body.host || 'MikroTik',
    host: req.body.host || '',
    port: Number(req.body.port) || 8728,
    user: req.body.user || 'admin',
    password: req.body.password || '',
    useTls: !!req.body.useTls
  };
  s.mikrotiks.push(router);
  writeJSON(SETTINGS_FILE, s);
  logAudit(req, 'mikrotik_router.add', `${router.name} (${router.host})`);
  res.json({ ...router, password: router.password ? '••••••••' : '' });
});

app.put('/api/mikrotik/routers/:id', requireAdmin, (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const r = (s.mikrotiks || []).find(r => r.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  r.name = req.body.name ?? r.name;
  r.host = req.body.host ?? r.host;
  r.port = req.body.port != null ? Number(req.body.port) : r.port;
  r.user = req.body.user ?? r.user;
  r.useTls = req.body.useTls != null ? !!req.body.useTls : r.useTls;
  if (req.body.password && req.body.password !== '••••••••') r.password = req.body.password;
  writeJSON(SETTINGS_FILE, s);
  res.json({ ...r, password: r.password ? '••••••••' : '' });
});

app.delete('/api/mikrotik/routers/:id', requireAdmin, (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const target = (s.mikrotiks || []).find(r => r.id === req.params.id);
  s.mikrotiks = (s.mikrotiks || []).filter(r => r.id !== req.params.id);
  writeJSON(SETTINGS_FILE, s);
  logAudit(req, 'mikrotik_router.delete', target ? `${target.name} (${target.host})` : req.params.id);
  res.json({ ok: true });
});

async function importFromRouter(routerCfg) {
  if (!routerCfg.host || !routerCfg.password) {
    const e = new Error('Заполните адрес и пароль роутера');
    e.code = 'not_configured';
    throw e;
  }
  const conn = new RouterOSAPI({
    host: routerCfg.host,
    user: routerCfg.user || 'admin',
    password: routerCfg.password,
    port: Number(routerCfg.port) || 8728,
    tls: !!routerCfg.useTls,
    timeout: 8
  });

  await conn.connect();
  const leases = await conn.write('/ip/dhcp-server/lease/print');
  conn.close();

  const db = readDB();
  let created = 0, updated = 0;

  leases.forEach(l => {
    const mac = (l['mac-address'] || '').toUpperCase();
    const ip = l.address || '';
    const name = l['host-name'] || l.comment || ip || 'DHCP-клиент';
    if (!mac && !ip) return;

    let existing = db.devices.find(d =>
      (mac && d.mac && d.mac.toUpperCase() === mac) || (ip && d.ip === ip)
    );

    if (existing) {
      existing.ip = ip || existing.ip;
      existing.mac = mac || existing.mac;
      if (existing.source && existing.source.startsWith('mikrotik') || !existing.name) existing.name = name;
      existing.source = existing.source || ('mikrotik:' + routerCfg.name);
      updated++;
    } else {
      db.devices.push({
        id: newId('d'),
        name,
        ip,
        mac,
        location: '',
        type: 'DHCP Client',
        category: 'workstation',
        comment: `Импортировано из MikroTik "${routerCfg.name}" (DHCP lease)`,
        key: false,
        source: 'mikrotik:' + routerCfg.name,
        monitored: false,
        checkInterval: DEFAULT_CHECK_INTERVAL_SEC,
        alertsEnabled: true,
        x: 100 + Math.random() * 800,
        y: 100 + Math.random() * 500
      });
      created++;
    }
  });

  writeDB(db);
  return { created, updated, total: leases.length };
}

app.post('/api/mikrotik/routers/:id/import', requireOperator, async (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const routerCfg = (s.mikrotiks || []).find(r => r.id === req.params.id);
  if (!routerCfg) return res.status(404).json({ error: 'not found' });
  try {
    const result = await importFromRouter(routerCfg);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.code || 'connection_failed', message: err.message || String(err) });
  }
});

// Импорт сразу со всех сохранённых роутеров
app.post('/api/mikrotik/import-all', requireOperator, async (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const routers = s.mikrotiks || [];
  const results = [];
  for (const r of routers) {
    try {
      const result = await importFromRouter(r);
      results.push({ router: r.name, ok: true, ...result });
    } catch (err) {
      results.push({ router: r.name, ok: false, message: err.message || String(err) });
    }
  }
  res.json({ results });
});

// ==================== ИНТЕГРАЦИЯ: UBIQUITI UNIFI ====================
// Поддерживаются оба варианта авторизации:
//  - UniFi OS (UDM/UDM Pro/Cloud Key Gen2+, современные консоли): POST /api/auth/login,
//    API живёт под /proxy/network/...
//  - Классический контроллер (software controller / Cloud Key Gen1): POST /api/login,
//    API живёт под /api/...
// Самоподписанный сертификат контроллера — обычное дело для локальной сети, поэтому TLS
// проверка сертификата отключена сознательно (это подключение внутри доверенной LAN, не в интернет).
// Небольшой helper поверх https.request — сознательно не используем встроенный fetch()
// для этих запросов: способ отключить проверку самоподписанного сертификата у fetch (через undici)
// зависит от деталей реализации и версии Node, тогда как у https.request rejectUnauthorized
// работает однозначно и предсказуемо на любой версии Node 18+.
function unifiHttpsRequest(options, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = https.request({
      ...options,
      rejectUnauthorized: false, // самоподписанный сертификат — обычное дело для локального контроллера в LAN
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...options.headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { /* не JSON — оставляем null */ }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Таймаут подключения к UniFi контроллеру')); });
    if (body) req.write(body);
    req.end();
  });
}

async function unifiLogin(ctrl) {
  const loginPath = ctrl.unifiOS ? '/api/auth/login' : '/api/login';
  const res = await unifiHttpsRequest({
    hostname: ctrl.host, port: ctrl.port || 443, path: loginPath, method: 'POST'
  }, { username: ctrl.user, password: ctrl.password });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const portHint = !ctrl.unifiOS ? ' Для классического контроллера (не UniFi OS) порт обычно 8443, а не 443.' : '';
    const bodyHint = res.raw ? ` Ответ сервера: ${res.raw.slice(0, 200)}` : '';
    const err = new Error(`Не удалось войти в UniFi (HTTP ${res.statusCode}).${portHint} Проверьте логин/пароль, адрес и порт.${bodyHint}`);
    err.code = 'unifi_login_failed';
    throw err;
  }
  const setCookie = res.headers['set-cookie'] || [];
  if (!setCookie.length) {
    const err = new Error('UniFi ответил успехом (HTTP 200), но не прислал cookie сессии — похоже, это не UniFi API на этом адресе/порту. Проверьте порт и тип консоли.');
    err.code = 'unifi_no_session';
    throw err;
  }
  const cookieHeader = setCookie.map(c => c.split(';')[0]).join('; ');
  const csrfToken = res.headers['x-csrf-token'] || res.headers['x-updated-csrf-token'];
  return { host: ctrl.host, port: ctrl.port || 443, cookieHeader, csrfToken };
}

async function unifiApiGet(ctrl, session, apiPath) {
  const prefix = ctrl.unifiOS ? '/proxy/network' : '';
  const site = ctrl.site || 'default';
  const fullPath = `${prefix}/api/s/${site}${apiPath}`;
  const headers = { 'Cookie': session.cookieHeader };
  if (session.csrfToken) headers['X-CSRF-Token'] = session.csrfToken;

  const res = await unifiHttpsRequest({
    hostname: session.host, port: session.port, path: fullPath, method: 'GET', headers
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const bodyHint = res.raw ? ` Ответ сервера: ${res.raw.slice(0, 200)}` : '';
    const err = new Error(`UniFi API вернул HTTP ${res.statusCode} для ${apiPath}.${bodyHint}`);
    err.code = 'unifi_api_failed';
    throw err;
  }
  return (res.body && res.body.data) || [];
}

// Определяем категорию по типу UniFi-устройства
function categoryForUnifiType(type) {
  if (['uap', 'usw', 'ugw', 'udm'].includes(type)) return 'network';
  return 'workstation';
}

async function importFromUnifi(ctrl) {
  const session = await unifiLogin(ctrl);
  const [infra, clients] = await Promise.all([
    unifiApiGet(ctrl, session, '/stat/device'),
    unifiApiGet(ctrl, session, '/stat/sta')
  ]);

  const db = readDB();
  let created = 0, updated = 0;

  const upsert = (mac, ip, name, type, comment) => {
    if (!mac && !ip) return;
    mac = (mac || '').toUpperCase();
    let existing = db.devices.find(d => (mac && d.mac && d.mac.toUpperCase() === mac) || (ip && d.ip === ip));
    if (existing) {
      existing.ip = ip || existing.ip;
      existing.mac = mac || existing.mac;
      if (existing.source && existing.source.startsWith('unifi') || !existing.name) existing.name = name;
      existing.source = existing.source || ('unifi:' + ctrl.name);
      updated++;
    } else {
      db.devices.push({
        id: newId('d'), name: name || ip || mac, ip: ip || '', mac,
        location: '', type: type || 'UniFi', category: categoryForUnifiType((type || '').toLowerCase()),
        comment: comment || `Импортировано из UniFi "${ctrl.name}"`,
        key: false, source: 'unifi:' + ctrl.name, monitored: false,
        checkInterval: DEFAULT_CHECK_INTERVAL_SEC, alertsEnabled: true,
        x: 100 + Math.random() * 800, y: 100 + Math.random() * 500
      });
      created++;
    }
  };

  infra.forEach(d => upsert(d.mac, d.ip, d.name || d.model, d.type, `Модель: ${d.model || '—'}`));
  clients.forEach(c => upsert(c.mac, c.ip, c.hostname || c.name, c.is_wired ? 'Wired Client' : 'Wi-Fi Client', c.oui ? `Производитель: ${c.oui}` : ''));

  return { created, updated, total: infra.length + clients.length };
}

app.get('/api/unifi/controllers', requireAuth, (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  res.json((s.unifiControllers || []).map(c => ({ ...c, password: c.password ? '••••••••' : '' })));
});

app.post('/api/unifi/controllers', requireAdmin, (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  if (!s.unifiControllers) s.unifiControllers = [];
  const ctrl = {
    id: newId('u'),
    name: req.body.name || req.body.host || 'UniFi',
    host: req.body.host || '',
    port: Number(req.body.port) || 443,
    user: req.body.user || '',
    password: req.body.password || '',
    site: req.body.site || 'default',
    unifiOS: !!req.body.unifiOS
  };
  s.unifiControllers.push(ctrl);
  writeJSON(SETTINGS_FILE, s);
  logAudit(req, 'unifi.add', ctrl.name);
  res.json({ ...ctrl, password: ctrl.password ? '••••••••' : '' });
});

app.delete('/api/unifi/controllers/:id', requireAdmin, (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  s.unifiControllers = (s.unifiControllers || []).filter(c => c.id !== req.params.id);
  writeJSON(SETTINGS_FILE, s);
  logAudit(req, 'unifi.delete', req.params.id);
  res.json({ ok: true });
});

app.post('/api/unifi/controllers/:id/import', requireOperator, async (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const ctrl = (s.unifiControllers || []).find(c => c.id === req.params.id);
  if (!ctrl) return res.status(404).json({ error: 'not found' });
  try {
    const result = await importFromUnifi(ctrl);
    logAudit(req, 'unifi.import', `${ctrl.name}: создано ${result.created}, обновлено ${result.updated}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.code || 'connection_failed', message: err.message || String(err) });
  }
});

// ==================== ИНТЕГРАЦИЯ: CISCO (по SSH) ====================
// У классических Cisco IOS/IOS-XE нет REST API уровня RouterOS API, поэтому подключаемся
// по SSH и парсим вывод стандартных команд (`show ip arp`). Работает для большинства свитчей
// и роутеров Cisco с включённым SSH-доступом (ssh version 2, локальный пользователь с правами
// на просмотр — privilege level 15 надёжнее всего, либо enable-пароль отдельно).
function sshExec(cfg, command) {
  return new Promise((resolve, reject) => {
    if (!SSHClient) return reject(new Error('Пакет ssh2 не установлен (выполните npm install)'));
    const conn = new SSHClient();
    let output = '';
    const timer = setTimeout(() => { conn.end(); reject(new Error('Таймаут подключения по SSH')); }, 12000);
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); return reject(err); }
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('close', () => { clearTimeout(timer); conn.end(); resolve(output); });
        stream.stderr.on('data', () => {});
      });
    });
    conn.on('error', err => { clearTimeout(timer); reject(err); });
    conn.connect({
      host: cfg.host, port: Number(cfg.port) || 22,
      username: cfg.user, password: cfg.password,
      readyTimeout: 10000,
      algorithms: { // многие Cisco IOS ещё используют старые алгоритмы — расширяем список для совместимости
        kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group1-sha1', 'ecdh-sha2-nistp256'],
        cipher: ['aes128-cbc', 'aes128-ctr', 'aes192-ctr', 'aes256-ctr', '3des-cbc'],
        serverHostKey: ['ssh-rsa', 'ssh-dss', 'ecdsa-sha2-nistp256']
      }
    });
  });
}

// Парсим вывод `show ip arp`, строки вида:
// Internet  10.7.1.1   -   aabb.ccdd.eeff  ARPA   Vlan10
function parseCiscoArp(text) {
  const results = [];
  const re = /Internet\s+(\d{1,3}(?:\.\d{1,3}){3})\s+\S+\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+ARPA\s+(\S+)/g;
  let m;
  while ((m = re.exec(text))) {
    const [, ip, ciscoMac, iface] = m;
    // Cisco пишет MAC как aabb.ccdd.eeff — приводим к привычному AA:BB:CC:DD:EE:FF
    const hex = ciscoMac.replace(/\./g, '');
    const mac = hex.match(/.{1,2}/g).join(':').toUpperCase();
    results.push({ ip, mac, interface: iface });
  }
  return results;
}

async function importFromCisco(cfg) {
  const output = await sshExec(cfg, 'show ip arp');
  const entries = parseCiscoArp(output);
  if (!entries.length) {
    const err = new Error('Команда выполнена, но не удалось разобрать ни одной записи ARP. Проверьте права пользователя и формат вывода (`show ip arp` вручную).');
    err.code = 'parse_failed';
    throw err;
  }

  const db = readDB();
  let created = 0, updated = 0;
  entries.forEach(e => {
    const existing = db.devices.find(d => (d.mac && d.mac.toUpperCase() === e.mac) || d.ip === e.ip);
    if (existing) {
      existing.ip = e.ip || existing.ip;
      existing.mac = e.mac || existing.mac;
      existing.source = existing.source || ('cisco:' + cfg.name);
      updated++;
    } else {
      db.devices.push({
        id: newId('d'), name: e.ip, ip: e.ip, mac: e.mac,
        location: '', type: 'DHCP Client', category: 'workstation',
        comment: `Импортировано из Cisco "${cfg.name}" (show ip arp, интерфейс ${e.interface})`,
        key: false, source: 'cisco:' + cfg.name, monitored: false,
        checkInterval: DEFAULT_CHECK_INTERVAL_SEC, alertsEnabled: true,
        x: 100 + Math.random() * 800, y: 100 + Math.random() * 500
      });
      created++;
    }
  });
  writeDB(db);
  return { created, updated, total: entries.length };
}

app.get('/api/cisco/devices', requireAuth, (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  res.json((s.ciscoDevices || []).map(c => ({ ...c, password: c.password ? '••••••••' : '' })));
});

app.post('/api/cisco/devices', requireAdmin, (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  if (!s.ciscoDevices) s.ciscoDevices = [];
  const cfg = {
    id: newId('c'),
    name: req.body.name || req.body.host || 'Cisco',
    host: req.body.host || '',
    port: Number(req.body.port) || 22,
    user: req.body.user || '',
    password: req.body.password || ''
  };
  s.ciscoDevices.push(cfg);
  writeJSON(SETTINGS_FILE, s);
  logAudit(req, 'cisco.add', cfg.name);
  res.json({ ...cfg, password: cfg.password ? '••••••••' : '' });
});

app.delete('/api/cisco/devices/:id', requireAdmin, (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  s.ciscoDevices = (s.ciscoDevices || []).filter(c => c.id !== req.params.id);
  writeJSON(SETTINGS_FILE, s);
  logAudit(req, 'cisco.delete', req.params.id);
  res.json({ ok: true });
});

app.post('/api/cisco/devices/:id/import', requireOperator, async (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const cfg = (s.ciscoDevices || []).find(c => c.id === req.params.id);
  if (!cfg) return res.status(404).json({ error: 'not found' });
  try {
    const result = await importFromCisco(cfg);
    logAudit(req, 'cisco.import', `${cfg.name}: создано ${result.created}, обновлено ${result.updated}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.code || 'connection_failed', message: err.message || String(err) });
  }
});

// ==================== ОБНАРУЖЕНИЕ СЕТИ И ТОПОЛОГИЯ ====================

// ---------- Подсказка: локальные подсети сервера (чтобы предзаполнить поле сканирования) ----------
app.get('/api/discovery/local-subnets', requireAuth, (req, res) => {
  const ifaces = os.networkInterfaces();
  const subnets = [];
  Object.values(ifaces).forEach(list => {
    (list || []).forEach(iface => {
      if (iface.family === 'IPv4' && !iface.internal) {
        const prefix = cidrPrefixFromNetmask(iface.netmask);
        subnets.push(`${cidrBase(iface.address, prefix)}/${prefix}`);
      }
    });
  });
  res.json([...new Set(subnets)]);
});

function cidrPrefixFromNetmask(mask) {
  return mask.split('.').reduce((bits, octet) => bits + (parseInt(octet, 10).toString(2).match(/1/g) || []).length, 0);
}
function ipToInt(ip) { return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0; }
function intToIp(n) { return [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255].join('.'); }
function cidrBase(ip, prefix) {
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return intToIp(ipToInt(ip) & mask);
}

// ---------- Скан подсети (ping-sweep) ----------
// Ограничиваем /24 (максимум 256 адресов) — чтобы не превратить кнопку в inadvertent DoS по сети
app.post('/api/discovery/scan', requireOperator, async (req, res) => {
  const cidr = (req.body && req.body.cidr || '').trim();
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!m) return res.status(400).json({ error: 'invalid_cidr', message: 'Укажите диапазон в формате 192.168.1.0/24' });
  const [, baseIp, prefixStr] = m;
  const prefix = parseInt(prefixStr, 10);
  if (prefix < 24 || prefix > 30) {
    return res.status(400).json({ error: 'range_too_big', message: 'Поддерживается диапазон от /24 до /30 (не более 256 адресов за раз)' });
  }
  const base = ipToInt(cidrBase(baseIp, prefix));
  const hostCount = Math.pow(2, 32 - prefix);
  const ips = [];
  for (let i = 1; i < hostCount - 1; i++) ips.push(intToIp(base + i)); // пропускаем network/broadcast

  const db = readDB();
  const known = new Set(db.devices.map(d => d.ip).filter(Boolean));

  const results = [];
  const CONCURRENCY = 16;
  for (let i = 0; i < ips.length; i += CONCURRENCY) {
    const batch = ips.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async ip => {
      const alive = await pingHost(ip);
      if (!alive) return null;
      let hostname = '';
      try { const names = await dns.reverse(ip); hostname = names[0] || ''; } catch (e) { /* нет PTR-записи — не страшно */ }
      return { ip, hostname, inRegistry: known.has(ip) };
    }));
    results.push(...batchResults.filter(Boolean));
  }
  res.json({ scanned: ips.length, found: results.length, results });
});

// ---------- ARP-таблица с MikroTik (IP + MAC + порт роутера) ----------
app.post('/api/mikrotik/routers/:id/arp', requireOperator, async (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const routerCfg = (s.mikrotiks || []).find(r => r.id === req.params.id);
  if (!routerCfg) return res.status(404).json({ error: 'not found' });
  try {
    const entries = await routerOsQuery(routerCfg, '/ip/arp/print');
    const db = readDB();
    const results = entries
      .filter(e => e.address && e['mac-address'])
      .map(e => {
        const mac = e['mac-address'].toUpperCase();
        const existing = db.devices.find(d => (d.mac && d.mac.toUpperCase() === mac) || d.ip === e.address);
        return {
          ip: e.address, mac, interface: e.interface || '',
          existingDeviceId: existing ? existing.id : null,
          existingDeviceName: existing ? existing.name : null
        };
      });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'connection_failed', message: err.message || String(err) });
  }
});

// ---------- Соседи по MikroTik Neighbor Discovery (кто к какому порту подключён) ----------
app.post('/api/mikrotik/routers/:id/neighbors', requireOperator, async (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const routerCfg = (s.mikrotiks || []).find(r => r.id === req.params.id);
  if (!routerCfg) return res.status(404).json({ error: 'not found' });
  try {
    const entries = await routerOsQuery(routerCfg, '/ip/neighbor/print');
    const db = readDB();
    const results = entries.map(e => {
      const mac = (e['mac-address'] || '').toUpperCase();
      const ip = e.address || '';
      const existing = db.devices.find(d => (mac && d.mac && d.mac.toUpperCase() === mac) || (ip && d.ip === ip));
      return {
        identity: e.identity || e['identity'] || '(без имени)',
        ip, mac,
        interface: e.interface || '',
        platform: e.platform || '',
        board: e.board || '',
        existingDeviceId: existing ? existing.id : null,
        existingDeviceName: existing ? existing.name : null
      };
    });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'connection_failed', message: err.message || String(err) });
  }
});

async function routerOsQuery(routerCfg, command) {
  const conn = new RouterOSAPI({
    host: routerCfg.host,
    user: routerCfg.user || 'admin',
    password: routerCfg.password,
    port: Number(routerCfg.port) || 8728,
    tls: !!routerCfg.useTls,
    timeout: 8
  });
  await conn.connect();
  const data = await conn.write(command);
  conn.close();
  return data;
}

// Найти устройство-роутер в реестре по IP, а если его там нет — создать (чтобы было от чего рисовать связи)
function ensureRouterDevice(db, routerCfg) {
  let device = db.devices.find(d => d.ip === routerCfg.host);
  if (!device) {
    device = {
      id: newId('d'),
      name: routerCfg.name || routerCfg.host,
      ip: routerCfg.host,
      mac: '',
      location: '',
      type: 'Router',
      category: 'network',
      comment: 'Добавлено автоматически как узел MikroTik для построения топологии',
      key: true,
      monitored: true,
      checkInterval: DEFAULT_CHECK_INTERVAL_SEC,
      alertsEnabled: true,
      source: 'mikrotik:' + (routerCfg.name || routerCfg.host),
      x: 500, y: 80
    };
    db.devices.push(device);
  }
  return device;
}

// Принять выбранные из обнаружения устройства и добавить в реестр одним запросом
app.post('/api/discovery/add-bulk', requireOperator, (req, res) => {
  const { items } = req.body || {}; // [{ name, ip, mac, category, type }]
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items_required' });
  const db = readDB();
  let created = 0;
  items.forEach(it => {
    if (!it.ip && !it.mac) return;
    const exists = db.devices.find(d => (it.mac && d.mac && d.mac.toUpperCase() === it.mac.toUpperCase()) || (it.ip && d.ip === it.ip));
    if (exists) return;
    db.devices.push({
      id: newId('d'),
      name: it.name || it.ip || 'Новое устройство',
      ip: it.ip || '',
      mac: (it.mac || '').toUpperCase(),
      location: '',
      type: it.type || '',
      category: it.category || 'other',
      comment: 'Добавлено через обнаружение сети',
      key: false,
      monitored: false,
      checkInterval: DEFAULT_CHECK_INTERVAL_SEC,
      alertsEnabled: true,
      source: it.source || 'discovery',
      x: 100 + Math.random() * 800,
      y: 100 + Math.random() * 500
    });
    created++;
  });
  writeDB(db);
  res.json({ ok: true, created });
});

// ---------- Автопостроение топологии по данным одного роутера (neighbors + arp) ----------
app.post('/api/topology/build/:routerId', requireOperator, async (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const routerCfg = (s.mikrotiks || []).find(r => r.id === req.params.routerId);
  if (!routerCfg) return res.status(404).json({ error: 'not found' });

  try {
    const [neighbors, arp] = await Promise.all([
      routerOsQuery(routerCfg, '/ip/neighbor/print'),
      routerOsQuery(routerCfg, '/ip/arp/print')
    ]);

    const db = readDB();
    const routerDevice = ensureRouterDevice(db, routerCfg);

    function findOrCreate(mac, ip, fallbackName, fallbackType) {
      mac = (mac || '').toUpperCase();
      let d = db.devices.find(dd => (mac && dd.mac && dd.mac.toUpperCase() === mac) || (ip && dd.ip === ip));
      if (d) return d;
      if (!ip && !mac) return null;
      d = {
        id: newId('d'),
        name: fallbackName || ip || mac,
        ip: ip || '', mac: mac || '',
        location: '', type: fallbackType || '', category: 'other',
        comment: 'Добавлено автоматически при построении топологии',
        key: false, monitored: false, checkInterval: DEFAULT_CHECK_INTERVAL_SEC, alertsEnabled: true,
        source: 'topology:' + routerCfg.name,
        x: 100 + Math.random() * 800, y: 100 + Math.random() * 500
      };
      db.devices.push(d);
      return d;
    }

    const topo = readJSON(TOPOLOGY_FILE, { edges: [] });
    // убираем старые связи от этого роутера — построим заново
    topo.edges = topo.edges.filter(e => e.viaRouterId !== routerCfg.id);

    let edgesCreated = 0;
    const seenInterfaces = new Set(); // чтобы не дублировать связь роутер-устройство на одном порту дважды

    neighbors.forEach(n => {
      const target = findOrCreate(n['mac-address'], n.address, n.identity, n.platform && n.platform.includes('MikroTik') ? 'Switch/AP' : '');
      if (!target || target.id === routerDevice.id) return;
      const key = target.id + '|' + (n.interface || '');
      if (seenInterfaces.has(key)) return;
      seenInterfaces.add(key);
      topo.edges.push({ id: newId('e'), from: routerDevice.id, to: target.id, interface: n.interface || '', label: n.identity || '', viaRouterId: routerCfg.id, manual: false });
      edgesCreated++;
    });

    arp.forEach(a => {
      if (!a.address || !a['mac-address']) return;
      const existing = db.devices.find(d => (d.mac && d.mac.toUpperCase() === a['mac-address'].toUpperCase()) || d.ip === a.address);
      if (!existing || existing.id === routerDevice.id) return;
      const key = existing.id + '|' + (a.interface || '');
      if (seenInterfaces.has(key)) return; // уже связали через neighbor discovery
      seenInterfaces.add(key);
      topo.edges.push({ id: newId('e'), from: routerDevice.id, to: existing.id, interface: a.interface || '', label: '', viaRouterId: routerCfg.id, manual: false });
      edgesCreated++;
    });

    writeDB(db);
    writeJSON(TOPOLOGY_FILE, topo);
    res.json({ ok: true, edgesCreated, routerDeviceId: routerDevice.id });
  } catch (err) {
    res.status(500).json({ error: 'connection_failed', message: err.message || String(err) });
  }
});

app.get('/api/topology', requireAuth, (req, res) => {
  res.json(readJSON(TOPOLOGY_FILE, { edges: [] }));
});

// ---------- Ручное редактирование связей на карте ----------
// Для неуправляемых свитчей LLDP/MNDP недоступен — здесь можно провести линию между
// двумя устройствами руками (например, с подписью порта или просто «через свитч в шкафу»).
app.post('/api/topology/edges', requireOperator, (req, res) => {
  const { from, to, label } = req.body || {};
  if (!from || !to || from === to) return res.status(400).json({ error: 'invalid_edge', message: 'Нужны два разных устройства' });
  const db = readDB();
  if (!db.devices.find(d => d.id === from) || !db.devices.find(d => d.id === to)) {
    return res.status(404).json({ error: 'device_not_found' });
  }
  const topo = readJSON(TOPOLOGY_FILE, { edges: [] });
  const edge = { id: newId('e'), from, to, label: label || '', manual: true };
  topo.edges.push(edge);
  writeJSON(TOPOLOGY_FILE, topo);
  res.json(edge);
});

app.put('/api/topology/edges/:id', requireOperator, (req, res) => {
  const topo = readJSON(TOPOLOGY_FILE, { edges: [] });
  const edge = topo.edges.find(e => e.id === req.params.id);
  if (!edge) return res.status(404).json({ error: 'not_found' });
  if (req.body.label != null) edge.label = req.body.label;
  writeJSON(TOPOLOGY_FILE, topo);
  res.json(edge);
});

app.delete('/api/topology/edges/:id', requireOperator, (req, res) => {
  const topo = readJSON(TOPOLOGY_FILE, { edges: [] });
  topo.edges = topo.edges.filter(e => e.id !== req.params.id);
  writeJSON(TOPOLOGY_FILE, topo);
  res.json({ ok: true });
});

// ---------- Правила подсетей (визуальная группировка на карте «облаками») ----------
app.get('/api/subnet-rules', requireAuth, (req, res) => {
  res.json(readJSON(SETTINGS_FILE, {}).subnetRules || []);
});

app.post('/api/subnet-rules', requireOperator, (req, res) => {
  const { rules } = req.body || {};
  if (!Array.isArray(rules)) return res.status(400).json({ error: 'rules_required' });
  const cidrRe = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/;
  const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  for (const r of rules) {
    if (!cidrRe.test(r.cidr || '')) {
      return res.status(400).json({ error: 'invalid_cidr', message: `Некорректный CIDR: "${r.cidr}". Пример: 10.7.7.0/24` });
    }
    if (r.color && !HEX_COLOR_RE.test(r.color)) {
      return res.status(400).json({ error: 'invalid_color', message: `Некорректный цвет: "${r.color}". Ожидается формат #RRGGBB` });
    }
  }
  const s = readJSON(SETTINGS_FILE, {});
  s.subnetRules = rules.map(r => ({
    id: r.id || newId('sr'),
    cidr: r.cidr,
    label: r.label || r.cidr,
    color: r.color || '#3b82f6'
  }));
  writeJSON(SETTINGS_FILE, s);
  res.json(s.subnetRules);
});

// ==================== ДОПОЛНИТЕЛЬНЫЕ МОДУЛИ (каждый включается отдельно) ====================

// ---------- Фиче-флаги ----------
app.get('/api/features', requireAuth, (req, res) => {
  res.json(getFeatures());
});

app.post('/api/features', requireAdmin, (req, res) => {
  const s = readJSON(SETTINGS_FILE, {});
  const incoming = req.body || {};
  s.features = {
    snmp: !!incoming.snmp,
    portChecks: !!incoming.portChecks,
    incidents: !!incoming.incidents,
    auditLog: !!incoming.auditLog
  };
  writeJSON(SETTINGS_FILE, s);
  logAudit(req, 'features.update', JSON.stringify(s.features));
  res.json(s.features);
});

// ---------- Аудит-лог ----------
app.get('/api/audit-log', requireAdmin, (req, res) => {
  const store = readJSON(AUDIT_FILE, { entries: [] });
  const all = [...store.entries].reverse();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));
  const start = (page - 1) * pageSize;
  res.json({
    entries: all.slice(start, start + pageSize),
    total: all.length,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(all.length / pageSize))
  });
});

app.get('/api/audit-log/export.csv', requireAdmin, (req, res) => {
  const store = readJSON(AUDIT_FILE, { entries: [] });
  const header = ['time', 'user', 'action', 'details'];
  const rows = [...store.entries].reverse().map(e => [
    new Date(e.t).toISOString(), e.user, e.action, e.details
  ].map(csvCell).join(','));
  const csv = '\uFEFF' + [header.join(','), ...rows].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="netmonitor-audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// ==================== РЕЗЕРВНОЕ КОПИРОВАНИЕ / ВОССТАНОВЛЕНИЕ ====================
// Секрет сессии (.session-secret) в бэкап намеренно не включается — он привязан
// к конкретной инсталляции, при восстановлении на другом сервере пересоздастся сам.
app.get('/api/backup', requireAdmin, (req, res) => {
  const bundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    devices: readJSON(DB_FILE, {}),
    users: readJSON(USERS_FILE, {}),
    settings: readJSON(SETTINGS_FILE, {}),
    history: readJSON(HISTORY_FILE, {}),
    topology: readJSON(TOPOLOGY_FILE, {}),
    incidents: readJSON(INCIDENTS_FILE, {}),
    audit: readJSON(AUDIT_FILE, {})
  };
  const filename = `netmonitor-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  logAudit(req, 'backup.download', filename);
  res.json(bundle);
});

app.post('/api/backup/restore', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.devices || !b.users || !b.settings) {
    return res.status(400).json({ error: 'invalid_backup', message: 'Файл не похож на бэкап NetMonitor (нет ожидаемых разделов).' });
  }
  try {
    writeJSON(DB_FILE, b.devices);
    writeJSON(USERS_FILE, b.users);
    writeJSON(SETTINGS_FILE, b.settings);
    if (b.history) writeJSON(HISTORY_FILE, b.history);
    if (b.topology) writeJSON(TOPOLOGY_FILE, b.topology);
    if (b.incidents) writeJSON(INCIDENTS_FILE, b.incidents);
    if (b.audit) writeJSON(AUDIT_FILE, b.audit);
    logAudit(req, 'backup.restore', `exportedAt=${b.exportedAt || '?'}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'restore_failed', message: err.message });
  }
});

// ---------- История инцидентов (даунтаймов) ----------
app.get('/api/incidents', requireAuth, (req, res) => {
  const store = readJSON(INCIDENTS_FILE, { open: {}, closed: [] });
  const limit = Math.min(1000, Number(req.query.limit) || 200);
  const db = readDB();
  const openList = Object.entries(store.open).map(([deviceId, inc]) => {
    const d = db.devices.find(x => x.id === deviceId);
    return { deviceId, deviceName: d ? d.name : '(удалено)', start: inc.start, end: null, durationSec: Math.round((Date.now() - inc.start) / 1000), escalated: !!inc.escalated };
  });
  const closedList = store.closed.slice(-limit).reverse();
  res.json({ open: openList, closed: closedList });
});

app.get('/api/incidents/stats', requireAuth, (req, res) => {
  const store = readJSON(INCIDENTS_FILE, { open: {}, closed: [] });
  const days = Math.min(90, Number(req.query.days) || 7);
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const recent = store.closed.filter(i => i.start >= cutoff);
  const byDevice = {};
  recent.forEach(i => {
    if (!byDevice[i.deviceId]) byDevice[i.deviceId] = { deviceName: i.deviceName, count: 0, totalDownSec: 0 };
    byDevice[i.deviceId].count++;
    byDevice[i.deviceId].totalDownSec += i.durationSec || 0;
  });
  const totalIncidents = recent.length;
  const totalDownSec = recent.reduce((sum, i) => sum + (i.durationSec || 0), 0);
  const mttrSec = totalIncidents ? Math.round(totalDownSec / totalIncidents) : 0;
  res.json({ days, totalIncidents, totalDownSec, mttrSec, byDevice });
});

// ---------- Импорт устройств из CSV ----------
// Ожидаемые колонки (заголовок обязателен): name,ip,mac,location,type,category,comment
// Разделитель запятая, простые значения в кавычках поддерживаются.
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

app.post('/api/devices/import-csv', requireOperator, (req, res) => {
  const { csv } = req.body || {};
  if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'csv_required' });
  const lines = csv.split(/\r?\n/).filter(l => l.trim().length);
  if (lines.length < 2) return res.status(400).json({ error: 'empty_csv', message: 'Нужен заголовок и хотя бы одна строка данных' });

  const header = parseCsvLine(lines[0]).map(h => h.toLowerCase());
  const required = ['name', 'ip'];
  if (!required.every(r => header.includes(r))) {
    return res.status(400).json({ error: 'bad_header', message: 'В заголовке обязательны колонки: name, ip (плюс опционально mac,location,type,category,comment)' });
  }

  const db = readDB();
  const validCategoryIds = new Set(db.categories.map(c => c.id));
  let created = 0, skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const row = {};
    header.forEach((h, idx) => row[h] = cols[idx] || '');
    if (!row.name || !row.ip) { skipped++; continue; }
    const exists = db.devices.find(d => d.ip === row.ip || (row.mac && d.mac && d.mac.toUpperCase() === row.mac.toUpperCase()));
    if (exists) { skipped++; continue; }
    db.devices.push({
      id: newId('d'),
      name: row.name,
      ip: row.ip || '',
      mac: (row.mac || '').toUpperCase(),
      location: row.location || '',
      type: row.type || '',
      category: validCategoryIds.has(row.category) ? row.category : 'other',
      comment: row.comment || '',
      key: false,
      monitored: false,
      checkInterval: DEFAULT_CHECK_INTERVAL_SEC,
      alertsEnabled: true,
      source: 'csv-import',
      x: 100 + Math.random() * 800,
      y: 100 + Math.random() * 500
    });
    created++;
  }

  writeDB(db);
  logAudit(req, 'devices.import_csv', `создано ${created}, пропущено ${skipped}`);
  res.json({ ok: true, created, skipped });
});

// ---------- Экспорт отчёта по аптайму (CSV — открывается в Excel) ----------
app.get('/api/reports/uptime.csv', requireAuth, (req, res) => {
  const db = readDB();
  const uptimeStore = readJSON(HISTORY_FILE, {});
  const now = Date.now();
  const cut24 = now - 24 * 3600 * 1000;
  const cut7d = now - 7 * 24 * 3600 * 1000;

  const calc = (points, cutoff) => {
    const pts = points.filter(p => p.t >= cutoff);
    if (!pts.length) return '';
    const up = pts.filter(p => p.online).length;
    return (Math.round((up / pts.length) * 1000) / 10) + '%';
  };

  const rows = [['Название', 'IP', 'Категория', 'Мониторится', 'Аптайм 24ч', 'Аптайм 7д']];
  db.devices.forEach(d => {
    const c = db.categories.find(c => c.id === d.category);
    const points = uptimeStore[d.id] || [];
    rows.push([
      d.name, d.ip, c ? c.name : d.category, d.monitored ? 'да' : 'нет',
      calc(points, cut24), calc(points, cut7d)
    ]);
  });

  const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="uptime-report.csv"');
  res.send('\uFEFF' + csv); // BOM — чтобы Excel сразу увидел кириллицу и UTF-8
});

if (USE_HTTPS) {
  const tlsOptions = {
    cert: fs.readFileSync(CERT_FILE),
    key: fs.readFileSync(KEY_FILE)
  };
  https.createServer(tlsOptions, app).listen(PORT, () => {
    console.log(`Network monitor запущен по HTTPS: https://localhost:${PORT}  (в локальной сети — https://<IP-этого-компьютера>:${PORT})`);
    console.log('Сертификат: ' + CERT_FILE);
  });

  // HTTP→HTTPS редирект включён по умолчанию на 80-м порту (стандартный порт для http://
  // без явного указания порта в адресе) — чтобы просто http://<IP> сам уводил на https.
  // Порт редиректа можно поменять/выключить переменной HTTP_REDIRECT_PORT (0 — выключить).
  const redirectPort = process.env.HTTP_REDIRECT_PORT != null ? Number(process.env.HTTP_REDIRECT_PORT) : 80;
  if (redirectPort > 0) {
    const redirectServer = http.createServer((req, res) => {
      const host = (req.headers.host || '').split(':')[0];
      res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
      res.end();
    });
    redirectServer.on('error', (err) => {
      if (err.code === 'EACCES') {
        console.log(`⚠ Не удалось поднять HTTP→HTTPS редирект на порту ${redirectPort} (нет прав — на Linux/macOS порты <1024 требуют root, на Windows иногда нужен запуск от администратора).`);
        console.log(`  Сайт всё равно доступен напрямую: https://<IP-этого-компьютера>:${PORT}`);
        console.log(`  Либо укажите порт редиректа ≥1024: HTTP_REDIRECT_PORT=8080 npm start`);
      } else if (err.code === 'EADDRINUSE') {
        console.log(`⚠ Порт ${redirectPort} для HTTP→HTTPS редиректа уже занят другим процессом — редирект не запущен.`);
      } else {
        console.log(`⚠ Не удалось запустить HTTP→HTTPS редирект на порту ${redirectPort}: ${err.message}`);
      }
    });
    redirectServer.listen(redirectPort, () => {
      console.log(`HTTP→HTTPS редирект слушает на порту ${redirectPort} (http://<IP> без порта сам уведёт на https://<IP>:${PORT})`);
    });
  }
} else {
  app.listen(PORT, () => {
    console.log(`Network monitor запущен: http://localhost:${PORT}  (в локальной сети — http://<IP-этого-компьютера>:${PORT})`);
    console.log(`Работает по обычному HTTP. Чтобы включить HTTPS: сгенерируйте сертификат (./make-cert.sh или make-cert.bat) и перезапустите сервер.`);
  });
}
