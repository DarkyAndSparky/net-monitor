'use strict';
const express = require('express');
const { db, hashPassword, verifyPassword } = require('../db');
const { requireAuth, requireAdmin, logAudit } = require('../middleware/auth');

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

router.post('/login', (req, res) => {
  const ip = req.ip;
  if (isLockedOut(ip)) {
    const wait = Math.ceil((loginAttempts[ip].lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: 'too_many_attempts', message: `Повторите через ~${wait} мин.` });
  }
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || !verifyPassword(password || '', user.salt, user.hash)) {
    registerFail(ip); return res.status(401).json({ error: 'invalid_credentials' });
  }
  delete loginAttempts[ip];
  req.session.userId = user.username;
  req.session.role   = user.role || 'admin';
  res.json({ ok: true, username: user.username, role: user.role });
});

router.post('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

router.get('/me', (req, res) => {
  if (req.session?.userId) return res.json({ username: req.session.userId, role: req.session.role || 'admin' });
  res.status(401).json({ error: 'auth_required' });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH)
    return res.status(400).json({ error: 'weak_password', message: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов` });
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(req.session.userId);
  if (!user || !verifyPassword(currentPassword || '', user.salt, user.hash))
    return res.status(401).json({ error: 'wrong_current_password' });
  const { salt, hash } = hashPassword(newPassword);
  db.prepare('UPDATE users SET salt=?,hash=? WHERE username=?').run(salt, hash, user.username);
  res.json({ ok: true });
});

router.get('/users', requireAdmin, (req, res) =>
  res.json(db.prepare('SELECT username,role FROM users ORDER BY username').all())
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
  db.prepare('INSERT INTO users (username,salt,hash,role) VALUES (?,?,?,?)').run(username, salt, hash, finalRole);
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
