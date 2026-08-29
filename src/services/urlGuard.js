'use strict';
/**
 * src/services/urlGuard.js — Защита от SSRF для пользовательских webhook-URL
 *
 * Этот инструмент — self-hosted, слать webhook/ntfy на внутренний сервер в своей
 * же сети (10.x/172.16.x/192.168.x/localhost) — легитимный, ожидаемый юзкейс, не
 * баг. Поэтому НЕ блокируем приватные диапазоны целиком (это сломало бы
 * self-hosted Ntfy и подобные интеграции).
 *
 * Блокируем только то, что не имеет ни одного легитимного применения для
 * webhook-уведомления в контексте сетевого мониторинга:
 *  - 169.254.0.0/16 (link-local) — включает cloud-metadata эндпоинты
 *    (169.254.169.254 у AWS/GCP/Azure), откуда воруют IAM-креды
 *  - любая схема, кроме http/https (file://, gopher://, dict:// и т.п.)
 *
 * Оговорка: это защита по IP-литералу/схеме URL, не полная защита от DNS
 * rebinding (домен, резолвящийся в 169.254.x.x в момент фактического запроса,
 * а не в момент валидации, всё ещё теоретически возможен — для этого нужен
 * контроль над DNS со стороны атакующего, что снижает практическую
 * вероятность, но не исключает её полностью).
 */
const { URL } = require('url');

function isLinkLocalIPv4(hostname) {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (!m) return false;
  return Number(m[1]) === 169 && Number(m[2]) === 254;
}

function isLinkLocalIPv6(hostname) {
  // fe80::/10 — IPv6 link-local
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return /^fe[89ab][0-9a-f]:/.test(h);
}

/** Возвращает null если URL безопасен для webhook-запроса, иначе строку с причиной отказа. */
function checkWebhookUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return 'Некорректный URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Разрешены только http:// и https://';
  if (isLinkLocalIPv4(u.hostname) || isLinkLocalIPv6(u.hostname)) {
    return 'Link-local адреса (169.254.x.x) запрещены — это диапазон cloud-metadata эндпоинтов';
  }
  return null;
}

module.exports = { checkWebhookUrl };
