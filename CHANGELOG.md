# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/)

---

## [Unreleased]

### Planned
- NetBox synchronization (IPAM)
- LLDP/CDP парсинг проверен только против тестовых данных — нужна валидация на реальном разнородном оборудовании
- Скриншоты / GIF в README

---

## [26w35-b02] — 2026-08-29

### Fixed — Security (четвёртый раунд аудита)
- **Самая серьёзная находка за весь проект**: не было глобального `unhandledRejection`/
  `uncaughtException` перехватчика — одно необработанное исключение в любом из ~50 async
  route-хендлеров роняло бы **весь процесс** (дефолтное поведение Node 15+), а не один запрос.
  Подтверждено реальным тестом (временный роут с намеренным `TypeError`): до фикса — краш сервера
  для всех, после — процесс жив, ошибка залогирована, сервис продолжает работать
- **Права доступа на файл БД** — `.db`/`.db-wal`/`.db-shm` создавались с правами `644`
  (world-readable) на файле, где в открытом виде хранятся LDAP/SMTP-пароли, Telegram bot token,
  password-хеши. Исправлено: `process.umask(0o077)` + явный `chmod 600`
- `npm audit` — 0 известных CVE (для протокола, не было находок)

---

## [26w35-b01] — 2026-08-28

### Added
- `scripts/sync-version.js` — `package.json` теперь единственный источник истины для версии.
  `server.js` уже читал её оттуда динамически в рантайме; скрипт синхронизирует статические файлы
  (`docs/index.html`), которые не могут прочитать её сами. Запуск: `npm run version:sync`, либо
  автоматически через `postversion`-хук при `npm version <bump>`
- GitHub Pages для `docs/` — `.github/workflows/pages.yml`, официальный Actions-based деплой
- Mobile-адаптивность — off-canvas sidebar с гамбургер-меню (≤768px)
- `aria-label` на 14 icon-only кнопках по всему интерфейсу

### Fixed — Security (pentest-раунд)
- **SSRF** через webhook/ntfy URL — не было защиты вообще; добавлен `src/services/urlGuard.js`
  (блокирует link-local/cloud-metadata диапазон и не-http(s) схемы, сознательно не трогает
  приватные LAN-адреса — легитимный self-hosted юзкейс)
- **SVG XSS** через логотип — старый blacklist обходился 4 способами (`javascript:` в
  `xlink:href`, SMIL-анимация, `foreignObject`, вложенный `data:text/html`); impact шире
  ожидаемого — логотип отдаётся без авторизации, видим на странице логина
- **Timing-based user enumeration** — несуществующий username отвечал ~7мс, существующий —
  ~50мс (реальный scrypt); добавлен constant-time padding
- **Information disclosure** — не было global error handler (риск утечки stack trace) и явного
  JSON 404 для `/api/*`; заодно отключён заголовок `X-Powered-By`

### Fixed — UI/UX
- 6 мест использовали голый `confirm()`, 3 — `alert()`, вместо стилизованных `showConfirm()`/
  `toast()` — включая восстановление бэкапа (самая опасная операция в приложении)
- Защита от двойного клика на формах создания/редактирования устройства и пользователя

---

## [26w34-b01] — 2026-08-22

### Added
- **Email (SMTP) алерты** — через nodemailer, поддержка STARTTLS/TLS, авторизация, четвёртый канал наравне с Telegram/Webhook/Ntfy
- **Ntfy.sh алерты** — self-hosted push-уведомления, с приоритетом/тегами по статусу устройства
- **LLDP/CDP автотопология** — обнаружение соседей по SNMP независимо от вендора (не только MikroTik), авто-создание устройств и связей на карте
- **Дашборд v2** — SLA-индикаторы (24ч/7д), heat map аптайма устройств по дням, сводка по статусам, открытые инциденты
- **Поиск и фильтры в аудит-логе** — по тексту, действию, пользователю, диапазону дат; экспорт CSV с учётом фильтров
- **Webhook на любое событие** — не только алерты устройств, весь аудит-лог целиком, с фильтром по типам событий и подписью через секрет
- **LDAP/Active Directory аутентификация** — вход через AD как дополнение к локальным аккаунтам, авто-провижининг, маппинг ролей по группам
- **Multi-site (площадки)** — привязка устройств к филиалам, фильтр дашборда по площадке
- **Просмотр системных логов** — фильтр по уровню/дате/тексту, живой tail в реальном времени (SSE), скачивание, удаление архивов
- Тестовая инфраструктура на встроенном `node:test` — 53 юнит- и интеграционных теста, включая полный HTTP round-trip через реальный сервер

### Fixed
- **Критично:** `POST /api/login` с пустыми учётными данными вешал соединение без ответа (необработанное исключение `node:sqlite` в async-роуте, не перехватываемое Express 4)
- **Критично:** роуты `/api/categories` и `/api/sites` были физически недостижимы (реальный путь — `/api/devices/categories`) из-за несоответствия точки монтирования роутера — вся форма управления категориями молча не сохраняла изменения
- `POST /api/backup/restore` терял привязку устройств к площадкам, SNMP-индекс интерфейса трафика, настройки LDAP и webhook-событий — не восстанавливались из бэкапа
- `POST /api/features` сбрасывал флаг мониторинга трафика при сохранении любой другой настройки (отсутствовал в whitelist)
- XSS в непроявленной ранее вкладке логов — значения полей лога вставлялись в DOM без экранирования
- Кнопка смены пароля при первом входе была нерабочей (`ReferenceError`: не существовало функции `btnLoading`, на которую опирался обработчик — та же причина ломала генерацию токена агента и кнопку «Проверить сейчас»)
- Первый запуск `start.bat`/`install.bat` на Windows ложно завершался с ошибкой, если опциональная нативная зависимость (`cpu-features` у `ssh2`) не собралась — при этом основные зависимости уже стояли корректно
- `install.bat` обрывался сразу после установки зависимостей (пропущенный `call` перед `npm install`)
- Браузер открывался до полной готовности сервера при запуске через `start.bat`
- Кириллица могла отображаться как кракозябры на консолях без UTF-8 (Windows без `chcp 65001`, Linux/macOS без UTF-8 локали) — теперь во всех установочных/стартовых скриптах есть диагностика и/или переключение кодировки
- Принудительная смена пароля при первом входе требовала повторного ввода текущего (только что введённого на экране логина) пароля
- SVG-карта сети использовала фиксированные цвета вместо CSS-переменных темы — не подстраивалась под светлую тему

### Changed
- `engines.node` в `package.json` сужен до явных LTS-линий (`22.x`, `24.x`), исключая EOL и non-LTS ветки
- Зависимость `ldapjs` (официально decommissioned автором, без патчей безопасности с мая 2024) заменена на активно поддерживаемый `ldapts`
- `users` получили поле `source` (`local`/`ldap`) для различения происхождения аккаунта

---

## [0.9.0-beta] — 2026-08-06

### Added
- Device registry with pagination, filters, bulk operations, CSV export
- Interactive network map (SVG, drag & drop, tree layout, subnets)
- Ping monitoring with 7-day sparkline history
- Alerts: Telegram bot + Webhook, escalation, incidents log
- Integrations: MikroTik RouterOS API, UniFi Controller, Cisco SSH
- Network discovery: ping sweep, ARP, MNDP, auto-topology
- SNMP monitoring and TCP port checks (optional feature flags)
- Role-based access: admin / viewer + audit log
- HTTPS with self-signed cert generator, brute-force protection
- Backup / restore (JSON), CSV export
- Dark / light theme toggle
- Branding customization (logo, title, accent color)

