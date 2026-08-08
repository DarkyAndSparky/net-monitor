'use strict';
const express = require('express');
const os      = require('os');
const dns     = require('dns').promises;
const { db, newId, getSetting, setSetting } = require('../db');
const { requireAuth, requireOperator, logAudit } = require('../middleware/auth');
const { pingHost } = require('../services/scheduler');
const { routerOsQuery } = require('./integrations');

const router = express.Router();
const DEFAULT_INT = 60;

// ── IP утилиты ────────────────────────────────────────────────────────
function cidrPrefixFromNetmask(mask) {
  return mask.split('.').reduce((b,o)=>b+(parseInt(o,10).toString(2).match(/1/g)||[]).length,0);
}
function ipToInt(ip)  { return ip.split('.').reduce((a,o)=>(a<<8)+parseInt(o,10),0)>>>0; }
function intToIp(n)   { return [n>>>24&255,n>>>16&255,n>>>8&255,n&255].join('.'); }
function cidrBase(ip,prefix) { return intToIp(ipToInt(ip)&(prefix===0?0:(~0<<(32-prefix))>>>0)); }

// ── Локальные подсети сервера ──────────────────────────────────────────
router.get('/local-subnets', requireAuth, (req, res) => {
  const subnets = [];
  Object.values(os.networkInterfaces()).forEach(list=>(list||[]).forEach(i=>{
    if(i.family==='IPv4'&&!i.internal){const p=cidrPrefixFromNetmask(i.netmask);subnets.push(`${cidrBase(i.address,p)}/${p}`);}
  }));
  res.json([...new Set(subnets)]);
});

// ── Ping-sweep ────────────────────────────────────────────────────────
router.post('/scan', requireOperator, async (req, res) => {
  const cidr=(req.body?.cidr||'').trim();
  const m=/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!m) return res.status(400).json({error:'invalid_cidr',message:'Укажите диапазон в формате 192.168.1.0/24'});
  const prefix=parseInt(m[2],10);
  if (prefix<24||prefix>30) return res.status(400).json({error:'range_too_big',message:'Поддерживается /24–/30'});
  const base=ipToInt(cidrBase(m[1],prefix)), count=Math.pow(2,32-prefix);
  const ips=[]; for(let i=1;i<count-1;i++) ips.push(intToIp(base+i));
  const known=new Set(db.prepare('SELECT ip FROM devices WHERE ip!=""').all().map(r=>r.ip));
  const results=[]; const CONC=16;
  for (let i=0;i<ips.length;i+=CONC) {
    const batch=ips.slice(i,i+CONC);
    const br=await Promise.all(batch.map(async ip=>{
      if (!await pingHost(ip)) return null;
      let hostname=''; try{const n=await dns.reverse(ip);hostname=n[0]||'';}catch{}
      return {ip,hostname,inRegistry:known.has(ip)};
    }));
    results.push(...br.filter(Boolean));
  }
  res.json({scanned:ips.length,found:results.length,results});
});

// ── Добавить найденные устройства ─────────────────────────────────────
router.post('/add-bulk', requireOperator, (req, res) => {
  const {items}=req.body||{};
  if (!Array.isArray(items)) return res.status(400).json({error:'items_required'});
  let created=0;
  db.transaction(()=>items.forEach(it=>{
    if (!it.ip&&!it.mac) return;
    if (db.prepare('SELECT 1 FROM devices WHERE ip=? OR (mac=? AND mac!="")').get(it.ip||'_',(it.mac||'').toUpperCase())) return;
    db.prepare(`INSERT INTO devices (id,name,ip,mac,location,type,category_id,comment,is_key,monitored,check_interval,alerts_enabled,source,x,y) VALUES (?,?,?,?,?,?,?,?,0,0,?,1,?,?,?)`).run(
      newId('d'),it.name||it.ip||'Новое устройство',it.ip||'',(it.mac||'').toUpperCase(),'',it.type||'',it.category||'other',
      'Добавлено через обнаружение сети',DEFAULT_INT,it.source||'discovery',100+Math.random()*800,100+Math.random()*500
    );
    created++;
  }))();
  res.json({ok:true,created});
});

// ══════════════════════════════════════════════════════════════════════
//  ТОПОЛОГИЯ
// ══════════════════════════════════════════════════════════════════════
router.get('/topology', requireAuth, (req, res) => {
  const edges=db.prepare('SELECT * FROM topology_edges').all().map(e=>({
    id:e.id, from:e.from_id, to:e.to_id, label:e.label,
    interface:e.iface, manual:!!e.manual, viaRouterId:e.via_router_id
  }));
  res.json({edges});
});

// Ручное добавление связи
router.post('/topology/edges', requireOperator, (req, res) => {
  const {from,to,label}=req.body||{};
  if (!from||!to||from===to) return res.status(400).json({error:'invalid_edge',message:'Нужны два разных устройства'});
  if (!db.prepare('SELECT 1 FROM devices WHERE id=?').get(from)||!db.prepare('SELECT 1 FROM devices WHERE id=?').get(to))
    return res.status(404).json({error:'device_not_found'});
  const id=newId('e');
  db.prepare('INSERT INTO topology_edges (id,from_id,to_id,label,manual) VALUES (?,?,?,?,1)').run(id,from,to,label||'');
  res.json({id,from,to,label:label||'',manual:true});
});

router.put('/topology/edges/:id', requireOperator, (req, res) => {
  const e=db.prepare('SELECT * FROM topology_edges WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({error:'not_found'});
  if (req.body.label!=null) db.prepare('UPDATE topology_edges SET label=? WHERE id=?').run(req.body.label,req.params.id);
  res.json({id:e.id,from:e.from_id,to:e.to_id,label:req.body.label??e.label});
});

router.delete('/topology/edges/:id', requireOperator, (req, res) => {
  db.prepare('DELETE FROM topology_edges WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

// Автопостроение топологии через MikroTik
router.post('/topology/build/:routerId', requireOperator, async (req, res) => {
  const cfg=(getSetting('mikrotiks')||[]).find(r=>r.id===req.params.routerId);
  if (!cfg) return res.status(404).json({error:'not_found'});
  try {
    const [neighbors,arp]=await Promise.all([
      routerOsQuery(cfg,'/ip/neighbor/print'),
      routerOsQuery(cfg,'/ip/arp/print')
    ]);

    // Найти или создать устройство-роутер
    let routerDev=db.prepare('SELECT * FROM devices WHERE ip=?').get(cfg.host);
    if (!routerDev) {
      const id=newId('d');
      db.prepare(`INSERT INTO devices (id,name,ip,type,category_id,is_key,monitored,check_interval,alerts_enabled,source,x,y) VALUES (?,?,?,'Router','network',1,1,?,1,?,500,80)`).run(id,cfg.name||cfg.host,cfg.host,DEFAULT_INT,'mikrotik:'+(cfg.name||cfg.host));
      routerDev=db.prepare('SELECT * FROM devices WHERE id=?').get(id);
    }

    // Удаляем старые связи от этого роутера
    db.prepare('DELETE FROM topology_edges WHERE via_router_id=?').run(cfg.id);

    const findOrCreate=(mac,ip,name,type)=>{
      mac=(mac||'').toUpperCase();
      let d=db.prepare('SELECT * FROM devices WHERE (mac=? AND mac!="") OR (ip=? AND ip!="")').get(mac,ip);
      if (d) return d;
      if (!ip&&!mac) return null;
      const id=newId('d');
      db.prepare(`INSERT INTO devices (id,name,ip,mac,type,category_id,monitored,check_interval,alerts_enabled,source,x,y) VALUES (?,?,?,?,?,'other',0,?,1,?,?,?)`).run(id,name||ip||mac,ip||'',mac,type||'',DEFAULT_INT,'topology:'+cfg.name,100+Math.random()*800,100+Math.random()*500);
      return db.prepare('SELECT * FROM devices WHERE id=?').get(id);
    };

    const seen=new Set(); let edgesCreated=0;
    neighbors.forEach(n=>{
      const target=findOrCreate(n['mac-address'],n.address,n.identity,'');
      if (!target||target.id===routerDev.id) return;
      const key=target.id+'|'+(n.interface||'');
      if (seen.has(key)) return; seen.add(key);
      db.prepare('INSERT INTO topology_edges (id,from_id,to_id,label,iface,manual,via_router_id) VALUES (?,?,?,?,?,0,?)').run(newId('e'),routerDev.id,target.id,n.identity||'',n.interface||'',cfg.id);
      edgesCreated++;
    });
    arp.forEach(a=>{
      if (!a.address||!a['mac-address']) return;
      const ex=db.prepare('SELECT * FROM devices WHERE mac=? OR ip=?').get(a['mac-address'].toUpperCase(),a.address);
      if (!ex||ex.id===routerDev.id) return;
      const key=ex.id+'|'+(a.interface||'');
      if (seen.has(key)) return; seen.add(key);
      db.prepare('INSERT INTO topology_edges (id,from_id,to_id,iface,manual,via_router_id) VALUES (?,?,?,?,0,?)').run(newId('e'),routerDev.id,ex.id,a.interface||'',cfg.id);
      edgesCreated++;
    });

    res.json({ok:true,edgesCreated,routerDeviceId:routerDev.id});
  } catch(err) { res.status(500).json({error:'connection_failed',message:err.message}); }
});

// ── Правила подсетей ──────────────────────────────────────────────────
router.get('/subnet-rules', requireAuth, (req,res) => res.json(getSetting('subnetRules')||[]));
router.post('/subnet-rules', requireOperator, (req,res) => {
  const {rules}=req.body||{};
  if (!Array.isArray(rules)) return res.status(400).json({error:'rules_required'});
  for (const r of rules) {
    if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(r.cidr||'')) return res.status(400).json({error:'invalid_cidr',message:`Некорректный CIDR: "${r.cidr}"`});
    if (r.color&&!/^#[0-9a-fA-F]{6}$/.test(r.color)) return res.status(400).json({error:'invalid_color'});
  }
  const result=rules.map(r=>({id:r.id||newId('sr'),cidr:r.cidr,label:r.label||r.cidr,color:r.color||'#3b82f6'}));
  setSetting('subnetRules',result); res.json(result);
});

module.exports = router;
