'use strict';

/**
 * src/middleware/rate-limit.js
 *
 * Общая защита всех /api/* эндпоинтов от перебора и злоупотребления.
 * /api/login имеет собственную блокировку по IP (см. routes/auth.js) —
 * этот модуль её не заменяет, а дополняет для остальных маршрутов.
 *
 * Три профиля лимитов:
 *   apiReadLimiter   — GET-запросы (статус, список устройств, история...)
 *   apiWriteLimiter   — POST/PUT/DELETE (создание, изменение, импорт...)
 *   scanLimiter       — тяжёлые операции (ping-sweep, импорт с MikroTik/UniFi/Cisco)
 *
 * Настройка через переменные окружения (см. .env / docker-compose):
 *   RATE_LIMIT_DISABLED=true   — полностью отключить (для отладки/тестов)
 */

const rateLimit = require('express-rate-limit');
const log = require('../services/logger');

const DISABLED = process.env.RATE_LIMIT_DISABLED === 'true';

function makeLimiter(opts) {
  if (DISABLED) return (req, res, next) => next();
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,   // RateLimit-* заголовки в ответе
    legacyHeaders: false,
    message: { error: 'rate_limited', message: opts.message || 'Слишком много запросов, попробуйте позже' },
    handler: (req, res, next, options) => {
      log.warn({ ip: req.ip, path: req.path, method: req.method }, 'Rate limit превышен');
      res.status(429).json(options.message);
    },
    // Пропускаем health-check и SSE — они не должны блокироваться лимитами
    skip: (req) => req.path === '/api/health' || req.path === '/api/events',
    // По умолчанию ключ — IP. Позволяем переопределить (нужно для агента,
    // у которого много устройств может быть за одним NAT-адресом).
    keyGenerator: opts.keyGenerator,
  });
}

// Чтение — щедрый лимит, интерфейс регулярно опрашивает статус/список
const apiReadLimiter = makeLimiter({
  windowMs: 60 * 1000,   // 1 минута
  max: 300,              // 5 запросов/сек в среднем — с запасом под активную работу с UI
  message: 'Слишком много запросов на чтение. Подождите минуту.',
});

// Запись — строже, изменения данных не должны происходить пачками от одного клиента
const apiWriteLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,               // 1 запрос/сек в среднем
  message: 'Слишком много запросов на изменение данных. Подождите минуту.',
});

// Тяжёлые операции — сканирование сети, импорт с внешних систем
const scanLimiter = makeLimiter({
  windowMs: 5 * 60 * 1000,  // 5 минут
  max: 10,
  message: 'Слишком много запросов на сканирование/импорт. Подождите несколько минут.',
});

// Агент — не браузер, шлёт метрики по расписанию. Лимитируем по токену
// устройства (в заголовке Authorization), а не по IP — иначе несколько
// машин за одним NAT-адресом делили бы общий лимит между собой.
const agentLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 20,   // легитимный агент шлёт 1 запрос/мин — 20 достаточно с запасом на ретраи
  message: 'Слишком много отчётов от агента. Проверьте интервал отправки.',
  keyGenerator: (req) => {
    const auth = req.headers['authorization'] || '';
    const m = /^Bearer (.+)$/.exec(auth);
    return m ? m[1] : req.ip; // ключ — токен устройства, фоллбек на IP если токена нет
  },
});

module.exports = { apiReadLimiter, apiWriteLimiter, scanLimiter, agentLimiter };
