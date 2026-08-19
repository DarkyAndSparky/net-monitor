'use strict';
const { db, getSetting } = require('../db');

function getLiveUser(username) {
  return db.prepare('SELECT * FROM users WHERE username=?').get(username);
}

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'auth_required' });
  const user = getLiveUser(req.session.userId);
  if (!user) { req.session.destroy(() => {}); return res.status(401).json({ error: 'auth_required' }); }
  req.session.role = user.role || 'admin';
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.session.role !== 'admin')
      return res.status(403).json({ error: 'forbidden', message: 'Требуются права администратора' });
    next();
  });
}

function requireOperator(req, res, next) {
  requireAuth(req, res, () => {
    if (!['admin', 'operator'].includes(req.session.role))
      return res.status(403).json({ error: 'forbidden', message: 'Недостаточно прав (нужна роль «Operator» или «Администратор»)' });
    next();
  });
}

function logAudit(req, action, details = '') {
  const username = req.session?.userId || '—';
  const ip = req.ip;
  try {
    const features = getSetting('features') || {};
    if (features.auditLog) {
      db.prepare('INSERT INTO audit_log (ts,username,ip,action,details) VALUES (?,?,?,?,?)').run(
        Date.now(), username, ip, action, details
      );
    }
  } catch {}
  try {
    require('../services/eventWebhook').fireEvent(action, details, { username, ip });
  } catch {}
}

module.exports = { getLiveUser, requireAuth, requireAdmin, requireOperator, logAudit };
