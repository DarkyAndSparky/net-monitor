'use strict';
const express = require('express');
const { db, getSetting, csvCell } = require('../db');
const { requireAuth, requireOperator, requireAdmin, logAudit } = require('../middleware/auth');

const router = express.Router();

// Статус (из кэша планировщика)
router.get('/status', requireAuth, (req, res) => {
  const { statusCache, snmpCache, portCheckCache } = require('../services/scheduler');
  res.json(db.prepare('SELECT id,ip,monitored FROM devices').all().map(d => {
    if (!d.monitored) return { id:d.id, ip:d.ip, monitored:false, online:null, lastChecked:null };
    const s=statusCache[d.id];
    return { id:d.id, ip:d.ip, monitored:true, online:s?s.online:null, lastChecked:s?s.lastChecked:null, snmp:snmpCache[d.id]||null, ports:portCheckCache[d.id]||null };
  }));
});

// Ручная проверка
router.post('/status/:id/check', requireAuth, async (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error:'not_found' });
  const { pingHost, statusCache } = require('../services/scheduler');
  const online = d.ip ? await pingHost(d.ip) : false;
  const now = Date.now();
  statusCache[d.id] = { online, lastChecked:now };
  if (d.monitored) db.prepare('INSERT INTO history (device_id,ts,online) VALUES (?,?,?)').run(d.id,now,online?1:0);
  res.json({ id:d.id, online, lastChecked:now });
});

// Массовое вкл/выкл мониторинга
router.post('/monitoring/bulk', requireOperator, (req, res) => {
  const { ids, monitored } = req.body||{};
  if (!Array.isArray(ids)) return res.status(400).json({ error:'ids_required' });
  ids.forEach(id => db.prepare('UPDATE devices SET monitored=? WHERE id=?').run(monitored?1:0,id));
  res.json({ ok:true, updated:ids.length });
});

// История
router.get('/history/:id', requireAuth, (req, res) => {
  const ms=req.query.range==='7d'?7*86400*1000:86400*1000;
  const cutoff=Date.now()-ms;
  res.json(db.prepare('SELECT ts,online FROM history WHERE device_id=? AND ts>=? ORDER BY ts').all(req.params.id,cutoff).map(r=>({t:r.ts,online:!!r.online})));
});

// Аптайм
router.get('/uptime', requireAuth, (req, res) => {
  const now=Date.now(), cut24=now-86400*1000, cut7d=now-7*86400*1000;
  const out={};
  db.prepare('SELECT id FROM devices WHERE monitored=1').all().forEach(({id})=>{
    const calc=cutoff=>{ const r=db.prepare('SELECT online FROM history WHERE device_id=? AND ts>=?').all(id,cutoff); if(!r.length)return null; return Math.round((r.filter(x=>x.online).length/r.length)*1000)/10; };
    const samples=db.prepare('SELECT ts,online FROM history WHERE device_id=? ORDER BY ts DESC LIMIT 30').all(id).reverse().map(r=>({t:r.ts,online:!!r.online}));
    out[id]={ uptime24h:calc(cut24), uptime7d:calc(cut7d), samples };
  });
  res.json(out);
});

// Алерт-настройки
router.get('/alert-settings', requireAuth, (req, res) => {
  const cfg=getSetting('alerting')||{};
  res.json({...cfg, telegram:{...cfg.telegram, botToken:cfg.telegram?.botToken?'••••••••':''}, ntfy:{...cfg.ntfy, authToken:cfg.ntfy?.authToken?'••••••••':''}, email:{...cfg.email, pass:cfg.email?.pass?'••••••••':''}});
});
router.post('/alert-settings', requireOperator, (req, res) => {
  const inc=req.body||{}, prev=getSetting('alerting')||{};
  const cfg={
    enabled:!!inc.enabled, failThreshold:Math.max(1,Number(inc.failThreshold)||2),
    repeatMinutes:Math.max(0,Number(inc.repeatMinutes)||0), notifyOnRecovery:inc.notifyOnRecovery!=null?!!inc.notifyOnRecovery:true,
    telegram:{ enabled:!!inc.telegram?.enabled, chatId:inc.telegram?.chatId??prev.telegram?.chatId??'', botToken:(inc.telegram?.botToken&&inc.telegram.botToken!=='••••••••')?inc.telegram.botToken:(prev.telegram?.botToken||'') },
    webhook:{ enabled:!!inc.webhook?.enabled, url:inc.webhook?.url??prev.webhook?.url??'' },
    ntfy:{ enabled:!!inc.ntfy?.enabled, url:inc.ntfy?.url??prev.ntfy?.url??'https://ntfy.sh', topic:inc.ntfy?.topic??prev.ntfy?.topic??'', authToken:(inc.ntfy?.authToken&&inc.ntfy.authToken!=='••••••••')?inc.ntfy.authToken:(prev.ntfy?.authToken||'') },
    email:{
      enabled:!!inc.email?.enabled,
      host:inc.email?.host??prev.email?.host??'',
      port:Math.max(1,Math.min(65535,Number(inc.email?.port)||prev.email?.port||587)),
      secure:!!(inc.email?.secure ?? prev.email?.secure),
      starttls:inc.email?.starttls ?? prev.email?.starttls ?? true,
      user:inc.email?.user??prev.email?.user??'',
      pass:(inc.email?.pass&&inc.email.pass!=='••••••••')?inc.email.pass:(prev.email?.pass||''),
      from:inc.email?.from??prev.email?.from??'',
      to:inc.email?.to??prev.email?.to??'',
      rejectUnauthorized:inc.email?.rejectUnauthorized ?? prev.email?.rejectUnauthorized ?? true
    },
    escalation:{ enabled:!!inc.escalation?.enabled, afterMinutes:Math.max(5,Number(inc.escalation?.afterMinutes)||60), telegramChatId:inc.escalation?.telegramChatId??prev.escalation?.telegramChatId??'' }
  };
  require('../db').setSetting('alerting',cfg);
  logAudit(req,'alert_settings.update','');
  res.json({ ok:true });
});
router.post('/alert-settings/test', requireOperator, async (req, res) => {
  const { dispatchAlert } = require('../services/scheduler');
  await dispatchAlert(getSetting('alerting')||{},{id:'test',name:'Тестовое устройство',ip:'10.0.0.1',location:'Тест'},'test','🧪 Тестовое уведомление от NetMonitor.');
  res.json({ ok:true });
});

// Webhook на любое событие (все действия аудит-лога, не только алерты устройств)
router.get('/event-webhook', requireAdmin, (req, res) => {
  const cfg=getSetting('eventWebhook')||{};
  res.json({...cfg, secret:cfg.secret?'••••••••':''});
});
router.post('/event-webhook', requireAdmin, (req, res) => {
  const inc=req.body||{}, prev=getSetting('eventWebhook')||{};
  const cfg={
    enabled:!!inc.enabled,
    url:inc.url??prev.url??'',
    events:Array.isArray(inc.events)?inc.events.filter(a=>typeof a==='string'):(prev.events||[]),
    secret:(inc.secret&&inc.secret!=='••••••••')?inc.secret:(prev.secret||'')
  };
  require('../db').setSetting('eventWebhook',cfg);
  logAudit(req,'event_webhook.update','');
  res.json({ ok:true });
});
router.post('/event-webhook/test', requireAdmin, async (req, res) => {
  const { fireEvent } = require('../services/eventWebhook');
  await fireEvent('test.event','🧪 Тестовое событие от NetMonitor.',{ username:req.session?.userId||'—', ip:req.ip });
  res.json({ ok:true });
});

// Дашборд v2 — SLA-индикатор, сводка по статусам, heat map устройств
router.get('/dashboard/widgets', requireAuth, (req, res) => {
  const days = Math.min(30, Math.max(7, Number(req.query.days) || 14));
  const now = Date.now();

  const slaFor = (windowMs) => {
    const row = db.prepare(`
      SELECT AVG(h.online) as pct, COUNT(*) as cnt
      FROM history h JOIN devices d ON d.id = h.device_id
      WHERE d.monitored = 1 AND h.ts >= ?
    `).get(now - windowMs);
    return row.cnt ? Math.round(row.pct * 1000) / 10 : null;
  };
  const sla24h = slaFor(86400 * 1000);
  const sla7d  = slaFor(7 * 86400 * 1000);

  const { statusCache } = require('../services/scheduler');
  const monitored = db.prepare('SELECT id FROM devices WHERE monitored=1').all();
  let online = 0, offline = 0, unknown = 0;
  monitored.forEach(({ id }) => {
    const s = statusCache[id];
    if (!s || s.online === null || s.online === undefined) unknown++;
    else if (s.online) online++;
    else offline++;
  });

  let openIncidents = null;
  const features = require('../db').getFeatures();
  if (features.incidents) {
    openIncidents = db.prepare("SELECT COUNT(*) as c FROM incidents WHERE end_ts IS NULL").get().c;
  }

  // Heat map: устройства под мониторингом, дневной аптайм за N дней
  const cutoff = now - days * 86400 * 1000;
  const devices = db.prepare('SELECT id,name FROM devices WHERE monitored=1 ORDER BY name').all();
  const rows = db.prepare(`
    SELECT device_id, date(ts/1000,'unixepoch') as day, AVG(online) as pct
    FROM history WHERE ts >= ? GROUP BY device_id, day
  `).all(cutoff);
  const byDevice = {};
  rows.forEach(r => { (byDevice[r.device_id] ||= {})[r.day] = Math.round(r.pct * 1000) / 10; });

  const dayList = [];
  for (let i = days - 1; i >= 0; i--) {
    dayList.push(new Date(now - i * 86400 * 1000).toISOString().slice(0, 10));
  }
  const heatmap = devices.map(d => ({
    id: d.id, name: d.name,
    days: dayList.map(day => ({ date: day, pct: byDevice[d.id]?.[day] ?? null }))
  }));

  res.json({ sla24h, sla7d, online, offline, unknown, totalMonitored: monitored.length, openIncidents, heatmap, days: dayList });
});

// Фиче-флаги
router.get('/features', requireAuth, (req, res) => res.json(require('../db').getFeatures()));
router.post('/features', requireAdmin, (req, res) => {
  const inc=req.body||{};
  const f={ snmp:!!inc.snmp, portChecks:!!inc.portChecks, incidents:!!inc.incidents, auditLog:!!inc.auditLog, traffic:!!inc.traffic };
  require('../db').setSetting('features',f);
  logAudit(req,'features.update',JSON.stringify(f));
  res.json(f);
});

// Инциденты
router.get('/incidents', requireAuth, (req, res) => {
  const limit=Math.min(1000,Number(req.query.limit)||200);
  const open=db.prepare("SELECT * FROM incidents WHERE end_ts IS NULL").all().map(i=>{
    const d=db.prepare('SELECT name FROM devices WHERE id=?').get(i.device_id);
    return {deviceId:i.device_id,deviceName:d?d.name:i.device_name,start:i.start_ts,end:null,durationSec:Math.round((Date.now()-i.start_ts)/1000),escalated:!!i.escalated};
  });
  const closed=db.prepare('SELECT * FROM incidents WHERE end_ts IS NOT NULL ORDER BY start_ts DESC LIMIT ?').all(limit)
    .map(i=>({deviceId:i.device_id,deviceName:i.device_name,start:i.start_ts,end:i.end_ts,durationSec:i.duration_sec,escalated:!!i.escalated}));
  res.json({ open, closed });
});
router.get('/incidents/stats', requireAuth, (req, res) => {
  const days=Math.min(90,Number(req.query.days)||7);
  const cutoff=Date.now()-days*86400*1000;
  const recent=db.prepare('SELECT * FROM incidents WHERE start_ts>=? AND end_ts IS NOT NULL').all(cutoff);
  const byDevice={};
  recent.forEach(i=>{ if(!byDevice[i.device_id])byDevice[i.device_id]={deviceName:i.device_name,count:0,totalDownSec:0}; byDevice[i.device_id].count++; byDevice[i.device_id].totalDownSec+=i.duration_sec||0; });
  const total=recent.length, totalDown=recent.reduce((s,i)=>s+(i.duration_sec||0),0);
  res.json({ days, totalIncidents:total, totalDownSec:totalDown, mttrSec:total?Math.round(totalDown/total):0, byDevice });
});

// Аудит-лог
function buildAuditFilter(q) {
  const where = [];
  const params = [];
  if (q.search && String(q.search).trim()) {
    const like = `%${String(q.search).trim()}%`;
    where.push('(username LIKE ? OR action LIKE ? OR details LIKE ? OR ip LIKE ?)');
    params.push(like, like, like, like);
  }
  if (q.action && String(q.action).trim()) {
    where.push('action = ?');
    params.push(String(q.action).trim());
  }
  if (q.user && String(q.user).trim()) {
    where.push('username = ?');
    params.push(String(q.user).trim());
  }
  if (q.from) {
    const ts = Date.parse(q.from);
    if (!isNaN(ts)) { where.push('ts >= ?'); params.push(ts); }
  }
  if (q.to) {
    const ts = Date.parse(q.to);
    if (!isNaN(ts)) { where.push('ts <= ?'); params.push(ts + 86399999); } // включаем весь день
  }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}
router.get('/audit-log', requireAdmin, (req, res) => {
  const page=Math.max(1,Number(req.query.page)||1);
  const pageSize=Math.min(500,Math.max(1,Number(req.query.pageSize)||50));
  const { clause, params } = buildAuditFilter(req.query);
  const total=db.prepare(`SELECT COUNT(*) as c FROM audit_log ${clause}`).get(...params).c;
  const entries=db.prepare(`SELECT * FROM audit_log ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...params,pageSize,(page-1)*pageSize);
  res.json({ entries:entries.map(e=>({t:e.ts,user:e.username,ip:e.ip,action:e.action,details:e.details})), total, page, pageSize, totalPages:Math.max(1,Math.ceil(total/pageSize)) });
});
router.get('/audit-log/actions', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map(r=>r.action));
});
router.get('/audit-log/users', requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT DISTINCT username FROM audit_log WHERE username != '' ORDER BY username").all().map(r=>r.username));
});
router.get('/audit-log/export.csv', requireAdmin, (req, res) => {
  const { clause, params } = buildAuditFilter(req.query);
  const entries=db.prepare(`SELECT * FROM audit_log ${clause} ORDER BY ts DESC`).all(...params);
  const rows=[['time','user','action','details'],...entries.map(e=>[new Date(e.ts).toISOString(),e.username,e.action,e.details])];
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="audit-log-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n'));
});

module.exports = router;
