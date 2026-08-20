'use strict';
/**
 * src/services/ldap.js — Аутентификация через LDAP/Active Directory
 *
 * Использует ldapts (актуальный, поддерживаемый пакет — не ldapjs,
 * который официально decommissioned автором в мае 2024 и с тех пор
 * не получает патчей безопасности).
 *
 * Схема входа с LDAP:
 *   1. Bind сервисной учётной записью (bindDN/bindPassword) — только чтение,
 *      создаётся отдельно в AD/LDAP специально для NetMonitor.
 *   2. Поиск пользователя по userFilter в baseDN.
 *   3. Bind под найденным DN с введённым паролем — это и есть проверка пароля.
 *   4. Определение роли по группам (memberOf) через roleMapping, либо defaultRole.
 */
let ldapts = null; try { ldapts = require('ldapts'); } catch {}
const log = require('./logger');

function escapeFilterValue(v) {
  // RFC 4515: экранируем спецсимволы LDAP-фильтра, чтобы предотвратить LDAP-инъекции
  return String(v).replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

function roleFromGroups(groups, roleMapping, defaultRole) {
  if (!Array.isArray(roleMapping)) return defaultRole || 'viewer';
  // roleMapping: [{ group: 'CN=NetAdmins,OU=Groups,DC=example,DC=com', role: 'admin' }, ...]
  // Первое совпадение по приоритету списка (admin обычно указывают первым)
  for (const rule of roleMapping) {
    if (!rule.group || !rule.role) continue;
    if (groups.some(g => g.toLowerCase() === rule.group.toLowerCase())) return rule.role;
  }
  return defaultRole || 'viewer';
}

/**
 * authenticate({ username, password }, ldapCfg) → { ok, role, displayName, error }
 */
async function authenticate(username, password, cfg) {
  if (!ldapts) return { ok: false, error: 'ldapts не установлен' };
  if (!cfg?.url || !cfg?.baseDN) return { ok: false, error: 'LDAP не настроен' };

  const client = new ldapts.Client({
    url: cfg.url,
    connectTimeout: 5000,
    timeout: 8000,
    tlsOptions: cfg.rejectUnauthorized === false ? { rejectUnauthorized: false } : undefined
  });

  try {
    // 1. Bind сервисной учётной записью для поиска пользователя
    await client.bind(cfg.bindDN, cfg.bindPassword);

    // 2. Поиск DN пользователя
    const filterTemplate = cfg.userFilter || '(sAMAccountName={{username}})';
    const filter = filterTemplate.replace('{{username}}', escapeFilterValue(username));
    const { searchEntries } = await client.search(cfg.baseDN, {
      scope: 'sub',
      filter,
      attributes: ['dn', 'memberOf', 'displayName', 'cn']
    });
    if (!searchEntries.length) return { ok: false, error: 'Пользователь не найден в LDAP' };
    const entry = searchEntries[0];
    const userDN = entry.dn;

    // 3. Отдельный клиент: bind под найденным DN с паролем пользователя — сама проверка пароля
    const userClient = new ldapts.Client({
      url: cfg.url, connectTimeout: 5000, timeout: 8000,
      tlsOptions: cfg.rejectUnauthorized === false ? { rejectUnauthorized: false } : undefined
    });
    try {
      await userClient.bind(userDN, password);
    } catch {
      return { ok: false, error: 'Неверный пароль' };
    } finally {
      try { await userClient.unbind(); } catch {}
    }

    // 4. Роль по группам
    let groups = entry.memberOf || [];
    if (!Array.isArray(groups)) groups = [groups];
    const role = roleFromGroups(groups, cfg.roleMapping, cfg.defaultRole);
    const displayName = entry.displayName || entry.cn || username;

    return { ok: true, role, displayName };
  } catch (e) {
    log.error({ err: e }, 'LDAP auth failed');
    return { ok: false, error: 'Ошибка соединения с LDAP-сервером' };
  } finally {
    try { await client.unbind(); } catch {}
  }
}

/** Проверка соединения (для кнопки "Тест" в настройках) — только bind сервисным аккаунтом */
async function testConnection(cfg) {
  if (!ldapts) return { ok: false, error: 'ldapts не установлен' };
  if (!cfg?.url || !cfg?.bindDN) return { ok: false, error: 'Заполните URL и Bind DN' };
  const client = new ldapts.Client({
    url: cfg.url, connectTimeout: 5000, timeout: 8000,
    tlsOptions: cfg.rejectUnauthorized === false ? { rejectUnauthorized: false } : undefined
  });
  try {
    await client.bind(cfg.bindDN, cfg.bindPassword);
    let userCount = null;
    if (cfg.baseDN) {
      try {
        const { searchEntries } = await client.search(cfg.baseDN, { scope: 'sub', filter: '(objectClass=*)', sizeLimit: 1 });
        userCount = searchEntries.length;
      } catch {}
    }
    return { ok: true, message: 'Соединение и Bind DN успешны.' };
  } catch (e) {
    return { ok: false, error: e.message || 'Не удалось подключиться' };
  } finally {
    try { await client.unbind(); } catch {}
  }
}

module.exports = { authenticate, testConnection };
