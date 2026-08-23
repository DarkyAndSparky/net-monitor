let DEVICES = [];
let CATEGORIES = [];
let SITES = [];
let TOPOLOGY = { edges: [] }; // реальные связи устройств, построенные автообнаружением
let FEATURES = { snmp: false, portChecks: false, incidents: false, auditLog: false }; // дополнительные модули
let STATUS = {};   // id -> { online: true|false|null, monitored: bool, lastChecked: number|null }
let UPTIME = {};   // id -> { uptime24h, uptime7d, samples: [{t,online}] }
let CURRENT_ROLE = 'admin'; // 'admin' | 'operator' | 'viewer' — управляет видимостью через admin-only/strict-admin-only
let editingId = null;

const catById = id => CATEGORIES.find(c => c.id === id) || { name: id, color: '#6b7280' };

// ---------------- AUTH ----------------
async function checkAuth() {
  const res = await fetch('/api/me');
  if (res.ok) {
    const me = await res.json();
    if (me.mustChangePassword) { showForcedPasswordChange(me.username); return; }
    showApp(me.username, me.role);
  } else {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('app-root').classList.add('hidden');
  setTimeout(() => document.getElementById('l-username').focus(), 50);
}

function showApp(username, role) {
  CURRENT_ROLE = ['admin', 'operator', 'viewer'].includes(role) ? role : 'admin';
  document.body.classList.toggle('role-viewer', CURRENT_ROLE === 'viewer');
  document.body.classList.toggle('role-operator', CURRENT_ROLE === 'operator');
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('app-root').classList.remove('hidden');
  const roleLabel = CURRENT_ROLE === 'admin' ? 'администратор' : CURRENT_ROLE === 'operator' ? 'operator' : 'только просмотр';
  document.getElementById('current-user').innerHTML = `👤 ${esc(username)} <span class="role-badge">${roleLabel}</span>`;
  loadAll();
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('l-username').value;
  const password = document.getElementById('l-password').value;
  const errBox = document.getElementById('login-error');
  errBox.classList.add('hidden');
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (res.ok) {
    const data = await res.json();
    if (data.mustChangePassword) { showForcedPasswordChange(data.username); return; }
    showApp(data.username, data.role);
  } else {
    const data = await res.json().catch(() => ({}));
    errBox.textContent = res.status === 429 ? (data.message || 'Слишком много попыток входа, попробуйте позже.') : 'Неверный логин или пароль';
    errBox.classList.remove('hidden');
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
});

/* ══════════════════════════════════════════════════════════
   ПРИНУДИТЕЛЬНАЯ СМЕНА ПАРОЛЯ (первый вход / новый пользователь)
══════════════════════════════════════════════════════════ */

function showForcedPasswordChange(username) {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('app-root').classList.add('hidden');
  document.getElementById('forced-pwchange-overlay').classList.remove('hidden');
  document.getElementById('fpw-new').value = '';
  document.getElementById('fpw-confirm').value = '';
  document.getElementById('forced-pwchange-error').classList.add('hidden');
  setTimeout(() => document.getElementById('fpw-new').focus(), 50);
  _forcedPwUsername = username;
}

let _forcedPwUsername = null;

document.getElementById('forced-pwchange-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = document.getElementById('forced-pwchange-error');
  errBox.classList.add('hidden');

  const newPassword = document.getElementById('fpw-new').value;
  const confirm = document.getElementById('fpw-confirm').value;

  if (newPassword !== confirm) {
    errBox.textContent = 'Пароли не совпадают';
    errBox.classList.remove('hidden');
    return;
  }
  if (newPassword.length < 8) {
    errBox.textContent = 'Пароль должен быть не короче 8 символов';
    errBox.classList.remove('hidden');
    return;
  }

  const btn = e.target.querySelector('button[type="submit"]');
  const restore = btnLoading(btn);
  try {
    const res = await fetch('/api/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errBox.textContent = data.message || (data.error === 'wrong_current_password' ? 'Неверный текущий пароль' : 'Ошибка смены пароля');
      errBox.classList.remove('hidden');
      return;
    }
    document.getElementById('forced-pwchange-overlay').classList.add('hidden');
    toast('Пароль изменён', 'success');
    // Роль на этот момент нам неизвестна из этого ответа — берём через /api/me
    const me = await fetch('/api/me').then(r => r.json());
    showApp(me.username, me.role);
  } catch (err) {
    errBox.textContent = 'Ошибка соединения с сервером';
    errBox.classList.remove('hidden');
  } finally {
    restore();
  }
});

// Обёртка над fetch: если сессия истекла — показываем экран логина
async function api(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) { showLogin(); throw new Error('auth'); }
  if (res.status === 403) {
    let data = {};
    try { data = await res.clone().json(); } catch {}
    if (data.error === 'password_change_required') {
      const me = await fetch('/api/me').then(r => r.json()).catch(() => ({}));
      showForcedPasswordChange(me.username || '');
      throw new Error('password_change_required');
    }
  }
  if (res.status === 429) {
    let msg = 'Слишком много запросов, подождите немного';
    try { const data = await res.clone().json(); if (data.message) msg = data.message; } catch {}
    const retryAfter = res.headers.get('RateLimit-Reset') || res.headers.get('Retry-After');
    if (retryAfter) msg += ` (~${Math.ceil(Number(retryAfter))} сек)`;
    toast(msg, 'warning', 6000);
    throw new Error('rate_limited');
  }
  return res;
}

// ---------------- LOAD ----------------
async function loadAll() {
  try {
    const [devices, categories, sites] = await Promise.all([
      api('/api/devices').then(r => r.json()),
      api('/api/categories').then(r => r.json()),
      api('/api/sites').then(r => r.json()).catch(() => [])
    ]);
    DEVICES = devices;
    CATEGORIES = categories;
    SITES = sites;
    try { TOPOLOGY = await api('/api/topology').then(r => r.json()); } catch (e) { TOPOLOGY = { edges: [] }; }
    try { SUBNET_RULES = await api('/api/subnet-rules').then(r => r.json()); } catch (e) { SUBNET_RULES = []; }
    try { FEATURES = await api('/api/features').then(r => r.json()); } catch (e) { /* оставляем дефолт: всё выключено */ }
    applyFeatureVisibility();
    fillCategorySelects();
    fillSiteSelects();
    renderDashboard();
    loadDashboardWidgets();
    renderDevices();
    renderMap();
    renderMonitoring();
    loadSettings();
    refreshStatus();
    refreshUptime();
    connectSSE();  // SSE: подписываемся на живые обновления
  } catch (e) { /* сессия истекла — уже показали логин */ }
}

function fillCategorySelects() {
  const filterSel = document.getElementById('filter-category');
  const formSel = document.getElementById('f-category');
  const bulkSel = document.getElementById('bulk-category-select');
  filterSel.innerHTML = '<option value="">Все категории</option>' +
    CATEGORIES.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  formSel.innerHTML = CATEGORIES.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  bulkSel.innerHTML = `<option value="">Категория...</option>` + CATEGORIES.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
}

// ---------------- STATUS (мгновенный пинг) ----------------
async function refreshStatus() {
  try {
    const res = await api('/api/status').then(r => r.json());
    res.forEach(s => STATUS[s.id] = s);
  } catch (e) { return; }
  renderDashboard();
  renderDevicesStatusOnly();
  renderMap();
  renderMonitoring();
}

// ── SSE: живые обновления статусов без перезагрузки ─────────────────
// Подключаемся один раз после логина. При разрыве — переподключаемся
// через 5 сек. В качестве fallback оставляем polling раз в 60 сек.

let _sseSource = null;
let _sseReconnectTimer = null;

function connectSSE() {
  if (_sseSource) { _sseSource.close(); _sseSource = null; }
  clearTimeout(_sseReconnectTimer);

  const es = new EventSource('/api/events');
  _sseSource = es;

  // snapshot — полный статус при первом подключении
  es.addEventListener('snapshot', e => {
    try {
      const list = JSON.parse(e.data);
      list.forEach(s => { STATUS[s.id] = { ...STATUS[s.id], ...s }; });
      renderDashboard();
      renderDevicesStatusOnly();
      renderMap();
      renderMonitoring();
    } catch {}
  });

  // status — смена статуса одного устройства
  es.addEventListener('status', e => {
    try {
      const s = JSON.parse(e.data);
      STATUS[s.id] = { ...STATUS[s.id], ...s, monitored: true };

      // Обновляем только нужный узел на карте — без полной перерисовки
      updateMapNode(s.id);

      // Счётчики дашборда и строки таблиц
      renderDashboard();
      renderDevicesStatusOnly();
      renderMonitoringRow(s.id);
    } catch {}
  });

  // incident — новый инцидент (если включён модуль)
  es.addEventListener('incident', e => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === 'open') toast(`🔴 Инцидент: ${ev.deviceName} недоступно`, 'error', 6000);
      if (ev.type === 'close') toast(`🟢 Восстановлено: ${ev.deviceName}`, 'success', 4000);
    } catch {}
  });

  // traffic — новая точка трафика (дебаунс на клиенте: обновляем таблицу не чаще раза в 3 сек)
  es.addEventListener('traffic', () => {
    const now = Date.now();
    if (now - _lastTrafficReload < 3000) return;
    _lastTrafficReload = now;
    if (document.getElementById('tab-traffic')?.classList.contains('active')) loadTraffic();
  });

  // agent — новый отчёт от агента (обновляем только если открыта детальная
  // страница именно этого устройства)
  es.addEventListener('agent', e => {
    try {
      const ev = JSON.parse(e.data);
      if (_ddDeviceId === ev.deviceId && !document.getElementById('device-detail-overlay')?.classList.contains('hidden')) {
        loadAgentPanel();
      }
    } catch {}
  });

  es.onerror = () => {
    es.close(); _sseSource = null;
    _sseReconnectTimer = setTimeout(connectSSE, 5000);
  };
}

// Обновление одного узла на SVG-карте без перерисовки всего
function updateMapNode(deviceId) {
  const svg = document.getElementById('network-svg');
  if (!svg) return;
  const node = svg.querySelector(`.map-node[data-id="${deviceId}"]`);
  if (!node) return;

  const d = DEVICES.find(x => x.id === deviceId);
  if (!d) return;
  const s = STATUS[deviceId];
  if (!s) return;

  let ringColor = 'var(--map-edge)';
  if (d.monitored && s) {
    ringColor = s.online === true ? 'var(--green)' : s.online === false ? 'var(--red)' : 'var(--map-edge)';
  }

  const circle = node.querySelector('circle[r="16"]');
  if (circle) {
    circle.setAttribute('stroke', ringColor);
  }
}

// Обновление одной строки в таблице мониторинга
function renderMonitoringRow(deviceId) {
  const row = document.querySelector(`#monitoring-table tr[data-id="${deviceId}"]`);
  if (!row) return;
  const s = STATUS[deviceId];
  if (!s) return;
  const statusCell = row.querySelector('.status-cell');
  if (!statusCell) return;
  const online = s.online;
  statusCell.innerHTML = online === true
    ? '<span class="status-badge status-online">Online</span>'
    : online === false
      ? '<span class="status-badge status-offline">Offline</span>'
      : '<span class="status-badge status-unknown">—</span>';
}

// Fallback polling — на случай если SSE не поддерживается или отвалился надолго
setInterval(refreshStatus, 60000);  // было 15000, теперь 60000 — SSE делает основную работу

// ---------------- UPTIME / ИСТОРИЯ ----------------
async function refreshUptime() {
  try {
    UPTIME = await api('/api/uptime').then(r => r.json());
  } catch (e) { return; }
  renderDashboard();
}
setInterval(refreshUptime, 60000);
setInterval(() => {
  if (document.getElementById('tab-dashboard')?.classList.contains('active')) loadDashboardWidgets();
}, 60000);

function sparklineHTML(deviceId) {
  const info = UPTIME[deviceId];
  const samples = (info && info.samples) || [];
  if (!samples.length) return '<div class="hint">История ещё копится (обновляется раз в минуту)</div>';
  const bars = samples.map(s => `<div class="bar ${s.online ? 'up' : 'down'}" style="height:${s.online ? 20 : 10}px"></div>`).join('');
  const u24 = info.uptime24h != null ? info.uptime24h + '%' : '—';
  const u7 = info.uptime7d != null ? info.uptime7d + '%' : '—';
  return `<div class="sparkline">${bars}</div>
    <div class="uptime-line"><span>Аптайм 24ч: ${u24}</span><span>7д: ${u7}</span></div>`;
}

// ---------------- DASHBOARD ----------------
function currentDashboardSite() {
  return document.getElementById('dashboard-site-select')?.value || '';
}
function renderDashboard() {
  const siteFilter = currentDashboardSite();
  const scopedDevices = siteFilter ? DEVICES.filter(d => d.site === siteFilter) : DEVICES;

  const cardsWrap = document.getElementById('category-cards');
  cardsWrap.innerHTML = CATEGORIES.map(c => {
    const count = scopedDevices.filter(d => d.category === c.id).length;
    return `<div class="stat-card">
      <div class="num"><span class="dot" style="background:${esc(c.color)}"></span>${count}</div>
      <div class="label">${esc(c.name)}</div>
    </div>`;
  }).join('') + `<div class="stat-card">
      <div class="num">${scopedDevices.length}</div>
      <div class="label">Всего устройств${siteFilter ? ' на площадке' : ''}</div>
    </div>`;

  const key = scopedDevices.filter(d => d.key);
  const keyWrap = document.getElementById('key-devices');
  if (!scopedDevices.length) {
    keyWrap.innerHTML = `<div class="empty-state">
      <i class="ti ti-server-off"></i>
      <h3>${siteFilter ? 'На этой площадке пока нет устройств' : 'Устройств пока нет'}</h3>
      <p>${siteFilter ? 'Привяжите устройства к площадке в форме редактирования.' : 'Добавьте первое устройство вручную или импортируйте из MikroTik / CSV.'}</p>
      ${!siteFilter && CURRENT_ROLE !== 'viewer' ? "<button class=\"empty-action\" onclick=\"showTab(&quot;devices&quot;);openAdd()\">+ Добавить устройство</button>" : ''}
    </div>`;
    return;
  }

  keyWrap.innerHTML = key.length ? key.map(d => {
    const s = STATUS[d.id];
    let cls, label;
    if (!d.monitored) { cls = 'status-unknown'; label = 'Не отслеживается'; }
    else if (!s) { cls = 'status-unknown'; label = 'Проверка...'; }
    else if (s.online === true) { cls = 'status-online'; label = 'В сети'; }
    else if (s.online === false) { cls = 'status-offline'; label = 'Недоступно'; }
    else { cls = 'status-unknown'; label = 'Проверка...'; }
    return `<div class="key-device-card">
      <div class="top-row">
        <div>
          <div class="name">${esc(d.name)}</div>
          <div class="ip">${esc(d.ip || '—')}</div>
        </div>
        <span class="status-badge ${cls}">${label}</span>
      </div>
      ${d.monitored ? sparklineHTML(d.id) : '<div class="hint">Включите мониторинг во вкладке «Мониторинг», чтобы видеть историю.</div>'}
    </div>`;
  }).join('') : `<div class="hint">Отметьте устройства как «ключевые» в форме редактирования — они появятся здесь.</div>`;
}

document.getElementById('dashboard-site-select').addEventListener('change', () => {
  renderDashboard();
  loadDashboardWidgets();
});

// ---------------- ДАШБОРД v2: SLA-виджеты и heat map ----------------
function slaClass(pct) {
  if (pct === null || pct === undefined) return '';
  if (pct >= 99) return 'num-green';
  if (pct >= 95) return 'num-yellow';
  return 'num-red';
}

async function loadDashboardWidgets() {
  if (!DEVICES.length) {
    document.getElementById('dashboard-widgets').innerHTML = '';
    document.getElementById('status-heatmap-wrap').innerHTML = '';
    document.getElementById('heatmap-range-hint').textContent = '';
    return;
  }
  try {
    const siteFilter = currentDashboardSite();
    const data = await api(`/api/dashboard/widgets?days=14${siteFilter ? '&site=' + encodeURIComponent(siteFilter) : ''}`).then(r => r.json());
    const widgetsWrap = document.getElementById('dashboard-widgets');
    const cards = [];
    if (data.sla24h !== null) cards.push(`<div class="stat-card"><div class="num ${slaClass(data.sla24h)}">${data.sla24h}%</div><div class="label">SLA за 24 часа</div></div>`);
    if (data.sla7d !== null) cards.push(`<div class="stat-card"><div class="num ${slaClass(data.sla7d)}">${data.sla7d}%</div><div class="label">SLA за 7 дней</div></div>`);
    cards.push(`<div class="stat-card"><div class="num ${data.offline > 0 ? 'num-red' : 'num-green'}">${data.online}/${data.totalMonitored}</div><div class="label">В сети из отслеживаемых</div></div>`);
    if (data.unknown > 0) cards.push(`<div class="stat-card"><div class="num">${data.unknown}</div><div class="label">Статус не определён</div></div>`);
    if (data.openIncidents !== null) cards.push(`<div class="stat-card"><div class="num ${data.openIncidents > 0 ? 'num-red' : 'num-green'}">${data.openIncidents}</div><div class="label">Открытых инцидентов</div></div>`);
    widgetsWrap.innerHTML = cards.join('');

    renderStatusHeatmap(data);
  } catch (e) { /* нет прав или сеть — просто не показываем */ }
}

function heatmapCellColor(pct) {
  if (pct === null || pct === undefined) return '';
  if (pct >= 99) return 'background:var(--green);';
  if (pct >= 90) return `background:var(--yellow); opacity:${0.5 + (pct - 90) / 20};`;
  return `background:var(--red); opacity:${0.5 + Math.min(pct, 50) / 100};`;
}

function renderStatusHeatmap(data) {
  const wrap = document.getElementById('status-heatmap-wrap');
  const hint = document.getElementById('heatmap-range-hint');
  if (!data.heatmap.length) {
    wrap.innerHTML = '<div class="hint">Нет устройств под мониторингом — heat map появится, когда будут накоплены данные.</div>';
    hint.textContent = '';
    return;
  }
  hint.textContent = `(${data.days[0]} — ${data.days[data.days.length - 1]})`;
  const dayHeader = `<div class="heatmap-days-header">${data.days.map(d => `<span title="${d}">${d.slice(8, 10)}</span>`).join('')}</div>`;
  const rows = data.heatmap.map(dev => {
    const cells = dev.days.map(d => {
      const pctLabel = d.pct === null ? 'нет данных' : `${d.pct}% онлайн`;
      const cls = d.pct === null ? 'heatmap-cell hm-nodata' : 'heatmap-cell';
      return `<span class="${cls}" style="${heatmapCellColor(d.pct)}" title="${esc(dev.name)} · ${d.date} · ${pctLabel}"></span>`;
    }).join('');
    return `<div class="heatmap-row"><span class="heatmap-names" title="${esc(dev.name)}">${esc(dev.name)}</span>${cells}</div>`;
  }).join('');
  wrap.innerHTML = dayHeader + rows;
}

// ---------------- DEVICES: TABLE / CARDS ----------------
let SORT_STATE = { field: null, dir: 1 };

function currentFilteredDevices() {
  const cat = document.getElementById('filter-category').value;
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  let list = DEVICES.filter(d => {
    if (cat && d.category !== cat) return false;
    if (!q) return true;
    return [d.name, d.ip, d.mac, d.location, d.type].join(' ').toLowerCase().includes(q);
  });
  if (SORT_STATE.field) {
    const f = SORT_STATE.field;
    list = [...list].sort((a, b) => {
      const va = (f === 'category' ? catById(a.category).name : (a[f] || '')).toString().toLowerCase();
      const vb = (f === 'category' ? catById(b.category).name : (b[f] || '')).toString().toLowerCase();
      if (va < vb) return -1 * SORT_STATE.dir;
      if (va > vb) return 1 * SORT_STATE.dir;
      return 0;
    });
  }
  return list;
}

document.querySelectorAll('#devices-table th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const field = th.dataset.sort;
    if (SORT_STATE.field === field) {
      SORT_STATE.dir *= -1;
    } else {
      SORT_STATE = { field, dir: 1 };
    }
    document.querySelectorAll('#devices-table th.sortable').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
    th.classList.add(SORT_STATE.dir === 1 ? 'sort-asc' : 'sort-desc');
    PAGE_STATE.page = 1;
    renderDevices();
  });
});

// Копирование значения по клику (используется для IP/MAC в таблице устройств)
async function copyToClipboard(text, el) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const original = el.textContent;
    el.textContent = 'Скопировано';
    setTimeout(() => { el.textContent = original; }, 900);
  } catch (e) { /* буфер обмена недоступен (например, не HTTPS) — тихо игнорируем */ }
}

let SELECTED_DEVICE_IDS = new Set();
let PAGE_STATE = { page: 1, pageSize: 50 };

function renderDevices() {
  const list = currentFilteredDevices();

  document.getElementById('devices-empty-state').classList.toggle('hidden', DEVICES.length > 0);
  if (!DEVICES.length) {
    document.getElementById('devices-empty-state').innerHTML = CURRENT_ROLE !== 'viewer'
      ? 'Пока нет ни одного устройства. <button class="btn-primary" onclick="openAdd()" style="margin-left:8px;">+ Добавить первое устройство</button> или импортируйте их из «Настроек» (CSV / MikroTik).'
      : 'Пока нет ни одного устройства.';
  }
  // забываем выделение устройств, которые перестали быть видны (удалены/отфильтрованы)
  const visibleIds = new Set(list.map(d => d.id));
  SELECTED_DEVICE_IDS.forEach(id => { if (!visibleIds.has(id)) SELECTED_DEVICE_IDS.delete(id); });

  // Пагинация — считается от полного отфильтрованного списка; выделение (чекбоксы) сохраняется
  // между страницами, т.к. хранится по id, а не по позиции.
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_STATE.pageSize));
  if (PAGE_STATE.page > totalPages) PAGE_STATE.page = totalPages;
  if (PAGE_STATE.page < 1) PAGE_STATE.page = 1;
  const startIdx = (PAGE_STATE.page - 1) * PAGE_STATE.pageSize;
  const pageList = list.slice(startIdx, startIdx + PAGE_STATE.pageSize);

  const paginationBar = document.getElementById('devices-pagination');
  if (list.length > 0) {
    paginationBar.classList.remove('hidden');
    document.getElementById('pagination-info').textContent =
      `Показано ${startIdx + 1}–${Math.min(startIdx + PAGE_STATE.pageSize, list.length)} из ${list.length}`;
    document.getElementById('page-prev-btn').disabled = PAGE_STATE.page <= 1;
    document.getElementById('page-next-btn').disabled = PAGE_STATE.page >= totalPages;
  } else {
    paginationBar.classList.add('hidden');
  }

  const tbody = document.getElementById('devices-tbody');
  tbody.innerHTML = pageList.map(d => {
    const c = catById(d.category);
    const s = STATUS[d.id];
    const dotColor = !d.monitored ? 'var(--text-dim)' : (s && s.online === true ? 'var(--green)' : s && s.online === false ? 'var(--red)' : 'var(--text-dim)');
    const dotTitle = !d.monitored ? 'Не отслеживается' : (s && s.online === true ? 'В сети' : s && s.online === false ? 'Недоступно' : '—');
    return `<tr data-id="${d.id}">
      <td class="admin-only"><input type="checkbox" class="row-select" data-id="${d.id}" ${SELECTED_DEVICE_IDS.has(d.id) ? 'checked' : ''}></td>
      <td><span class="status-dot" style="background:${dotColor}" title="${dotTitle}"></span></td>
      <td><span title="${esc(d.type)}">${iconFor(d)}</span> ${esc(d.name)}</td>
      <td><span class="copyable" title="Скопировать IP" onclick="copyToClipboard('${esc(d.ip)}', this)">${esc(d.ip)}</span></td>
      <td>
        <span class="copyable" title="Скопировать MAC" onclick="copyToClipboard('${esc(d.mac)}', this)">${esc(d.mac)}</span>
        ${d.vendor ? `<div class="hint" style="white-space:nowrap;">${esc(d.vendor)}</div>` : ''}
      </td>
      <td>${esc(d.location)}</td>
      <td>${esc(d.type)}</td>
      <td><span class="cat-badge" style="background:${esc(c.color)}22;color:${esc(c.color)}">${esc(c.name)}</span></td>
      <td>${esc(d.comment)}</td>
      <td class="row-actions admin-only">
        <button onclick="openDeviceDetail('${d.id}')" title="Подробнее">🔍</button>
        <button onclick="openEdit('${d.id}')">✎</button>
        <button onclick="duplicateDevice('${d.id}')" title="Дублировать">⧉</button>
        <button onclick="deleteDevice('${d.id}')">🗑</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.row-select').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) SELECTED_DEVICE_IDS.add(cb.dataset.id); else SELECTED_DEVICE_IDS.delete(cb.dataset.id);
      updateBulkActionsBar();
    });
  });
  updateBulkActionsBar();

  const cardsWrap = document.getElementById('devices-cards-wrap');
  cardsWrap.innerHTML = pageList.map(d => {
    const c = catById(d.category);
    const s = STATUS[d.id];
    let cls, label;
    if (!d.monitored) { cls = 'status-unknown'; label = 'Не отслеж.'; }
    else if (s && s.online === true) { cls = 'status-online'; label = 'В сети'; }
    else if (s && s.online === false) { cls = 'status-offline'; label = 'Недоступно'; }
    else { cls = 'status-unknown'; label = '—'; }
    return `<div class="device-card">
      <div class="top">
        <div>
          <div class="name">${iconFor(d)} ${esc(d.name)}</div>
          <div class="type">${esc(d.type)}</div>
        </div>
        <span class="status-badge ${cls}">${label}</span>
      </div>
      <dl>
        <div><span>IP</span><span class="copyable" title="Скопировать" onclick="copyToClipboard('${esc(d.ip)}', this)">${esc(d.ip || '—')}</span></div>
        <div><span>MAC</span><span class="copyable" title="Скопировать" onclick="copyToClipboard('${esc(d.mac)}', this)">${esc(d.mac || '—')}${d.vendor ? ` <span style="opacity:.7;">(${esc(d.vendor)})</span>` : ''}</span></div>
        <div><span>Расположение</span><span>${esc(d.location || '—')}</span></div>
        <div><span>Категория</span><span style="color:${esc(c.color)}">${esc(c.name)}</span></div>
      </dl>
      ${d.comment ? `<div class="comment">${esc(d.comment)}</div>` : ''}
      <div class="row-actions admin-only">
        <button onclick="openDeviceDetail('${d.id}')">🔍 Подробнее</button>
        <button onclick="openEdit('${d.id}')">✎ Изменить</button>
        <button onclick="duplicateDevice('${d.id}')">⧉ Дублировать</button>
        <button onclick="deleteDevice('${d.id}')">🗑 Удалить</button>
      </div>
    </div>`;
  }).join('');
}

function updateBulkActionsBar() {
  const bar = document.getElementById('bulk-actions-bar');
  const count = SELECTED_DEVICE_IDS.size;
  bar.classList.toggle('hidden', count === 0);
  document.getElementById('bulk-selected-count').textContent = `Выбрано: ${count}`;
  const selectAll = document.getElementById('select-all-devices');
  const visibleChecked = document.querySelectorAll('.row-select').length;
  selectAll.checked = visibleChecked > 0 && visibleChecked === document.querySelectorAll('.row-select:checked').length;
}

document.getElementById('select-all-devices').addEventListener('change', (e) => {
  document.querySelectorAll('.row-select').forEach(cb => {
    cb.checked = e.target.checked;
    if (e.target.checked) SELECTED_DEVICE_IDS.add(cb.dataset.id); else SELECTED_DEVICE_IDS.delete(cb.dataset.id);
  });
  updateBulkActionsBar();
});

document.getElementById('bulk-clear-selection').addEventListener('click', () => {
  SELECTED_DEVICE_IDS.clear();
  renderDevices();
});

document.getElementById('bulk-delete-btn').addEventListener('click', async () => {
  const ids = [...SELECTED_DEVICE_IDS];
  if (!ids.length) return;
  if (!confirm(`Удалить выбранные устройства (${ids.length} шт.)? Действие необратимо.`)) return;
  await api('/api/devices/bulk-delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids })
  });
  SELECTED_DEVICE_IDS.clear();
  await loadAll();
});

document.getElementById('bulk-enable-monitoring').addEventListener('click', () => bulkUpdateSelected({ monitored: true }));
document.getElementById('bulk-disable-monitoring').addEventListener('click', () => bulkUpdateSelected({ monitored: false }));
document.getElementById('bulk-apply-category').addEventListener('click', () => {
  const category = document.getElementById('bulk-category-select').value;
  if (!category) return;
  bulkUpdateSelected({ category });
});

async function bulkUpdateSelected(patch) {
  const ids = [...SELECTED_DEVICE_IDS];
  if (!ids.length) return;
  await api('/api/devices/bulk-update', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, patch })
  });
  await loadAll();
}

document.getElementById('export-devices-csv-btn').addEventListener('click', async () => {
  try {
    const res = await api('/api/devices/export.csv');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `netmonitor-devices-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { /* сессия истекла — уже показали логин через api() */ }
});

function renderDevicesStatusOnly() {
  document.querySelectorAll('#devices-tbody tr').forEach(tr => {
    const id = tr.dataset.id;
    const d = DEVICES.find(d => d.id === id);
    const s = STATUS[id];
    const dot = tr.querySelector('.status-dot');
    if (!dot) return;
    if (!d || !d.monitored) dot.style.background = 'var(--text-dim)';
    else dot.style.background = s && s.online === true ? 'var(--green)' : s && s.online === false ? 'var(--red)' : 'var(--text-dim)';
  });
}

function esc(s) {
  return (s || '').toString().replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// ---------------- TOAST-УВЕДОМЛЕНИЯ ----------------
// Разметка (#toast-container) и вся анимация уже были в HTML/CSS — не хватало
// только этой функции. Использовалась по всему коду (24 места), но нигде не
// была объявлена: каждый вызов ронял ReferenceError и молча обрывал остаток
// содержащей его функции.
const TOAST_ICONS = { success: 'ti-circle-check', error: 'ti-circle-x', warning: 'ti-alert-triangle', info: 'ti-info-circle' };
function toast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="ti ${TOAST_ICONS[type] || TOAST_ICONS.info}"></i><div class="toast-msg">${esc(message)}</div><button type="button" class="toast-close" aria-label="Закрыть">✕</button>`;
  const remove = () => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.toast-close').addEventListener('click', remove);
  const timer = setTimeout(remove, duration);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  container.appendChild(el);
}

// ---------------- ПОДТВЕРЖДЕНИЕ ДЕЙСТВИЯ (замена window.confirm) ----------------
// Разметка и CSS уже существовали (#confirm-dialog-overlay), функции не было.
function showConfirm(title, subtitle = '', options = {}) {
  return new Promise(resolve => {
    const overlay = document.getElementById('confirm-dialog-overlay');
    document.getElementById('confirm-dialog-title').textContent = title;
    document.getElementById('confirm-dialog-text').textContent = subtitle;
    const okBtn = document.getElementById('confirm-dialog-ok');
    const cancelBtn = document.getElementById('confirm-dialog-cancel');
    okBtn.textContent = options.okLabel || 'Удалить';
    okBtn.className = options.okClass || '';
    if (!options.okClass) okBtn.removeAttribute('style'); // сброс на дефолтный красный стиль из CSS (#confirm-dialog-ok)

    const cleanup = (result) => {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlayClick = (e) => { if (e.target === overlay) cleanup(false); };
    const onKeydown = (e) => { if (e.key === 'Escape') cleanup(false); };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown);
    overlay.classList.remove('hidden');
    setTimeout(() => cancelBtn.focus(), 50);
  });
}

// ---------------- ПЕРЕКЛЮЧЕНИЕ ВКЛАДОК ПРОГРАММНО ----------------
// Обычный клик по .nav-btn уже был закольцован отдельным обработчиком ниже —
// эта функция нужна для программных переходов (пустые состояния, горячие
// клавиши), которые эту логику не проходили и были сломаны.
function showTab(tabName) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const btn = document.querySelector(`.nav-btn[data-tab="${tabName}"]`);
  const panel = document.getElementById('tab-' + tabName);
  if (btn) btn.classList.add('active');
  if (panel) panel.classList.add('active');
  if (tabName === 'discovery') initDiscoveryTab();
  if (tabName === 'incidents') loadIncidents();
}

// Индикатор загрузки на кнопке: добавляет класс .loading (спиннер уже есть в CSS
// через ::before) и блокирует повторный клик. Возвращает restore() для отмены.
function btnLoading(btn) {
  if (!btn) return () => {};
  const wasDisabled = btn.disabled;
  btn.classList.add('loading');
  btn.disabled = true;
  return () => {
    btn.classList.remove('loading');
    btn.disabled = wasDisabled;
  };
}

// ---------------- MAP (SVG) ----------------
// ---------------- КАРТА: состояние ----------------
let MAP_VIEW = { x: 0, y: 0, w: 1000, h: 650 }; // текущий viewBox (зум/пан)
let LINK_EDIT_MODE = false;
let SEARCH_MATCH_ID = null; // id узла, подсвеченного поиском по карте
let LINK_EDIT_FIRST = null; // id первого выбранного узла при создании связи
let SUBNET_RULES = [];
let TREE_VIEW = false;
let TREE_ORIENTATION = 'vertical'; // 'vertical' (сверху вниз) | 'horizontal' (слева направо)
let TREE_POSITIONS = {}; // id -> {x,y}, пересчитывается при каждом рендере в режиме дерева

// ---------------- РЕЖИМ «ДЕРЕВО»: автоматическая иерархическая раскладка ----------------
// Строится по связям (TOPOLOGY.edges — и автообнаруженным, и проведённым вручную).
// «from» считается родителем «to». Если у узла несколько входящих связей — для раскладки
// берётся первая, остальные всё равно рисуются (как дополнительные линии).
function computeTreeLayout() {
  const deviceIds = new Set(DEVICES.map(d => d.id));
  const parentOf = {};      // childId -> parentId (первая связь)
  const childrenOf = {};    // parentId -> [childId, ...]
  const touched = new Set();

  (TOPOLOGY.edges || []).forEach(e => {
    if (!deviceIds.has(e.from) || !deviceIds.has(e.to) || e.from === e.to) return;
    touched.add(e.from); touched.add(e.to);
    if (parentOf[e.to] == null) {
      parentOf[e.to] = e.from;
      if (!childrenOf[e.from]) childrenOf[e.from] = [];
      childrenOf[e.from].push(e.to);
    }
  });

  const roots = [...touched].filter(id => parentOf[id] == null);
  const orphans = DEVICES.filter(d => !touched.has(d.id)).map(d => d.id);

  const LEVEL_GAP = 130, LEAF_SPACING = 120;
  const depthPos = {}; // id -> {depth, leaf} — считаем в абстрактных координатах, потом переводим в x/y
  let leafCounter = 0;

  function assignLeaf(nodeId, depth, ancestors) {
    if (ancestors.has(nodeId)) { // защита от цикла (например, ручная связь создала петлю)
      const leaf = leafCounter; leafCounter++;
      depthPos[nodeId] = { depth, leaf };
      return leaf;
    }
    const nextAncestors = new Set(ancestors); nextAncestors.add(nodeId);
    const children = (childrenOf[nodeId] || []);
    if (!children.length) {
      const leaf = leafCounter; leafCounter++;
      depthPos[nodeId] = { depth, leaf };
      return leaf;
    }
    const childLeaves = children.map(c => assignLeaf(c, depth + 1, nextAncestors));
    const leaf = (Math.min(...childLeaves) + Math.max(...childLeaves)) / 2;
    depthPos[nodeId] = { depth, leaf };
    return leaf;
  }

  roots.forEach(r => assignLeaf(r, 0, new Set()));

  // Устройства без единой связи — отдельным рядом в конце, чтобы не терялись
  const maxDepthSoFar = () => Math.max(0, ...Object.values(depthPos).map(p => p.depth)) + 1;
  if (orphans.length) {
    const depth = maxDepthSoFar();
    orphans.forEach(id => { depthPos[id] = { depth, leaf: leafCounter }; leafCounter++; });
  }
  // Подстраховка: узлы, участвовавшие только в цикле без единого корня (a→b→c→a) — roots для
  // них не находится — не даём им остаться без позиции.
  const stillMissing = [...touched].filter(id => !depthPos[id]);
  if (stillMissing.length) {
    const depth = maxDepthSoFar();
    stillMissing.forEach(id => { depthPos[id] = { depth, leaf: leafCounter }; leafCounter++; });
  }

  const positions = {};
  Object.entries(depthPos).forEach(([id, p]) => {
    positions[id] = TREE_ORIENTATION === 'horizontal'
      ? { x: p.depth * LEVEL_GAP * 1.8, y: p.leaf * LEAF_SPACING }
      : { x: p.leaf * LEAF_SPACING, y: p.depth * LEVEL_GAP };
  });

  return { positions, parentOf, hasTree: touched.size > 0 };
}

// Текущая позиция узла на карте: в режиме дерева — вычисленная, иначе — сохранённая (ручная)
function getNodePos(d) {
  if (TREE_VIEW && TREE_POSITIONS[d.id]) return TREE_POSITIONS[d.id];
  return { x: d.x, y: d.y };
}

document.getElementById('tree-view-btn').addEventListener('click', () => {
  TREE_VIEW = !TREE_VIEW;
  document.getElementById('tree-view-btn').classList.toggle('active', TREE_VIEW);
  document.getElementById('tree-orientation-btn').classList.toggle('hidden', !TREE_VIEW);
  renderMap();
  fitMapToDevices();
});

document.getElementById('tree-orientation-btn').addEventListener('click', (e) => {
  TREE_ORIENTATION = TREE_ORIENTATION === 'vertical' ? 'horizontal' : 'vertical';
  e.target.textContent = TREE_ORIENTATION === 'vertical' ? '⇄ Горизонтально' : '⇅ Вертикально';
  renderMap();
  fitMapToDevices();
});

function ipToInt(ip) {
  const parts = (ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return null;
  return parts.reduce((acc, o) => (acc << 8) + o, 0) >>> 0;
}
function ipInCidr(ip, cidr) {
  const ipNum = ipToInt(ip);
  const [base, prefixStr] = (cidr || '').split('/');
  const baseNum = ipToInt(base);
  const prefix = parseInt(prefixStr, 10);
  if (ipNum == null || baseNum == null || isNaN(prefix)) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function applyMapView() {
  const svg = document.getElementById('network-svg');
  svg.setAttribute('viewBox', `${MAP_VIEW.x} ${MAP_VIEW.y} ${MAP_VIEW.w} ${MAP_VIEW.h}`);
}

function fitMapToDevices() {
  if (!DEVICES.length) { MAP_VIEW = { x: 0, y: 0, w: 1000, h: 650 }; applyMapView(); return; }
  const pad = 80;
  const positions = DEVICES.map(d => getNodePos(d));
  const xs = positions.map(p => p.x), ys = positions.map(p => p.y);
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const w = Math.max(200, maxX - minX), h = Math.max(150, maxY - minY);
  // сохраняем пропорции области просмотра (примерно как контейнер 1000x650)
  const targetRatio = 1000 / 650;
  let fw = w, fh = h;
  if (w / h > targetRatio) fh = w / targetRatio; else fw = h * targetRatio;
  MAP_VIEW = { x: minX - (fw - w) / 2, y: minY - (fh - h) / 2, w: fw, h: fh };
  applyMapView();
}

function zoomMap(factor) {
  const cx = MAP_VIEW.x + MAP_VIEW.w / 2, cy = MAP_VIEW.y + MAP_VIEW.h / 2;
  MAP_VIEW.w = Math.max(150, Math.min(6000, MAP_VIEW.w * factor));
  MAP_VIEW.h = Math.max(100, Math.min(4000, MAP_VIEW.h * factor));
  MAP_VIEW.x = cx - MAP_VIEW.w / 2;
  MAP_VIEW.y = cy - MAP_VIEW.h / 2;
  applyMapView();
}

document.getElementById('zoom-in-btn').addEventListener('click', () => zoomMap(0.8));
document.getElementById('zoom-out-btn').addEventListener('click', () => zoomMap(1.25));
document.getElementById('zoom-fit-btn').addEventListener('click', fitMapToDevices);

// ---------------- ПОИСК УСТРОЙСТВА НА КАРТЕ ----------------
function panToNode(d) {
  const pos = getNodePos(d);
  // держим текущий масштаб, но не мельче разумного минимума, чтобы узел было видно крупно
  MAP_VIEW.w = Math.min(MAP_VIEW.w, 700);
  MAP_VIEW.h = Math.min(MAP_VIEW.h, 450);
  MAP_VIEW.x = pos.x - MAP_VIEW.w / 2;
  MAP_VIEW.y = pos.y - MAP_VIEW.h / 2;
  applyMapView();
}

document.getElementById('map-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const resultBox = document.getElementById('map-search-result');
  if (!q) {
    SEARCH_MATCH_ID = null;
    resultBox.classList.add('hidden');
    renderMap();
    return;
  }
  const matches = DEVICES.filter(d =>
    (d.name || '').toLowerCase().includes(q) ||
    (d.ip || '').toLowerCase().includes(q) ||
    (d.mac || '').toLowerCase().includes(q)
  );
  resultBox.classList.remove('hidden');
  if (!matches.length) {
    SEARCH_MATCH_ID = null;
    resultBox.textContent = 'Ничего не найдено.';
  } else {
    SEARCH_MATCH_ID = matches[0].id;
    resultBox.textContent = matches.length === 1
      ? `Найдено: ${matches[0].name}`
      : `Найдено ${matches.length}: показываю первое — ${matches[0].name} (уточните запрос, если нужно другое)`;
    panToNode(matches[0]);
  }
  renderMap();
});

document.getElementById('link-edit-btn').addEventListener('click', () => {
  LINK_EDIT_MODE = !LINK_EDIT_MODE;
  LINK_EDIT_FIRST = null;
  document.getElementById('link-edit-btn').classList.toggle('active', LINK_EDIT_MODE);
  document.getElementById('link-edit-hint').classList.toggle('hidden', !LINK_EDIT_MODE);
  renderMap();
});
document.getElementById('link-edit-exit').addEventListener('click', () => document.getElementById('link-edit-btn').click());

// ---------------- КАРТА: рендер ----------------
function renderMap() {
  const svg = document.getElementById('network-svg');
  const list = DEVICES;
  const byId = id => list.find(d => d.id === id);
  let cloudsHtml = '', edgesHtml = '', nodesHtml = '';

  let treeInfo = null;
  if (TREE_VIEW) {
    treeInfo = computeTreeLayout();
    TREE_POSITIONS = treeInfo.positions;
  }

  // --- Облака подсетей (рисуются под всем остальным; в режиме дерева не показываем — там своя иерархия) ---
  if (!TREE_VIEW) {
    SUBNET_RULES.forEach(rule => {
      const members = list.filter(d => d.ip && ipInCidr(d.ip, rule.cidr));
      if (members.length < 1) return;
      const pad = 55;
      const xs = members.map(d => d.x), ys = members.map(d => d.y);
      const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
      const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
      cloudsHtml += `<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="28" ry="28"
        fill="${esc(rule.color)}" fill-opacity="0.10" stroke="${esc(rule.color)}" stroke-opacity="0.45" stroke-width="1.5" stroke-dasharray="6,4" />
        <text x="${minX + 14}" y="${minY + 22}" font-size="12" font-weight="700" fill="${esc(rule.color)}">${esc(rule.label)} · ${esc(rule.cidr)}</text>`;
    });
  }

  // --- Связи ---
  const drawEdge = (a, b, opts) => {
    const pa = getNodePos(a), pb = getNodePos(b);
    const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
    const id = opts.id || '';
    edgesHtml += `<g class="map-edge" data-edge-id="${id}">
      <line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" stroke="${opts.color}" stroke-width="${opts.width}" ${opts.dash ? `stroke-dasharray="${opts.dash}"` : ''} />
      <line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" stroke="transparent" stroke-width="14" class="edge-hit" style="cursor:${LINK_EDIT_MODE ? 'pointer' : 'default'}" />
      ${opts.label ? `<text x="${mx}" y="${my - 4}" text-anchor="middle" font-size="9" fill="${opts.labelColor || 'var(--map-label)'}">${esc(opts.label)}</text>` : ''}
    </g>`;
  };

  if (TREE_VIEW) {
    // Рисуем связи «родитель → ребёнок» из построенного дерева. Если у узла больше одного
    // родителя — лишние связи всё равно рисуются, но тонкой дополнительной линией.
    const drawnAsTree = new Set();
    Object.entries(treeInfo.parentOf).forEach(([childId, parentId]) => {
      const a = byId(parentId), b = byId(childId);
      if (!a || !b) return;
      const edge = (TOPOLOGY.edges || []).find(e => e.from === parentId && e.to === childId);
      drawEdge(a, b, edge && edge.manual
        ? { color: 'var(--accent)', width: 2, label: edge.label }
        : { color: 'var(--map-edge)', width: 1.5, label: edge ? edge.interface : '' });
      drawnAsTree.add(parentId + '>' + childId);
    });
    (TOPOLOGY.edges || []).forEach(e => {
      if (drawnAsTree.has(e.from + '>' + e.to)) return;
      const a = byId(e.from), b = byId(e.to);
      if (!a || !b) return;
      drawEdge(a, b, { color: 'var(--map-edge-weak)', width: 1, dash: '2,3', label: e.label || e.interface });
    });
  } else if (TOPOLOGY.edges && TOPOLOGY.edges.length) {
    TOPOLOGY.edges.forEach(e => {
      const a = byId(e.from), b = byId(e.to);
      if (!a || !b) return;
      if (e.manual) {
        drawEdge(a, b, { id: e.id, color: 'var(--accent)', width: 2, label: e.label, labelColor: 'var(--accent)' });
      } else {
        drawEdge(a, b, { id: e.id, color: 'var(--map-edge)', width: 1.5, label: e.interface, labelColor: 'var(--map-label)' });
      }
    });
    const connected = new Set(TOPOLOGY.edges.flatMap(e => [e.from, e.to]));
    const core = list.find(d => d.category === 'network' && d.key) || list.find(d => d.category === 'network');
    if (core) {
      list.forEach(d => {
        if (d.id === core.id || connected.has(d.id)) return;
        drawEdge(core, d, { color: 'var(--map-edge-weak)', width: 1, dash: '2,3' });
      });
    }
  } else {
    const core = list.find(d => d.category === 'network' && d.key) || list.find(d => d.category === 'network');
    if (core) {
      list.forEach(d => {
        if (d.id === core.id) return;
        drawEdge(core, d, { color: 'var(--map-edge-weak)', width: 1.5 });
      });
    }
  }

  // --- Узлы ---
  list.forEach(d => {
    const c = catById(d.category);
    const s = STATUS[d.id];
    let ringColor = 'var(--map-edge)';
    if (d.monitored && s) {
      ringColor = s.online === true ? 'var(--green)' : s.online === false ? 'var(--red)' : 'var(--map-edge)';
    }
    const selected = LINK_EDIT_MODE && LINK_EDIT_FIRST === d.id;
    const found = SEARCH_MATCH_ID === d.id;
    const pos = getNodePos(d);
    const draggable = !TREE_VIEW; // в режиме дерева позиции считаются автоматически, тащить нечего
    nodesHtml += `<g class="map-node" data-id="${d.id}" transform="translate(${pos.x},${pos.y})" style="cursor:${LINK_EDIT_MODE ? 'pointer' : (draggable ? 'grab' : 'default')}">
      ${found ? `<circle r="26" fill="none" stroke="var(--yellow)" stroke-width="2" opacity="0.7"><animate attributeName="r" values="20;30;20" dur="1.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.8;0.1;0.8" dur="1.4s" repeatCount="indefinite"/></circle>` : ''}
      <circle r="16" fill="${esc(c.color)}" stroke="${selected ? 'var(--yellow)' : (found ? 'var(--yellow)' : ringColor)}" stroke-width="${selected || found ? 4 : 3}" ${!d.monitored ? 'stroke-dasharray="3,2"' : ''}/>
      <text y="4" text-anchor="middle" font-size="13" fill="white" font-weight="700">${iconFor(d)}</text>
      <text y="32" text-anchor="middle" font-size="11" fill="var(--text)" font-weight="600">${esc(d.name)}</text>
      <text y="46" text-anchor="middle" font-size="10" fill="var(--text-dim)">${esc(d.ip)}</text>
    </g>`;
  });

  svg.innerHTML = cloudsHtml + edgesHtml + nodesHtml;
  if (!DEVICES.length) {
    svg.innerHTML = `<foreignObject x="0" y="0" width="100%" height="100%">
      <div xmlns="http://www.w3.org/1999/xhtml" class="empty-state" style="height:100%;justify-content:center;">
        <i class="ti ti-topology-star-off" style="font-size:48px;opacity:.3;margin-bottom:16px;"></i>
        <h3 style="margin:0 0 8px;font-size:16px;">Карта пуста</h3>
        <p style="margin:0 0 20px;font-size:13px;text-align:center;max-width:300px;color:var(--text-dim)">Добавьте устройства чтобы они появились на карте</p>
      </div>
    </foreignObject>`;
    return;
  }
  applyMapView();
  attachMapInteractions(svg);

  const hint = document.getElementById('topology-hint');
  if (hint) {
    if (TREE_VIEW) {
      hint.textContent = treeInfo.hasTree
        ? 'Иерархия построена по связям (авто + ручные). Отдельным рядом внизу — устройства без связей. Чтобы изменить структуру дерева: «Редактировать связи».'
        : 'Связей пока нет — все устройства показаны отдельным рядом. Постройте автотопологию во вкладке «Обнаружение» или проведите связи вручную.';
    } else {
      hint.textContent = (TOPOLOGY.edges && TOPOLOGY.edges.length)
        ? `Связей на карте: ${TOPOLOGY.edges.length} · перетаскивайте узлы мышью · колесо мыши — зум`
        : 'Связи ещё не построены — используется условная звезда от ядра сети. Постройте автотопологию во вкладке «Обнаружение» или проведите связи вручную кнопкой выше.';
    }
  }

  document.getElementById('map-legend').innerHTML = CATEGORIES.map(c =>
    `<div class="legend-item"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</div>`
  ).join('');
}

function iconFor(d) {
  const type = typeof d === 'string' ? d : (d && d.type) || '';
  const category = typeof d === 'object' && d ? d.category : null;
  const t = type.toLowerCase();

  // Сетевое оборудование
  if (t.includes('router') || t.includes('роутер') || t.includes('маршрутизатор')) return '⇄';
  if (t.includes('firewall') || t.includes('файрвол') || t.includes('межсетев')) return '🛡';
  if (t.includes('switch') || t.includes('свитч') || t.includes('коммутатор')) return '▤';
  if (t.includes('hub') || t.includes('хаб')) return '▦';
  if (t.includes('access') || /\bap\b/.test(t) || t.includes('точка доступа') || t.includes('wi-fi') || t.includes('wifi')) return '📶';
  if (t.includes('modem') || t.includes('модем')) return '📡';

  // Видеонаблюдение
  if (t.includes('camera') || t.includes('камера') || t.includes('cctv')) return '◉';
  if (t.includes('nvr') || t.includes('dvr') || t.includes('видеорегистратор')) return '⏺';

  // Серверы и хранилища
  if (t.includes('nas') || t.includes('storage') || t.includes('хранилищ')) return '🗄';
  if (t.includes('server') || t.includes('сервер')) return '▣';
  if (t.includes('ups') || t.includes('ибп')) return '🔋';

  // Пользовательские устройства
  if (t.includes('printer') || t.includes('принтер') || t.includes('мфу')) return '🖨';
  if (t.includes('laptop') || t.includes('ноутбук')) return '💻';
  if (t.includes('phone') || t.includes('voip') || t.includes('телефон')) return '☎';
  if (t.includes('tv') || t.includes('телевизор') || t.includes('панель')) return '📺';
  if (t.includes('pc') || t.includes('desktop') || t.includes('компьютер') || t.includes('рабочая станция')) return '🖥';

  // IoT / прочее
  if (t.includes('iot') || t.includes('sensor') || t.includes('датчик')) return '⚙';

  // Если тип не распознан — берём иконку по умолчанию для категории
  const categoryDefaults = { network: '⇄', server: '▣', cctv: '◉', workstation: '🖥' };
  return (category && categoryDefaults[category]) || '●';
}

// ---------------- КАРТА: взаимодействие (перетаскивание узлов, пан, зум колесом, редактирование связей) ----------------
function attachMapInteractions(svg) {
  // Клик по связи — удаление (только в режиме редактирования)
  if (LINK_EDIT_MODE) {
    svg.querySelectorAll('.map-edge .edge-hit').forEach(hit => {
      hit.addEventListener('click', async (e) => {
        e.stopPropagation();
        const edgeId = hit.closest('.map-edge').dataset.edgeId;
        if (!edgeId) return; // связь из условной «звезды» — нечего удалять, она не хранится
        if (!confirm('Удалить эту связь?')) return;
        await api(`/api/topology/edges/${edgeId}`, { method: 'DELETE' });
        TOPOLOGY = await api('/api/topology').then(r => r.json());
        renderMap();
      });
    });
  }

  // Клик/перетаскивание узлов
  let dragging = null;
  let dragMoved = false;
  svg.querySelectorAll('.map-node').forEach(node => {
    node.addEventListener('mousedown', (e) => {
      if (CURRENT_ROLE === 'viewer') return;
      if (LINK_EDIT_MODE) return; // в режиме связей узлы не двигаем, только кликаем
      if (TREE_VIEW) return; // в режиме дерева позиции вычисляются автоматически
      dragging = node; dragMoved = false;
      node.style.cursor = 'grabbing';
      e.stopPropagation();
    });
    node.addEventListener('click', (e) => {
      if (!LINK_EDIT_MODE) return;
      e.stopPropagation();
      const id = node.dataset.id;
      if (!LINK_EDIT_FIRST) {
        LINK_EDIT_FIRST = id;
        renderMap();
      } else if (LINK_EDIT_FIRST !== id) {
        openLinkLabelModal(LINK_EDIT_FIRST, id);
        LINK_EDIT_FIRST = null;
      } else {
        LINK_EDIT_FIRST = null;
        renderMap();
      }
    });
  });

  svg.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    dragMoved = true;
    const pt = svgPoint(svg, e);
    dragging.setAttribute('transform', `translate(${pt.x},${pt.y})`);
  });
  window.addEventListener('mouseup', async () => {
    if (!dragging) return;
    const id = dragging.dataset.id;
    const transform = dragging.getAttribute('transform');
    const [x, y] = transform.match(/[-\d.]+/g).map(Number);
    dragging.style.cursor = 'grab';
    dragging = null;
    if (!dragMoved) return;
    const d = DEVICES.find(d => d.id === id);
    if (d) { d.x = x; d.y = y; }
    await api(`/api/devices/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x, y })
    });
    renderMap();
  });

  // Панорамирование перетаскиванием фона
  let panning = null;
  svg.addEventListener('mousedown', (e) => {
    if (e.target !== svg) return; // клик именно по пустому фону, не по узлу/связи
    panning = { startX: e.clientX, startY: e.clientY, view: { ...MAP_VIEW } };
  });
  svg.addEventListener('mousemove', (e) => {
    if (!panning) return;
    const scale = MAP_VIEW.w / svg.clientWidth;
    MAP_VIEW.x = panning.view.x - (e.clientX - panning.startX) * scale;
    MAP_VIEW.y = panning.view.y - (e.clientY - panning.startY) * scale;
    applyMapView();
  });
  window.addEventListener('mouseup', () => { panning = null; });

  // Зум колесом мыши
  svg.onwheel = (e) => {
    e.preventDefault();
    zoomMap(e.deltaY > 0 ? 1.1 : 0.9);
  };
}

function svgPoint(svg, evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

// ---------------- РУЧНОЕ СОЗДАНИЕ СВЯЗИ (модалка с подписью) ----------------
let PENDING_LINK = null;
function openLinkLabelModal(fromId, toId) {
  PENDING_LINK = { from: fromId, to: toId };
  document.getElementById('link-label-input').value = '';
  document.getElementById('link-label-modal').classList.remove('hidden');
}
document.getElementById('link-label-cancel').addEventListener('click', () => {
  document.getElementById('link-label-modal').classList.add('hidden');
  PENDING_LINK = null;
  renderMap();
});
document.getElementById('link-label-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!PENDING_LINK) return;
  await api('/api/topology/edges', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: PENDING_LINK.from, to: PENDING_LINK.to, label: document.getElementById('link-label-input').value })
  });
  document.getElementById('link-label-modal').classList.add('hidden');
  PENDING_LINK = null;
  TOPOLOGY = await api('/api/topology').then(r => r.json());
  renderMap();
});

// ---------------- ПРАВИЛА ПОДСЕТЕЙ ----------------
async function loadSubnetRules() {
  try {
    SUBNET_RULES = await api('/api/subnet-rules').then(r => r.json());
  } catch (e) { SUBNET_RULES = []; }
}

function renderSubnetRulesTable() {
  const tbody = document.getElementById('subnet-rules-tbody');
  tbody.innerHTML = SUBNET_RULES.map((r, i) => `
    <tr data-idx="${i}">
      <td><input type="text" class="sr-cidr" value="${esc(r.cidr)}" placeholder="10.7.7.0/24" style="width:130px;"></td>
      <td><input type="text" class="sr-label" value="${esc(r.label)}" placeholder="Wi-Fi клиенты" style="width:150px;"></td>
      <td><input type="color" class="sr-color" value="${r.color}"></td>
      <td><button class="small-btn sr-remove">✕</button></td>
    </tr>`).join('');
  tbody.querySelectorAll('.sr-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.closest('tr').dataset.idx);
      SUBNET_RULES.splice(idx, 1);
      renderSubnetRulesTable();
    });
  });
}

document.getElementById('subnet-rules-btn').addEventListener('click', async () => {
  await loadSubnetRules();
  renderSubnetRulesTable();
  document.getElementById('subnet-rules-result').textContent = '';
  document.getElementById('subnet-rules-modal').classList.remove('hidden');
});
document.getElementById('subnet-rules-close').addEventListener('click', () => {
  document.getElementById('subnet-rules-modal').classList.add('hidden');
});
document.getElementById('subnet-rule-add-row').addEventListener('click', () => {
  SUBNET_RULES.push({ cidr: '', label: '', color: '#3b82f6' });
  renderSubnetRulesTable();
});
document.getElementById('subnet-rules-save').addEventListener('click', async () => {
  const rows = [...document.querySelectorAll('#subnet-rules-tbody tr')];
  const rules = rows.map(tr => ({
    cidr: tr.querySelector('.sr-cidr').value.trim(),
    label: tr.querySelector('.sr-label').value.trim(),
    color: tr.querySelector('.sr-color').value
  })).filter(r => r.cidr);
  const res = await api('/api/subnet-rules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules })
  });
  const data = await res.json();
  const resultBox = document.getElementById('subnet-rules-result');
  if (!res.ok) { resultBox.textContent = 'Ошибка: ' + (data.message || data.error); return; }
  SUBNET_RULES = data;
  resultBox.textContent = 'Сохранено.';
  renderMap();
});


// ---------------- MODAL / CRUD ----------------
// Тип устройства: выпадашка с иконками + fallback на произвольный текст ("Другое")
const KNOWN_DEVICE_TYPES = ['Router', 'Switch', 'Access Point', 'Firewall', 'Modem', 'IP Camera', 'NVR', 'Server', 'NAS', 'UPS', 'PC', 'Laptop', 'Printer', 'IP Phone', 'TV', 'IoT Sensor', 'DHCP Client'];
function setDeviceTypeField(type) {
  const select = document.getElementById('f-type-select');
  const customWrap = document.getElementById('f-type-custom-wrap');
  const customInput = document.getElementById('f-type-custom');
  if (type && KNOWN_DEVICE_TYPES.includes(type)) {
    select.value = type;
    customWrap.classList.add('hidden');
    customInput.value = '';
  } else {
    select.value = '__custom__';
    customWrap.classList.remove('hidden');
    customInput.value = type || '';
  }
}
function getDeviceTypeValue() {
  const select = document.getElementById('f-type-select');
  if (select.value === '__custom__') return document.getElementById('f-type-custom').value.trim();
  return select.value;
}
document.getElementById('f-type-select').addEventListener('change', (e) => {
  document.getElementById('f-type-custom-wrap').classList.toggle('hidden', e.target.value !== '__custom__');
});

function duplicateDevice(id) {
  const src = DEVICES.find(d => d.id === id);
  if (!src) return;
  openAdd();
  document.getElementById('f-name').value = src.name + ' (копия)';
  document.getElementById('f-location').value = src.location || '';
  document.getElementById('f-site').value = src.site || '';
  setDeviceTypeField(src.type || '');
  document.getElementById('f-category').value = src.category || 'other';
  document.getElementById('f-comment').value = src.comment || '';
  document.getElementById('f-key').checked = !!src.key;
  document.getElementById('f-monitored').checked = src.monitored !== false;
  document.getElementById('f-alerts').checked = src.alertsEnabled !== false;
  document.getElementById('f-interval').value = String(src.checkInterval || 60);
  toggleIntervalVisibility();
  // IP и MAC намеренно оставляем пустыми — у нового устройства они должны быть свои
  document.getElementById('f-ip').focus();
}

function openAdd() {
  editingId = null;
  document.getElementById('modal-title').textContent = 'Новое устройство';
  document.getElementById('device-form').reset();
  document.getElementById('device-form-error').classList.add('hidden');
  document.getElementById('f-monitored').checked = true;
  document.getElementById('f-alerts').checked = true;
  document.getElementById('f-interval').value = '60';
  document.getElementById('f-snmp-enabled').checked = false;
  document.getElementById('f-snmp-community').value = 'public';
  document.getElementById('f-snmp-port').value = '161';
  document.getElementById('f-snmp-ifindex').value = '';
  document.getElementById('f-portchecks').value = '';
  document.getElementById('f-type-custom-wrap').classList.add('hidden');
  toggleIntervalVisibility();
  document.getElementById('f-snmp-wrap').classList.toggle('hidden', !FEATURES.snmp);
  document.getElementById('f-ports-wrap').classList.toggle('hidden', !FEATURES.portChecks);
  document.getElementById('device-modal').classList.remove('hidden');
}

function openEdit(id) {
  const d = DEVICES.find(d => d.id === id);
  if (!d) return;
  editingId = id;
  document.getElementById('modal-title').textContent = 'Редактирование устройства';
  document.getElementById('device-form-error').classList.add('hidden');
  document.getElementById('f-id').value = d.id;
  document.getElementById('f-name').value = d.name;
  document.getElementById('f-ip').value = d.ip;
  document.getElementById('f-mac').value = d.mac;
  document.getElementById('f-location').value = d.location;
  document.getElementById('f-site').value = d.site || '';
  setDeviceTypeField(d.type);
  document.getElementById('f-category').value = d.category;
  document.getElementById('f-comment').value = d.comment;
  document.getElementById('f-key').checked = !!d.key;
  document.getElementById('f-monitored').checked = d.monitored !== false;
  document.getElementById('f-alerts').checked = d.alertsEnabled !== false;
  document.getElementById('f-interval').value = String(d.checkInterval || 60);
  document.getElementById('f-snmp-enabled').checked = !!(d.snmp && d.snmp.enabled);
  document.getElementById('f-snmp-community').value = (d.snmp && d.snmp.community) || 'public';
  document.getElementById('f-snmp-port').value = (d.snmp && d.snmp.port) || 161;
  document.getElementById('f-snmp-ifindex').value = (d.snmp && d.snmp.ifIndex != null) ? d.snmp.ifIndex : '';
  document.getElementById('f-portchecks').value = (d.portChecks || []).map(p => p.port).join(',');
  toggleIntervalVisibility();
  document.getElementById('f-snmp-wrap').classList.toggle('hidden', !FEATURES.snmp);
  document.getElementById('f-ports-wrap').classList.toggle('hidden', !FEATURES.portChecks);
  document.getElementById('device-modal').classList.remove('hidden');
}

function toggleIntervalVisibility() {
  const on = document.getElementById('f-monitored').checked;
  document.getElementById('f-interval-wrap').style.display = on ? 'flex' : 'none';
}
document.getElementById('f-monitored').addEventListener('change', toggleIntervalVisibility);

async function deleteDevice(id) {
  if (!confirm('Удалить устройство?')) return;
  await api(`/api/devices/${id}`, { method: 'DELETE' });
  await loadAll();
}

document.getElementById('device-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = document.getElementById('device-form-error');
  errBox.classList.add('hidden');

  const ip = document.getElementById('f-ip').value.trim();
  const mac = document.getElementById('f-mac').value.trim();
  // Поле «IP» на самом деле принимает и hostname (сервер умеет пинговать DNS-имена) —
  // поэтому здесь только защита от явного мусора/спецсимволов, а не жёсткая IPv4-only маска.
  const SAFE_HOST_RE = /^[a-zA-Z0-9.:_-]+$/;
  const IPV4_SHAPE_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
  const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

  if (ip && !SAFE_HOST_RE.test(ip)) {
    errBox.textContent = 'IP/hostname может содержать только буквы, цифры, точки, двоеточия и дефисы.';
    errBox.classList.remove('hidden');
    return;
  }
  if (ip && IPV4_SHAPE_RE.test(ip) && ip.split('.').some(o => Number(o) > 255)) {
    errBox.textContent = 'Некорректный IP-адрес: октет больше 255. Пример: 192.168.1.10';
    errBox.classList.remove('hidden');
    return;
  }
  if (mac && !MAC_RE.test(mac)) {
    errBox.textContent = 'Некорректный MAC-адрес. Пример: AA:BB:CC:00:00:01';
    errBox.classList.remove('hidden');
    return;
  }

  const payload = {
    name: document.getElementById('f-name').value,
    ip, mac,
    location: document.getElementById('f-location').value,
    site: document.getElementById('f-site').value || null,
    type: getDeviceTypeValue(),
    category: document.getElementById('f-category').value,
    comment: document.getElementById('f-comment').value,
    key: document.getElementById('f-key').checked,
    monitored: document.getElementById('f-monitored').checked,
    alertsEnabled: document.getElementById('f-alerts').checked,
    checkInterval: Number(document.getElementById('f-interval').value),
    snmp: {
      enabled: document.getElementById('f-snmp-enabled').checked,
      community: document.getElementById('f-snmp-community').value || 'public',
      port: Number(document.getElementById('f-snmp-port').value) || 161,
      ifIndex: document.getElementById('f-snmp-ifindex').value !== '' ? Number(document.getElementById('f-snmp-ifindex').value) : null
    },
    portChecks: document.getElementById('f-portchecks').value
      .split(',').map(s => s.trim()).filter(Boolean)
      .map(port => ({ port: Number(port), label: '' }))
  };
  if (editingId) {
    await api(`/api/devices/${editingId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
  } else {
    await api('/api/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
  }
  document.getElementById('device-modal').classList.add('hidden');
  await loadAll();
});

document.getElementById('cancel-btn').addEventListener('click', () => {
  document.getElementById('device-modal').classList.add('hidden');
});
document.getElementById('add-device-btn').addEventListener('click', openAdd);

// ---------------- ВКЛАДКА «МОНИТОРИНГ» ----------------
function timeAgo(ts) {
  if (!ts) return '—';
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return sec + ' сек назад';
  if (sec < 3600) return Math.round(sec / 60) + ' мин назад';
  return Math.round(sec / 3600) + ' ч назад';
}

function renderMonitoring() {
  const tbody = document.getElementById('monitoring-tbody');
  const monitoredCount = DEVICES.filter(d => d.monitored).length;
  document.getElementById('monitoring-count').textContent = `Отслеживается: ${monitoredCount} из ${DEVICES.length}`;

  if (!DEVICES.length) {
    tbody.innerHTML = `<tr><td colspan="7">
      <div class="empty-state">
        <i class="ti ti-activity-off"></i>
        <h3>Нечего мониторить</h3>
        <p>Сначала добавьте устройства в реестр.</p>
        ${CURRENT_ROLE !== 'viewer' ? "<button class=\"empty-action\" onclick=\"showTab(&quot;devices&quot;);openAdd()\">+ Добавить устройство</button>" : ''}
      </div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = DEVICES.map(d => {
    const c = catById(d.category);
    const s = STATUS[d.id];
    let cls, label;
    if (!d.monitored) { cls = 'status-unknown'; label = 'Выключено'; }
    else if (s && s.online === true) { cls = 'status-online'; label = 'В сети'; }
    else if (s && s.online === false) { cls = 'status-offline'; label = 'Недоступно'; }
    else { cls = 'status-unknown'; label = 'Ожидание...'; }

    const intervalOptions = [15, 30, 60, 300, 900].map(v =>
      `<option value="${v}" ${Number(d.checkInterval || 60) === v ? 'selected' : ''}>${v < 60 ? v + ' сек' : (v / 60) + ' мин'}</option>`
    ).join('');

    let extra = '';
    if (FEATURES.snmp && d.snmp && d.snmp.enabled && s && s.snmp) {
      if (s.snmp.error) extra += `<div class="hint" style="color:var(--red);">SNMP: ${esc(s.snmp.error)}</div>`;
      else if (s.snmp.cpuLoad != null) extra += `<div class="hint">SNMP CPU: ${s.snmp.cpuLoad}%</div>`;
    }
    if (FEATURES.portChecks && Array.isArray(d.portChecks) && d.portChecks.length && s && s.ports) {
      extra += `<div class="hint">` + s.ports.map(p => `<span style="color:${p.open ? 'var(--green)' : 'var(--red)'}">${p.port}${p.open ? '✓' : '✕'}</span>`).join(' ') + `</div>`;
    }

    return `<tr data-id="${d.id}">
      <td>
        <label class="toggle-switch admin-only">
          <input type="checkbox" class="mon-toggle" data-id="${d.id}" ${d.monitored ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
        <span class="admin-hide-only">${d.monitored ? 'Да' : 'Нет'}</span>
      </td>
      <td>
        <label class="toggle-switch admin-only">
          <input type="checkbox" class="alert-toggle" data-id="${d.id}" ${d.alertsEnabled !== false ? 'checked' : ''} ${!d.monitored ? 'disabled' : ''}>
          <span class="toggle-slider"></span>
        </label>
        <span class="admin-hide-only">${d.alertsEnabled !== false ? 'Да' : 'Нет'}</span>
      </td>
      <td>${esc(d.name)}</td>
      <td>${esc(d.ip || '—')}</td>
      <td><span class="cat-badge" style="background:${esc(c.color)}22;color:${esc(c.color)}">${esc(c.name)}</span></td>
      <td><span class="status-badge ${cls}">${label}</span>${extra}</td>
      <td class="last-checked">${d.monitored ? timeAgo(s && s.lastChecked) : '—'}</td>
      <td>
        <select class="mon-interval admin-only" data-id="${d.id}" ${!d.monitored ? 'disabled' : ''}>${intervalOptions}</select>
        <span class="admin-hide-only">${d.checkInterval || 60} сек</span>
      </td>
      <td class="admin-only"><button class="small-btn mon-check" data-id="${d.id}" ${!d.ip ? 'disabled' : ''}>Проверить сейчас</button></td>
    </tr>`;
  }).join('');

  // навешиваем обработчики (перерисовка полная, поэтому вешаем заново)
  tbody.querySelectorAll('.mon-toggle').forEach(el => {
    el.addEventListener('change', async () => {
      const id = el.dataset.id;
      await api(`/api/devices/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monitored: el.checked })
      });
      const d = DEVICES.find(d => d.id === id);
      if (d) d.monitored = el.checked;
      renderMonitoring();
      renderDashboard();
      renderDevices();
      renderMap();
    });
  });

  tbody.querySelectorAll('.alert-toggle').forEach(el => {
    el.addEventListener('change', async () => {
      const id = el.dataset.id;
      await api(`/api/devices/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertsEnabled: el.checked })
      });
      const d = DEVICES.find(d => d.id === id);
      if (d) d.alertsEnabled = el.checked;
    });
  });

  tbody.querySelectorAll('.mon-interval').forEach(el => {
    el.addEventListener('change', async () => {
      const id = el.dataset.id;
      await api(`/api/devices/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkInterval: Number(el.value) })
      });
      const d = DEVICES.find(d => d.id === id);
      if (d) d.checkInterval = Number(el.value);
    });
  });

  tbody.querySelectorAll('.mon-check').forEach(el => {
    el.addEventListener('click', async () => {
      el.disabled = true; el.textContent = 'Проверяю...';
      try {
        const res = await api(`/api/status/${el.dataset.id}/check`, { method: 'POST' }).then(r => r.json());
        STATUS[el.dataset.id] = { online: res.online, monitored: true, lastChecked: res.lastChecked };
      } finally {
        el.disabled = false; el.textContent = 'Проверить сейчас';
        renderMonitoring();
        renderDashboard();
        renderDevicesStatusOnly();
        renderMap();
      }
    });
  });
}

document.getElementById('mon-add-all').addEventListener('click', async () => {
  await api('/api/monitoring/bulk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: DEVICES.map(d => d.id), monitored: true })
  });
  await loadAll();
});

document.getElementById('mon-remove-all').addEventListener('click', async () => {
  if (!confirm('Выключить мониторинг для всех устройств?')) return;
  await api('/api/monitoring/bulk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: DEVICES.map(d => d.id), monitored: false })
  });
  await loadAll();
});

// ---------------- ОБНАРУЖЕНИЕ СЕТИ ----------------
async function initDiscoveryTab() {
  try {
    const subnets = await api('/api/discovery/local-subnets').then(r => r.json());
    document.getElementById('local-subnets-hint').textContent = subnets.length ? subnets.join(', ') : 'не определены';
    if (subnets.length && !document.getElementById('scan-cidr').value) {
      document.getElementById('scan-cidr').value = subnets[0];
    }
  } catch (e) { /* ignore */ }

  try {
    const routers = await api('/api/mikrotik/routers').then(r => r.json());
    const sel = document.getElementById('discovery-router-select');
    sel.innerHTML = routers.length
      ? routers.map(r => `<option value="${r.id}">${esc(r.name)} (${esc(r.host)})</option>`).join('')
      : `<option value="">Сначала добавьте роутер в «Настройках»</option>`;
  } catch (e) { /* ignore */ }

  try {
    const devices = await api('/api/lldp-cdp/devices').then(r => r.json());
    const sel = document.getElementById('lldp-device-select');
    sel.innerHTML = devices.length
      ? devices.map(d => `<option value="${d.id}">${esc(d.name)} (${esc(d.ip)})</option>`).join('')
      : `<option value="">Нет устройств с включённым SNMP</option>`;
  } catch (e) { /* ignore */ }
}

document.getElementById('scan-btn').addEventListener('click', async () => {
  const cidr = document.getElementById('scan-cidr').value.trim();
  const resBox = document.getElementById('scan-result');
  const table = document.getElementById('scan-table');
  const tbody = document.getElementById('scan-tbody');
  const addBtn = document.getElementById('scan-add-selected');
  resBox.textContent = 'Сканирую... это может занять до минуты';
  table.classList.add('hidden');
  addBtn.classList.add('hidden');
  try {
    const res = await api('/api/discovery/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cidr })
    });
    const data = await res.json();
    if (!res.ok) { resBox.textContent = 'Ошибка: ' + (data.message || data.error); return; }
    resBox.textContent = `Проверено ${data.scanned} адресов, отвечают ${data.found}.`;
    if (!data.results.length) return;
    tbody.innerHTML = data.results.map((r, i) => `
      <tr>
        <td>${r.inRegistry ? '' : `<input type="checkbox" class="scan-check" data-idx="${i}">`}</td>
        <td>${esc(r.ip)}</td>
        <td>${esc(r.hostname || '—')}</td>
        <td>${r.inRegistry ? '<span class="status-badge status-online">Уже в реестре</span>' : '<span class="status-badge status-unknown">Новое</span>'}</td>
        <td>${r.inRegistry ? '' : `<button class="small-btn scan-add-single" data-idx="${i}">Добавить</button>`}</td>
      </tr>`).join('');
    table.classList.remove('hidden');
    if (data.results.some(r => !r.inRegistry)) addBtn.classList.remove('hidden');
    table.dataset.payload = JSON.stringify(data.results);
    // Кнопки «Добавить» по одной строке — через делегирование событий, а не inline onclick
    // (inline onclick с JSON.stringify внутри HTML-атрибута — хрупкий паттерн, ловили баги).
    tbody.querySelectorAll('.scan-add-single').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = data.results[Number(btn.dataset.idx)];
        addSingleDiscovered({ ip: r.ip, name: r.hostname || r.ip, source: 'scan' });
      });
    });
  } catch (e) {
    resBox.textContent = 'Ошибка соединения с сервером.';
  }
});

document.getElementById('scan-add-selected').addEventListener('click', async () => {
  const table = document.getElementById('scan-table');
  const payload = JSON.parse(table.dataset.payload || '[]');
  const checked = [...document.querySelectorAll('.scan-check:checked')].map(el => Number(el.dataset.idx));
  const items = checked.map(i => ({ ip: payload[i].ip, name: payload[i].hostname || payload[i].ip, source: 'scan' }));
  if (!items.length) return;
  await api('/api/discovery/add-bulk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items })
  });
  document.getElementById('scan-btn').click();
  await loadAll();
});

async function addSingleDiscovered(item) {
  await api('/api/discovery/add-bulk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [item] })
  });
  await loadAll();
}

async function runMikrotikDiscovery(endpoint, columnsFn) {
  const routerId = document.getElementById('discovery-router-select').value;
  const resBox = document.getElementById('discovery-mt-result');
  const table = document.getElementById('discovery-mt-table');
  const tbody = document.getElementById('discovery-mt-tbody');
  const addBtn = document.getElementById('mt-add-selected');
  if (!routerId) { resBox.textContent = 'Сначала выберите роутер.'; return; }
  resBox.textContent = 'Запрашиваю данные с роутера...';
  table.classList.add('hidden');
  addBtn.classList.add('hidden');
  try {
    const res = await api(`/api/mikrotik/routers/${routerId}/${endpoint}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { resBox.textContent = 'Ошибка: ' + (data.message || data.error); return; }
    if (!data.results.length) { resBox.textContent = 'Ничего не найдено.'; return; }
    resBox.textContent = `Найдено записей: ${data.results.length}`;
    tbody.innerHTML = data.results.map((r, i) => columnsFn(r, i)).join('');
    table.classList.remove('hidden');
    table.dataset.payload = JSON.stringify(data.results);
    if (data.results.some(r => !r.existingDeviceId)) addBtn.classList.remove('hidden');
    // Кнопки «Добавить» по одной строке — через делегирование событий (data-idx), а не inline onclick.
    tbody.querySelectorAll('.mt-add-single').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = data.results[Number(btn.dataset.idx)];
        addSingleDiscovered({ ip: r.ip || '', mac: r.mac || '', name: r.identity || r.ip || '', source: btn.dataset.source || 'discovery' });
      });
    });
  } catch (e) {
    resBox.textContent = 'Ошибка соединения с сервером.';
  }
}

document.getElementById('arp-btn').addEventListener('click', () => runMikrotikDiscovery('arp', (r, i) => `
  <tr>
    <td>${r.existingDeviceId ? '' : `<input type="checkbox" class="mt-check" data-idx="${i}">`}</td>
    <td>${esc(r.ip)}</td>
    <td>${esc(r.mac)}</td>
    <td>${esc(r.interface)}</td>
    <td>${r.existingDeviceId ? `<span class="status-badge status-online">${esc(r.existingDeviceName)}</span>` : '<span class="status-badge status-unknown">Новое</span>'}</td>
    <td>${r.existingDeviceId ? '' : `<button class="small-btn mt-add-single" data-idx="${i}" data-source="arp">Добавить</button>`}</td>
  </tr>`));

document.getElementById('neighbors-btn').addEventListener('click', () => runMikrotikDiscovery('neighbors', (r, i) => `
  <tr>
    <td>${r.existingDeviceId ? '' : `<input type="checkbox" class="mt-check" data-idx="${i}">`}</td>
    <td>${esc(r.identity)}${r.ip ? ' · ' + esc(r.ip) : ''}</td>
    <td>${esc(r.mac)}</td>
    <td>${esc(r.interface)}</td>
    <td>${r.existingDeviceId ? `<span class="status-badge status-online">${esc(r.existingDeviceName)}</span>` : '<span class="status-badge status-unknown">Новое</span>'}</td>
    <td>${r.existingDeviceId ? '' : `<button class="small-btn" disabled title="Добавляется автоматически при построении топологии">—</button>`}</td>
  </tr>`));

document.getElementById('mt-add-selected').addEventListener('click', async () => {
  const table = document.getElementById('discovery-mt-table');
  const payload = JSON.parse(table.dataset.payload || '[]');
  const checked = [...document.querySelectorAll('.mt-check:checked')].map(el => Number(el.dataset.idx));
  const items = checked.map(i => ({ ip: payload[i].ip, mac: payload[i].mac, name: payload[i].identity || payload[i].ip, source: 'mikrotik-discovery' }));
  if (!items.length) return;
  await api('/api/discovery/add-bulk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items })
  });
  await loadAll();
});

document.getElementById('build-topology-btn').addEventListener('click', async () => {
  const routerId = document.getElementById('discovery-router-select').value;
  const resBox = document.getElementById('discovery-mt-result');
  if (!routerId) { resBox.textContent = 'Сначала выберите роутер.'; return; }
  resBox.textContent = 'Строю топологию (это может занять несколько секунд)...';
  try {
    const res = await api(`/api/topology/build/${routerId}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { resBox.textContent = 'Ошибка: ' + (data.message || data.error); return; }
    resBox.textContent = `Готово: построено связей — ${data.edgesCreated}. Откройте вкладку «Карта сети».`;
    await loadAll();
  } catch (e) {
    resBox.textContent = 'Ошибка соединения с сервером.';
  }
});

document.getElementById('lldp-build-btn').addEventListener('click', async () => {
  const deviceId = document.getElementById('lldp-device-select').value;
  const resBox = document.getElementById('lldp-result');
  if (!deviceId) { resBox.textContent = 'Сначала выберите устройство с включённым SNMP.'; return; }
  resBox.textContent = 'Опрашиваю устройство по LLDP/CDP (это может занять несколько секунд)...';
  try {
    const res = await api(`/api/topology/build-snmp/${deviceId}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { resBox.textContent = 'Ошибка: ' + (data.message || data.error); return; }
    if (!data.edgesCreated) { resBox.textContent = data.message || 'Соседей не найдено.'; return; }
    const proto = data.protocol === 'cdp' ? 'CDP' : 'LLDP';
    resBox.textContent = `Готово (${proto}): построено связей — ${data.edgesCreated}. Откройте вкладку «Карта сети».`;
    await loadAll();
  } catch (e) {
    resBox.textContent = 'Ошибка соединения с сервером.';
  }
});

// ---------------- НАСТРОЙКИ: MIKROTIK (НЕСКОЛЬКО РОУТЕРОВ) ----------------
// ---------------- ФИЧЕ-ФЛАГИ: показ/скрытие зависимого UI ----------------
function applyFeatureVisibility() {
  document.getElementById('nav-incidents').classList.toggle('hidden', !FEATURES.incidents);
  document.getElementById('nav-traffic').classList.toggle('hidden', !FEATURES.traffic);
  document.getElementById('escalation-block').classList.toggle('hidden', !FEATURES.incidents);
  document.getElementById('f-snmp-wrap').classList.toggle('hidden', !FEATURES.snmp);
  document.getElementById('f-ports-wrap').classList.toggle('hidden', !FEATURES.portChecks);

  const auditHint = document.getElementById('audit-log-hint');
  const auditTable = document.getElementById('audit-log-table');
  if (FEATURES.auditLog) {
    auditHint.textContent = 'Загрузка...';
    auditTable.classList.remove('hidden');
    loadAuditLog();
  } else {
    auditHint.textContent = 'Требует включения функции «Аудит-лог» в разделе «Функции» выше.';
    auditTable.classList.add('hidden');
  }
}

async function loadFeaturesForm() {
  document.getElementById('feat-snmp').checked = !!FEATURES.snmp;
  document.getElementById('feat-portchecks').checked = !!FEATURES.portChecks;
  document.getElementById('feat-incidents').checked = !!FEATURES.incidents;
  document.getElementById('feat-auditlog').checked = !!FEATURES.auditLog;
  document.getElementById('feat-traffic').checked = !!FEATURES.traffic;
}

document.getElementById('features-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resultBox = document.getElementById('features-result');
  const res = await api('/api/features', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      snmp: document.getElementById('feat-snmp').checked,
      portChecks: document.getElementById('feat-portchecks').checked,
      incidents: document.getElementById('feat-incidents').checked,
      auditLog: document.getElementById('feat-auditlog').checked,
      traffic: document.getElementById('feat-traffic').checked
    })
  });
  FEATURES = await res.json();
  applyFeatureVisibility();
  resultBox.textContent = 'Сохранено. Изменения применятся со следующего цикла проверки (несколько секунд).';
});

// ---------------- АУДИТ-ЛОГ ----------------
let AUDIT_LOG_PAGE = 1;
let AUDIT_LOG_FILTERS_LOADED = false;

function buildAuditQuery() {
  const params = new URLSearchParams();
  params.set('page', AUDIT_LOG_PAGE);
  params.set('pageSize', 50);
  const search = document.getElementById('audit-log-search').value.trim();
  const action = document.getElementById('audit-log-filter-action').value;
  const user = document.getElementById('audit-log-filter-user').value;
  const from = document.getElementById('audit-log-filter-from').value;
  const to = document.getElementById('audit-log-filter-to').value;
  if (search) params.set('search', search);
  if (action) params.set('action', action);
  if (user) params.set('user', user);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return params;
}

async function loadAuditFilterOptions() {
  if (AUDIT_LOG_FILTERS_LOADED) return;
  try {
    const [actions, users] = await Promise.all([
      api('/api/audit-log/actions').then(r => r.json()),
      api('/api/audit-log/users').then(r => r.json())
    ]);
    const actionSel = document.getElementById('audit-log-filter-action');
    actions.forEach(a => { const o = document.createElement('option'); o.value = a; o.textContent = a; actionSel.appendChild(o); });
    const userSel = document.getElementById('audit-log-filter-user');
    users.forEach(u => { const o = document.createElement('option'); o.value = u; o.textContent = u; userSel.appendChild(o); });
    AUDIT_LOG_FILTERS_LOADED = true;
  } catch (e) { /* ignore */ }
}

async function loadAuditLog(page) {
  if (page) AUDIT_LOG_PAGE = page;
  await loadAuditFilterOptions();
  try {
    const query = buildAuditQuery();
    document.getElementById('audit-log-export-link').href = `/api/audit-log/export.csv?${query.toString()}`;
    const data = await api(`/api/audit-log?${query.toString()}`).then(r => r.json());
    const hint = document.getElementById('audit-log-hint');
    const table = document.getElementById('audit-log-table');
    const actions = document.getElementById('audit-log-actions');
    const pagination = document.getElementById('audit-log-pagination');
    actions.classList.remove('hidden');
    if (!data.total) {
      hint.textContent = 'Ничего не найдено.';
      table.classList.add('hidden'); pagination.classList.add('hidden');
      return;
    }
    hint.textContent = '';
    table.classList.remove('hidden'); pagination.classList.remove('hidden');
    document.getElementById('audit-log-tbody').innerHTML = data.entries.map(e => `
      <tr>
        <td class="last-checked">${new Date(e.t).toLocaleString('ru-RU')}</td>
        <td>${esc(e.user)}</td>
        <td>${esc(e.action)}</td>
        <td>${esc(e.details)}</td>
      </tr>`).join('');
    document.getElementById('audit-log-pagination-info').textContent = `Страница ${data.page} из ${data.totalPages} · всего: ${data.total}`;
    document.getElementById('audit-log-prev-btn').disabled = data.page <= 1;
    document.getElementById('audit-log-next-btn').disabled = data.page >= data.totalPages;
  } catch (e) { /* нет прав или сеть — просто не показываем */ }
}
document.getElementById('audit-log-prev-btn').addEventListener('click', () => loadAuditLog(AUDIT_LOG_PAGE - 1));
document.getElementById('audit-log-next-btn').addEventListener('click', () => loadAuditLog(AUDIT_LOG_PAGE + 1));

let auditSearchDebounce = null;
document.getElementById('audit-log-search').addEventListener('input', () => {
  clearTimeout(auditSearchDebounce);
  auditSearchDebounce = setTimeout(() => loadAuditLog(1), 350);
});
['audit-log-filter-action', 'audit-log-filter-user', 'audit-log-filter-from', 'audit-log-filter-to'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => loadAuditLog(1));
});
document.getElementById('audit-log-reset-btn').addEventListener('click', () => {
  document.getElementById('audit-log-search').value = '';
  document.getElementById('audit-log-filter-action').value = '';
  document.getElementById('audit-log-filter-user').value = '';
  document.getElementById('audit-log-filter-from').value = '';
  document.getElementById('audit-log-filter-to').value = '';
  loadAuditLog(1);
});

// ---------------- ИНЦИДЕНТЫ ----------------
async function loadIncidents() {
  try {
    const [data, stats] = await Promise.all([
      api('/api/incidents').then(r => r.json()),
      api('/api/incidents/stats?days=7').then(r => r.json())
    ]);
    document.getElementById('incidents-stats').textContent =
      `За 7 дней: ${stats.totalIncidents} инцидент(ов), суммарный даунтайм ${formatDuration(stats.totalDownSec)}, MTTR ${formatDuration(stats.mttrSec)}`;

    document.getElementById('incidents-open-tbody').innerHTML = data.open.length ? data.open.map(i => `
      <tr>
        <td>${esc(i.deviceName)}</td>
        <td class="last-checked">${new Date(i.start).toLocaleString('ru-RU')}</td>
        <td>${formatDuration(i.durationSec)}</td>
        <td>${i.escalated ? '🆘 да' : '—'}</td>
      </tr>`).join('') : `<tr><td colspan="4" class="hint">Сейчас всё в порядке — недоступных устройств нет.</td></tr>`;

    document.getElementById('incidents-closed-tbody').innerHTML = data.closed.length ? data.closed.map(i => `
      <tr>
        <td>${esc(i.deviceName)}</td>
        <td class="last-checked">${new Date(i.start).toLocaleString('ru-RU')}</td>
        <td class="last-checked">${i.end ? new Date(i.end).toLocaleString('ru-RU') : '—'}</td>
        <td>${formatDuration(i.durationSec)}</td>
        <td>${i.escalated ? '🆘 да' : '—'}</td>
      </tr>`).join('') : `<tr><td colspan="5" class="hint">История пуста.</td></tr>`;
  } catch (e) { /* ignore */ }
}

function formatDuration(sec) {
  sec = Number(sec) || 0;
  if (sec < 60) return sec + ' сек';
  if (sec < 3600) return Math.round(sec / 60) + ' мин';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return `${h} ч ${m} мин`;
}

// ---------------- ИМПОРТ CSV ----------------
document.getElementById('csv-import-btn').addEventListener('click', async () => {
  const resultBox = document.getElementById('csv-import-result');
  const csv = document.getElementById('csv-input').value.trim();
  if (!csv) { resultBox.textContent = 'Вставьте CSV в поле выше.'; return; }
  resultBox.textContent = 'Импортирую...';
  const res = await api('/api/devices/import-csv', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv })
  });
  const data = await res.json();
  if (!res.ok) { resultBox.textContent = 'Ошибка: ' + (data.message || data.error); return; }
  resultBox.textContent = `Готово: создано ${data.created}, пропущено (дубли/пустые строки) ${data.skipped}.`;
  document.getElementById('csv-input').value = '';
  await loadAll();
});

async function loadSettings() {
  loadOuiStatus(); // доступно всем ролям (кнопка обновления — только админу)
  if (CURRENT_ROLE === 'viewer') return; // у viewer в «Настройках» доступна только смена пароля и статус OUI
  renderCategoriesTable();
  renderSitesTable();
  await Promise.all([loadConnections(), loadAlertSettings()]);
  if (CURRENT_ROLE !== 'admin') return; // Operator не видит пользователей/функции/брендинг/бэкап/аудит-лог/о системе
  await Promise.all([loadUsers(), loadFeaturesForm(), loadBrandingForm(), loadAboutPanel()]);
}

// ---------------- OUI: БАЗА ПРОИЗВОДИТЕЛЕЙ ----------------
async function loadOuiStatus() {
  try {
    const s = await api('/api/oui/status').then(r => r.json());
    const box = document.getElementById('oui-status');
    if (!s.entryCount) {
      box.innerHTML = `⚠ База ещё не загружена${s.lastError ? ` (последняя ошибка: ${esc(s.lastError)})` : ''}. Определение производителя недоступно.`;
    } else {
      const dateStr = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString('ru-RU') : '—';
      box.innerHTML = `${s.stale ? '⚠' : '✅'} Записей: ${s.entryCount.toLocaleString('ru-RU')}. Обновлена: ${dateStr}${s.stale ? ' (устарела, попробую обновить в фоне)' : ''}${s.lastError ? `<br>Последняя попытка обновления не удалась: ${esc(s.lastError)}` : ''}`;
    }
  } catch (e) { /* ignore */ }
}

document.getElementById('oui-refresh-btn').addEventListener('click', async () => {
  const resultBox = document.getElementById('oui-refresh-result');
  resultBox.textContent = 'Обновляю (может занять до минуты)...';
  try {
    const res = await api('/api/oui/refresh', { method: 'POST' });
    const data = await res.json();
    resultBox.textContent = res.ok ? `Готово: ${data.count.toLocaleString('ru-RU')} записей.` : `Ошибка: ${data.message}`;
    await loadOuiStatus();
    if (res.ok) await loadAll(); // обновляем список устройств — вдруг появятся новые производители
  } catch (e) {
    resultBox.textContent = 'Ошибка соединения с сервером.';
  }
});

// ── MIT-лицензия — скачивание текста по клику ────────────────────────
function downloadLicense() {
  const year = new Date().getFullYear();
  const text = `MIT License

Copyright (c) ${year} DarkyAndSparky

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'LICENSE.txt';
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

// ── Полная страница «О системе» — динамический список зависимостей ───
async function loadAboutPanel() {
  const el = document.getElementById('about-page-content');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text-dim);font-size:13px">Загрузка…</div>';
  let info;
  try {
    info = await api('/api/system-info').then(r => r.json());
  } catch (e) {
    el.innerHTML = `<div class="si-card"><div class="si-card-body" style="color:var(--red)">Не удалось загрузить: ${esc(e.message)}</div></div>`;
    return;
  }

  const depRow = (d) => `
    <tr data-pkg="${esc(d.name)}">
      <td class="si-pkg-name">${esc(d.name)}</td>
      <td class="si-pkg-installed" style="color:${d.installed ? 'var(--green)' : 'var(--red)'}">${esc(d.installed || '— не установлен')}</td>
      <td class="si-pkg-range">${esc(d.range)}</td>
      <td class="outdated-cell si-outdated-col"></td>
    </tr>`;

  el.innerHTML = `
    <div class="si-card">
      <div class="si-card-header"><span class="si-card-title">ℹ️ ${esc(info.name)}</span></div>
      <div class="si-card-body">
        <div class="si-grid">
          <span>Версия</span><span style="font-family:monospace;font-weight:600">${esc(info.version)}</span>
          <span>Описание</span><span>${esc(info.description || '—')}</span>
          <span>Лицензия</span><span><a href="#" onclick="downloadLicense();return false;" class="si-link" title="Скачать текст лицензии">${esc(info.license)} — скачать</a></span>
          <span>Автор</span><span>${esc(info.author)}</span>
          <span>Репозиторий</span><span><a href="${esc(info.repository)}" target="_blank" rel="noopener" class="si-link">${esc(info.repository)}</a></span>
        </div>
      </div>
    </div>

    <div class="si-card" id="about-env-card">
      <div class="si-card-header"><span class="si-card-title">🖥️ Окружение</span><span class="si-card-hint">обновляется каждые 10 сек</span></div>
      <div class="si-card-body">
        <div class="si-grid">
          <span>Node.js</span><span style="font-family:monospace">${esc(info.node)}</span>
          <span>Платформа</span><span style="font-family:monospace">${esc(info.platform)} / ${esc(info.arch)}</span>
          <span>Время работы</span><span id="about-env-uptime">${fmtUptimeShared(info.uptimeSec)}</span>
          <span>Память процесса</span><span id="about-env-memory">${info.memoryMB} МБ</span>
          <span>PID</span><span style="font-family:monospace">${info.pid}</span>
          <span>Размер БД</span><span id="about-env-dbsize">${fmtBytesShared(info.dbSizeBytes)}</span>
        </div>
      </div>
    </div>

    <div class="si-card">
      <div class="si-card-header"><span class="si-card-title">🧰 Технологии</span></div>
      <div class="si-card-body">
        <div class="si-tech-grid">${buildTechStackHtml(info)}</div>
      </div>
    </div>

    <div class="si-card">
      <div class="si-card-header"><span class="si-card-title">📊 Данные</span></div>
      <div class="si-card-body">
        <div class="si-counts">
          <div><div class="si-count-num">${info.counts?.devices ?? '—'}</div><div class="si-count-label">устройств</div></div>
          <div><div class="si-count-num">${info.counts?.monitored ?? '—'}</div><div class="si-count-label">мониторится</div></div>
          <div><div class="si-count-num">${info.counts?.users ?? '—'}</div><div class="si-count-label">пользователей</div></div>
        </div>
      </div>
    </div>

    <div class="si-card">
      <div class="si-card-header">
        <span class="si-card-title">📦 Зависимости (${info.dependencies.length})</span>
        <button class="small-btn" id="btn-check-outdated" onclick="checkOutdatedPackages()" style="margin-left:auto">🔄 Проверить обновления</button>
      </div>
      <div id="outdated-summary" class="si-outdated-summary"></div>
      <div class="si-table-wrap">
        <table class="si-table">
          <thead><tr>
            <th>Пакет</th>
            <th>Установлено</th>
            <th>Диапазон в package.json</th>
            <th id="outdated-col-header" class="si-outdated-col">Последняя на npm</th>
          </tr></thead>
          <tbody id="deps-tbody">${info.dependencies.map(depRow).join('')}</tbody>
        </table>
      </div>
    </div>
  `;
  startAboutEnvPolling();
}

// ── Технологии — курируемое описание стека (не статичный список: показываем
// только то, что реально присутствует в dependencies) ────────────────
function buildTechStackHtml(info) {
  const installedNames = new Set((info.dependencies || []).map(d => d.name));
  const has = (name) => installedNames.has(name);

  const items = [
    { cond: true,               icon: '🟢', title: 'Node.js + Express', desc: 'Backend-сервер и REST API' },
    { cond: true,                icon: '🗄️', title: 'node:sqlite', desc: 'Встроенный SQLite, без компиляции нативных модулей' },
    { cond: has('pino'),         icon: '📝', title: 'pino', desc: 'Структурированные логи с ротацией' },
    { cond: has('node-routeros'),icon: '🔌', title: 'node-routeros', desc: 'MikroTik RouterOS API' },
    { cond: has('net-snmp'),     icon: '📡', title: 'net-snmp', desc: 'SNMP-опрос сетевых устройств' },
    { cond: has('ssh2'),         icon: '🔒', title: 'ssh2', desc: 'Cisco SSH подключение' },
    { cond: has('express-session'), icon: '🔑', title: 'express-session', desc: 'Управление сессиями' },
    { cond: true,                icon: '⚡', title: 'Server-Sent Events', desc: 'Живые обновления карты и статусов без polling' },
    { cond: true,                icon: '🍦', title: 'Vanilla JS + HTML/CSS', desc: 'Фронтенд без фреймворков и сборщиков' },
    { cond: true,                icon: '🗺️', title: 'SVG-карта сети', desc: 'Интерактивная топология без внешних библиотек' },
  ];

  return items.filter(i => i.cond).map(i => `
    <div class="si-tech-item">
      <span class="si-tech-icon">${i.icon}</span>
      <div>
        <div class="si-tech-title">${esc(i.title)}</div>
        <div class="si-tech-desc">${esc(i.desc)}</div>
      </div>
    </div>`).join('');
}

// ── Автообновление карточки «Окружение» ───────────────────────────────
let aboutEnvPollTimer = null;
function startAboutEnvPolling() {
  if (aboutEnvPollTimer) clearInterval(aboutEnvPollTimer);
  aboutEnvPollTimer = setInterval(async () => {
    const card = document.getElementById('about-env-card');
    if (!card) { clearInterval(aboutEnvPollTimer); aboutEnvPollTimer = null; return; }
    try {
      const info = await api('/api/system-info').then(r => r.json());
      const up  = document.getElementById('about-env-uptime');
      const mem = document.getElementById('about-env-memory');
      const dbs = document.getElementById('about-env-dbsize');
      if (up)  up.textContent  = fmtUptimeShared(info.uptimeSec);
      if (mem) mem.textContent = info.memoryMB + ' МБ';
      if (dbs) dbs.textContent = fmtBytesShared(info.dbSizeBytes);
    } catch { /* ignore */ }
  }, 10000);
}

function fmtUptimeShared(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d} д`);
  if (h) parts.push(`${h} ч`);
  parts.push(`${m} мин`);
  return parts.join(' ');
}
function fmtBytesShared(b) {
  return b > 1024*1024 ? `${(b/1024/1024).toFixed(1)} МБ` : `${(b/1024).toFixed(0)} КБ`;
}

// ── Проверка устаревших пакетов — по клику (npm outdated на сервере) ──
async function checkOutdatedPackages() {
  const btn = document.getElementById('btn-check-outdated');
  const summary = document.getElementById('outdated-summary');
  const colHeader = document.getElementById('outdated-col-header');
  if (!btn) return;
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Проверка…';
  summary.textContent = '';

  try {
    const result = await api('/api/system-info/outdated').then(r => r.json());
    colHeader.classList.remove('si-outdated-col');
    document.querySelectorAll('.outdated-cell').forEach(td => td.classList.remove('si-outdated-col'));

    const outdatedMap = {};
    (result.outdated || []).forEach(o => { outdatedMap[o.name] = o; });

    document.querySelectorAll('#deps-tbody tr[data-pkg]').forEach(tr => {
      const pkg = tr.getAttribute('data-pkg');
      const cell = tr.querySelector('.outdated-cell');
      const o = outdatedMap[pkg];
      if (o) {
        cell.innerHTML = `<span style="color:var(--yellow)">${esc(o.latest)}</span>`;
        cell.title = 'Доступна более новая версия';
      } else {
        cell.innerHTML = `<span style="color:var(--green)">актуально</span>`;
      }
    });

    const n = (result.outdated || []).length;
    summary.textContent = n > 0
      ? `⚠️ Устаревших пакетов: ${n} — проверено ${new Date(result.checkedAt).toLocaleString('ru-RU')}`
      : `✅ Все пакеты актуальны — проверено ${new Date(result.checkedAt).toLocaleString('ru-RU')}`;
    summary.style.color = n > 0 ? 'var(--yellow)' : 'var(--green)';
  } catch (e) {
    summary.textContent = '❌ ' + e.message;
    summary.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// ---------------- КАТЕГОРИИ УСТРОЙСТВ ----------------
function renderCategoriesTable() {
  const tbody = document.getElementById('categories-tbody');
  tbody.innerHTML = CATEGORIES.map((c, i) => `
    <tr data-idx="${i}" data-id="${esc(c.id)}">
      <td><input type="text" class="cat-name" value="${esc(c.name)}"></td>
      <td><input type="color" class="cat-color" value="${esc(c.color)}"></td>
      <td><button class="small-btn cat-remove">✕</button></td>
    </tr>`).join('');
  tbody.querySelectorAll('.cat-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.closest('tr').dataset.idx);
      CATEGORIES.splice(idx, 1);
      renderCategoriesTable();
    });
  });
}

document.getElementById('category-add-row').addEventListener('click', () => {
  CATEGORIES.push({ id: null, name: '', color: '#6b7280' });
  renderCategoriesTable();
});

document.getElementById('categories-save').addEventListener('click', async () => {
  const rows = [...document.querySelectorAll('#categories-tbody tr')];
  const categories = rows.map(tr => ({
    id: tr.dataset.id || null,
    name: tr.querySelector('.cat-name').value.trim(),
    color: tr.querySelector('.cat-color').value
  })).filter(c => c.name);
  const resultBox = document.getElementById('categories-result');
  const res = await api('/api/categories', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categories })
  });
  const data = await res.json();
  if (!res.ok) { resultBox.textContent = 'Ошибка: ' + (data.message || data.error); return; }
  CATEGORIES = data;
  resultBox.textContent = 'Сохранено.';
  renderCategoriesTable();
  fillCategorySelects();
  renderDashboard();
  renderDevices();
  renderMap();
});

// ---------------- ПЛОЩАДКИ (MULTI-SITE) ----------------
function renderSitesTable() {
  const tbody = document.getElementById('sites-tbody');
  tbody.innerHTML = SITES.map((s, i) => `
    <tr data-idx="${i}" data-id="${esc(s.id)}">
      <td><input type="text" class="site-name" value="${esc(s.name)}"></td>
      <td><input type="text" class="site-address" value="${esc(s.address || '')}" placeholder="г. Москва, ул. ..."></td>
      <td><input type="color" class="site-color" value="${esc(s.color)}"></td>
      <td><button class="small-btn site-remove">✕</button></td>
    </tr>`).join('');
  tbody.querySelectorAll('.site-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.closest('tr').dataset.idx);
      SITES.splice(idx, 1);
      renderSitesTable();
    });
  });
}

document.getElementById('site-add-row').addEventListener('click', () => {
  SITES.push({ id: null, name: '', address: '', color: '#6b7280' });
  renderSitesTable();
});

document.getElementById('sites-save').addEventListener('click', async () => {
  const rows = [...document.querySelectorAll('#sites-tbody tr')];
  const sites = rows.map(tr => ({
    id: tr.dataset.id || null,
    name: tr.querySelector('.site-name').value.trim(),
    address: tr.querySelector('.site-address').value.trim(),
    color: tr.querySelector('.site-color').value
  })).filter(s => s.name);
  const resultBox = document.getElementById('sites-result');
  const res = await api('/api/sites', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sites })
  });
  const data = await res.json();
  if (!res.ok) { resultBox.textContent = 'Ошибка: ' + (data.message || data.error); return; }
  SITES = data;
  resultBox.textContent = 'Сохранено.';
  renderSitesTable();
  fillSiteSelects();
  renderDashboard();
  loadDashboardWidgets();
  renderDevices();
});

function fillSiteSelects() {
  const opts = `<option value="">Без площадки</option>` + SITES.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  const formSel = document.getElementById('f-site');
  if (formSel) formSel.innerHTML = opts;
  const dashSel = document.getElementById('dashboard-site-select');
  if (dashSel) {
    const prev = dashSel.value;
    dashSel.innerHTML = `<option value="">Все площадки</option>` + SITES.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    if (SITES.some(s => s.id === prev)) dashSel.value = prev;
  }
}

// ---------------- ИНТЕГРАЦИИ: единый список подключений (MikroTik / UniFi / Cisco) ----------------
const CONN_TYPE_LABELS = { mikrotik: 'MikroTik', unifi: 'UniFi', cisco: 'Cisco' };
const CONN_TYPE_ENDPOINTS = {
  mikrotik: '/api/mikrotik/routers',
  unifi: '/api/unifi/controllers',
  cisco: '/api/cisco/devices'
};

async function loadConnections() {
  const tbody = document.getElementById('connections-tbody');
  try {
    const [mikrotiks, unifis, ciscos] = await Promise.all([
      api('/api/mikrotik/routers').then(r => r.json()).catch(() => []),
      api('/api/unifi/controllers').then(r => r.json()).catch(() => []),
      api('/api/cisco/devices').then(r => r.json()).catch(() => [])
    ]);
    const rows = [
      ...mikrotiks.map(c => ({ ...c, type: 'mikrotik' })),
      ...unifis.map(c => ({ ...c, type: 'unifi' })),
      ...ciscos.map(c => ({ ...c, type: 'cisco' }))
    ];
    tbody.innerHTML = rows.length ? rows.map(c => `
      <tr>
        <td><span class="cat-badge" style="background:#3b82f622;color:#3b82f6">${CONN_TYPE_LABELS[c.type]}</span></td>
        <td>${esc(c.name)}</td>
        <td>${esc(c.host)}${c.useTls || c.unifiOS ? ' 🔒' : ''}</td>
        <td>${esc(String(c.port || ''))}</td>
        <td>${esc(c.user || '')}</td>
        <td class="row-actions admin-only">
          <button class="small-btn conn-import-btn" data-id="${esc(c.id)}" data-type="${c.type}">Импортировать</button>
          <button class="small-btn conn-edit-btn" data-id="${esc(c.id)}" data-type="${c.type}" title="Редактировать">✏</button>
          <button class="conn-delete-btn" data-id="${esc(c.id)}" data-type="${c.type}" title="Удалить">🗑</button>
        </td>
      </tr>`).join('') : `<tr><td colspan="6" class="hint">Подключений ещё не добавлено</td></tr>`;

    tbody.querySelectorAll('.conn-import-btn').forEach(btn => {
      btn.addEventListener('click', () => importConnection(btn.dataset.type, btn.dataset.id, btn));
    });
    tbody.querySelectorAll('.conn-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteConnection(btn.dataset.type, btn.dataset.id));
    });
    tbody.querySelectorAll('.conn-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => editConnection(btn.dataset.type, btn.dataset.id, rows));
    });
  } catch (e) { /* ignore */ }
}

async function editConnection(type, id, rows) {
  const conn = rows.find(r => r.id === id && r.type === type);
  if (!conn) return;
  // Заполняем форму добавления данными для редактирования
  const typeSelect = document.getElementById('conn-type');
  if (typeSelect) {
    typeSelect.value = type === 'mikrotik' ? 'mikrotik' : type === 'unifi' ? 'unifi' : 'cisco';
    typeSelect.dispatchEvent(new Event('change'));
  }
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
  set('conn-name', conn.name);
  set('conn-host', conn.host);
  set('conn-port', conn.port);
  set('conn-user', conn.user);
  set('conn-password', '');  // пароль не передаётся, пусть введут заново
  if (type === 'unifi') {
    set('conn-site', conn.site);
    const unifiosEl = document.getElementById('conn-unifios');
    if (unifiosEl) unifiosEl.checked = !!conn.unifiOS;
  }
  if (type === 'mikrotik') {
    const tlsEl = document.getElementById('conn-tls');
    if (tlsEl) tlsEl.checked = !!conn.useTls;
    set('conn-traffic-ifaces', (conn.trafficInterfaces || []).join(','));
  }
  // Сначала удаляем старое, потом форма создаст новое при сабмите
  if (await showConfirm(
    `Редактировать подключение "${conn.name}"?`,
    'Текущая запись будет удалена и создана заново с новыми данными. Введите новые данные в форму ниже и нажмите «Добавить».',
    { okLabel: 'Удалить и редактировать', okClass: 'btn-primary' }
  )) {
    await api(`${CONN_TYPE_ENDPOINTS[type]}/${id}`, { method: 'DELETE' });
    await loadConnections();
    toast(`Подключение "${conn.name}" удалено — введите новые данные и нажмите «Добавить»`, 'info', 6000);
    // Скроллим к форме
    document.getElementById('conn-type')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

async function importConnection(type, id, btn) {
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Импортирую...';
  try {
    const res = await api(`${CONN_TYPE_ENDPOINTS[type]}/${id}/import`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { alert('Ошибка: ' + (data.message || data.error)); return; }
    alert(`Готово: найдено ${data.total}, создано ${data.created}, обновлено ${data.updated}.`);
    await loadAll();
  } catch (e) {
    alert('Ошибка соединения с сервером.');
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
}

async function deleteConnection(type, id) {
  if (!confirm('Удалить это подключение из списка?')) return;
  await api(`${CONN_TYPE_ENDPOINTS[type]}/${id}`, { method: 'DELETE' });
  await loadConnections();
}

// Переключение видимых полей формы в зависимости от выбранного типа подключения
function updateConnFormFields() {
  const type = document.getElementById('conn-type').value;
  const isUnifiOS = document.getElementById('conn-unifios').checked;
  document.getElementById('conn-site-wrap').classList.toggle('hidden', type !== 'unifi');
  document.getElementById('conn-unifios-wrap').classList.toggle('hidden', type !== 'unifi');
  document.getElementById('conn-tls-wrap').classList.toggle('hidden', type !== 'mikrotik');
  document.getElementById('conn-traffic-wrap').classList.toggle('hidden', type !== 'mikrotik');
  document.getElementById('conn-traffic-hint').classList.toggle('hidden', type !== 'mikrotik');
  document.getElementById('conn-hint-mikrotik').classList.toggle('hidden', type !== 'mikrotik');
  document.getElementById('conn-hint-unifi').classList.toggle('hidden', type !== 'unifi');
  document.getElementById('conn-hint-cisco').classList.toggle('hidden', type !== 'cisco');

  const portField = document.getElementById('conn-port');
  const userField = document.getElementById('conn-user');
  // Порт по умолчанию: MikroTik — 8728, Cisco (SSH) — 22, UniFi зависит от типа консоли —
  // UniFi OS (UDM/UDM Pro/Cloud Key Gen2+) слушает на 443, а классический software-контроллер
  // (или Cloud Key Gen1) — на 8443. Это частая причина «не могу подключиться» у UniFi.
  const knownDefaults = ['8728', '443', '8443', '22'];
  if (!portField.value || knownDefaults.includes(portField.value)) {
    portField.value = type === 'mikrotik' ? '8728' : type === 'cisco' ? '22' : (isUnifiOS ? '443' : '8443');
  }
  if (!userField.value || userField.value === 'admin') userField.value = 'admin';
}
document.getElementById('conn-type').addEventListener('change', updateConnFormFields);
document.getElementById('conn-unifios').addEventListener('change', updateConnFormFields);
updateConnFormFields();

document.getElementById('connection-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const type = document.getElementById('conn-type').value;
  const resultBox = document.getElementById('conn-result');
  const payload = {
    name: document.getElementById('conn-name').value,
    host: document.getElementById('conn-host').value,
    port: document.getElementById('conn-port').value,
    user: document.getElementById('conn-user').value,
    password: document.getElementById('conn-password').value
  };
  if (type === 'mikrotik') {
    payload.useTls = document.getElementById('conn-tls').checked;
    payload.trafficInterfaces = document.getElementById('conn-traffic-ifaces').value;
  }
  if (type === 'unifi') {
    payload.site = document.getElementById('conn-site').value || 'default';
    payload.unifiOS = document.getElementById('conn-unifios').checked;
  }

  const res = await api(CONN_TYPE_ENDPOINTS[type], {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) { resultBox.textContent = 'Ошибка: ' + (data.message || data.error); return; }
  document.getElementById('connection-form').reset();
  document.getElementById('conn-type').value = type;
  updateConnFormFields();
  resultBox.textContent = 'Добавлено.';
  await loadConnections();
});

document.getElementById('mt-import-all-btn').addEventListener('click', async () => {
  const box = document.getElementById('mt-import-all-result');
  box.textContent = 'Импортирую со всех MikroTik...';
  try {
    const res = await api('/api/mikrotik/import-all', { method: 'POST' }).then(r => r.json());
    box.innerHTML = res.results.length ? res.results.map(r =>
      r.ok ? `✅ ${esc(r.router)}: найдено ${r.total}, создано ${r.created}, обновлено ${r.updated}`
           : `❌ ${esc(r.router)}: ${esc(r.message)}`
    ).join('<br>') : 'MikroTik-роутеров пока не добавлено.';
    await loadAll();
  } catch (e) {
    box.textContent = 'Ошибка соединения с сервером.';
  }
});

// ---------------- НАСТРОЙКИ: АЛЕРТЫ ----------------
async function loadAlertSettings() {
  try {
    const cfg = await api('/api/alert-settings').then(r => r.json());
    document.getElementById('al-enabled').checked = !!cfg.enabled;
    document.getElementById('al-threshold').value = String(cfg.failThreshold || 2);
    document.getElementById('al-repeat').value = String(cfg.repeatMinutes != null ? cfg.repeatMinutes : 30);
    document.getElementById('al-recovery').checked = cfg.notifyOnRecovery !== false;
    document.getElementById('al-tg-enabled').checked = !!cfg.telegram?.enabled;
    document.getElementById('al-tg-token').value = cfg.telegram?.botToken || '';
    document.getElementById('al-tg-chat').value = cfg.telegram?.chatId || '';
    document.getElementById('al-wh-enabled').checked = !!cfg.webhook?.enabled;
    document.getElementById('al-wh-url').value = cfg.webhook?.url || '';
    document.getElementById('al-ntfy-enabled').checked = !!cfg.ntfy?.enabled;
    document.getElementById('al-ntfy-url').value = cfg.ntfy?.url || 'https://ntfy.sh';
    document.getElementById('al-ntfy-topic').value = cfg.ntfy?.topic || '';
    document.getElementById('al-ntfy-token').value = cfg.ntfy?.authToken || '';
    document.getElementById('al-email-enabled').checked = !!cfg.email?.enabled;
    document.getElementById('al-email-host').value = cfg.email?.host || '';
    document.getElementById('al-email-port').value = cfg.email?.port || 587;
    document.getElementById('al-email-secure').checked = !!cfg.email?.secure;
    document.getElementById('al-email-user').value = cfg.email?.user || '';
    document.getElementById('al-email-pass').value = cfg.email?.pass || '';
    document.getElementById('al-email-from').value = cfg.email?.from || '';
    document.getElementById('al-email-to').value = cfg.email?.to || '';
    document.getElementById('al-esc-enabled').checked = !!cfg.escalation?.enabled;
    document.getElementById('al-esc-minutes').value = String(cfg.escalation?.afterMinutes || 60);
    document.getElementById('al-esc-chat').value = cfg.escalation?.telegramChatId || '';
  } catch (e) { /* ignore */ }
}

async function saveAlertSettings() {
  await api('/api/alert-settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: document.getElementById('al-enabled').checked,
      failThreshold: Number(document.getElementById('al-threshold').value),
      repeatMinutes: Number(document.getElementById('al-repeat').value),
      notifyOnRecovery: document.getElementById('al-recovery').checked,
      telegram: {
        enabled: document.getElementById('al-tg-enabled').checked,
        botToken: document.getElementById('al-tg-token').value,
        chatId: document.getElementById('al-tg-chat').value
      },
      webhook: {
        enabled: document.getElementById('al-wh-enabled').checked,
        url: document.getElementById('al-wh-url').value
      },
      ntfy: {
        enabled: document.getElementById('al-ntfy-enabled').checked,
        url: document.getElementById('al-ntfy-url').value,
        topic: document.getElementById('al-ntfy-topic').value,
        authToken: document.getElementById('al-ntfy-token').value
      },
      email: {
        enabled: document.getElementById('al-email-enabled').checked,
        host: document.getElementById('al-email-host').value,
        port: Number(document.getElementById('al-email-port').value) || 587,
        secure: document.getElementById('al-email-secure').checked,
        user: document.getElementById('al-email-user').value,
        pass: document.getElementById('al-email-pass').value,
        from: document.getElementById('al-email-from').value,
        to: document.getElementById('al-email-to').value
      },
      escalation: {
        enabled: document.getElementById('al-esc-enabled').checked,
        afterMinutes: Number(document.getElementById('al-esc-minutes').value) || 60,
        telegramChatId: document.getElementById('al-esc-chat').value
      }
    })
  });
}

document.getElementById('alert-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveAlertSettings();
  document.getElementById('al-result').textContent = 'Настройки алертов сохранены.';
});

document.getElementById('al-test-btn').addEventListener('click', async () => {
  const box = document.getElementById('al-result');
  box.textContent = 'Сохраняю и отправляю тестовое уведомление...';
  await saveAlertSettings();
  try {
    await api('/api/alert-settings/test', { method: 'POST' });
    box.textContent = 'Тестовое уведомление отправлено (если каналы настроены верно — оно уже пришло).';
  } catch (e) {
    box.textContent = 'Ошибка отправки.';
  }
});

document.getElementById('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resultBox = document.getElementById('pw-result');
  const res = await api('/api/change-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currentPassword: document.getElementById('p-current').value,
      newPassword: document.getElementById('p-new').value
    })
  });
  if (res.ok) {
    resultBox.textContent = 'Пароль успешно изменён.';
    document.getElementById('password-form').reset();
  } else {
    const data = await res.json();
    resultBox.textContent = data.error === 'wrong_current_password' ? 'Неверный текущий пароль.' : 'Ошибка: пароль слишком короткий.';
  }
});

// ---------------- NAV / TABS ----------------
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

// ---------------- FILTERS / VIEW TOGGLE ----------------
document.getElementById('filter-category').addEventListener('change', () => { PAGE_STATE.page = 1; renderDevices(); });
document.getElementById('search-input').addEventListener('input', () => { PAGE_STATE.page = 1; renderDevices(); });

document.getElementById('page-prev-btn').addEventListener('click', () => { PAGE_STATE.page--; renderDevices(); });
document.getElementById('page-next-btn').addEventListener('click', () => { PAGE_STATE.page++; renderDevices(); });
document.getElementById('page-size-select').addEventListener('change', (e) => {
  PAGE_STATE.pageSize = Number(e.target.value);
  PAGE_STATE.page = 1;
  renderDevices();
});
document.getElementById('view-table-btn').addEventListener('click', () => setView('table'));
document.getElementById('view-cards-btn').addEventListener('click', () => setView('cards'));

function setView(v) {
  document.getElementById('view-table-btn').classList.toggle('active', v === 'table');
  document.getElementById('view-cards-btn').classList.toggle('active', v === 'cards');
  document.getElementById('devices-table-wrap').classList.toggle('hidden', v !== 'table');
  document.getElementById('devices-cards-wrap').classList.toggle('hidden', v !== 'cards');
}

// ---------------- НАСТРОЙКИ: ПОЛЬЗОВАТЕЛИ (только для админа) ----------------
async function loadUsers() {
  try {
    const users = await api('/api/users').then(r => r.json());
    const meRes = await api('/api/me').then(r => r.json());
    document.getElementById('users-tbody').innerHTML = users.map(u => `
      <tr>
        <td>${esc(u.username)}${u.username === meRes.username ? ' <span class="hint">(вы)</span>' : ''}
          ${u.source === 'ldap' ? '<span class="status-badge status-unknown" style="margin-left:6px;" title="Учётная запись создана автоматически при входе через LDAP/AD">LDAP</span>' : ''}
          ${u.mustChangePassword ? '<span class="status-badge status-offline" style="margin-left:6px;" title="Ещё не сменил пароль по умолчанию">пароль не сменён</span>' : ''}
        </td>
        <td>
          <select class="role-select" data-username="${esc(u.username)}" ${u.username === meRes.username ? 'disabled' : ''}>
            <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>Только просмотр</option>
            <option value="operator" ${u.role === 'operator' ? 'selected' : ''}>Operator</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Администратор</option>
          </select>
        </td>
        <td>${u.username === meRes.username ? '' : `<button onclick="deleteUser('${esc(u.username)}')">🗑</button>`}</td>
      </tr>`).join('');

    document.querySelectorAll('.role-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const res = await api(`/api/users/${sel.dataset.username}/role`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: sel.value })
        });
        if (!res.ok) {
          const d = await res.json();
          toast(d.message || d.error, 'error');
          await loadUsers();
        } else {
          toast('Роль обновлена', 'success');
        }
      });
    });
  } catch (e) { /* ignore */ }
}

document.getElementById('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resultBox = document.getElementById('user-result');
  const res = await api('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: document.getElementById('u-username').value,
      password: document.getElementById('u-password').value,
      role: document.getElementById('u-role').value
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { resultBox.textContent = 'Ошибка: ' + (data.message || data.error); return; }
  resultBox.textContent = 'Пользователь добавлен.';
  document.getElementById('user-form').reset();
  await loadUsers();
});

async function deleteUser(username) {
  const ok = await showConfirm(`Удалить пользователя «${username}»?`, 'Это действие необратимо.');
  if (!ok) return;
  const res = await api(`/api/users/${username}`, { method: 'DELETE' });
  if (!res.ok) {
    const d = await res.json();
    toast(d.message || d.error, 'error');
  } else {
    toast(`Пользователь «${username}» удалён`, 'success');
  }
  await loadUsers();
}

// ---------------- РЕЗЕРВНАЯ КОПИЯ ----------------
document.getElementById('backup-download-btn').addEventListener('click', async () => {
  const resultBox = document.getElementById('backup-download-result');
  resultBox.textContent = 'Готовлю файл...';
  try {
    const res = await api('/api/backup');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `netmonitor-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    resultBox.textContent = 'Готово, файл скачан.';
  } catch (e) {
    resultBox.textContent = 'Ошибка при скачивании бэкапа.';
  }
});

document.getElementById('backup-restore-btn').addEventListener('click', async () => {
  const fileInput = document.getElementById('backup-restore-file');
  const resultBox = document.getElementById('backup-restore-result');
  const file = fileInput.files[0];
  if (!file) { resultBox.textContent = 'Выберите файл бэкапа.'; return; }
  if (!confirm('Восстановление ПОЛНОСТЬЮ заменит текущие данные содержимым файла. Действие необратимо. Продолжить?')) return;

  resultBox.textContent = 'Читаю файл...';
  try {
    const text = await file.text();
    const bundle = JSON.parse(text);
    resultBox.textContent = 'Восстанавливаю...';
    const res = await api('/api/backup/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bundle)
    });
    const data = await res.json();
    if (!res.ok) { resultBox.textContent = 'Ошибка: ' + (data.message || data.error); return; }
    resultBox.textContent = 'Готово. Обновляю страницу...';
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    resultBox.textContent = 'Файл повреждён или не является корректным JSON-бэкапом.';
  }
});

// ---------------- ESC ЗАКРЫВАЕТ ОТКРЫТОЕ МОДАЛЬНОЕ ОКНО ----------------
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const closableModals = [
    ['device-modal', 'cancel-btn'],
    ['link-label-modal', 'link-label-cancel'],
    ['subnet-rules-modal', 'subnet-rules-close']
  ];
  for (const [modalId, btnId] of closableModals) {
    const modal = document.getElementById(modalId);
    if (modal && !modal.classList.contains('hidden')) {
      document.getElementById(btnId).click();
      break;
    }
  }
});

fetch('/api/health').then(r => r.json()).then(h => {
  document.getElementById('app-version').textContent = h.version || '?';
}).catch(() => {});

// ---------------- ТЕМА И БРЕНДИНГ (применяются ещё до логина) ----------------
function applyTheme(theme) {
  document.body.classList.toggle('theme-light', theme === 'light');
  document.querySelectorAll('.theme-choice').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

async function loadBrandingAndTheme() {
  let branding = { appName: 'NetMonitor', accentColor: '#3b82f6', defaultTheme: 'dark' };
  try {
    branding = await fetch('/api/branding').then(r => r.json());
  } catch (e) { /* используем дефолты */ }

  document.title = branding.appName || 'NetMonitor';
  document.getElementById('sidebar-app-name').textContent = branding.appName || 'NetMonitor';
  document.getElementById('login-app-name').textContent = branding.appName || 'NetMonitor';
  document.documentElement.style.setProperty('--accent', branding.accentColor || '#3b82f6');

  const bust = '?v=' + Date.now(); // чтобы браузер не кэшировал старый логотип после загрузки нового
  document.getElementById('sidebar-logo').src = '/api/branding/logo' + bust;
  document.getElementById('login-logo').src = '/api/branding/logo' + bust;

  const savedTheme = localStorage.getItem('netmonitor-theme');
  applyTheme(savedTheme || branding.defaultTheme || 'dark');
}

document.querySelectorAll('.theme-choice').forEach(btn => {
  btn.addEventListener('click', () => {
    localStorage.setItem('netmonitor-theme', btn.dataset.theme);
    applyTheme(btn.dataset.theme);
  });
});

loadBrandingAndTheme();

// ---------------- ПОДВКЛАДКИ НАСТРОЕК ----------------
document.querySelectorAll('.settings-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.settings-subtab').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    document.querySelector(`.settings-subtab[data-settings-panel="${btn.dataset.settingsTab}"]`).classList.remove('hidden');
    // Перезагружаем данные при открытии вкладки "О системе"
    if (btn.dataset.settingsTab === 'about') loadAboutPanel();
    if (btn.dataset.settingsTab === 'event-webhook') loadEventWebhookForm();
    if (btn.dataset.settingsTab === 'ldap') loadLdapForm();
  });
});

// ---------------- WEBHOOK НА ЛЮБОЕ СОБЫТИЕ ----------------
const EVENT_WEBHOOK_ACTIONS = [
  'device.create','device.update','device.delete','devices.import_csv',
  'user.create','user.delete','user.role_change','user.change_password',
  'maintenance.create','maintenance.delete',
  'mikrotik_router.add','mikrotik_router.delete',
  'cisco.add','cisco.delete','cisco.import',
  'unifi.add','unifi.delete','unifi.import',
  'agent.token_generate','agent.token_reset','agent.unlink',
  'alert_settings.update','event_webhook.update','features.update',
  'branding.update','categories.update','oui.refresh',
  'backup.download','backup.restore','ldap.update','logs.delete'
];

function populateEventWebhookSelect() {
  const sel = document.getElementById('ew-events');
  if (sel.options.length) return;
  EVENT_WEBHOOK_ACTIONS.forEach(a => { const o = document.createElement('option'); o.value = a; o.textContent = a; sel.appendChild(o); });
}

async function loadEventWebhookForm() {
  populateEventWebhookSelect();
  try {
    const cfg = await api('/api/event-webhook').then(r => r.json());
    document.getElementById('ew-enabled').checked = !!cfg.enabled;
    document.getElementById('ew-url').value = cfg.url || '';
    document.getElementById('ew-secret').value = cfg.secret || '';
    const events = new Set(cfg.events || []);
    Array.from(document.getElementById('ew-events').options).forEach(o => { o.selected = events.has(o.value); });
  } catch (e) { /* ignore */ }
}

document.getElementById('event-webhook-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const events = Array.from(document.getElementById('ew-events').selectedOptions).map(o => o.value);
  await api('/api/event-webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: document.getElementById('ew-enabled').checked,
      url: document.getElementById('ew-url').value,
      secret: document.getElementById('ew-secret').value,
      events
    })
  });
  document.getElementById('ew-result').textContent = 'Настройки сохранены.';
});

document.getElementById('ew-test-btn').addEventListener('click', async () => {
  const box = document.getElementById('ew-result');
  box.textContent = 'Отправляю...';
  try {
    await api('/api/event-webhook/test', { method: 'POST' });
    box.textContent = 'Тестовое событие отправлено.';
  } catch (e) {
    box.textContent = 'Ошибка отправки. Проверьте URL и настройки.';
  }
});

// ---------------- LDAP/AD ----------------
function ldapRuleRow(rule = { group: '', role: 'viewer' }) {
  const div = document.createElement('div');
  div.className = 'controls';
  div.style.marginBottom = '6px';
  div.innerHTML = `
    <input type="text" class="ldap-rule-group" placeholder="CN=NetAdmins,OU=Groups,DC=example,DC=local" value="${esc(rule.group)}" style="flex:2;">
    <select class="ldap-rule-role" style="flex:1;">
      <option value="admin">Администратор</option>
      <option value="operator">Оператор</option>
      <option value="viewer">Наблюдатель</option>
    </select>
    <button type="button" class="small-btn ldap-rule-remove" title="Удалить правило">✕</button>
  `;
  div.querySelector('.ldap-rule-role').value = rule.role;
  div.querySelector('.ldap-rule-remove').addEventListener('click', () => div.remove());
  return div;
}

document.getElementById('ldap-add-rule-btn').addEventListener('click', () => {
  document.getElementById('ldap-role-rules').appendChild(ldapRuleRow());
});

async function loadLdapForm() {
  try {
    const cfg = await api('/api/ldap').then(r => r.json());
    document.getElementById('ldap-enabled').checked = !!cfg.enabled;
    document.getElementById('ldap-url').value = cfg.url || '';
    document.getElementById('ldap-reject-unauthorized').checked = cfg.rejectUnauthorized !== false;
    document.getElementById('ldap-binddn').value = cfg.bindDN || '';
    document.getElementById('ldap-bindpass').value = cfg.bindPassword || '';
    document.getElementById('ldap-basedn').value = cfg.baseDN || '';
    document.getElementById('ldap-userfilter').value = cfg.userFilter || '(sAMAccountName={{username}})';
    document.getElementById('ldap-defaultrole').value = cfg.defaultRole || 'viewer';
    const rulesWrap = document.getElementById('ldap-role-rules');
    rulesWrap.innerHTML = '';
    (cfg.roleMapping || []).forEach(r => rulesWrap.appendChild(ldapRuleRow(r)));
  } catch (e) { /* ignore */ }
}

document.getElementById('ldap-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const roleMapping = Array.from(document.querySelectorAll('#ldap-role-rules > div')).map(div => ({
    group: div.querySelector('.ldap-rule-group').value.trim(),
    role: div.querySelector('.ldap-rule-role').value
  })).filter(r => r.group);
  await api('/api/ldap', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: document.getElementById('ldap-enabled').checked,
      url: document.getElementById('ldap-url').value,
      rejectUnauthorized: document.getElementById('ldap-reject-unauthorized').checked,
      bindDN: document.getElementById('ldap-binddn').value,
      bindPassword: document.getElementById('ldap-bindpass').value,
      baseDN: document.getElementById('ldap-basedn').value,
      userFilter: document.getElementById('ldap-userfilter').value,
      defaultRole: document.getElementById('ldap-defaultrole').value,
      roleMapping
    })
  });
  document.getElementById('ldap-result').textContent = 'Настройки сохранены.';
});

document.getElementById('ldap-test-btn').addEventListener('click', async () => {
  const box = document.getElementById('ldap-result');
  box.textContent = 'Проверяю соединение...';
  const passVal = document.getElementById('ldap-bindpass').value;
  try {
    const res = await api('/api/ldap/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(passVal === '••••••••'
        ? { useSaved: true }
        : {
            url: document.getElementById('ldap-url').value,
            rejectUnauthorized: document.getElementById('ldap-reject-unauthorized').checked,
            bindDN: document.getElementById('ldap-binddn').value,
            bindPassword: passVal,
            baseDN: document.getElementById('ldap-basedn').value
          })
    });
    const data = await res.json();
    box.textContent = data.ok ? '✅ ' + (data.message || 'Успешно.') : '❌ ' + (data.error || 'Ошибка.');
  } catch (e) {
    box.textContent = '❌ Ошибка соединения с сервером NetMonitor.';
  }
});

// ---------------- БРЕНДИНГ: форма (только админ) ----------------
async function loadBrandingForm() {
  try {
    const b = await api('/api/branding').then(r => r.json());
    document.getElementById('brand-name').value = b.appName || 'NetMonitor';
    document.getElementById('brand-accent').value = b.accentColor || '#3b82f6';
    document.getElementById('brand-default-theme').value = b.defaultTheme || 'dark';
  } catch (e) { /* ignore */ }
}

document.getElementById('branding-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resultBox = document.getElementById('branding-result');
  const res = await api('/api/branding', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appName: document.getElementById('brand-name').value,
      accentColor: document.getElementById('brand-accent').value,
      defaultTheme: document.getElementById('brand-default-theme').value
    })
  });
  const data = await res.json();
  if (!res.ok) { resultBox.textContent = 'Ошибка: ' + (data.message || data.error); return; }
  resultBox.textContent = 'Сохранено.';
  await loadBrandingAndTheme();
});

document.getElementById('logo-upload-btn').addEventListener('click', async () => {
  const fileInput = document.getElementById('logo-file');
  const resultBox = document.getElementById('logo-result');
  const file = fileInput.files[0];
  if (!file) { resultBox.textContent = 'Выберите файл.'; return; }
  const allowed = ['image/svg+xml', 'image/png', 'image/jpeg'];
  if (!allowed.includes(file.type)) { resultBox.textContent = 'Разрешены только SVG, PNG или JPG.'; return; }
  if (file.size > 1024 * 1024) { resultBox.textContent = 'Файл больше 1 МБ.'; return; }

  resultBox.textContent = 'Загружаю...';
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const res = await api('/api/branding/logo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl })
  });
  const data = await res.json();
  if (!res.ok) { resultBox.textContent = 'Ошибка: ' + (data.message || data.error); return; }
  resultBox.textContent = 'Готово.';
  fileInput.value = '';
  await loadBrandingAndTheme();
  document.getElementById('logo-preview').src = '/api/branding/logo?v=' + Date.now();
});

document.getElementById('logo-reset-btn').addEventListener('click', async () => {
  const resultBox = document.getElementById('logo-result');
  await api('/api/branding/logo', { method: 'DELETE' });
  resultBox.textContent = 'Сброшено на стандартный логотип.';
  await loadBrandingAndTheme();
  document.getElementById('logo-preview').src = '/api/branding/logo?v=' + Date.now();
});

checkAuth();

// ══════════════════════════════════════════════════════════════════
//  ЛОГИ — просмотр системных логов в настройках
// ══════════════════════════════════════════════════════════════════

const LEVEL_COLORS = {
  ERROR: '#ef4444', WARN: '#f59e0b', INFO: '#22c55e',
  DEBUG: '#3b82f6', TRACE: '#8b95ab', FATAL: '#ef4444', RAW: '#8b95ab'
};

async function initLogsTab() {
  // Загружаем список файлов логов в select
  try {
    const data = await api('/api/logs/files').then(r => r.json());
    const sel = document.getElementById('logs-date-select');
    sel.innerHTML = '<option value="">Сегодня (текущий)</option>';
    (data.files || []).forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.date;
      const kb = (f.sizeBytes / 1024).toFixed(1);
      opt.textContent = `${f.date} (${kb} KB)`;
      sel.appendChild(opt);
    });
  } catch {}
  stopLogsLiveTail();
  await loadLogs();
}

let _logsSearchDebounce = null;
function loadLogsDebounced() {
  clearTimeout(_logsSearchDebounce);
  _logsSearchDebounce = setTimeout(loadLogs, 300);
}

async function loadLogs() {
  const date    = document.getElementById('logs-date-select').value;
  const level   = document.getElementById('logs-level-select').value;
  const lines   = document.getElementById('logs-lines-select').value;
  const search  = document.getElementById('logs-search').value.trim();
  const container = document.getElementById('logs-container');
  const stats   = document.getElementById('logs-stats');
  const delBtn  = document.getElementById('logs-delete-btn');
  const dlBtn   = document.getElementById('logs-download-btn');
  const liveBtn = document.getElementById('logs-live-btn');

  liveBtn.style.display = date ? 'none' : ''; // живой tail только для текущего активного файла
  if (date) stopLogsLiveTail();

  container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-dim);">Загрузка...</div>';

  try {
    const params = new URLSearchParams({ lines });
    if (level) params.set('level', level);
    if (search) params.set('search', search);
    const url = date ? `/api/logs/file/${encodeURIComponent(date)}?${params}` : `/api/logs?${params}`;

    const data = await api(url).then(r => r.json());

    stats.textContent = `Дата: ${data.date} · Строк: ${data.count}`;
    delBtn.style.display = date ? '' : 'none';
    delBtn.dataset.date = date || '';
    dlBtn.href = date ? `/api/logs/file/${encodeURIComponent(date)}/download` : `/api/logs/file/${encodeURIComponent(data.date)}/download`;

    if (!data.lines || !data.lines.length) {
      container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-dim);">Нет записей</div>';
      return;
    }

    // Рендерим строки снизу вверх (новые снизу)
    container.innerHTML = data.lines.map(logLineHTML).join('');

    // Скроллим вниз (новые записи внизу)
    container.scrollTop = container.scrollHeight;

  } catch(e) {
    container.innerHTML = `<div style="padding:24px;text-align:center;color:var(--red);">Ошибка: ${esc(e.message)}</div>`;
  }
}

// Общий рендер одной строки лога — используется и статичной загрузкой, и живым tail
function logLineHTML(line) {
  const ts   = line.ts ? new Date(line.ts).toLocaleTimeString('ru-RU') : '—';
  const lvl  = line.level || 'RAW';
  const msg  = line.msg || '';
  const color = LEVEL_COLORS[lvl] || '#8b95ab';

  const extra = Object.entries(line)
    .filter(([k]) => !['ts','level','msg'].includes(k))
    .map(([k,v]) => `<span style="opacity:.6;">${esc(k)}=</span>${esc(typeof v==='object'?JSON.stringify(v):String(v))}`)
    .join(' ');

  return `<div style="display:flex;gap:8px;padding:3px 10px;border-bottom:1px solid var(--border);font-size:11.5px;line-height:1.6;" onmouseover="this.style.background='var(--panel)'" onmouseout="this.style.background=''">
    <span style="color:var(--text-dim);flex-shrink:0;width:60px;">${esc(ts)}</span>
    <span style="color:${color};flex-shrink:0;width:48px;font-weight:600;">${esc(lvl)}</span>
    <span style="flex:1;word-break:break-all;">${esc(msg)}${extra ? ' <span style="opacity:.5;font-size:10.5px;">' + extra + '</span>' : ''}</span>
  </div>`;
}

// ---------------- ЖИВОЙ TAIL (как `docker logs -f`), через SSE ----------------
let _logsEventSource = null;
function startLogsLiveTail() {
  if (_logsEventSource) return;
  const container = document.getElementById('logs-container');
  const liveBtn = document.getElementById('logs-live-btn');
  _logsEventSource = new EventSource('/api/logs/stream');
  liveBtn.classList.add('active');
  liveBtn.textContent = '🔴 Live (вкл)';
  _logsEventSource.onmessage = (ev) => {
    try {
      const line = JSON.parse(ev.data);
      if (container.children.length === 1 && container.textContent.includes('Нет записей')) container.innerHTML = '';
      container.insertAdjacentHTML('beforeend', logLineHTML(line));
      // Не даём контейнеру расти бесконечно при долго открытой вкладке
      while (container.children.length > 2000) container.removeChild(container.firstChild);
      container.scrollTop = container.scrollHeight;
    } catch {}
  };
  _logsEventSource.onerror = () => { /* браузер сам переподключится; ничего не делаем */ };
}
function stopLogsLiveTail() {
  if (_logsEventSource) { _logsEventSource.close(); _logsEventSource = null; }
  const liveBtn = document.getElementById('logs-live-btn');
  if (liveBtn) { liveBtn.classList.remove('active'); liveBtn.textContent = '🔴 Live'; }
}
function toggleLogsLiveTail() {
  if (_logsEventSource) stopLogsLiveTail(); else startLogsLiveTail();
}

async function deleteLogFile() {
  const btn = document.getElementById('logs-delete-btn');
  const date = btn.dataset.date;
  if (!date) return;
  const ok = await showConfirm(`Удалить лог за ${date}?`, 'Файл будет удалён безвозвратно.');
  if (!ok) return;
  try {
    await api(`/api/logs/file/${encodeURIComponent(date)}`, { method: 'DELETE' });
    toast(`Лог за ${date} удалён`, 'success');
    document.getElementById('logs-date-select').value = '';
    await initLogsTab();
  } catch(e) {
    toast('Ошибка удаления: ' + e.message, 'error');
  }
}

// Инициализация при открытии вкладки настроек
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.settingsTab === 'logs') {
        initLogsTab();
      } else {
        stopLogsLiveTail(); // ушли с вкладки логов — закрываем SSE-соединение
      }
    });
  });
});


/* ══════════════════════════════════════════════════════════
   ВКЛАДКИ ФОРМЫ УСТРОЙСТВА
══════════════════════════════════════════════════════════ */

// Инициализация вкладок при клике
document.addEventListener('click', e => {
  const tab = e.target.closest('.form-tab');
  if (!tab) return;
  const container = tab.closest('.modal');
  if (!container) return;
  // Переключаем кнопки
  container.querySelectorAll('.form-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  // Переключаем панели
  const targetId = tab.dataset.tab;
  container.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  const panel = container.querySelector('#' + targetId);
  if (panel) panel.classList.remove('hidden');
});

// При открытии формы — сбрасываем на первую вкладку
const _origOpenDeviceModal = window.openDeviceModal;
function resetFormTabs() {
  const modal = document.getElementById('device-modal');
  if (!modal) return;
  modal.querySelectorAll('.form-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  modal.querySelectorAll('.tab-panel').forEach((p, i) => p.classList.toggle('hidden', i !== 0));
}

/* ══════════════════════════════════════════════════════════
   MAINTENANCE WINDOWS
══════════════════════════════════════════════════════════ */

let MAINTENANCE = [];

async function loadMaintenance() {
  try {
    MAINTENANCE = await api('/api/maintenance').then(r => r.json());
  } catch { MAINTENANCE = []; }
  renderMaintenance();
}

function renderMaintenance() {
  const container = document.getElementById('mw-list');
  if (!container) return;
  const now = Date.now();

  if (!MAINTENANCE.length) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="ti ti-calendar-off"></i>
        <h3>Нет окон обслуживания</h3>
        <p>Создайте окно обслуживания чтобы временно приостановить алерты для устройств во время плановых работ.</p>
        ${CURRENT_ROLE !== 'viewer' ? "<button class=\"empty-action\" onclick=\"document.getElementById(&quot;add-mw-btn&quot;).click()\">+ Добавить окно</button>" : ''}
      </div>`;
    return;
  }

  // Сортируем: активные → будущие → завершённые
  const sorted = [...MAINTENANCE].sort((a, b) => {
    const aActive = a.startTs <= now && a.endTs > now;
    const bActive = b.startTs <= now && b.endTs > now;
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.startTs - a.startTs;
  });

  container.innerHTML = sorted.map(w => {
    const isActive  = w.startTs <= now && w.endTs > now;
    const isPending = w.startTs > now;
    const isExpired = w.endTs <= now;
    const badge = isActive  ? '<span class="mw-badge active">Активно сейчас</span>'
                : isPending ? '<span class="mw-badge pending">Запланировано</span>'
                :             '<span class="mw-badge expired">Завершено</span>';
    const devText = w.allDevices ? 'Все устройства' : `${w.deviceIds.length} устр.`;
    const start = new Date(w.startTs).toLocaleString('ru-RU', {day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'});
    const end   = new Date(w.endTs).toLocaleString('ru-RU',   {day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'});
    return `<div class="mw-card${isActive ? ' active-now' : ''}">
      ${badge}
      <div class="mw-info">
        <div class="mw-name">${esc(w.name)}</div>
        <div class="mw-time">${start} — ${end}</div>
        <div class="mw-devices">${devText}${w.note ? ' · ' + esc(w.note) : ''}</div>
      </div>
      ${CURRENT_ROLE !== 'viewer' ? `<button class="btn-secondary" onclick="deleteMaintenance('${w.id}')">
        <i class="ti ti-trash"></i>
      </button>` : ''}
    </div>`;
  }).join('');
}

async function deleteMaintenance(id) {
  const ok = await showConfirm('Удалить окно обслуживания?', 'Алерты для устройств возобновятся немедленно.');
  if (!ok) return;
  try {
    await api(`/api/maintenance/${id}`, { method: 'DELETE' });
    MAINTENANCE = MAINTENANCE.filter(w => w.id !== id);
    renderMaintenance();
    toast('Окно обслуживания удалено', 'success');
  } catch { toast('Ошибка удаления', 'error'); }
}

// Открытие модалки создания окна
document.addEventListener('DOMContentLoaded', () => {
  // Кнопка добавить
  document.addEventListener('click', e => {
    if (e.target.closest('#add-mw-btn')) {
      // Заполняем список устройств
      const sel = document.getElementById('mw-devices');
      if (sel) {
        sel.innerHTML = DEVICES.sort((a,b)=>a.name.localeCompare(b.name))
          .map(d => `<option value="${d.id}">${esc(d.name)} (${d.ip || '—'})</option>`).join('');
      }
      // Дефолтное время: сейчас + 10 мин → через 2 часа
      const pad = n => String(n).padStart(2,'0');
      const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const start = new Date(Date.now() + 10 * 60000);
      const end   = new Date(Date.now() + 2  * 3600000);
      const startEl = document.getElementById('mw-start');
      const endEl   = document.getElementById('mw-end');
      if (startEl) startEl.value = fmt(start);
      if (endEl)   endEl.value   = fmt(end);
      document.getElementById('mw-modal').classList.remove('hidden');
    }
  });

  // Показать/скрыть список устройств при "все устройства"
  const mwAll = document.getElementById('mw-all');
  if (mwAll) {
    mwAll.addEventListener('change', () => {
      const wrap = document.getElementById('mw-devices-wrap');
      if (wrap) wrap.classList.toggle('hidden', mwAll.checked);
    });
  }

  // Форма создания maintenance window
  const mwForm = document.getElementById('mw-form');
  if (mwForm) {
    mwForm.addEventListener('submit', async e => {
      e.preventDefault();
      const allDevices = document.getElementById('mw-all')?.checked;
      const sel = document.getElementById('mw-devices');
      const deviceIds = allDevices ? [] : [...(sel?.selectedOptions || [])].map(o => o.value);
      const startVal = document.getElementById('mw-start')?.value;
      const endVal   = document.getElementById('mw-end')?.value;

      if (!startVal || !endVal) return toast('Укажите начало и конец', 'warning');
      const startTs = new Date(startVal).getTime();
      const endTs   = new Date(endVal).getTime();
      if (endTs <= startTs) return toast('Конец должен быть позже начала', 'warning');
      if (!allDevices && !deviceIds.length) return toast('Выберите устройства', 'warning');

      try {
        const w = await api('/api/maintenance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: document.getElementById('mw-name')?.value || 'Плановые работы',
            allDevices, deviceIds, startTs, endTs,
            note: document.getElementById('mw-note')?.value || '',
          }),
        }).then(r => r.json());
        MAINTENANCE.push(w);
        renderMaintenance();
        document.getElementById('mw-modal').classList.add('hidden');
        toast('Окно обслуживания создано', 'success');
      } catch { toast('Ошибка создания', 'error'); }
    });
  }
});

// Загружаем maintenance при переходе на вкладку
const _origShowTab = window.showTab;
document.addEventListener('click', e => {
  const btn = e.target.closest('.nav-btn');
  if (btn && btn.dataset.tab === 'maintenance') {
    loadMaintenance();
  }
});

// Хелпер esc для XSS-защиты (если ещё не определён)
if (typeof esc === 'undefined') {
  window.esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ══════════════════════════════════════════════════════════
   ДЕТАЛЬНАЯ СТРАНИЦА УСТРОЙСТВА
══════════════════════════════════════════════════════════ */

let _ddDeviceId  = null;
let _ddData      = null;
let _ddRange     = '24h';
let _ddChartCtx  = null;

// Открыть детальную страницу
async function openDeviceDetail(deviceId) {
  _ddDeviceId = deviceId;
  _ddRange    = '24h';
  document.getElementById('device-detail-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  await loadDeviceDetail();
}

// Закрыть
function closeDeviceDetail() {
  document.getElementById('device-detail-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  _ddDeviceId = null;
  _ddData     = null;
}

// Загрузить данные
async function loadDeviceDetail() {
  if (!_ddDeviceId) return;
  try {
    _ddData = await api(`/api/device/${_ddDeviceId}/detail`).then(r => r.json());
    renderDeviceDetail(_ddData);
  } catch (e) {
    console.error('loadDeviceDetail:', e);
    toast('Ошибка загрузки данных устройства', 'error');
  }
  loadAgentPanel(); // независимо — не блокируем остальную страницу если агент недоступен
}

/* ══════════════════════════════════════════════════════════
   АГЕНТ (CPU/RAM/disk с самой машины)
══════════════════════════════════════════════════════════ */

let _agentRange = '1h';
let _agentData  = null;

async function loadAgentPanel() {
  if (!_ddDeviceId) return;
  const linked = _ddData?.device?.agentEnabled;

  document.getElementById('dd-agent-not-linked').classList.toggle('hidden', !!linked);
  document.getElementById('dd-agent-linked').classList.toggle('hidden', !linked);

  if (linked) {
    const tokenEl = document.getElementById('dd-agent-token-display');
    if (tokenEl && !tokenEl.dataset.copy) {
      // Токен не показываем повторно из соображений безопасности —
      // только маску. Полный токен виден один раз, при генерации.
      tokenEl.childNodes[0].textContent = '•••• (скрыт, см. при генерации)';
    }
  }

  try {
    _agentData = await api(`/api/devices/${_ddDeviceId}/agent/metrics?range=${_agentRange}`).then(r => r.json());
  } catch (e) {
    console.error('loadAgentPanel:', e);
    return;
  }

  const card = document.getElementById('dd-agent-metrics-card');
  if (!_agentData.latest) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  const L = _agentData.latest;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  const pctColor = v => v == null ? 'var(--text-dim)' : v >= 90 ? 'var(--red)' : v >= 75 ? 'var(--yellow)' : 'var(--green)';
  const setPct = (id, val) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val != null ? val + '%' : '—';
    el.style.color = pctColor(val);
  };

  setPct('dd-agent-cpu', L.cpuPct);
  setPct('dd-agent-ram', L.ramPct);
  setPct('dd-agent-disk', L.diskPct);

  set('dd-agent-hostname', L.hostname || '—');
  set('dd-agent-os', L.os || '—');
  set('dd-agent-uptime', L.uptimeSec != null ? fmtDuration(L.uptimeSec) : '—');
  set('dd-agent-last-report', 'обновлено ' + fmtRelativeTime(L.ts));

  renderAgentChart(_agentData.history);
}

async function showAgentToken() {
  if (!_ddDeviceId) return;
  const btn = document.getElementById('dd-agent-get-token-btn');
  const restore = btnLoading(btn);
  try {
    const { token } = await api(`/api/devices/${_ddDeviceId}/agent/token`).then(r => r.json());
    showTokenDialog(token, 'Токен агента сгенерирован');
    document.getElementById('dd-agent-not-linked').classList.add('hidden');
    document.getElementById('dd-agent-linked').classList.remove('hidden');
    const tokenEl = document.getElementById('dd-agent-token-display');
    tokenEl.dataset.copy = token;
    tokenEl.childNodes[0].textContent = token.slice(0, 8) + '••••••••';
  } catch (e) {
    toast('Ошибка получения токена', 'error');
  } finally {
    restore();
  }
}

async function resetAgentToken() {
  if (!_ddDeviceId) return;
  const ok = await showConfirm('Перевыпустить токен?', 'Старый токен сразу перестанет работать — обновите его в конфигурации агента на машине.', { okLabel: 'Перевыпустить', okClass: 'btn-primary' });
  if (!ok) return;
  try {
    const { token } = await api(`/api/devices/${_ddDeviceId}/agent/reset`, { method: 'POST' }).then(r => r.json());
    showTokenDialog(token, 'Новый токен сгенерирован');
    const tokenEl = document.getElementById('dd-agent-token-display');
    tokenEl.dataset.copy = token;
    tokenEl.childNodes[0].textContent = token.slice(0, 8) + '••••••••';
    toast('Токен перевыпущен', 'success');
  } catch (e) {
    toast('Ошибка перевыпуска токена', 'error');
  }
}

async function unlinkAgent() {
  if (!_ddDeviceId) return;
  const ok = await showConfirm('Отвязать агента?', 'Токен будет удалён, агент на машине перестанет иметь доступ. Метрики истории сохранятся.');
  if (!ok) return;
  try {
    await api(`/api/devices/${_ddDeviceId}/agent`, { method: 'DELETE' });
    document.getElementById('dd-agent-not-linked').classList.remove('hidden');
    document.getElementById('dd-agent-linked').classList.add('hidden');
    document.getElementById('dd-agent-token-display').dataset.copy = '';
    toast('Агент отвязан', 'success');
  } catch (e) {
    toast('Ошибка отвязки агента', 'error');
  }
}

// Простой модальный показ токена с копированием (токен виден только один раз при генерации)
function showTokenDialog(token, title) {
  let modal = document.getElementById('agent-token-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'agent-token-modal';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
  }
  modal.innerHTML = `
    <div class="modal" style="width:480px">
      <h2>${esc(title)}</h2>
      <p class="hint" style="margin:0 0 12px;">Скопируйте токен сейчас — повторно он не показывается. Используйте его в команде запуска агента (<code>--token</code>).</p>
      <div class="copyable" data-copy="${esc(token)}" style="background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:10px 12px; font-family:monospace; font-size:12px; word-break:break-all; cursor:pointer;">
        ${esc(token)} <i class="ti ti-copy copy-icon"></i>
      </div>
      <div class="modal-actions">
        <button class="btn-primary" onclick="document.getElementById('agent-token-modal').classList.add('hidden')">Готово</button>
      </div>
    </div>`;
  modal.classList.remove('hidden');
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-agent-range]');
  if (!btn) return;
  document.querySelectorAll('[data-agent-range]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _agentRange = btn.dataset.agentRange;
  loadAgentPanel();
});

function renderAgentChart(history) {
  const canvas = document.getElementById('dd-agent-chart');
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.clientWidth - 32;
  const H = 90;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  if (!history.length) {
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#a09e99';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Нет данных за выбранный период', W / 2, H / 2);
    return;
  }

  const padTop = 6, padBottom = 6;
  const plotH = H - padTop - padBottom;
  const stepX = W / Math.max(1, history.length - 1);

  const drawLine = (key, color) => {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    let started = false;
    history.forEach((p, i) => {
      if (p[key] == null) return;
      const x = i * stepX;
      const y = padTop + plotH - (p[key] / 100) * plotH;
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    });
    ctx.stroke();
  };

  const accentColor = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#60a5fa';
  const greenColor  = getComputedStyle(document.body).getPropertyValue('--green').trim()  || '#4ade80';
  const yellowColor = getComputedStyle(document.body).getPropertyValue('--yellow').trim() || '#fbbf24';
  drawLine('cpu', accentColor);
  drawLine('ram', greenColor);
  drawLine('disk', yellowColor);
}

// Рендер
function renderDeviceDetail(data) {
  const { device, uptime, stats24h, history, incidents, topology, audit } = data;
  const s = STATUS[device.id] || {};

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '—'; };
  const setHTML = (id, val) => { const el = document.getElementById(id); if (el) el.innerHTML = val; };

  // Шапка
  set('dd-name', device.name);
  document.getElementById('dd-subtitle').textContent =
    [device.ip, device.location, device.categoryName].filter(Boolean).join(' · ');

  // Статус-бейдж
  const badge = document.getElementById('dd-status-badge');
  if (badge) {
    if (!device.monitored) {
      badge.className = 'status-badge status-unknown'; badge.textContent = 'Не отслеживается';
    } else if (s.online === true) {
      badge.className = 'status-badge status-online'; badge.textContent = 'Online';
    } else if (s.online === false) {
      badge.className = 'status-badge status-offline'; badge.textContent = 'Offline';
    } else {
      badge.className = 'status-badge status-unknown'; badge.textContent = 'Нет данных';
    }
  }

  // Кнопки
  document.getElementById('dd-edit-btn').onclick = () => {
    closeDeviceDetail();
    openEdit(device.id);
  };
  document.getElementById('dd-check-btn').onclick = async () => {
    const btn = document.getElementById('dd-check-btn');
    const restore = btnLoading(btn);
    try {
      await api(`/api/status/${device.id}/check`, { method: 'POST' });
      await loadDeviceDetail();
    } finally { restore(); }
  };

  // Инфо-строки
  const ipEl = document.getElementById('dd-ip');
  if (ipEl) { ipEl.childNodes[0].textContent = device.ip || '—'; ipEl.dataset.copy = device.ip || ''; }
  const macEl = document.getElementById('dd-mac');
  if (macEl) { macEl.childNodes[0].textContent = device.mac || '—'; macEl.dataset.copy = device.mac || ''; }
  set('dd-location', device.location || '—');
  set('dd-type',     device.type     || '—');

  const catEl = document.getElementById('dd-category');
  if (catEl) {
    catEl.innerHTML = device.categoryName
      ? `<span class="cat-badge" style="background:${device.categoryColor}22;color:${device.categoryColor}">${esc(device.categoryName)}</span>`
      : '—';
  }
  set('dd-source',  device.source   || '—');
  set('dd-created', device.createdAt ? new Date(device.createdAt).toLocaleDateString('ru-RU') : '—');

  const commentRow = document.getElementById('dd-comment-row');
  if (device.comment) {
    commentRow.style.display = '';
    set('dd-comment', device.comment);
  } else {
    commentRow.style.display = 'none';
  }

  // Мониторинг
  set('dd-interval',   device.monitored ? `${device.checkInterval} сек` : 'Выключен');
  set('dd-last-check', s.lastChecked ? fmtRelativeTime(s.lastChecked) : '—');
  set('dd-alerts',     device.alertsEnabled ? 'Включены' : 'Выключены');

  // Аптайм
  const fmtUp = v => v === null ? '—' : v + '%';
  const cls = v => v === null ? 'dd-uptime-na' : v >= 99 ? 'dd-uptime-good' : v >= 95 ? 'dd-uptime-warn' : 'dd-uptime-bad';

  ['1h','24h','7d','30d'].forEach(k => {
    const el = document.getElementById(`dd-up-${k}`);
    const key = k === '1h' ? 'h1' : k === '24h' ? 'h24' : k === '7d' ? 'd7' : 'd30';
    if (el) { el.textContent = fmtUp(uptime[key]); el.className = 'dd-uptime-val ' + cls(uptime[key]); }
  });

  set('dd-checks', stats24h.totalChecks || '0');
  set('dd-ok',     stats24h.successChecks || '0');
  set('dd-fail',   stats24h.failChecks || '0');

  // График
  renderDDChart(history, _ddRange);

  // Инциденты
  const incCard = document.getElementById('dd-incidents-card');
  const incList = document.getElementById('dd-incidents-list');
  if (incidents.length) {
    incCard.style.display = '';
    incList.innerHTML = incidents.map(i => `
      <div class="dd-incident-row">
        <span class="${i.open ? 'dd-incident-open' : 'dd-incident-closed'}">
          ${i.open ? '🔴 Открыт' : '✓ Закрыт'}${i.escalated ? ' ⚡' : ''}
        </span>
        <span>${new Date(i.start).toLocaleDateString('ru-RU', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
        <span class="dd-incident-dur">${fmtDuration(i.durationSec)}</span>
      </div>`).join('');
  } else {
    incCard.style.display = '';
    incList.innerHTML = '<div style="padding:12px 16px;font-size:12px;color:var(--text-dim)">Инцидентов нет</div>';
  }

  // Топология
  const topoList = document.getElementById('dd-topo-list');
  if (topology.edges.length) {
    topoList.innerHTML = topology.edges.map(e => {
      const isFrom = e.from.id === device.id;
      const peer   = isFrom ? e.to : e.from;
      const dir    = isFrom ? '→' : '←';
      return `<div class="dd-topo-row" onclick="closeDeviceDetail();openDeviceDetail('${peer.id}')">
        <span class="dd-topo-dir">${dir}</span>
        <span class="dd-topo-name">${esc(peer.name)}</span>
        <span class="dd-topo-ip">${esc(peer.ip || '')}</span>
        <span class="dd-topo-iface">${esc(e.iface || e.label || '')}</span>
      </div>`;
    }).join('');
  } else {
    topoList.innerHTML = '<div style="padding:12px 16px;font-size:12px;color:var(--text-dim)">Нет связей на карте</div>';
  }

  // Аудит
  const auditCard = document.getElementById('dd-audit-card');
  const auditList = document.getElementById('dd-audit-list');
  if (audit.length) {
    auditCard.style.display = '';
    auditList.innerHTML = audit.map(a => `
      <div class="dd-audit-row">
        <span class="dd-audit-time">${new Date(a.t).toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'})}</span>
        <span class="dd-audit-action">${esc(a.action)}</span>
        <span class="dd-audit-user">${esc(a.user)}</span>
      </div>`).join('');
  } else {
    auditCard.style.display = 'none';
  }

  // Порты
  const portsCard = document.getElementById('dd-ports-card');
  const portsList = document.getElementById('dd-ports-list');
  const portChecks = device.portChecks || [];
  const portStatus = (STATUS[device.id] || {}).ports || null;
  if (portChecks.length) {
    portsCard.style.display = '';
    portsList.innerHTML = portChecks.map(pc => {
      const ps = portStatus ? portStatus.find(p => String(p.port) === String(pc.port)) : null;
      const open = ps ? ps.open : null;
      return `<div class="dd-port-row">
        <span class="dd-port-num">${pc.port}</span>
        <span class="dd-port-label">${esc(pc.label || '')}</span>
        <span class="${open === true ? 'dd-port-open' : open === false ? 'dd-port-closed' : ''}">
          ${open === true ? 'Открыт' : open === false ? 'Закрыт' : '—'}
        </span>
      </div>`;
    }).join('');
  } else {
    portsCard.style.display = 'none';
  }
}

// ── График доступности на Canvas ──────────────────────────────────────
function renderDDChart(history, range) {
  const canvas = document.getElementById('dd-chart');
  if (!canvas) return;

  // Фильтруем по диапазону
  const now    = Date.now();
  const cutoff = range === '24h' ? now - 86400 * 1000 : now - 7 * 86400 * 1000;
  const pts    = history.filter(p => p.t >= cutoff);

  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.parentElement.clientWidth - 32;
  const H   = 80;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  if (!pts.length) {
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#64748b';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Нет данных за выбранный период', W / 2, H / 2);
    return;
  }

  const green  = getComputedStyle(document.body).getPropertyValue('--green').trim() || '#22c55e';
  const red    = getComputedStyle(document.body).getPropertyValue('--red').trim()   || '#ef4444';
  const barW   = Math.max(2, Math.floor(W / pts.length) - 1);
  const barGap = Math.max(1, Math.floor(W / pts.length));

  pts.forEach((p, i) => {
    const x = i * barGap;
    ctx.fillStyle = p.online ? green : red;
    ctx.fillRect(x, p.online ? H * 0.2 : H * 0.5, barW, p.online ? H * 0.6 : H * 0.35);
  });
}

// ── Переключение диапазона графика ────────────────────────────────────
document.addEventListener('click', e => {
  const btn = e.target.closest('.dd-range-btn');
  if (!btn || !_ddData) return;
  document.querySelectorAll('.dd-range-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _ddRange = btn.dataset.range;
  renderDDChart(_ddData.history, _ddRange);
});

// ── ESC закрывает детальную страницу ─────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && _ddDeviceId) closeDeviceDetail();
});

// ── Вспомогательные форматтеры ────────────────────────────────────────
function fmtDuration(sec) {
  if (!sec) return '0 сек';
  if (sec < 60)   return sec + ' сек';
  if (sec < 3600) return Math.floor(sec / 60) + ' мин';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h + 'ч ' + (m ? m + 'м' : '');
}

function fmtRelativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000)   return 'только что';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' мин назад';
  if (diff < 86400000)return Math.floor(diff / 3600000) + ' ч назад';
  return new Date(ts).toLocaleDateString('ru-RU');
}

// ── Кнопки "Подробнее" в карточках устройств ─────────────────────────
// Добавляем кнопку в renderDeviceCards и renderDevicesTable
const _origRenderDeviceCards = window.renderDeviceCards;

/* ══════════════════════════════════════════════════════════
   ГОРЯЧИЕ КЛАВИШИ
══════════════════════════════════════════════════════════ */

document.addEventListener('keydown', e => {
  // Не срабатывают в полях ввода и модалках
  const tag = document.activeElement?.tagName;
  if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
  if (!document.querySelector('.modal-overlay:not(.hidden)') === false) return;
  if (_ddDeviceId) return; // детальная страница открыта — ESC обрабатывается там

  switch (e.key) {
    case 'n': case 'N':
      // N — новое устройство
      if (CURRENT_ROLE !== 'viewer') { e.preventDefault(); showTab('devices'); openAdd(); }
      break;

    case '/':
      // / — фокус на поиск
      e.preventDefault();
      const searchInput = document.querySelector('.tab.active input[type="text"][id$="-search"], .tab.active input[placeholder*="поиск" i], .tab.active input[placeholder*="Поиск" i], #device-search');
      if (searchInput) { searchInput.focus(); searchInput.select(); }
      break;

    case 'm': case 'M':
      // M — перейти на карту
      e.preventDefault();
      showTab('map');
      break;

    case 'd': case 'D':
      // D — перейти на дашборд
      e.preventDefault();
      showTab('dashboard');
      break;

    case 's': case 'S':
      // S — перейти в настройки (только admin/operator)
      if (CURRENT_ROLE !== 'viewer') { e.preventDefault(); showTab('settings'); }
      break;

    case '?':
      // ? — показать справку по клавишам
      e.preventDefault();
      showHotkeysHelp();
      break;

    case 'Escape':
      // ESC — закрыть любую открытую модалку
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
      break;
  }
});

// ── Справка по горячим клавишам ───────────────────────────────────────
function showHotkeysHelp() {
  // Создаём модалку если нет
  let modal = document.getElementById('hotkeys-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'hotkeys-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal" style="width:420px">
        <h2>Горячие клавиши</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tbody>
            ${[
              ['N', 'Новое устройство'],
              ['/', 'Фокус на поиск'],
              ['D', 'Дашборд'],
              ['M', 'Карта сети'],
              ['S', 'Настройки'],
              ['?', 'Эта справка'],
              ['Esc', 'Закрыть / Назад'],
            ].map(([k, v]) => `<tr>
              <td style="padding:8px 12px;border-bottom:1px solid var(--border)">
                <kbd style="background:var(--panel-2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-family:monospace;font-size:12px;">${k}</kbd>
              </td>
              <td style="padding:8px 12px;border-bottom:1px solid var(--border);color:var(--text-dim)">${v}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div class="modal-actions" style="margin-top:16px">
          <button class="btn-primary" onclick="document.getElementById('hotkeys-modal').classList.add('hidden')">Закрыть</button>
        </div>
      </div>`;
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
    document.body.appendChild(modal);
  }
  modal.classList.remove('hidden');
}

// ── Подсказка ? в правом нижнем углу ─────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const hint = document.createElement('button');
  hint.title   = 'Горячие клавиши (?)';
  hint.onclick = showHotkeysHelp;
  hint.style.cssText = `
    position:fixed; bottom:20px; right:20px; z-index:70;
    width:32px; height:32px; border-radius:50%;
    background:var(--panel); border:1px solid var(--border);
    color:var(--text-dim); font-size:15px; cursor:pointer;
    display:flex; align-items:center; justify-content:center;
    transition:all .15s; box-shadow:0 2px 8px rgba(0,0,0,.2);
  `;
  hint.innerHTML = '?';
  hint.addEventListener('mouseenter', () => { hint.style.borderColor = 'var(--accent)'; hint.style.color = 'var(--accent)'; });
  hint.addEventListener('mouseleave', () => { hint.style.borderColor = 'var(--border)'; hint.style.color = 'var(--text-dim)'; });
  document.body.appendChild(hint);
});


/* ══════════════════════════════════════════════════════════
   ТРАФИК (SNMP-устройства + MikroTik-интерфейсы)
══════════════════════════════════════════════════════════ */

let TRAFFIC_DATA = { devices: [], routers: [] };
let trafficPollTimer = null;
let _lastTrafficReload = 0;

function fmtBps(bps) {
  if (bps == null) return '—';
  if (bps >= 1e9) return (bps / 1e9).toFixed(2) + ' Гбит/с';
  if (bps >= 1e6) return (bps / 1e6).toFixed(2) + ' Мбит/с';
  if (bps >= 1e3) return (bps / 1e3).toFixed(1) + ' Кбит/с';
  return bps + ' бит/с';
}

async function loadTraffic() {
  try {
    TRAFFIC_DATA = await api('/api/traffic/current').then(r => r.json());
  } catch (e) {
    console.error('loadTraffic:', e);
    return;
  }
  renderTraffic();
}

function renderTraffic() {
  const { devices = [], routers = [] } = TRAFFIC_DATA;
  const empty = document.getElementById('traffic-empty');
  const content = document.getElementById('traffic-content');
  if (!empty || !content) return;

  const hasData = devices.length > 0 || routers.length > 0;
  empty.classList.toggle('hidden', hasData);
  content.classList.toggle('hidden', !hasData);
  if (!hasData) return;

  const devTbody = document.getElementById('traffic-devices-tbody');
  devTbody.innerHTML = devices.length ? devices.map(d => `
    <tr>
      <td>${esc(d.name)}</td>
      <td class="hint">${esc(d.ip || '—')}</td>
      <td style="color:var(--accent)">${fmtBps(d.rxBps)}</td>
      <td style="color:var(--yellow)">${fmtBps(d.txBps)}</td>
      <td class="hint">${fmtRelativeTime(d.ts)}</td>
      <td><button class="small-btn" onclick="openTrafficChart('device','${esc(d.id)}','', '${esc(d.name)}')">📈 График</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="hint">Нет устройств с настроенным SNMP-трафиком</td></tr>';

  const rtrTbody = document.getElementById('traffic-routers-tbody');
  rtrTbody.innerHTML = routers.length ? routers.map(r => `
    <tr>
      <td>${esc(r.routerName)}</td>
      <td class="hint">${esc(r.iface)}</td>
      <td style="color:var(--accent)">${fmtBps(r.rxBps)}</td>
      <td style="color:var(--yellow)">${fmtBps(r.txBps)}</td>
      <td class="hint">${fmtRelativeTime(r.ts)}</td>
      <td><button class="small-btn" onclick="openTrafficChart('router','${esc(r.routerId)}','${esc(r.iface)}', '${esc(r.routerName)} / ${esc(r.iface)}')">📈 График</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="hint">Нет роутеров с настроенными интерфейсами трафика</td></tr>';
}

// ── График трафика (Canvas, аналогично детальной странице устройства) ─
let _trafficChartSource = null; // { type, id, iface }
let _trafficChartRange  = '1h';

async function openTrafficChart(sourceType, sourceId, iface, title) {
  _trafficChartSource = { type: sourceType, id: sourceId, iface };
  _trafficChartRange = '1h';
  document.getElementById('traffic-chart-title').textContent = 'График трафика — ' + title;
  document.querySelectorAll('[data-traffic-range]').forEach(b => b.classList.toggle('active', b.dataset.trafficRange === '1h'));
  document.getElementById('traffic-chart-modal').classList.remove('hidden');
  await loadTrafficChart();
}

async function loadTrafficChart() {
  if (!_trafficChartSource) return;
  const { type, id, iface } = _trafficChartSource;
  const url = type === 'device'
    ? `/api/traffic/device/${id}?range=${_trafficChartRange}`
    : `/api/traffic/router/${id}/${encodeURIComponent(iface)}?range=${_trafficChartRange}`;
  try {
    const points = await api(url).then(r => r.json());
    renderTrafficChart(points);
  } catch (e) {
    console.error('loadTrafficChart:', e);
  }
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-traffic-range]');
  if (!btn) return;
  document.querySelectorAll('[data-traffic-range]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _trafficChartRange = btn.dataset.trafficRange;
  loadTrafficChart();
});

function renderTrafficChart(points) {
  const canvas = document.getElementById('traffic-chart-canvas');
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.clientWidth - 32;
  const H = 140;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  if (!points.length) {
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#a09e99';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Нет данных за выбранный период', W / 2, H / 2);
    return;
  }

  const maxVal = Math.max(1, ...points.map(p => Math.max(p.rx, p.tx)));
  const padTop = 10, padBottom = 20;
  const plotH = H - padTop - padBottom;
  const stepX = W / Math.max(1, points.length - 1);

  const drawLine = (key, color) => {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    points.forEach((p, i) => {
      const x = i * stepX;
      const y = padTop + plotH - (p[key] / maxVal) * plotH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  const accentColor = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#60a5fa';
  const yellowColor = getComputedStyle(document.body).getPropertyValue('--yellow').trim() || '#fbbf24';
  drawLine('rx', accentColor);
  drawLine('tx', yellowColor);

  // Подпись максимума
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#a09e99';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(fmtBps(maxVal), 4, padTop);
}

// Автообновление вкладки раз в 30 сек, пока она открыта
function startTrafficPolling() {
  if (trafficPollTimer) clearInterval(trafficPollTimer);
  trafficPollTimer = setInterval(() => {
    if (document.getElementById('tab-traffic')?.classList.contains('active')) loadTraffic();
    else { clearInterval(trafficPollTimer); trafficPollTimer = null; }
  }, 30000);
}

// Перехватываем переход на вкладку "Трафик"
document.addEventListener('click', e => {
  const btn = e.target.closest('.nav-btn');
  if (btn && btn.dataset.tab === 'traffic') {
    loadTraffic();
    startTrafficPolling();
  }
});
