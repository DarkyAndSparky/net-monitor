'use strict';
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { db, newId, slugify, deviceRow, getSetting, setSetting, getFeatures, hashPassword } = require('../db');
const { requireAuth, requireAdmin, requireOperator, logAudit } = require('../middleware/auth');

const router = express.Router();

const DATA_DIR    = path.join(__dirname, '../../data');
const BRANDING_DIR= path.join(DATA_DIR, 'branding');
const LOGO_MIME   = { 'image/svg+xml':'svg', 'image/png':'png', 'image/jpeg':'jpg' };
const LOGO_CT     = { svg:'image/svg+xml', png:'image/png', jpg:'image/jpeg' };
const DEFAULT_INT = 60;

// ── Категории устройств ──────────────────────────────────────────────
// (перенесено сюда из devices.js: этот роутер монтируется на /api напрямую,
// а devices.js — на /api/devices, где /categories был бы недостижим
// как /api/categories, что и вызывал фронтенд)
router.get('/categories', requireAuth, (req, res) =>
  res.json(db.prepare('SELECT * FROM categories ORDER BY sort,name').all())
);
router.post('/categories', requireOperator, (req, res) => {
  const { categories } = req.body || {};
  if (!Array.isArray(categories) || !categories.length)
    return res.status(400).json({ error: 'categories_required', message: 'Нужна хотя бы одна категория' });
  const newIds = new Set();
  for (const c of categories) {
    if (!c.name?.trim()) return res.status(400).json({ error: 'invalid_category', message: 'У категории должно быть название' });
    if (c.color && !/^#[0-9a-fA-F]{6}$/.test(c.color)) return res.status(400).json({ error: 'invalid_color' });
    const id = c.id || slugify(c.name);
    if (newIds.has(id)) return res.status(400).json({ error: 'duplicate_id' });
    newIds.add(id);
  }
  const usedIds = new Set(db.prepare('SELECT DISTINCT category_id FROM devices').all().map(r => r.category_id));
  const removedUsed = [...usedIds].filter(id => !newIds.has(id));
  if (removedUsed.length) return res.status(400).json({ error: 'category_in_use', message: `Используется устройствами: ${removedUsed.join(', ')}` });
  db.transaction(() => {
    db.prepare('DELETE FROM categories').run();
    categories.forEach((c, i) => db.prepare('INSERT INTO categories (id,name,color,sort) VALUES (?,?,?,?)').run(c.id||slugify(c.name), c.name.trim(), c.color||'#6b7280', i));
  })();
  logAudit(req, 'categories.update', `${categories.length} категорий`);
  res.json(db.prepare('SELECT * FROM categories ORDER BY sort').all());
});

// ── Площадки (Multi-site) ────────────────────────────────────────────
router.get('/sites', requireAuth, (req, res) =>
  res.json(db.prepare('SELECT * FROM sites ORDER BY sort,name').all())
);
router.post('/sites', requireOperator, (req, res) => {
  const { sites } = req.body || {};
  if (!Array.isArray(sites))
    return res.status(400).json({ error: 'sites_required', message: 'Ожидался список площадок' });
  const newIds = new Set();
  for (const s of sites) {
    if (!s.name?.trim()) return res.status(400).json({ error: 'invalid_site', message: 'У площадки должно быть название' });
    if (s.color && !/^#[0-9a-fA-F]{6}$/.test(s.color)) return res.status(400).json({ error: 'invalid_color' });
    const id = s.id || slugify(s.name);
    if (newIds.has(id)) return res.status(400).json({ error: 'duplicate_id' });
    newIds.add(id);
  }
  const usedIds = new Set(db.prepare("SELECT DISTINCT site_id FROM devices WHERE site_id IS NOT NULL AND site_id!=''").all().map(r => r.site_id));
  const removedUsed = [...usedIds].filter(id => !newIds.has(id));
  if (removedUsed.length) return res.status(400).json({ error: 'site_in_use', message: `Площадка используется устройствами: ${removedUsed.join(', ')}` });
  db.transaction(() => {
    db.prepare('DELETE FROM sites').run();
    sites.forEach((s, i) => db.prepare('INSERT INTO sites (id,name,color,address,sort) VALUES (?,?,?,?,?)').run(s.id||slugify(s.name), s.name.trim(), s.color||'#6b7280', s.address||'', i));
  })();
  logAudit(req, 'sites.update', `${sites.length} площадок`);
  res.json(db.prepare('SELECT * FROM sites ORDER BY sort').all());
});

// ── Брендинг ──────────────────────────────────────────────────────────
router.get('/branding', (req, res) => {
  res.json(getSetting('branding') || { appName:'NetMonitor', accentColor:'#3b82f6', defaultTheme:'dark' });
});
router.post('/branding', requireAdmin, (req, res) => {
  const {appName,accentColor,defaultTheme}=req.body||{};
  if (!appName?.trim()||appName.trim().length>40) return res.status(400).json({error:'invalid_name'});
  if (accentColor&&!/^#[0-9a-fA-F]{6}$/.test(accentColor)) return res.status(400).json({error:'invalid_color'});
  const branding={appName:appName.trim(),accentColor:accentColor||(getSetting('branding')?.accentColor||'#3b82f6'),defaultTheme:defaultTheme==='light'?'light':'dark'};
  setSetting('branding',branding);
  logAudit(req,'branding.update',`${branding.appName}, ${branding.accentColor}`);
  res.json(branding);
});
router.post('/branding/logo', requireAdmin, (req, res) => {
  const m=/^data:([^;]+);base64,(.+)$/.exec(req.body?.dataUrl||'');
  if (!m) return res.status(400).json({error:'invalid_file'});
  const ext=LOGO_MIME[m[1]]; if (!ext) return res.status(400).json({error:'unsupported_type'});
  const buf=Buffer.from(m[2],'base64');
  if (buf.length>1024*1024) return res.status(400).json({error:'too_large'});
  if (ext==='svg'&&(/<script/i.test(buf.toString())||/on[a-z]+\s*=/i.test(buf.toString()))) return res.status(400).json({error:'unsafe_svg'});
  if (!fs.existsSync(BRANDING_DIR)) fs.mkdirSync(BRANDING_DIR,{recursive:true});
  Object.values(LOGO_MIME).forEach(e=>{const p=path.join(BRANDING_DIR,`logo.${e}`);if(fs.existsSync(p))fs.unlinkSync(p);});
  fs.writeFileSync(path.join(BRANDING_DIR,`logo.${ext}`),buf);
  const br=getSetting('branding')||{}; br.logoExt=ext; setSetting('branding',br);
  logAudit(req,'branding.logo-upload',ext); res.json({ok:true});
});
router.delete('/branding/logo', requireAdmin, (req, res) => {
  Object.values(LOGO_MIME).forEach(e=>{const p=path.join(BRANDING_DIR,`logo.${e}`);if(fs.existsSync(p))fs.unlinkSync(p);});
  const br=getSetting('branding')||{}; delete br.logoExt; setSetting('branding',br);
  logAudit(req,'branding.logo-reset',''); res.json({ok:true});
});
router.get('/branding/logo', (req, res) => {
  const ext=getSetting('branding')?.logoExt;
  if (ext&&fs.existsSync(path.join(BRANDING_DIR,`logo.${ext}`))) {
    res.setHeader('Content-Type',LOGO_CT[ext]); res.setHeader('Cache-Control','no-cache');
    return res.sendFile(path.join(BRANDING_DIR,`logo.${ext}`));
  }
  res.setHeader('Content-Type','image/svg+xml');
  res.sendFile(path.join(__dirname,'../../public/favicon.svg'));
});

// ── Бэкап / восстановление ────────────────────────────────────────────
router.get('/backup', requireAdmin, (req, res) => {
  const devices  = db.prepare('SELECT * FROM devices').all().map(deviceRow);
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort').all();
  const users    = db.prepare('SELECT username,role FROM users').all();
  const edges    = db.prepare('SELECT * FROM topology_edges').all();
  const incidents= db.prepare('SELECT * FROM incidents ORDER BY start_ts').all();
  const audit    = db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 5000').all();

  const bundle = {
    version: 2,
    exportedAt: new Date().toISOString(),
    devices: { devices, categories },
    users: { users },
    settings: {
      mikrotiks:        getSetting('mikrotiks')||[],
      unifiControllers: getSetting('unifiControllers')||[],
      ciscoDevices:     getSetting('ciscoDevices')||[],
      alerting:         getSetting('alerting')||{},
      features:         getFeatures(),
      branding:         getSetting('branding')||{},
      subnetRules:      getSetting('subnetRules')||[],
    },
    topology: { edges: edges.map(e=>({id:e.id,from:e.from_id,to:e.to_id,label:e.label,interface:e.iface,manual:!!e.manual,viaRouterId:e.via_router_id})) },
    incidents: { closed: incidents.filter(i=>i.end_ts).map(i=>({deviceId:i.device_id,deviceName:i.device_name,start:i.start_ts,end:i.end_ts,durationSec:i.duration_sec,escalated:!!i.escalated})) },
    audit: { entries: audit.map(e=>({t:e.ts,user:e.username,ip:e.ip,action:e.action,details:e.details})) },
  };
  logAudit(req,'backup.download','');
  res.setHeader('Content-Disposition',`attachment; filename="netmonitor-backup-${new Date().toISOString().slice(0,10)}.json"`);
  res.json(bundle);
});

router.post('/backup/restore', requireAdmin, (req, res) => {
  const b=req.body||{};
  if (!b.devices||!b.users||!b.settings) return res.status(400).json({error:'invalid_backup',message:'Файл не похож на бэкап NetMonitor'});
  try {
    db.transaction(()=>{
      // Устройства и категории
      db.prepare('DELETE FROM devices').run();
      db.prepare('DELETE FROM categories').run();
      const defCats=[{id:'network',name:'Сетевое оборудование',color:'#3b82f6',sort:1},{id:'server',name:'Серверы',color:'#8b5cf6',sort:2},{id:'workstation',name:'Пользовательские устройства',color:'#10b981',sort:3},{id:'cctv',name:'Видеонаблюдение',color:'#f59e0b',sort:4},{id:'other',name:'Прочее',color:'#6b7280',sort:5}];
      (b.devices.categories||defCats).forEach((c,i)=>db.prepare('INSERT OR REPLACE INTO categories (id,name,color,sort) VALUES (?,?,?,?)').run(c.id,c.name,c.color||'#6b7280',i));
      (b.devices.devices||[]).forEach(d=>{
        db.prepare(`INSERT OR REPLACE INTO devices (id,name,ip,mac,location,type,category_id,comment,is_key,monitored,check_interval,alerts_enabled,source,snmp_enabled,snmp_community,snmp_port,port_checks,x,y) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          d.id,d.name||'Без имени',d.ip||'',d.mac||'',d.location||'',d.type||'',d.category||'other',d.comment||'',
          d.key?1:0,d.monitored!==false?1:0,d.checkInterval||DEFAULT_INT,d.alertsEnabled!==false?1:0,d.source||'restore',
          d.snmp?.enabled?1:0,d.snmp?.community||'public',d.snmp?.port||161,
          JSON.stringify(d.portChecks||[]),d.x||300,d.y||300
        );
      });
      // Настройки
      ['mikrotiks','unifiControllers','ciscoDevices','alerting','features','branding','subnetRules'].forEach(k=>{if(b.settings[k]!=null)setSetting(k,b.settings[k]);});
      // Топология
      db.prepare('DELETE FROM topology_edges').run();
      (b.topology?.edges||[]).forEach(e=>db.prepare('INSERT OR IGNORE INTO topology_edges (id,from_id,to_id,label,iface,manual,via_router_id) VALUES (?,?,?,?,?,?,?)').run(e.id||newId('e'),e.from,e.to,e.label||'',e.interface||'',e.manual?1:0,e.viaRouterId||null));
    })();
    logAudit(req,'backup.restore',`exportedAt=${b.exportedAt||'?'}`);
    res.json({ok:true});
  } catch(err) { res.status(500).json({error:'restore_failed',message:err.message}); }
});

// ══════════════════════════════════════════════════════════════════════
//  LDAP/AD-АУТЕНТИФИКАЦИЯ
// ══════════════════════════════════════════════════════════════════════
router.get('/ldap', requireAdmin, (req, res) => {
  const cfg = getSetting('ldap') || {};
  res.json({ ...cfg, bindPassword: cfg.bindPassword ? '••••••••' : '' });
});

router.post('/ldap', requireAdmin, (req, res) => {
  const inc = req.body || {}, prev = getSetting('ldap') || {};
  const cfg = {
    enabled: !!inc.enabled,
    url: inc.url ?? prev.url ?? '',
    bindDN: inc.bindDN ?? prev.bindDN ?? '',
    bindPassword: (inc.bindPassword && inc.bindPassword !== '••••••••') ? inc.bindPassword : (prev.bindPassword || ''),
    baseDN: inc.baseDN ?? prev.baseDN ?? '',
    userFilter: inc.userFilter ?? prev.userFilter ?? '(sAMAccountName={{username}})',
    defaultRole: ['admin', 'operator', 'viewer'].includes(inc.defaultRole) ? inc.defaultRole : (prev.defaultRole || 'viewer'),
    roleMapping: Array.isArray(inc.roleMapping)
      ? inc.roleMapping.filter(r => r?.group && ['admin', 'operator', 'viewer'].includes(r.role)).map(r => ({ group: String(r.group), role: r.role }))
      : (prev.roleMapping || []),
    rejectUnauthorized: inc.rejectUnauthorized ?? prev.rejectUnauthorized ?? true
  };
  setSetting('ldap', cfg);
  logAudit(req, 'ldap.update', '');
  res.json({ ok: true });
});

router.post('/ldap/test', requireAdmin, async (req, res) => {
  const cfg = req.body?.useSaved ? (getSetting('ldap') || {}) : req.body;
  if (req.body?.useSaved) {
    const saved = getSetting('ldap') || {};
    if (!saved.bindPassword) return res.status(400).json({ ok: false, error: 'Пароль сервисной учётной записи не сохранён' });
  } else if (cfg.bindPassword === '••••••••') {
    cfg.bindPassword = (getSetting('ldap') || {}).bindPassword || '';
  }
  const { testConnection } = require('../services/ldap');
  const result = await testConnection(cfg);
  res.json(result);
});

module.exports = router;
