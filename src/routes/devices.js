'use strict';
const express = require('express');
const { db, newId, slugify, csvCell, deviceRow, getSetting } = require('../db');
const { requireAuth, requireAdmin, requireOperator, logAudit } = require('../middleware/auth');

const router = express.Router();
const DEFAULT_INTERVAL = 60;
const MIN_INTERVAL     = 10;

let _ouiLookup = null;
function lookupVendor(mac) {
  try { if (!_ouiLookup) _ouiLookup = require('../services/oui').lookupVendor; return _ouiLookup(mac); } catch { return null; }
}

function parseCsvLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) { if (ch==='"'&&line[i+1]==='"'){cur+='"';i++;} else if(ch==='"')inQ=false; else cur+=ch; }
    else { if(ch==='"')inQ=true; else if(ch===','){out.push(cur);cur='';} else cur+=ch; }
  }
  out.push(cur); return out.map(s=>s.trim());
}

// Категории и площадки (Multi-site) вынесены в settings.js — там роутер
// монтируется на /api напрямую, а этот файл монтируется на /api/devices,
// так что /categories и /sites здесь были бы недостижимы как /api/categories.

// Устройства: CRUD
router.get('/', requireAuth, (req, res) =>
  res.json(db.prepare('SELECT * FROM devices ORDER BY name').all().map(r => ({ ...deviceRow(r), vendor: lookupVendor(r.mac) })))
);

router.post('/', requireOperator, (req, res) => {
  const b = req.body || {};
  const id = newId('d');
  db.prepare(`INSERT INTO devices (id,name,ip,mac,location,site_id,type,category_id,comment,is_key,monitored,check_interval,alerts_enabled,source,snmp_enabled,snmp_community,snmp_port,snmp_if_index,port_checks,x,y)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, b.name||'Без имени', b.ip||'', b.mac||'', b.location||'', b.site||null, b.type||'', b.category||'other',
    b.comment||'', b.key?1:0, b.monitored!==false?1:0,
    Math.max(MIN_INTERVAL, Number(b.checkInterval)||DEFAULT_INTERVAL),
    b.alertsEnabled!==false?1:0, b.source||'manual',
    b.snmp?.enabled?1:0, b.snmp?.community||'public', Number(b.snmp?.port)||161,
    b.snmp?.ifIndex!=null && b.snmp.ifIndex!=='' ? Number(b.snmp.ifIndex) : null,
    JSON.stringify(Array.isArray(b.portChecks)?b.portChecks:[]),
    b.x??100+Math.random()*800, b.y??100+Math.random()*500
  );
  logAudit(req, 'device.create', `${b.name} (${b.ip})`);
  res.json(deviceRow(db.prepare('SELECT * FROM devices WHERE id=?').get(id)));
});

router.put('/:id', requireOperator, (req, res) => {
  const row = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const posOnly = Object.keys(b).every(k => ['x','y'].includes(k));
  db.prepare(`UPDATE devices SET name=?,ip=?,mac=?,location=?,site_id=?,type=?,category_id=?,comment=?,is_key=?,monitored=?,check_interval=?,alerts_enabled=?,snmp_enabled=?,snmp_community=?,snmp_port=?,snmp_if_index=?,port_checks=?,x=?,y=?,updated_at=? WHERE id=?`).run(
    b.name??row.name, b.ip??row.ip, b.mac??row.mac, b.location??row.location, b.site!==undefined?(b.site||null):row.site_id, b.type??row.type,
    b.category??row.category_id, b.comment??row.comment,
    b.key!==undefined?(b.key?1:0):row.is_key,
    b.monitored!==undefined?(b.monitored?1:0):row.monitored,
    b.checkInterval!==undefined?Math.max(MIN_INTERVAL,Number(b.checkInterval)||DEFAULT_INTERVAL):row.check_interval,
    b.alertsEnabled!==undefined?(b.alertsEnabled?1:0):row.alerts_enabled,
    b.snmp?.enabled!==undefined?(b.snmp.enabled?1:0):row.snmp_enabled,
    b.snmp?.community??row.snmp_community,
    b.snmp?.port!=null?Number(b.snmp.port):row.snmp_port,
    b.snmp?.ifIndex!==undefined ? (b.snmp.ifIndex===''||b.snmp.ifIndex===null ? null : Number(b.snmp.ifIndex)) : row.snmp_if_index,
    b.portChecks!==undefined?JSON.stringify(b.portChecks):row.port_checks,
    b.x!=null?Number(b.x):row.x, b.y!=null?Number(b.y):row.y,
    Date.now(), req.params.id
  );
  if (!posOnly) logAudit(req, 'device.update', `${b.name??row.name} (${b.ip??row.ip})`);
  res.json(deviceRow(db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id)));
});

router.delete('/:id', requireOperator, (req, res) => {
  const row = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM devices WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM history WHERE device_id=?').run(req.params.id);
  logAudit(req, 'device.delete', row ? `${row.name} (${row.ip})` : req.params.id);
  res.json({ ok: true });
});

// Массовые операции
router.post('/bulk-delete', requireOperator, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)||!ids.length) return res.status(400).json({ error: 'ids_required' });
  db.transaction(() => ids.forEach(id => { db.prepare('DELETE FROM devices WHERE id=?').run(id); db.prepare('DELETE FROM history WHERE device_id=?').run(id); }))();
  logAudit(req, 'device.bulk-delete', `${ids.length} устройств`);
  res.json({ ok: true, deleted: ids.length });
});

router.post('/bulk-update', requireOperator, (req, res) => {
  const { ids, patch } = req.body || {};
  if (!Array.isArray(ids)||!ids.length) return res.status(400).json({ error: 'ids_required' });
  const sets = []; const vals = [];
  if (patch.category!==undefined)      { sets.push('category_id=?');   vals.push(patch.category); }
  if (patch.monitored!==undefined)     { sets.push('monitored=?');      vals.push(patch.monitored?1:0); }
  if (patch.alertsEnabled!==undefined) { sets.push('alerts_enabled=?'); vals.push(patch.alertsEnabled?1:0); }
  if (patch.key!==undefined)           { sets.push('is_key=?');         vals.push(patch.key?1:0); }
  if (patch.checkInterval!==undefined) { sets.push('check_interval=?'); vals.push(Math.max(MIN_INTERVAL,Number(patch.checkInterval)||DEFAULT_INTERVAL)); }
  if (patch.location!==undefined)      { sets.push('location=?');       vals.push(patch.location); }
  if (!sets.length) return res.status(400).json({ error: 'no_valid_fields' });
  ids.forEach(id => db.prepare(`UPDATE devices SET ${sets.join(',')} WHERE id=?`).run(...vals, id));
  logAudit(req, 'device.bulk-update', `${ids.length} устройств`);
  res.json({ ok: true, updated: ids.length });
});

// Экспорт CSV
router.get('/export.csv', requireAuth, (req, res) => {
  const devs = db.prepare('SELECT d.*,c.name as cat_name FROM devices d LEFT JOIN categories c ON c.id=d.category_id ORDER BY d.name').all();
  const hdr = ['name','ip','mac','location','type','category','comment','monitored','key'];
  const rows = devs.map(d => [d.name,d.ip,d.mac,d.location,d.type,d.cat_name||d.category_id,d.comment,d.monitored?'да':'нет',d.is_key?'да':'нет'].map(csvCell).join(','));
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="netmonitor-devices-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\uFEFF'+[hdr.join(','),...rows].join('\r\n'));
});

// Импорт CSV
router.post('/import-csv', requireOperator, (req, res) => {
  const { csv } = req.body || {};
  if (!csv) return res.status(400).json({ error: 'csv_required' });
  const lines = csv.split(/\r?\n/).filter(l=>l.trim());
  if (lines.length<2) return res.status(400).json({ error: 'empty_csv' });
  const header = parseCsvLine(lines[0]).map(h=>h.toLowerCase());
  if (!['name','ip'].every(r=>header.includes(r))) return res.status(400).json({ error: 'bad_header', message: 'Обязательны колонки: name, ip' });
  const validCats = new Set(db.prepare('SELECT id FROM categories').all().map(r=>r.id));
  let created=0, skipped=0;
  db.transaction(()=>{
    for(let i=1;i<lines.length;i++){
      const cols=parseCsvLine(lines[i]); const row={};
      header.forEach((h,idx)=>row[h]=cols[idx]||'');
      if(!row.name||!row.ip){skipped++;continue;}
      if(db.prepare('SELECT 1 FROM devices WHERE ip=?').get(row.ip)){skipped++;continue;}
      db.prepare(`INSERT INTO devices (id,name,ip,mac,location,type,category_id,comment,is_key,monitored,check_interval,alerts_enabled,source,x,y) VALUES (?,?,?,?,?,?,?,?,0,0,?,1,'csv-import',?,?)`).run(
        newId('d'),row.name,row.ip,(row.mac||'').toUpperCase(),row.location||'',row.type||'',
        validCats.has(row.category)?row.category:'other',row.comment||'',
        DEFAULT_INTERVAL, 100+Math.random()*800, 100+Math.random()*500
      );
      created++;
    }
  })();
  logAudit(req,'devices.import_csv',`создано ${created}, пропущено ${skipped}`);
  res.json({ ok:true, created, skipped });
});

// Отчёт аптайма CSV
router.get('/uptime.csv', requireAuth, (req, res) => {
  const now=Date.now(), cut24=now-86400*1000, cut7d=now-7*86400*1000;
  const devs=db.prepare('SELECT d.*,c.name as cat_name FROM devices d LEFT JOIN categories c ON c.id=d.category_id ORDER BY d.name').all();
  const calc=(id,cutoff)=>{ const r=db.prepare('SELECT online FROM history WHERE device_id=? AND ts>=?').all(id,cutoff); if(!r.length)return''; return(Math.round((r.filter(x=>x.online).length/r.length)*1000)/10)+'%'; };
  const rows=[['Название','IP','Категория','Мониторится','Аптайм 24ч','Аптайм 7д'],...devs.map(d=>[d.name,d.ip,d.cat_name||d.category_id,d.monitored?'да':'нет',calc(d.id,cut24),calc(d.id,cut7d)])];
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="uptime-report.csv"');
  res.send('\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n'));
});

module.exports = router;
module.exports.parseCsvLine = parseCsvLine;
