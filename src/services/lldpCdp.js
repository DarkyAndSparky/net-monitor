'use strict';
/**
 * src/services/lldpCdp.js — Автотопология через LLDP/CDP по SNMP
 *
 * Не требует MikroTik: работает с любым устройством, отвечающим по SNMP
 * и поддерживающим стандартный LLDP-MIB (RFC 2922 / IEEE 802.1AB) или
 * фирменный CISCO-CDP-MIB. Пробуем сначала LLDP (вендоронезависимый),
 * при пустом результате — CDP.
 */
let snmpLib = null; try { snmpLib = require('net-snmp'); } catch {}

// LLDP-MIB (стандартный, RFC/IEEE)
const LLDP_LOC_PORT_DESC = '1.0.8802.1.1.2.1.3.7.1.4'; // lldpLocPortDesc, индекс: lldpLocPortNum
const LLDP_REM_SYSNAME   = '1.0.8802.1.1.2.1.4.1.1.9';  // lldpRemSysName, индекс: TimeMark.LocalPortNum.Index
const LLDP_REM_PORTID    = '1.0.8802.1.1.2.1.4.1.1.7';  // lldpRemPortId
const LLDP_REM_PORTDESC  = '1.0.8802.1.1.2.1.4.1.1.8';  // lldpRemPortDesc
const LLDP_REM_CHASSISID = '1.0.8802.1.1.2.1.4.1.1.5';  // lldpRemChassisId (часто MAC)

// CISCO-CDP-MIB (фирменный, для оборудования Cisco/поддерживающего CDP)
const CDP_DEVICEID = '1.3.6.1.4.1.9.9.23.1.2.1.1.6'; // cdpCacheDeviceId, индекс: ifIndex.DeviceIndex
const CDP_DEVPORT  = '1.3.6.1.4.1.9.9.23.1.2.1.1.7'; // cdpCacheDevicePort
const CDP_ADDRESS  = '1.3.6.1.4.1.9.9.23.1.2.1.1.4'; // cdpCacheAddress (raw bytes)
const CDP_PLATFORM = '1.3.6.1.4.1.9.9.23.1.2.1.1.8'; // cdpCachePlatform

function walk(session, oid) {
  return new Promise((resolve) => {
    const rows = [];
    session.subtree(oid, 20, (varbinds) => {
      varbinds.forEach(vb => { if (!snmpLib.isVarbindError(vb)) rows.push(vb); });
    }, () => resolve(rows));
  });
}

function suffixAfter(oid, prefix) {
  return oid.startsWith(prefix + '.') ? oid.slice(prefix.length + 1) : null;
}

function bufToStr(v) {
  if (Buffer.isBuffer(v)) return v.toString('utf8').replace(/[^\x20-\x7eА-Яа-яЁё]/g, '').trim() || v.toString('hex');
  return String(v ?? '').trim();
}

function bufToIp(v) {
  if (Buffer.isBuffer(v) && v.length === 4) return Array.from(v).join('.');
  return null;
}

async function discoverLldp(session) {
  const [sysNames, portIds, portDescs, chassisIds, locPortDescs] = await Promise.all([
    walk(session, LLDP_REM_SYSNAME),
    walk(session, LLDP_REM_PORTID),
    walk(session, LLDP_REM_PORTDESC),
    walk(session, LLDP_REM_CHASSISID),
    walk(session, LLDP_LOC_PORT_DESC)
  ]);
  if (!sysNames.length && !chassisIds.length) return [];

  const locPortByNum = {};
  locPortDescs.forEach(vb => {
    const idx = suffixAfter(vb.oid, LLDP_LOC_PORT_DESC);
    if (idx) locPortByNum[idx] = bufToStr(vb.value);
  });
  const portIdByKey = {}; portIds.forEach(vb => { const k = suffixAfter(vb.oid, LLDP_REM_PORTID); if (k) portIdByKey[k] = bufToStr(vb.value); });
  const portDescByKey = {}; portDescs.forEach(vb => { const k = suffixAfter(vb.oid, LLDP_REM_PORTDESC); if (k) portDescByKey[k] = bufToStr(vb.value); });
  const chassisByKey = {}; chassisIds.forEach(vb => { const k = suffixAfter(vb.oid, LLDP_REM_CHASSISID); if (k) chassisByKey[k] = bufToStr(vb.value); });

  return sysNames.map(vb => {
    const key = suffixAfter(vb.oid, LLDP_REM_SYSNAME);
    if (!key) return null;
    const parts = key.split('.'); // timeMark.localPortNum.index
    const localPortNum = parts[1];
    return {
      source: 'lldp',
      remoteName: bufToStr(vb.value) || chassisByKey[key] || '',
      remotePort: portDescByKey[key] || portIdByKey[key] || '',
      remoteChassisId: chassisByKey[key] || '',
      remoteIp: '',
      localPortDesc: locPortByNum[localPortNum] || ''
    };
  }).filter(Boolean).filter(n => n.remoteName || n.remoteChassisId);
}

async function discoverCdp(session) {
  const [deviceIds, devPorts, addresses, platforms] = await Promise.all([
    walk(session, CDP_DEVICEID),
    walk(session, CDP_DEVPORT),
    walk(session, CDP_ADDRESS),
    walk(session, CDP_PLATFORM)
  ]);
  if (!deviceIds.length) return [];

  const portByKey = {}; devPorts.forEach(vb => { const k = suffixAfter(vb.oid, CDP_DEVPORT); if (k) portByKey[k] = bufToStr(vb.value); });
  const addrByKey = {}; addresses.forEach(vb => { const k = suffixAfter(vb.oid, CDP_ADDRESS); if (k) addrByKey[k] = bufToIp(vb.value); });
  const platByKey = {}; platforms.forEach(vb => { const k = suffixAfter(vb.oid, CDP_PLATFORM); if (k) platByKey[k] = bufToStr(vb.value); });

  return deviceIds.map(vb => {
    const key = suffixAfter(vb.oid, CDP_DEVICEID);
    if (!key) return null;
    const ifIndex = key.split('.')[0];
    return {
      source: 'cdp',
      remoteName: bufToStr(vb.value),
      remotePort: portByKey[key] || '',
      remoteChassisId: '',
      remoteIp: addrByKey[key] || '',
      remotePlatform: platByKey[key] || '',
      localPortDesc: 'ifIndex ' + ifIndex
    };
  }).filter(Boolean).filter(n => n.remoteName);
}

// Возвращает список соседей устройства через LLDP (приоритет) или CDP (fallback)
function discoverNeighbors(device) {
  if (!snmpLib) return Promise.reject(new Error('net-snmp не установлен'));
  return new Promise((resolve, reject) => {
    const session = snmpLib.createSession(device.ip, device.snmp_community || 'public', {
      port: device.snmp_port || 161, timeout: 4000, retries: 1
    });
    session.on('error', () => {}); // не даём упасть процессу на сетевых ошибках
    (async () => {
      try {
        let neighbors = await discoverLldp(session);
        if (!neighbors.length) neighbors = await discoverCdp(session);
        session.close();
        resolve(neighbors);
      } catch (e) {
        try { session.close(); } catch {}
        reject(e);
      }
    })();
  });
}

module.exports = { discoverNeighbors };
