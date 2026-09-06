'use strict';
const log          = require('./logger');
const { execFile } = require('child_process');
const net          = require('net');
const os           = require('os');
const { db, newId, getSetting, getFeatures } = require('../db');

const TICK_MS       = 5000;
const DEFAULT_INT   = 60;
const MIN_INT       = 10;
const SAFE_HOST_RE  = /^[a-zA-Z0-9.:_-]+$/;

const statusCache    = {};
const portCheckCache = {};
const snmpCache      = {};
const alertState     = {};

// SSE broadcast — ленивый require чтобы избежать circular dep
let _broadcast = null;
function getBroadcast() {
  if (!_broadcast) { try { _broadcast = require('../routes/sse').broadcast; } catch { _broadcast = () => {}; } }
  return _broadcast;
}

// ── Ping ──────────────────────────────────────────────────────────────
function pingHost(ip) {
  return new Promise(resolve => {
    if (!ip||typeof ip!=='string'||ip.length>253||!SAFE_HOST_RE.test(ip)) return resolve(false);
    const isWin = os.platform()==='win32';
    execFile('ping', isWin?['-n','1','-w','800',ip]:['-c','1','-W','1',ip], { timeout:3000 }, err => resolve(!err));
  });
}

// ── TCP Port ──────────────────────────────────────────────────────────
function checkTcpPort(ip, port, ms=2000) {
  return new Promise(resolve => {
    if (!ip||!port) return resolve(false);
    const s=new net.Socket(); let done=false;
    const fin=r=>{ if(done)return; done=true; s.destroy(); resolve(r); };
    s.setTimeout(ms); s.once('connect',()=>fin(true)); s.once('timeout',()=>fin(false)); s.once('error',()=>fin(false));
    s.connect(port, ip);
  });
}
async function checkDevicePorts(device) {
  const checks = JSON.parse(device.port_checks||'[]');
  const results = [];
  for (const pc of checks) {
    const open = await checkTcpPort(device.ip, Number(pc.port));
    results.push({ port:pc.port, label:pc.label||'', open, lastChecked:Date.now() });
  }
  portCheckCache[device.id] = results;
}

// ── SNMP ──────────────────────────────────────────────────────────────
let snmpLib = null; try { snmpLib = require('net-snmp'); } catch {}

function pollSnmp(device) {
  if (!snmpLib) { log.warn('net-snmp не установлен, SNMP опрос недоступен'); snmpCache[device.id]={ error:'net-snmp не установлен', lastChecked:Date.now() }; return Promise.resolve(); }
  return new Promise(resolve => {
    const session = snmpLib.createSession(device.ip, device.snmp_community||'public', { port:device.snmp_port||161, timeout:2000, retries:0 });
    session.get(['1.3.6.1.2.1.1.3.0','1.3.6.1.4.1.14988.1.1.3.14.0'], (err, vb) => {
      snmpCache[device.id] = err
        ? { error:'Нет ответа по SNMP', lastChecked:Date.now() }
        : { sysUptimeTicks:!snmpLib.isVarbindError(vb[0])?Number(vb[0].value):null, cpuLoad:!snmpLib.isVarbindError(vb[1])?Number(vb[1].value):null, lastChecked:Date.now(), error:null };
      session.close(); resolve();
    });
  });
}

// ── Трафик: SNMP (устройства) ─────────────────────────────────────────
// ifOctets — 32-битный счётчик, накопительный. Считаем дельту между двумя
// опросами и переводим в bps. Требует поле snmp_if_index у устройства.
const trafficRawCache = {}; // key(device.id) -> { ts, rxBytes, txBytes }

function snmpGetIfOctets(device) {
  if (!snmpLib) return Promise.resolve(null);
  const idx = device.snmp_if_index;
  if (idx == null) return Promise.resolve(null);
  return new Promise(resolve => {
    const session = snmpLib.createSession(device.ip, device.snmp_community||'public', { port:device.snmp_port||161, timeout:2000, retries:0 });
    const inOid  = `1.3.6.1.2.1.2.2.1.10.${idx}`;
    const outOid = `1.3.6.1.2.1.2.2.1.16.${idx}`;
    session.get([inOid, outOid], (err, vb) => {
      session.close();
      if (err) return resolve(null);
      const rx = !snmpLib.isVarbindError(vb[0]) ? Number(vb[0].value) : null;
      const tx = !snmpLib.isVarbindError(vb[1]) ? Number(vb[1].value) : null;
      resolve(rx != null && tx != null ? { rxBytes: rx, txBytes: tx } : null);
    });
  });
}

async function pollDeviceTraffic(device) {
  const now = Date.now();
  const reading = await snmpGetIfOctets(device);
  if (!reading) return;

  const key  = 'd:' + device.id;
  const prev = trafficRawCache[key];
  trafficRawCache[key] = { ts: now, ...reading };
  if (!prev) return; // первый опрос — только запоминаем базовую точку

  const elapsedSec = (now - prev.ts) / 1000;
  if (elapsedSec < 1) return;

  // Защита от переполнения 32-битного счётчика (wrap around ~4.3GB)
  const deltaRx = reading.rxBytes >= prev.rxBytes ? reading.rxBytes - prev.rxBytes : reading.rxBytes;
  const deltaTx = reading.txBytes >= prev.txBytes ? reading.txBytes - prev.txBytes : reading.txBytes;

  const rxBps = Math.round((deltaRx * 8) / elapsedSec);
  const txBps = Math.round((deltaTx * 8) / elapsedSec);

  db.prepare('INSERT INTO traffic_history (source_type,source_id,iface,ts,rx_bps,tx_bps) VALUES (?,?,?,?,?,?)')
    .run('device', device.id, '', now, rxBps, txBps);

  getBroadcast()('traffic', { sourceType: 'device', sourceId: device.id, iface: '', rxBps, txBps, ts: now });
}

// ── Трафик: MikroTik (роутеры) ────────────────────────────────────────
// /interface/print stats даёт накопительные rx-byte/tx-byte по интерфейсу —
// та же логика дельты, что и для SNMP.
let _routerOsQuery = null;
function getRouterOsQuery() {
  if (!_routerOsQuery) { try { _routerOsQuery = require('../routes/integrations').routerOsQuery; } catch { _routerOsQuery = null; } }
  return _routerOsQuery;
}

async function pollRouterTraffic(routerCfg) {
  const ifaces = routerCfg.trafficInterfaces || [];
  if (!ifaces.length) return;
  const query = getRouterOsQuery();
  if (!query) return;

  let stats;
  try {
    // RouterOS API возвращает rx-byte/tx-byte в стандартном ответе /interface/print —
    // в отличие от CLI-таблицы, для API не нужен отдельный флаг "stats".
    stats = await query(routerCfg, '/interface/print');
  } catch { return; } // роутер недоступен — тихо пропускаем этот тик

  const now = Date.now();
  for (const ifaceName of ifaces) {
    const row = (Array.isArray(stats) ? stats : []).find(s => s.name === ifaceName);
    if (!row || row['rx-byte'] == null || row['tx-byte'] == null) continue;

    const rxBytes = Number(row['rx-byte']);
    const txBytes = Number(row['tx-byte']);
    const key  = 'r:' + routerCfg.id + ':' + ifaceName;
    const prev = trafficRawCache[key];
    trafficRawCache[key] = { ts: now, rxBytes, txBytes };
    if (!prev) continue;

    const elapsedSec = (now - prev.ts) / 1000;
    if (elapsedSec < 1) continue;

    const deltaRx = rxBytes >= prev.rxBytes ? rxBytes - prev.rxBytes : rxBytes;
    const deltaTx = txBytes >= prev.txBytes ? txBytes - prev.txBytes : txBytes;
    const rxBps = Math.round((deltaRx * 8) / elapsedSec);
    const txBps = Math.round((deltaTx * 8) / elapsedSec);

    db.prepare('INSERT INTO traffic_history (source_type,source_id,iface,ts,rx_bps,tx_bps) VALUES (?,?,?,?,?,?)')
      .run('router', routerCfg.id, ifaceName, now, rxBps, txBps);

    getBroadcast()('traffic', { sourceType: 'router', sourceId: routerCfg.id, iface: ifaceName, rxBps, txBps, ts: now });
  }
}

// ── Отдельный, более редкий тик для трафика (раз в 30 сек) ────────────
const TRAFFIC_TICK_MS = 30000;
async function trafficTick() {
  const features = getFeatures();
  if (!features.traffic) return;

  const devices = db.prepare('SELECT * FROM devices WHERE monitored=1 AND snmp_enabled=1 AND snmp_if_index IS NOT NULL').all();
  for (const d of devices) {
    pollDeviceTraffic(d).catch(err => log.debug({ err, deviceId: d.id }, 'Ошибка опроса трафика (SNMP)'));
  }

  const routers = getSetting('mikrotiks') || [];
  for (const r of routers) {
    if (r.trafficInterfaces?.length) {
      pollRouterTraffic(r).catch(err => log.debug({ err, routerId: r.id }, 'Ошибка опроса трафика (MikroTik)'));
    }
  }
}
setInterval(trafficTick, TRAFFIC_TICK_MS);

// ── Алерты ───────────────────────────────────────────────────────────
async function sendTelegram(cfg, text) {
  if (!cfg.telegram?.enabled||!cfg.telegram.botToken||!cfg.telegram.chatId) return;
  try { await fetch(`https://api.telegram.org/bot${cfg.telegram.botToken}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:cfg.telegram.chatId,text,parse_mode:'HTML'})}); } catch(e){ log.error({ err: e }, 'Telegram alert failed'); }
}
async function sendWebhook(cfg, payload) {
  if (!cfg.webhook?.enabled||!cfg.webhook.url) return;
  const blocked = require('./urlGuard').checkWebhookUrl(cfg.webhook.url);
  if (blocked) { log.warn({ url: cfg.webhook.url, reason: blocked }, 'Webhook alert blocked by SSRF guard'); return; }
  try { await fetch(cfg.webhook.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); } catch(e){ log.error({ err: e }, 'Webhook alert failed'); }
}
async function sendNtfy(cfg, text, status) {
  if (!cfg.ntfy?.enabled||!cfg.ntfy.url) return;
  const blocked = require('./urlGuard').checkWebhookUrl(cfg.ntfy.url);
  if (blocked) { log.warn({ url: cfg.ntfy.url, reason: blocked }, 'Ntfy alert blocked by SSRF guard'); return; }
  try {
    const plain = text.replace(/<\/?b>/g,'').replace(/\\n/g,'\n');
    const base = cfg.ntfy.url.replace(/\/+$/,'');
    const topicUrl = cfg.ntfy.topic ? `${base}/${cfg.ntfy.topic}` : base;
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Title': 'NetMonitor' };
    if (status==='down') { headers['Priority']='high'; headers['Tags']='red_circle'; }
    else if (status==='up') { headers['Priority']='default'; headers['Tags']='green_circle'; }
    if (cfg.ntfy.authToken) headers['Authorization'] = `Bearer ${cfg.ntfy.authToken}`;
    await fetch(topicUrl, { method:'POST', headers, body: plain });
  } catch(e){ log.error({ err: e }, 'Ntfy alert failed'); }
}
let nodemailer = null; try { nodemailer = require('nodemailer'); } catch {}
let cachedTransport = null, cachedTransportKey = null;
function getTransport(cfg) {
  const key = JSON.stringify(cfg);
  if (cachedTransport && cachedTransportKey === key) return cachedTransport;
  cachedTransport = nodemailer.createTransport({
    host: cfg.host, port: cfg.port || 587,
    secure: !!cfg.secure, // true → implicit TLS (обычно порт 465)
    requireTLS: cfg.starttls !== false && !cfg.secure,
    auth: (cfg.user && cfg.pass) ? { user: cfg.user, pass: cfg.pass } : undefined,
    tls: { rejectUnauthorized: cfg.rejectUnauthorized !== false }
  });
  cachedTransportKey = key;
  return cachedTransport;
}
async function sendEmail(cfg, subject, text, status) {
  if (!cfg.email?.enabled || !cfg.email.host || !cfg.email.to) return;
  if (!nodemailer) { log.warn('nodemailer не установлен, email-алерты недоступны'); return; }
  try {
    const transport = getTransport(cfg.email);
    await transport.sendMail({
      from: cfg.email.from || cfg.email.user || 'netmonitor@localhost',
      to: cfg.email.to,
      subject,
      text: text.replace(/<\/?b>/g, '')
    });
  } catch (e) { log.error({ err: e }, 'Email alert failed'); }
}
async function dispatchAlert(cfg, device, status, text) {
  const subject = status === 'down'
    ? `🔴 NetMonitor: ${device.name} недоступно`
    : status === 'up'
      ? `🟢 NetMonitor: ${device.name} снова в сети`
      : `NetMonitor: ${device.name}`;
  await Promise.all([
    sendTelegram(cfg, text),
    sendWebhook(cfg, { device:{id:device.id,name:device.name,ip:device.ip,location:device.location}, status, message:text, time:new Date().toISOString() }),
    sendNtfy(cfg, text, status),
    sendEmail(cfg, subject, text, status)
  ]);
}
async function evaluateAlert(device, online) {
  const cfg = getSetting('alerting')||{};
  if (!cfg.enabled||!device.alerts_enabled) return;

  // Проверяем maintenance window — не отправляем алерты в окне обслуживания
  try {
    const { isInMaintenance } = require('../routes/maintenance');
    if (isInMaintenance(device.id)) {
      log.debug({ deviceId: device.id, name: device.name }, 'Алерт подавлен (maintenance window)');
      return;
    }
  } catch {}
  const threshold=Math.max(1,Number(cfg.failThreshold)||2);
  const repeatMs=Math.max(0,Number(cfg.repeatMinutes)||0)*60000;
  const now=Date.now();
  const st=alertState[device.id]||{consecutiveFails:0,lastAlertSentAt:0,wasDown:false,downSince:0,escalated:false};
  if (online===false) {
    if (!st.consecutiveFails) st.downSince=now;
    st.consecutiveFails++;
    if (st.consecutiveFails===threshold||(st.wasDown&&repeatMs>0&&(now-st.lastAlertSentAt)>=repeatMs)) {
      await dispatchAlert(cfg,device,'down',`🔴 <b>${device.name}</b> недоступно\nIP: ${device.ip||'—'}\nРасположение: ${device.location||'—'}\nПодряд неудачных проверок: ${st.consecutiveFails}`);
      st.lastAlertSentAt=now; st.wasDown=true;
    }
    const esc=cfg.escalation||{};
    if (getFeatures().incidents&&esc.enabled&&!st.escalated&&st.downSince&&(now-st.downSince)>=esc.afterMinutes*60000) {
      st.escalated=true;
      const min=Math.round((now-st.downSince)/60000);
      if (esc.telegramChatId) await sendTelegram({telegram:{enabled:true,botToken:cfg.telegram?.botToken,chatId:esc.telegramChatId}},`🆘 <b>ЭСКАЛАЦИЯ</b>: ${device.name} недоступно уже ${min} мин\nIP: ${device.ip||'—'}`);
      db.prepare("UPDATE incidents SET escalated=1 WHERE device_id=? AND end_ts IS NULL").run(device.id);
    }
  } else {
    if (st.wasDown&&cfg.notifyOnRecovery) await dispatchAlert(cfg,device,'up',`🟢 <b>${device.name}</b> снова в сети\nIP: ${device.ip||'—'}\nРасположение: ${device.location||'—'}`);
    st.consecutiveFails=0; st.wasDown=false; st.downSince=0; st.escalated=false;
  }
  alertState[device.id]=st;
}

// ── Инциденты ─────────────────────────────────────────────────────────
function recordIncidentTransition(device, prevOnline, online) {
  if (!getFeatures().incidents) return;
  if (online===false&&prevOnline!==false) {
    const startTs = Date.now();
    db.prepare('INSERT OR IGNORE INTO incidents (id,device_id,device_name,start_ts) VALUES (?,?,?,?)').run(newId('i'),device.id,device.name,startTs);
    getBroadcast()('incident', { type:'open', deviceId:device.id, deviceName:device.name, start:startTs });
  } else if (online===true) {
    const inc=db.prepare('SELECT * FROM incidents WHERE device_id=? AND end_ts IS NULL').get(device.id);
    if (inc) { const end=Date.now(); db.prepare('UPDATE incidents SET end_ts=?,duration_sec=? WHERE id=?').run(end,Math.round((end-inc.start_ts)/1000),inc.id); }
  }
}

// ── Планировщик ───────────────────────────────────────────────────────
async function schedulerTick() {
  const now=Date.now();
  const devices=db.prepare('SELECT * FROM devices WHERE monitored=1').all();
  const features=getFeatures();
  const ins=db.prepare('INSERT INTO history (device_id,ts,online) VALUES (?,?,?)');
  for (const d of devices) {
    const interval=Math.max(MIN_INT,d.check_interval||DEFAULT_INT)*1000;
    if (now-(statusCache[d.id]?.lastChecked||0)<interval) continue;
    const online=d.ip?await pingHost(d.ip):false;
    const prev=statusCache[d.id];
    statusCache[d.id]={online,lastChecked:now};
    ins.run(d.id,now,online?1:0);

    // Пушим SSE только при смене статуса (не каждый тик)
    if (!prev || prev.online !== online) {
      getBroadcast()('status', { id: d.id, online, lastChecked: now });
    }

    evaluateAlert(d,online).catch(()=>{});
    recordIncidentTransition(d,prev?.online??null,online);
    if (features.snmp&&d.snmp_enabled)                                      pollSnmp(d).catch(()=>{});
    if (features.portChecks&&JSON.parse(d.port_checks||'[]').length>0) checkDevicePorts(d).catch(()=>{});
  }
}
setInterval(schedulerTick, TICK_MS);
schedulerTick();

module.exports = { pingHost, statusCache, snmpCache, portCheckCache, dispatchAlert,
  // Экспортировано дополнительно для юнит-тестов (test/unit/scheduler.test.js) —
  // не влияет на поведение планировщика, он всё так же стартует setInterval() выше
  // при require() этого модуля.
  evaluateAlert, recordIncidentTransition, schedulerTick, trafficTick, alertState,
  checkDevicePorts };
