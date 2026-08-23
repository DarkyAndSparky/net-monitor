'use strict';
const express = require('express');
const { db, hashPassword, verifyPassword, getSetting } = require('../db');
const { requireAuth, requireAdmin, logAudit } = require('../middleware/auth');
const log = require('../services/logger');

const router = express.Router();
const MIN_PASSWORD_LENGTH = 8;
const LOGIN_MAX_ATTEMPTS  = 5;
const LOGIN_LOCKOUT_MS    = 5 * 60 * 1000;
const VALID_ROLES         = ['admin', 'operator', 'viewer'];
const loginAttempts       = {};

function isLockedOut(ip) { const r = loginAttempts[ip]; return r?.lockedUntil > Date.now(); }
function registerFail(ip) {
  const r = loginAttempts[ip] || { count: 0, lockedUntil: 0 };
  if (++r.count >= LOGIN_MAX_ATTEMPTS) { r.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS; r.count = 0; }
  loginAttempts[ip] = r;
}
function normalizeRole(role) { return VALID_ROLES.includes(role) ? role : 'viewer'; }

router.post('/login', async (req, res) => {
  try {
    const ip = req.ip;
    if (isLockedOut(ip)) {
      const wait = Math.ceil((loginAttempts[ip].lockedUntil - Date.now()) / 60000);
      return res.status(429).json({ error: 'too_many_attempts', message: `Повторите через ~${wait} мин.` });
    }
    const { username, password } = req.body || {};
    if (!username || typeof username !== 'string') {
      registerFail(ip); return res.status(401).json({ error: 'invalid_credentials' });
    }
    let user = db.prepare('SELECT * FROM users WHERE username=?').get(username);

    // Локальный пользователь — обычная проверка пароля (без изменений в поведении)
    if (user && user.source !== 'ldap') {
      if (!verifyPassword(password || '', user.salt, user.hash)) {
        registerFail(ip); return res.status(401).json({ error: 'invalid_credentials' });
      }
    } else {
      // Нет локального пользователя (или он привязан к LDAP) — пробуем LDAP, если он включён
      const ldapCfg = getSetting('ldap') || {};
      if (!ldapCfg.enabled) {
        registerFail(ip); return res.status(401).json({ error: 'invalid_credentials' });
      }
      const { authenticate } = require('../services/ldap');
      const result = await authenticate(username, password || '', ldapCfg);
      if (!result.ok) {
        registerFail(ip); return res.status(401).json({ error: 'invalid_credentials' });
      }
      // Авто-провижининг / синхронизация роли по группам при каждом успешном входе
      const role = normalizeRole(result.role);
      if (user) {
        db.prepare('UPDATE users SET role=? WHERE username=?').run(role, username);
      } else {
        db.prepare('INSERT INTO users (username,salt,hash,role,must_change_password,source) VALUES (?,?,?,?,0,?)')
          .run(username, '', '', role, 'ldap');
      }
      user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    }

    delete loginAttempts[ip];
    req.session.userId = user.username;
    req.session.role   = user.role || 'admin';
    res.json({ ok: true, username: user.username, role: user.role, mustChangePassword: !!user.must_change_password });
  } catch (err) {
    log.error({ err }, 'Login handler failed unexpectedly');
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

router.get('/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'auth_required' });
  const user = db.prepare('SELECT role, must_change_password FROM users WHERE username=?').get(req.session.userId);
  if (!user) { req.session.destroy(() => {}); return res.status(401).json({ error: 'auth_required' }); }
  res.json({ username: req.session.userId, role: user.role || 'admin', mustChangePassword: !!user.must_change_password });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'auth_required' });
  if (user.source === 'ldap')
    return res.status(400).json({ error: 'ldap_managed', message: 'Пароль этой учётной записи управляется через LDAP/AD — смените его там.' });
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH)
    return res.status(400).json({ error: 'weak_password', message: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов` });
  // Принудительная смена пароля по умолчанию при первом входе: пользователь только что
  // ввёл текущий пароль на экране логина несколько секунд назад — сама валидная сессия
  // это доказывает, повторный ввод не требуем. Для добровольной смены через настройки
  // (must_change_password уже снят) текущий пароль по-прежнему обязателен.
  if (!user.must_change_password) {
    if (newPassword === currentPassword)
      return res.status(400).json({ error: 'same_password', message: 'Новый пароль должен отличаться от текущего' });
    if (!verifyPassword(currentPassword || '', user.salt, user.hash))
      return res.status(401).json({ error: 'wrong_current_password' });
  } else if (verifyPassword(newPassword, user.salt, user.hash)) {
    return res.status(400).json({ error: 'same_password', message: 'Новый пароль должен отличаться от текущего (по умолчанию)' });
  }
  const { salt, hash } = hashPassword(newPassword);
  db.prepare('UPDATE users SET salt=?,hash=?,must_change_password=0 WHERE username=?').run(salt, hash, user.username);
  logAudit(req, 'user.change_password', user.username);
  res.json({ ok: true });
});

router.get('/users', requireAdmin, (req, res) =>
  res.json(db.prepare('SELECT username,role,must_change_password as mustChangePassword,source FROM users ORDER BY username').all()
    .map(u => ({ ...u, mustChangePassword: !!u.mustChangePassword })))
);

router.post('/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username))
    return res.status(400).json({ error: 'invalid_username', message: 'Логин: 3–32 символа, латиница/цифры/._-' });
  if (!password || password.length < MIN_PASSWORD_LENGTH)
    return res.status(400).json({ error: 'weak_password', message: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов` });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username))
    return res.status(409).json({ error: 'already_exists', message: 'Пользователь уже существует' });
  const finalRole = normalizeRole(role);
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO users (username,salt,hash,role,must_change_password) VALUES (?,?,?,?,1)').run(username, salt, hash, finalRole);
  logAudit(req, 'user.create', `${username} (${finalRole})`);
  res.json({ ok: true });
});

router.put('/users/:username/role', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(req.params.username);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const newRole = normalizeRole(req.body.role);
  if ((user.role || 'admin') === 'admin' && newRole !== 'admin') {
    const admins = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get().c;
    if (admins <= 1) return res.status(400).json({ error: 'last_admin', message: 'Нельзя понизить последнего администратора' });
  }
  db.prepare('UPDATE users SET role=? WHERE username=?').run(newRole, req.params.username);
  logAudit(req, 'user.role_change', `${req.params.username} -> ${newRole}`);
  res.json({ ok: true });
});

router.delete('/users/:username', requireAdmin, (req, res) => {
  if (req.params.username === req.session.userId)
    return res.status(400).json({ error: 'cannot_delete_self', message: 'Нельзя удалить самого себя' });
  const target = db.prepare('SELECT * FROM users WHERE username=?').get(req.params.username);
  if (!target) return res.status(404).json({ error: 'not_found' });
  if ((target.role || 'admin') === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get().c;
    if (admins <= 1) return res.status(400).json({ error: 'last_admin', message: 'Нельзя удалить последнего администратора' });
  }
  db.prepare('DELETE FROM users WHERE username=?').run(req.params.username);
  logAudit(req, 'user.delete', req.params.username);
  res.json({ ok: true });
});

module.exports = router;
