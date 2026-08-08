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
  res.json({...cfg, telegram:{...cfg.telegram, botToken:cfg.telegram?.botToken?'••••••••':''}});
});
router.post('/alert-settings', requireOperator, (req, res) => {
  const inc=req.body||{}, prev=getSetting('alerting')||{};
  const cfg={
    enabled:!!inc.enabled, failThreshold:Math.max(1,Number(inc.failThreshold)||2),
    repeatMinutes:Math.max(0,Number(inc.repeatMinutes)||0), notifyOnRecovery:inc.notifyOnRecovery!=null?!!inc.notifyOnRecovery:true,
    telegram:{ enabled:!!inc.telegram?.enabled, chatId:inc.telegram?.chatId??prev.telegram?.chatId??'', botToken:(inc.telegram?.botToken&&inc.telegram.botToken!=='••••••••')?inc.telegram.botToken:(prev.telegram?.botToken||'') },
    webhook:{ enabled:!!inc.webhook?.enabled, url:inc.webhook?.url??prev.webhook?.url??'' },
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

// Фиче-флаги
router.get('/features', requireAuth, (req, res) => res.json(require('../db').getFeatures()));
router.post('/features', requireAdmin, (req, res) => {
  const inc=req.body||{};
  const f={ snmp:!!inc.snmp, portChecks:!!inc.portChecks, incidents:!!inc.incidents, auditLog:!!inc.auditLog };
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
router.get('/audit-log', requireAdmin, (req, res) => {
  const page=Math.max(1,Number(req.query.page)||1);
  const pageSize=Math.min(500,Math.max(1,Number(req.query.pageSize)||50));
  const total=db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c;
  const entries=db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ? OFFSET ?').all(pageSize,(page-1)*pageSize);
  res.json({ entries:entries.map(e=>({t:e.ts,user:e.username,ip:e.ip,action:e.action,details:e.details})), total, page, pageSize, totalPages:Math.max(1,Math.ceil(total/pageSize)) });
});
router.get('/audit-log/export.csv', requireAdmin, (req, res) => {
  const entries=db.prepare('SELECT * FROM audit_log ORDER BY ts DESC').all();
  const rows=[['time','user','action','details'],...entries.map(e=>[new Date(e.ts).toISOString(),e.username,e.action,e.details])];
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="audit-log-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n'));
});

module.exports = router;
