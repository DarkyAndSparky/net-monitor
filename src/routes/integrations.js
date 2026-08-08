'use strict';
const express  = require('express');
const https    = require('https');
const { RouterOSAPI } = require('node-routeros');
const { db, newId, getSetting, setSetting } = require('../db');
const { requireAuth, requireAdmin, requireOperator, logAudit } = require('../middleware/auth');

const router = express.Router();
const DEFAULT_INT = 60;

let SSHClient = null; try { SSHClient = require('ssh2').Client; } catch {}

// ══════════════════════════════════════════════════════════════════════
//  OUI
// ══════════════════════════════════════════════════════════════════════
const path = require('path');
const fs   = require('fs');
const OUI_FILE    = path.join(__dirname, '../../data/oui.json');
const OUI_URL     = 'https://standards-oui.ieee.org/oui/oui.csv';
const OUI_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

let ouiTable = {}, ouiUpdatedAt = null, ouiLastError = null;

function loadOuiFromDisk() {
  if (!fs.existsSync(OUI_FILE)) return false;
  try { const d=JSON.parse(fs.readFileSync(OUI_FILE,'utf-8')); ouiTable=d.entries||{}; ouiUpdatedAt=d.updatedAt||null; return true; } catch { return false; }
}
function parseOuiCsv(text) {
  const table={};
  for (const line of text.split('\n')) {
    const m=/^MA-L,([0-9A-Fa-f]{6}),/.exec(line.trim());
    if (!m) continue;
    const rest=line.slice(line.indexOf(m[0])+m[0].length);
    let org=rest.startsWith('"')?rest.slice(1,rest.indexOf('"',1)):rest.split(',')[0];
    org=org.trim(); if (org) table[m[1].toUpperCase()]=org;
  }
  return table;
}
async function refreshOuiDatabase() {
  try {
    const csv=await new Promise((res,rej)=>{
      https.get(OUI_URL,{timeout:20000},r=>{ if(r.statusCode!==200){r.resume();return rej(new Error(`HTTP ${r.statusCode}`));} let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d)); }).on('error',rej);
    });
    const table=parseOuiCsv(csv), count=Object.keys(table).length;
    if (count<1000) throw new Error(`Неполные данные (${count})`);
    ouiTable=table; ouiUpdatedAt=Date.now(); ouiLastError=null;
    fs.writeFileSync(OUI_FILE,JSON.stringify({updatedAt:ouiUpdatedAt,entries:ouiTable}));
    console.log(`OUI обновлена: ${count} записей`);
    return { ok:true, count };
  } catch(err) { ouiLastError=err.message; console.error('⚠ OUI:',err.message); return { ok:false, message:err.message }; }
}
function lookupVendor(mac) {
  if (!mac) return null;
  const clean=mac.replace(/[:\-.]/g,'').toUpperCase();
  return clean.length>=6?(ouiTable[clean.slice(0,6)]||null):null;
}
loadOuiFromDisk();
if (!ouiUpdatedAt||Date.now()-ouiUpdatedAt>OUI_MAX_AGE) refreshOuiDatabase();

// Экспортируем для devices.js
module.exports.lookupVendor = lookupVendor;

router.get('/oui/status', requireAuth, (req,res) =>
  res.json({ entryCount:Object.keys(ouiTable).length, updatedAt:ouiUpdatedAt, stale:!ouiUpdatedAt||Date.now()-ouiUpdatedAt>OUI_MAX_AGE, lastError:ouiLastError })
);
router.post('/oui/refresh', requireOperator, async (req,res) => {
  const r=await refreshOuiDatabase();
  logAudit(req,'oui.refresh',r.ok?`${r.count} записей`:r.message);
  r.ok?res.json(r):res.status(502).json(r);
});

// ══════════════════════════════════════════════════════════════════════
//  RouterOS helpers
// ══════════════════════════════════════════════════════════════════════
async function routerOsQuery(cfg, command) {
  const conn=new RouterOSAPI({ host:cfg.host, user:cfg.user||'admin', password:cfg.password, port:Number(cfg.port)||8728, tls:!!cfg.useTls, timeout:8 });
  await conn.connect(); const data=await conn.write(command); conn.close(); return data;
}

// ══════════════════════════════════════════════════════════════════════
//  MikroTik
// ══════════════════════════════════════════════════════════════════════
router.get('/mikrotik/routers', requireAuth, (req,res) =>
  res.json((getSetting('mikrotiks')||[]).map(r=>({...r,password:r.password?'••••••••':''})))
);
router.post('/mikrotik/routers', requireAdmin, (req,res) => {
  const list=getSetting('mikrotiks')||[];
  const router={id:newId('r'),name:req.body.name||req.body.host||'MikroTik',host:req.body.host||'',port:Number(req.body.port)||8728,user:req.body.user||'admin',password:req.body.password||'',useTls:!!req.body.useTls};
  list.push(router); setSetting('mikrotiks',list); logAudit(req,'mikrotik_router.add',router.name);
  res.json({...router,password:router.password?'••••••••':''});
});
router.put('/mikrotik/routers/:id', requireAdmin, (req,res) => {
  const list=getSetting('mikrotiks')||[], r=list.find(r=>r.id===req.params.id);
  if (!r) return res.status(404).json({error:'not_found'});
  r.name=req.body.name??r.name; r.host=req.body.host??r.host; r.port=req.body.port!=null?Number(req.body.port):r.port;
  r.user=req.body.user??r.user; r.useTls=req.body.useTls!=null?!!req.body.useTls:r.useTls;
  if (req.body.password&&req.body.password!=='••••••••') r.password=req.body.password;
  setSetting('mikrotiks',list); res.json({...r,password:r.password?'••••••••':''});
});
router.delete('/mikrotik/routers/:id', requireAdmin, (req,res) => {
  setSetting('mikrotiks',(getSetting('mikrotiks')||[]).filter(r=>r.id!==req.params.id));
  logAudit(req,'mikrotik_router.delete',req.params.id); res.json({ok:true});
});

async function importFromRouter(cfg) {
  if (!cfg.host||!cfg.password) { const e=new Error('Заполните адрес и пароль'); e.code='not_configured'; throw e; }
  const leases=await routerOsQuery(cfg,'/ip/dhcp-server/lease/print');
  let created=0,updated=0;
  db.transaction(()=>{
    leases.forEach(l=>{
      const mac=(l['mac-address']||'').toUpperCase(), ip=l.address||'', name=l['host-name']||l.comment||ip||'DHCP-клиент';
      if (!mac&&!ip) return;
      const ex=db.prepare('SELECT * FROM devices WHERE (mac=? AND mac!="") OR ip=?').get(mac,ip);
      if (ex) { db.prepare('UPDATE devices SET ip=?,mac=?,updated_at=? WHERE id=?').run(ip||ex.ip,mac||ex.mac,Date.now(),ex.id); updated++; }
      else { db.prepare(`INSERT INTO devices (id,name,ip,mac,location,type,category_id,comment,is_key,monitored,check_interval,alerts_enabled,source,x,y) VALUES (?,?,?,?,?,?,?,?,0,0,?,1,?,?,?)`).run(newId('d'),name,ip,mac,'','DHCP Client','workstation',`Из MikroTik "${cfg.name}"`,DEFAULT_INT,'mikrotik:'+cfg.name,100+Math.random()*800,100+Math.random()*500); created++; }
    });
  })();
  return { created, updated, total:leases.length };
}
router.post('/mikrotik/routers/:id/import', requireOperator, async (req,res) => {
  const cfg=(getSetting('mikrotiks')||[]).find(r=>r.id===req.params.id);
  if (!cfg) return res.status(404).json({error:'not_found'});
  try { res.json({ok:true,...await importFromRouter(cfg)}); } catch(err) { res.status(500).json({error:err.code||'connection_failed',message:err.message}); }
});
router.post('/mikrotik/import-all', requireOperator, async (req,res) => {
  const results=[];
  for (const r of getSetting('mikrotiks')||[]) {
    try { results.push({router:r.name,ok:true,...await importFromRouter(r)}); }
    catch(err) { results.push({router:r.name,ok:false,message:err.message}); }
  }
  res.json({results});
});
router.post('/mikrotik/routers/:id/arp', requireOperator, async (req,res) => {
  const cfg=(getSetting('mikrotiks')||[]).find(r=>r.id===req.params.id);
  if (!cfg) return res.status(404).json({error:'not_found'});
  try {
    const entries=await routerOsQuery(cfg,'/ip/arp/print');
    res.json({results:entries.filter(e=>e.address&&e['mac-address']).map(e=>{
      const mac=e['mac-address'].toUpperCase();
      const ex=db.prepare('SELECT id,name FROM devices WHERE mac=? OR ip=?').get(mac,e.address);
      return {ip:e.address,mac,interface:e.interface||'',existingDeviceId:ex?.id||null,existingDeviceName:ex?.name||null};
    })});
  } catch(err) { res.status(500).json({error:'connection_failed',message:err.message}); }
});
router.post('/mikrotik/routers/:id/neighbors', requireOperator, async (req,res) => {
  const cfg=(getSetting('mikrotiks')||[]).find(r=>r.id===req.params.id);
  if (!cfg) return res.status(404).json({error:'not_found'});
  try {
    const entries=await routerOsQuery(cfg,'/ip/neighbor/print');
    res.json({results:entries.map(e=>{
      const mac=(e['mac-address']||'').toUpperCase(), ip=e.address||'';
      const ex=db.prepare('SELECT id,name FROM devices WHERE (mac=? AND mac!="") OR (ip=? AND ip!="")').get(mac,ip);
      return {identity:e.identity||'(без имени)',ip,mac,interface:e.interface||'',platform:e.platform||'',board:e.board||'',existingDeviceId:ex?.id||null,existingDeviceName:ex?.name||null};
    })});
  } catch(err) { res.status(500).json({error:'connection_failed',message:err.message}); }
});

// ══════════════════════════════════════════════════════════════════════
//  UniFi
// ══════════════════════════════════════════════════════════════════════
function unifiRequest(options, body) {
  return new Promise((resolve,reject)=>{
    const b=body?JSON.stringify(body):null;
    const req=https.request({...options,rejectUnauthorized:false,headers:{'Content-Type':'application/json',...(b?{'Content-Length':Buffer.byteLength(b)}:{}),...options.headers}},(res)=>{
      let data=''; res.on('data',c=>data+=c); res.on('end',()=>{ let parsed=null; try{parsed=data?JSON.parse(data):null}catch{}; resolve({statusCode:res.statusCode,headers:res.headers,body:parsed,raw:data}); });
    });
    req.on('error',reject); req.setTimeout(10000,()=>req.destroy(new Error('Таймаут')));
    if (b) req.write(b); req.end();
  });
}
async function unifiLogin(ctrl) {
  const r=await unifiRequest({hostname:ctrl.host,port:ctrl.port||443,path:ctrl.unifiOS?'/api/auth/login':'/api/login',method:'POST'},{username:ctrl.user,password:ctrl.password});
  if (r.statusCode<200||r.statusCode>=300) { const e=new Error(`HTTP ${r.statusCode} — проверьте логин/пароль`); e.code='unifi_login_failed'; throw e; }
  const cookies=(r.headers['set-cookie']||[]);
  if (!cookies.length) { const e=new Error('Нет cookie сессии'); e.code='unifi_no_session'; throw e; }
  return {host:ctrl.host,port:ctrl.port||443,cookieHeader:cookies.map(c=>c.split(';')[0]).join('; '),csrfToken:r.headers['x-csrf-token']||r.headers['x-updated-csrf-token']};
}
async function unifiGet(ctrl,session,apiPath) {
  const prefix=ctrl.unifiOS?'/proxy/network':'', site=ctrl.site||'default';
  const headers={'Cookie':session.cookieHeader}; if(session.csrfToken)headers['X-CSRF-Token']=session.csrfToken;
  const r=await unifiRequest({hostname:session.host,port:session.port,path:`${prefix}/api/s/${site}${apiPath}`,method:'GET',headers});
  if (r.statusCode<200||r.statusCode>=300){const e=new Error(`UniFi API HTTP ${r.statusCode}`);e.code='unifi_api_failed';throw e;}
  return r.body?.data||[];
}
async function importFromUnifi(ctrl) {
  const session=await unifiLogin(ctrl);
  const [infra,clients]=await Promise.all([unifiGet(ctrl,session,'/stat/device'),unifiGet(ctrl,session,'/stat/sta')]);
  let created=0,updated=0;
  db.transaction(()=>{
    const upsert=(mac,ip,name,type,comment)=>{
      if (!mac&&!ip) return; mac=(mac||'').toUpperCase();
      const ex=db.prepare('SELECT * FROM devices WHERE (mac=? AND mac!="") OR (ip=? AND ip!="")').get(mac,ip);
      if (ex) { db.prepare('UPDATE devices SET ip=?,mac=?,updated_at=? WHERE id=?').run(ip||ex.ip,mac||ex.mac,Date.now(),ex.id); updated++; }
      else { db.prepare(`INSERT INTO devices (id,name,ip,mac,location,type,category_id,comment,is_key,monitored,check_interval,alerts_enabled,source,x,y) VALUES (?,?,?,?,?,?,?,?,0,0,?,1,?,?,?)`).run(newId('d'),name||ip||mac,ip||'',mac,'',type||'UniFi',['uap','usw','ugw','udm'].includes((type||'').toLowerCase())?'network':'workstation',comment||`Из UniFi "${ctrl.name}"`,DEFAULT_INT,'unifi:'+ctrl.name,100+Math.random()*800,100+Math.random()*500); created++; }
    };
    infra.forEach(d=>upsert(d.mac,d.ip,d.name||d.model,d.type,`Модель: ${d.model||'—'}`));
    clients.forEach(c=>upsert(c.mac,c.ip,c.hostname||c.name,c.is_wired?'Wired Client':'Wi-Fi Client',''));
  })();
  return { created, updated, total:infra.length+clients.length };
}
router.get('/unifi/controllers', requireAuth, (req,res) => res.json((getSetting('unifiControllers')||[]).map(c=>({...c,password:c.password?'••••••••':''}))));
router.post('/unifi/controllers', requireAdmin, (req,res) => {
  const list=getSetting('unifiControllers')||[];
  const ctrl={id:newId('u'),name:req.body.name||req.body.host||'UniFi',host:req.body.host||'',port:Number(req.body.port)||443,user:req.body.user||'',password:req.body.password||'',site:req.body.site||'default',unifiOS:!!req.body.unifiOS};
  list.push(ctrl); setSetting('unifiControllers',list); logAudit(req,'unifi.add',ctrl.name);
  res.json({...ctrl,password:ctrl.password?'••••••••':''});
});
router.delete('/unifi/controllers/:id', requireAdmin, (req,res) => {
  setSetting('unifiControllers',(getSetting('unifiControllers')||[]).filter(c=>c.id!==req.params.id));
  logAudit(req,'unifi.delete',req.params.id); res.json({ok:true});
});
router.post('/unifi/controllers/:id/import', requireOperator, async (req,res) => {
  const ctrl=(getSetting('unifiControllers')||[]).find(c=>c.id===req.params.id);
  if (!ctrl) return res.status(404).json({error:'not_found'});
  try { const r=await importFromUnifi(ctrl); logAudit(req,'unifi.import',`${ctrl.name}: +${r.created}`); res.json({ok:true,...r}); }
  catch(err) { res.status(500).json({error:err.code||'connection_failed',message:err.message}); }
});

// ══════════════════════════════════════════════════════════════════════
//  Cisco SSH
// ══════════════════════════════════════════════════════════════════════
function sshExec(cfg, command) {
  return new Promise((resolve,reject)=>{
    if (!SSHClient) return reject(new Error('Пакет ssh2 не установлен'));
    const conn=new SSHClient(); let output='';
    const timer=setTimeout(()=>{conn.end();reject(new Error('Таймаут SSH'));},12000);
    conn.on('ready',()=>conn.exec(command,(err,stream)=>{
      if(err){clearTimeout(timer);conn.end();return reject(err);}
      stream.on('data',c=>output+=c.toString());
      stream.on('close',()=>{clearTimeout(timer);conn.end();resolve(output);});
      stream.stderr.on('data',()=>{});
    }));
    conn.on('error',err=>{clearTimeout(timer);reject(err);});
    conn.connect({host:cfg.host,port:Number(cfg.port)||22,username:cfg.user,password:cfg.password,readyTimeout:10000,
      algorithms:{kex:['diffie-hellman-group14-sha1','diffie-hellman-group-exchange-sha256','ecdh-sha2-nistp256'],cipher:['aes128-cbc','aes128-ctr','aes256-ctr'],serverHostKey:['ssh-rsa','ssh-dss','ecdsa-sha2-nistp256']}});
  });
}
function parseCiscoArp(text) {
  const results=[]; const re=/Internet\s+(\d{1,3}(?:\.\d{1,3}){3})\s+\S+\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+ARPA\s+(\S+)/g; let m;
  while((m=re.exec(text))){const hex=m[2].replace(/\./g,'');results.push({ip:m[1],mac:hex.match(/.{1,2}/g).join(':').toUpperCase(),interface:m[3]});}
  return results;
}
async function importFromCisco(cfg) {
  const entries=parseCiscoArp(await sshExec(cfg,'show ip arp'));
  if (!entries.length){const e=new Error('Не удалось разобрать ARP');e.code='parse_failed';throw e;}
  let created=0,updated=0;
  db.transaction(()=>entries.forEach(e=>{
    const ex=db.prepare('SELECT * FROM devices WHERE mac=? OR ip=?').get(e.mac,e.ip);
    if(ex){db.prepare('UPDATE devices SET ip=?,mac=?,updated_at=? WHERE id=?').run(e.ip||ex.ip,e.mac||ex.mac,Date.now(),ex.id);updated++;}
    else{db.prepare(`INSERT INTO devices (id,name,ip,mac,location,type,category_id,comment,is_key,monitored,check_interval,alerts_enabled,source,x,y) VALUES (?,?,?,?,?,?,?,?,0,0,?,1,?,?,?)`).run(newId('d'),e.ip,e.ip,e.mac,'','DHCP Client','workstation',`Из Cisco "${cfg.name}" (${e.interface})`,DEFAULT_INT,'cisco:'+cfg.name,100+Math.random()*800,100+Math.random()*500);created++;}
  }))();
  return { created, updated, total:entries.length };
}
router.get('/cisco/devices', requireAuth, (req,res) => res.json((getSetting('ciscoDevices')||[]).map(c=>({...c,password:c.password?'••••••••':''}))));
router.post('/cisco/devices', requireAdmin, (req,res) => {
  const list=getSetting('ciscoDevices')||[];
  const cfg={id:newId('c'),name:req.body.name||req.body.host||'Cisco',host:req.body.host||'',port:Number(req.body.port)||22,user:req.body.user||'',password:req.body.password||''};
  list.push(cfg); setSetting('ciscoDevices',list); logAudit(req,'cisco.add',cfg.name);
  res.json({...cfg,password:cfg.password?'••••••••':''});
});
router.delete('/cisco/devices/:id', requireAdmin, (req,res) => {
  setSetting('ciscoDevices',(getSetting('ciscoDevices')||[]).filter(c=>c.id!==req.params.id));
  logAudit(req,'cisco.delete',req.params.id); res.json({ok:true});
});
router.post('/cisco/devices/:id/import', requireOperator, async (req,res) => {
  const cfg=(getSetting('ciscoDevices')||[]).find(c=>c.id===req.params.id);
  if (!cfg) return res.status(404).json({error:'not_found'});
  try{const r=await importFromCisco(cfg);logAudit(req,'cisco.import',`${cfg.name}: +${r.created}`);res.json({ok:true,...r});}
  catch(err){res.status(500).json({error:err.code||'connection_failed',message:err.message});}
});

// Экспортируем routerOsQuery для discovery
module.exports = router;
module.exports.routerOsQuery = routerOsQuery;
module.exports.lookupVendor  = lookupVendor;
