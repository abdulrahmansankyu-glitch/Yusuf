/**
 * The browser app. Plain ES modules, no build step: the file in the repository
 * is the file that runs.
 *
 * It carries no copy of the register definitions — the columns, their labels,
 * their types and their options all come from `/api/config`, so the workbook's
 * shape has exactly one source of truth.
 */

const root = document.getElementById('root');

const state = {
  token: localStorage.getItem('token') || '',
  user: null,
  can: {},
  registers: [],
  route: { name: 'dashboard' },
  summary: null,
  activity: [],
  records: [],
  coverage: null,
  filters: {},
  sort: { key: 'dueDate', dir: 1 },
  drawer: null,
  importing: null,
  users: [],
  error: '',
  notice: '',
  busy: false,
};

/* ------------------------------------------------------------------ *
 * Tiny DOM helper
 * ------------------------------------------------------------------ */

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'html') element.innerHTML = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') element.value = value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

const text = (value, fallback = '—') => (value === null || value === undefined || value === '' ? fallback : String(value));

/** Dates are shown as the team writes them: day/month/year. */
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : text(iso);
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const STATE_LABEL = {
  overdue: 'Overdue',
  'due-soon': 'Due soon',
  scheduled: 'Scheduled',
  closed: 'Closed',
  undated: 'No date',
};

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });

  if (response.status === 401) {
    signOut();
    throw new Error('Your session has ended — sign in again.');
  }
  if (response.status === 204) return null;

  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await response.json() : await response.blob();
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
  return payload;
}

function download(path, filename) {
  api(path)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const link = h('a', { href: url, download: filename });
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    })
    .catch(fail);
}

function fail(error) {
  state.error = error.message;
  state.busy = false;
  render();
}

function flash(message) {
  state.notice = message;
  render();
  setTimeout(() => {
    if (state.notice === message) {
      state.notice = '';
      render();
    }
  }, 4000);
}

function signOut() {
  state.token = '';
  state.user = null;
  localStorage.removeItem('token');
  render();
}

const registerById = (id) => state.registers.find((r) => r.id === id) ?? null;

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

async function boot() {
  if (!state.token) return render();
  try {
    const me = await api('/me');
    state.user = me.user;
    state.can = me.can;
    const config = await api('/config');
    state.registers = config.registers;
    await loadRoute();
  } catch (error) {
    state.error = error.message;
  }
  render();
}

async function loadRoute() {
  state.busy = true;
  render();
  try {
    if (state.route.name === 'dashboard') {
      state.summary = await api('/summary');
      state.activity = (await api('/activity?limit=12')).activity;
    } else if (state.route.name === 'register') {
      // The summary comes too: the sidebar prints each register's total and its
      // overdue count, and closing a job here left that flag reading one too
      // many until somebody happened to open the dashboard.
      const [payload, summary] = await Promise.all([
        api(`/registers/${state.route.id}/records`),
        api('/summary'),
      ]);
      state.records = payload.records;
      state.coverage = payload.coverage;
      state.summary = summary;
    } else if (state.route.name === 'settings') {
      state.users = (await api('/users')).users;
    }
    state.error = '';
  } catch (error) {
    state.error = error.message;
  }
  state.busy = false;
  render();
}

function go(route) {
  state.route = route;
  state.filters = {};
  state.sort = route.name === 'register' ? { key: 'dueDate', dir: 1 } : state.sort;
  state.drawer = null;
  loadRoute();
}

/* ------------------------------------------------------------------ *
 * Sign in and first-run setup
 * ------------------------------------------------------------------ */

function gate() {
  const form = h('form', { class: 'card', onsubmit: submit });
  let mode = 'signin';

  const fields = h('div', { class: 'card-body' });
  const title = h('div');
  form.append(h('div', { class: 'card-head' }, title), fields);

  function paint() {
    title.replaceChildren(
      h('div', {}, h('h1', {}, 'Engineering Planning Tracker'), h('p', {}, mode === 'signin' ? 'Sign in to continue.' : 'Create the administrator account.')),
    );
    fields.replaceChildren(
      state.error ? h('div', { class: 'error' }, state.error) : null,
      mode === 'setup' ? labelled('Your name', h('input', { name: 'name', autocomplete: 'name' })) : null,
      labelled('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'username' })),
      labelled('Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
      mode === 'setup' ? labelled('Access code', h('input', { name: 'accessCode', type: 'password' })) : null,
      h('button', { class: 'primary', type: 'submit' }, mode === 'signin' ? 'Sign in' : 'Create administrator'),
    );
  }

  async function submit(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const result = await api(mode === 'signin' ? '/session' : '/setup', { method: 'POST', body: data });
      state.token = result.token;
      localStorage.setItem('token', result.token);
      state.error = '';
      boot();
    } catch (error) {
      state.error = error.message;
      paint();
    }
  }

  api('/setup')
    .then((info) => {
      mode = info.needsSetup ? 'setup' : 'signin';
      paint();
    })
    .catch(() => paint());

  paint();
  return h('div', { class: 'gate' }, form);
}

function labelled(label, control, note) {
  return h('div', {}, h('label', {}, label), control, note ? h('div', { class: 'field-note' }, note) : null);
}

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

function sidebar() {
  const counts = new Map((state.summary?.registers ?? []).map((r) => [r.id, r]));
  const groups = [];
  for (const register of state.registers) {
    const group = groups.find((g) => g.name === register.group);
    if (group) group.items.push(register);
    else groups.push({ name: register.group, items: [register] });
  }

  return h(
    'nav',
    { class: 'sidebar' },
    h('div', { class: 'brand' }, h('strong', {}, 'Planning Tracker'), h('span', {}, 'Engineering department')),
    h(
      'button',
      {
        class: 'nav-item',
        'aria-current': String(state.route.name === 'dashboard'),
        onclick: () => go({ name: 'dashboard' }),
      },
      'Dashboard',
    ),
    groups.map((group) => [
      h('div', { class: 'nav-group' }, group.name),
      group.items.map((register) => {
        const entry = counts.get(register.id);
        return h(
          'button',
          {
            class: 'nav-item',
            'aria-current': String(state.route.name === 'register' && state.route.id === register.id),
            onclick: () => go({ name: 'register', id: register.id }),
          },
          h('span', {}, register.name),
          h('span', { class: 'count' }, entry ? String(entry.total) : '0'),
          entry?.overdue ? h('span', { class: 'flag', title: `${entry.overdue} overdue` }, entry.overdue) : null,
        );
      }),
    ]),
  );
}

function topbar() {
  return h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'spacer' }),
    state.can.import ? h('button', { onclick: () => go({ name: 'import' }) }, 'Import workbook') : null,
    h('button', { onclick: () => download('/export', `engineering-planning-${state.summary?.today ?? 'export'}.xlsx`) }, '↓ Export all'),
    state.can.admin ? h('button', { onclick: () => go({ name: 'settings' }) }, 'Settings') : null,
    h('span', { class: 'who' }, h('b', {}, state.user?.name ?? ''), ` · ${state.user?.role ?? ''}`),
    h('button', { class: 'ghost', onclick: signOut }, 'Sign out'),
  );
}

/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */

function dashboard() {
  const summary = state.summary;
  if (!summary) return h('div', { class: 'empty' }, 'Loading…');
  const t = summary.totals;

  const kpis = [
    { label: 'Total jobs', value: t.total, note: `${summary.registerCount} registers` },
    { label: 'Open', value: t.open },
    { label: 'Overdue', value: t.overdue, className: 'overdue' },
    { label: `Due in ${summary.dueSoonDays} days`, value: t.dueSoon, className: 'due-soon' },
    { label: 'Closed', value: t.closed, className: 'closed' },
    { label: 'No date set', value: t.undated, note: 'Not counted as late' },
  ];
  if (summary.people.sheets) {
    kpis.push({
      label: 'People sheets filled',
      value: summary.people.coverage === null ? '—' : `${summary.people.coverage}%`,
      note: `${summary.people.people} people · ${summary.people.cellsFilled}/${summary.people.cellsTotal} cells`,
    });
  }

  return h(
    'div',
    {},
    summary.restricted
      ? h('div', { class: 'notice' }, `This account covers ${summary.registerCount} of the registers, so these figures are for those only.`)
      : null,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Dashboard'), h('p', {}, `Position on ${fmtDate(summary.today)}`))),
    h('div', { class: 'kpis' }, kpis.map((k) =>
      h(
        'div',
        { class: `kpi ${k.className ?? ''}` },
        h('div', { class: 'label' }, k.label),
        h('div', { class: 'value' }, String(k.value)),
        h('div', { class: 'note' }, k.note ?? ''),
      ),
    )),
    h('div', { class: 'register-grid' }, summary.registers.map(registerCard)),
    h(
      'div',
      { class: 'card', style: 'margin-top:18px' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Needs attention'), h('div', { class: 'spacer' }), h('span', { class: 'who' }, `${summary.attention.length} items overdue or due within ${summary.dueSoonDays} days`)),
      summary.attention.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['Register', 'Reference', 'What', 'Owner', 'Due', 'Days', 'Priority'].map((c) => h('th', {}, c)))),
              h(
                'tbody',
                {},
                summary.attention.slice(0, 40).map((item) =>
                  h(
                    'tr',
                    { style: 'cursor:pointer', onclick: () => go({ name: 'register', id: item.registerId }) },
                    h('td', {}, item.registerShort),
                    h('td', {}, text(item.ref)),
                    h('td', {}, h('span', { class: 'cell-long' }, text(item.title))),
                    h('td', {}, text(item.actionBy)),
                    h('td', {}, fmtDate(item.dueDate)),
                    h('td', { class: 'num' }, h('span', { class: `tag state-${item.state}` }, item.daysToDue < 0 ? `${-item.daysToDue}d late` : `${item.daysToDue}d`)),
                    h('td', {}, h('span', { class: `tag p-${item.priority}` }, item.priority)),
                  ),
                ),
              ),
            ),
          )
        : h('div', { class: 'empty' }, 'Nothing is overdue or due within the month.'),
    ),
    h(
      'div',
      { class: 'card', style: 'margin-top:18px' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Recent changes')),
      h(
        'div',
        { class: 'card-body feed' },
        state.activity.length
          ? state.activity.map((entry) =>
              h('div', { class: 'item' }, h('span', { class: 'when' }, fmtWhen(entry.at)), h('span', {}, `${entry.actor ?? 'Someone'} — ${entry.summary ?? entry.action}`)),
            )
          : h('div', { class: 'empty' }, 'Nothing has changed yet.'),
      ),
    ),
  );
}

function registerCard(entry) {
  const people = entry.kind === 'people';
  const segments = people
    ? [{ key: 'filled', value: entry.cellsFilled }, { key: 'undated', value: Math.max(0, entry.cellsTotal - entry.cellsFilled) }]
    : [
        { key: 'overdue', value: entry.overdue },
        { key: 'due-soon', value: entry.dueSoon },
        { key: 'scheduled', value: entry.scheduled },
        { key: 'undated', value: entry.undated },
        { key: 'closed', value: entry.closed },
      ];
  const total = segments.reduce((n, s) => n + s.value, 0) || 1;

  const legend = people
    ? [
        ['People', entry.total, 'var(--brand)'],
        ['Filled', `${entry.coverage ?? 0}%`, 'var(--closed)'],
      ]
    : [
        ['Overdue', entry.overdue, 'var(--overdue)'],
        ['Due soon', entry.dueSoon, 'var(--due-soon)'],
        ['Open', entry.open, 'var(--scheduled)'],
        ['Closed', entry.closed, 'var(--closed)'],
      ];

  return h(
    'button',
    { class: 'register-card', onclick: () => go({ name: 'register', id: entry.id }) },
    h('div', { class: 'rc-top' }, h('strong', {}, entry.name), h('span', { class: 'total' }, String(entry.total))),
    h('div', { class: 'rc-desc' }, registerById(entry.id)?.description ?? ''),
    h('div', { class: 'bar' }, segments.map((s) => h('span', { class: `s-${s.key}`, style: `width:${(s.value / total) * 100}%` }))),
    h('div', { class: 'legend' }, legend.map(([label, value, colour]) => h('span', {}, h('i', { style: `background:${colour}` }), `${label} `, h('b', {}, String(value))))),
  );
}

/* ------------------------------------------------------------------ *
 * Register page
 * ------------------------------------------------------------------ */

function registerPage() {
  const register = registerById(state.route.id);
  if (!register) return h('div', { class: 'empty' }, 'That register is not available to this account.');

  const rows = filterAndSort(register, state.records);

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, register.name), h('p', {}, register.description)),
      h('div', { class: 'spacer' }),
      state.can.write ? h('button', { class: 'primary', onclick: () => openDrawer(register, null) }, '+ New entry') : null,
      h('button', { onclick: () => download(`/export?register=${register.id}`, `${register.id}.xlsx`) }, '↓ Export sheet'),
      h('button', { onclick: () => download(`/template/${register.id}`, `${register.id}-template.xlsx`) }, 'Blank template'),
    ),
    toolbar(register, rows.length),
    register.kind === 'people' ? matrixPanel(register) : null,
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'table-wrap' }, rows.length ? recordTable(register, rows) : h('div', { class: 'empty' }, state.records.length ? 'Nothing matches those filters.' : 'Nothing here yet — import the workbook or add an entry.')),
    ),
  );
}

function toolbar(register, shown) {
  const set = (key) => (event) => {
    state.filters[key] = event.target.value;
    render();
  };
  const owners = [...new Set(state.records.map((r) => r.derived.actionBy || r.derived.supplier || r.derived.initiator).filter(Boolean))].sort();

  return h(
    'div',
    { class: 'toolbar' },
    h('input', { class: 'grow', placeholder: 'Search…', value: state.filters.q ?? '', oninput: set('q') }),
    register.kind === 'jobs'
      ? h('select', { onchange: set('state'), value: state.filters.state ?? '' },
          h('option', { value: '' }, 'Any due state'),
          ['overdue', 'due-soon', 'scheduled', 'undated', 'closed'].map((s) => h('option', { value: s, selected: state.filters.state === s }, STATE_LABEL[s])),
        )
      : null,
    register.kind === 'jobs'
      ? h('select', { onchange: set('status'), value: state.filters.status ?? '' },
          h('option', { value: '' }, 'Any status'),
          ['Not Started', 'In Progress', 'On Hold', 'Completed', 'Cancelled'].map((s) => h('option', { value: s, selected: state.filters.status === s }, s)),
        )
      : null,
    register.kind === 'jobs'
      ? h('select', { onchange: set('priority'), value: state.filters.priority ?? '' },
          h('option', { value: '' }, 'Any priority'),
          ['Critical', 'High', 'Medium', 'Low', 'Planned'].map((p) => h('option', { value: p, selected: state.filters.priority === p }, p)),
        )
      : null,
    owners.length
      ? h('select', { onchange: set('owner'), value: state.filters.owner ?? '' },
          h('option', { value: '' }, 'Anyone'),
          owners.map((o) => h('option', { value: o, selected: state.filters.owner === o }, o)),
        )
      : null,
    h('span', { class: 'who' }, `${shown} of ${state.records.length}`),
  );
}

function filterAndSort(register, records) {
  const f = state.filters;
  const query = (f.q ?? '').trim().toLowerCase();

  const rows = records.filter((record) => {
    if (f.state && record.state !== f.state) return false;
    if (f.status && record.derived.status !== f.status) return false;
    if (f.priority && record.derived.priority !== f.priority) return false;
    if (f.owner) {
      const owner = record.derived.actionBy || record.derived.supplier || record.derived.initiator;
      if (owner !== f.owner) return false;
    }
    if (query) {
      const haystack = Object.values(record.data ?? {}).join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  const { key, dir } = state.sort;
  rows.sort((a, b) => dir * compare(value(a, key, register), value(b, key, register)));
  return rows;
}

function value(record, key, register) {
  if (key === 'dueDate') return record.derived.dueDate ?? record.derived.dueText ?? '';
  if (key === 'state') return record.state;
  if (key === 'filled') return record.derived.filledCells ?? 0;
  const field = register.fields.find((f) => f.key === key);
  const raw = record.data?.[key] ?? '';
  return field?.type === 'number' ? Number(raw) || 0 : String(raw).toLowerCase();
}

function compare(a, b) {
  // Blanks sort last whichever way the column is pointing: a screen of empty
  // rows above the data is never what somebody clicking a heading wanted.
  const aEmpty = a === '' || a === null || a === undefined;
  const bEmpty = b === '' || b === null || b === undefined;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortBy(key) {
  state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: 1 };
  render();
}

function recordTable(register, rows) {
  const columns = register.tableColumns.map((key) => register.fields.find((f) => f.key === key)).filter(Boolean);
  const showDue = register.kind === 'jobs' && Boolean(register.roles.due);

  const head = h(
    'tr',
    {},
    columns.map((field) =>
      h(
        'th',
        // A matrix heading is a course or a month name over a one-character
        // cell, so it wraps instead of forcing the column to its own width.
        {
          class: register.matrix?.cells.includes(field.key) ? 'rot' : '',
          title: field.short ? field.label : null,
          onclick: () => sortBy(field.key),
        },
        field.short ?? field.label,
        state.sort.key === field.key ? h('span', { class: 'arrow' }, state.sort.dir > 0 ? ' ▲' : ' ▼') : null,
      ),
    ),
    showDue ? h('th', { onclick: () => sortBy('state') }, 'Due in') : null,
    register.kind === 'people' ? h('th', { onclick: () => sortBy('filled') }, register.matrix.measure) : null,
    h('th', {}, ''),
  );

  const body = rows.map((record) =>
    h(
      'tr',
      {},
      columns.map((field) =>
        h(
          'td',
          { class: cellClass(register, record, field), title: register.matrix?.cells.includes(field.key) ? String(record.data?.[field.key] ?? '') : null },
          cell(register, record, field),
        ),
      ),
      showDue
        ? h(
            'td',
            {},
            h('span', { class: `tag state-${record.state}` }, record.state === 'overdue' ? `${-record.daysToDue}d late` : record.state === 'due-soon' ? `${record.daysToDue}d` : STATE_LABEL[record.state]),
          )
        : null,
      register.kind === 'people'
        ? h('td', { class: 'num' }, `${record.derived.filledCells}/${record.derived.totalCells}`)
        : null,
      h(
        'td',
        { class: 'row-actions' },
        h('button', { class: 'small', onclick: () => openDrawer(register, record) }, state.can.write ? 'Edit' : 'View'),
      ),
    ),
  );

  return h('table', { class: register.kind === 'people' ? 'matrix' : '' }, h('thead', {}, head), h('tbody', {}, body));
}

function cellClass(register, record, field) {
  if (register.matrix?.cells.includes(field.key)) {
    return String(record.data?.[field.key] ?? '').trim() ? 'cell on' : 'cell off';
  }
  return field.type === 'number' ? 'num' : '';
}

function cell(register, record, field) {
  const raw = record.data?.[field.key];
  if (field.type === 'date') {
    // A phrase in a date column is shown as written, with a note that it is not
    // a date the app can count from.
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(String(raw ?? ''));
    return iso ? fmtDate(raw) : h('span', {}, text(raw), raw ? h('span', { class: 'sub' }, 'no calendar date') : null);
  }
  if (field.key === register.roles.priority && raw) {
    return h('span', {}, h('span', { class: `tag p-${record.derived.priority}` }, record.derived.priority), String(raw) !== record.derived.priority ? h('span', { class: 'sub' }, String(raw)) : null);
  }
  if (field.key === register.roles.status && raw) {
    return h('span', {}, h('span', { class: `tag state-${record.state}` }, record.derived.status), String(raw) !== record.derived.status ? h('span', { class: 'sub' }, String(raw)) : null);
  }
  if (register.matrix?.cells.includes(field.key)) {
    const value = String(raw ?? '').trim();
    if (!value) return '·';
    // The cell is a few characters wide. A short entry (`V`, `2`, `yes`) is
    // shown as written; anything longer becomes a tick with the full value on
    // hover, which beats truncating a date to `202`.
    return value.length <= 4 ? value : '✓';
  }
  return h('span', { class: field.type === 'longtext' ? 'cell-long' : 'cell-short' }, text(raw));
}

/**
 * Per-column coverage for a people sheet.
 *
 * One "62% filled" figure hides the course only three people hold, which is the
 * only thing on that page anybody can act on.
 */
function matrixPanel(register) {
  const coverage = state.coverage;
  if (!coverage || !coverage.people) return null;
  return h(
    'div',
    { class: 'card', style: 'margin-bottom:14px' },
    h('div', { class: 'card-head' }, h('h2', {}, `${register.matrix.cellLabel} coverage`), h('div', { class: 'spacer' }), h('span', { class: 'who' }, `${coverage.people} people`)),
    h(
      'div',
      { class: 'card-body coverage' },
      (register.matrix.coverageOrder === 'declared' ? coverage.columns : [...coverage.columns].sort((a, b) => a.percent - b.percent))
        .map((column) =>
          h(
            'div',
            { class: 'coverage-row' },
            h('span', { class: 'name', title: column.label }, column.label),
            h('span', { class: 'bar' }, h('span', { class: 's-filled', style: `width:${column.percent}%` })),
            h('span', { class: 'count' }, `${column.held}/${coverage.people}`),
          ),
        ),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Entry drawer
 * ------------------------------------------------------------------ */

async function openDrawer(register, record) {
  const data = { ...(record?.data ?? {}) };
  if (!record && register.autoNumber) {
    try {
      // A preview, not a reservation: closing the drawer without saving
      // consumes nothing and leaves no gap in the sequence.
      const { number } = await api(`/registers/${register.id}/next-number`);
      if (number) data[register.autoNumber.field] = number;
    } catch {
      /* A missing suggestion is not worth blocking the form for. */
    }
  }
  state.drawer = { register, record, data, freeText: {} };
  render();
}

function drawer() {
  const { register, record, data, freeText } = state.drawer;
  const readOnly = !state.can.write;

  const extras = Object.keys(data).filter((key) => key.startsWith('extra:'));

  const form = h(
    'form',
    {
      class: 'drawer',
      onsubmit: (event) => {
        event.preventDefault();
        save();
      },
      /* Enter saves, as it does on the sign-in form — except in a text area,
         where it is a new line, and on a date input, where the browser's own
         picker uses it to accept a date. */
      onkeydown: (event) => {
        if (event.key !== 'Enter') return;
        const tag = event.target.tagName;
        if (tag === 'TEXTAREA' || event.target.type === 'date') return;
        if (tag === 'INPUT' || tag === 'SELECT') {
          event.preventDefault();
          save();
        }
      },
    },
    h(
      'header',
      {},
      h('h2', {}, record ? `Edit — ${register.name}` : `New ${register.name} entry`),
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'ghost', onclick: closeDrawer }, '✕'),
    ),
    h(
      'div',
      { class: 'fields' },
      register.fields.map((field) => fieldControl(register, field, data, freeText, readOnly)),
      extras.map((key) =>
        labelled(
          `${key.slice(6)} (from the sheet)`,
          h('input', { value: data[key] ?? '', disabled: readOnly, oninput: (e) => { data[key] = e.target.value; } }),
        ),
      ),
      record
        ? h('div', { class: 'field-note' }, `Last changed by ${record.updatedBy ?? 'unknown'} on ${fmtWhen(record.updatedAt)}.`)
        : null,
    ),
    h(
      'footer',
      {},
      record && state.can.write
        ? h('button', { type: 'button', class: 'danger', onclick: remove }, 'Delete')
        : null,
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', onclick: closeDrawer }, 'Cancel'),
      readOnly ? null : h('button', { class: 'primary', type: 'submit' }, 'Save'),
    ),
  );

  async function save() {
    try {
      if (record) await api(`/records/${record.id}`, { method: 'PUT', body: { data } });
      else await api(`/registers/${register.id}/records`, { method: 'POST', body: { data } });
      state.drawer = null;
      flash('Saved.');
      await loadRoute();
    } catch (error) {
      fail(error);
    }
  }

  async function remove() {
    if (!confirm('Delete this entry? This cannot be undone.')) return;
    try {
      await api(`/records/${record.id}`, { method: 'DELETE' });
      state.drawer = null;
      flash('Deleted.');
      await loadRoute();
    } catch (error) {
      fail(error);
    }
  }

  return h('div', { class: 'scrim', onclick: (e) => e.target === e.currentTarget && closeDrawer() }, form);
}

function closeDrawer() {
  state.drawer = null;
  render();
}

function fieldControl(register, field, data, freeText, readOnly) {
  const set = (event) => {
    data[field.key] = event.target.value;
  };
  const current = data[field.key] ?? '';

  if (field.computed) {
    return labelled(field.label, h('input', { value: current, disabled: true }), 'Worked out from the columns beside it.');
  }

  if (field.type === 'longtext') {
    return labelled(field.label, h('textarea', { disabled: readOnly, oninput: set }, current));
  }

  if (field.type === 'select') {
    return labelled(
      field.label,
      h(
        'select',
        { disabled: readOnly, onchange: set },
        h('option', { value: '' }, '—'),
        field.options.map((option) => h('option', { value: option, selected: current === option }, option)),
      ),
    );
  }

  if (field.type === 'suggest') {
    const listId = `list-${register.id}-${field.key}`;
    return labelled(
      field.label,
      h(
        'span',
        {},
        h('input', { value: current, list: listId, disabled: readOnly, oninput: set }),
        h('datalist', { id: listId }, field.options.map((option) => h('option', { value: option }))),
      ),
      'The sheet’s own list — anything else is accepted too.',
    );
  }

  if (field.type === 'date') {
    const isDate = /^\d{4}-\d{2}-\d{2}$/.test(String(current));
    // A row that already holds a phrase opens as a text box, so editing it
    // cannot silently discard what it says.
    const asText = freeText[field.key] ?? (current !== '' && !isDate);
    const toggle = h(
      'button',
      {
        type: 'button',
        class: 'small',
        disabled: readOnly,
        onclick: () => {
          freeText[field.key] = !asText;
          render();
        },
      },
      asText ? 'Use a date' : 'Enter text instead',
    );
    return labelled(
      field.label,
      h(
        'span',
        { class: 'date-row' },
        h('input', { type: asText ? 'text' : 'date', value: current, disabled: readOnly, oninput: set, placeholder: asText ? 'e.g. Next Shutdown' : '' }),
        toggle,
      ),
      asText ? 'Kept as written. The job will show as having no calendar date.' : null,
    );
  }

  return labelled(field.label, h('input', { type: field.type === 'number' ? 'number' : 'text', value: current, disabled: readOnly, oninput: set }));
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

function importPage() {
  const job = state.importing;

  const picker = h('input', {
    type: 'file',
    accept: '.xlsx,.xlsm,.xls',
    onchange: async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      const form = new FormData();
      form.append('file', file);
      state.busy = true;
      render();
      try {
        const result = await api('/import/inspect', { method: 'POST', form });
        state.importing = {
          file,
          sheets: result.sheets.map((sheet) => ({
            ...sheet,
            // A recognised sheet with no rows in it preselects nothing: showing a
            // register beside "0 rows" reads as a promise to import something.
            chosen: sheet.allowed && sheet.rowCount ? sheet.registerId : null,
            mode: 'replace',
            include: Boolean(sheet.registerId && sheet.allowed && sheet.rowCount),
          })),
        };
        state.error = '';
      } catch (error) {
        state.error = error.message;
      }
      state.busy = false;
      render();
    },
  });

  if (!job) {
    return h(
      'div',
      {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Import a workbook'), h('p', {}, 'Every sheet becomes its own choice: which register it belongs to, and whether it replaces that register or adds to it.'))),
      h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'dropzone' }, h('p', {}, 'Choose an .xlsx file'), picker))),
    );
  }

  const rows = job.sheets.map((sheet, i) =>
    h(
      'div',
      { class: 'sheet-row' },
      h(
        'div',
        {},
        h('strong', {}, sheet.name),
        h(
          'div',
          { class: 'meta' },
          sheet.registerId
            ? `${sheet.rowCount} rows · header on row ${sheet.headerRow}${sheet.headerSpan > 1 ? '–' + (sheet.headerRow + 1) : ''} · ${sheet.confidence} columns matched${sheet.skipped ? ` · ${sheet.skipped} legend rows ignored` : ''}`
            : sheet.reason ?? 'Not recognised',
        ),
        sheet.extraColumns?.length ? h('div', { class: 'meta' }, `Extra columns kept: ${sheet.extraColumns.join(', ')}`) : null,
      ),
      h(
        'select',
        {
          disabled: !sheet.allowed,
          onchange: (e) => {
            job.sheets[i].chosen = e.target.value || null;
            job.sheets[i].include = Boolean(e.target.value);
            render();
          },
        },
        h('option', { value: '' }, 'Do not import'),
        state.registers.map((register) => h('option', { value: register.id, selected: sheet.chosen === register.id }, register.name)),
      ),
      h(
        'select',
        {
          disabled: !sheet.chosen,
          onchange: (e) => {
            job.sheets[i].mode = e.target.value;
          },
        },
        h('option', { value: 'replace', selected: sheet.mode === 'replace' }, 'Replace register'),
        h('option', { value: 'append', selected: sheet.mode === 'append' }, 'Add to register'),
      ),
    ),
  );

  const chosen = job.sheets.filter((s) => s.include && s.chosen);

  return h(
    'div',
    {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, `Import — ${job.file.name}`), h('p', {}, 'Sheet names never decide a register on their own; the columns do.')), h('div', { class: 'spacer' }), h('button', { onclick: () => { state.importing = null; render(); } }, 'Choose another file')),
    h('div', { class: 'card' }, h('div', { class: 'card-body' }, rows)),
    h(
      'div',
      { style: 'margin-top:14px;display:flex;gap:10px;align-items:center' },
      h('button', { class: 'primary', disabled: !chosen.length, onclick: commit }, `Import ${chosen.length} sheet${chosen.length === 1 ? '' : 's'}`),
      h('span', { class: 'who' }, 'Replacing a register removes everything currently in it.'),
    ),
  );

  async function commit() {
    const form = new FormData();
    form.append('file', job.file);
    form.append('choices', JSON.stringify(chosen.map((s) => ({ sheet: s.name, registerId: s.chosen, mode: s.mode }))));
    state.busy = true;
    render();
    try {
      const { results } = await api('/import/commit', { method: 'POST', form });
      state.importing = null;
      const total = results.reduce((n, r) => n + r.imported, 0);
      flash(`Imported ${total} rows across ${results.length} sheets.`);
      go({ name: 'dashboard' });
    } catch (error) {
      fail(error);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

function settingsPage() {
  const form = h('form', { class: 'card-body', style: 'display:grid;gap:12px', onsubmit: add });

  return h(
    'div',
    {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Accounts'), h('p', {}, 'The role says what kind of thing somebody may do; the register list says where.'))),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'People')),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Registers', ''].map((c) => h('th', {}, c)))),
          h(
            'tbody',
            {},
            state.users.map((user) =>
              h(
                'tr',
                {},
                h('td', {}, user.name),
                h('td', {}, user.email),
                h(
                  'td',
                  {},
                  h(
                    'select',
                    { onchange: (e) => update(user, { role: e.target.value }) },
                    ['viewer', 'editor', 'admin'].map((role) => h('option', { value: role, selected: user.role === role }, role)),
                  ),
                ),
                h('td', {}, user.registers?.length ? `${user.registers.length} of ${state.registers.length}` : 'All'),
                h('td', { class: 'row-actions' }, h('button', { class: 'small danger', onclick: () => remove(user) }, 'Remove')),
              ),
            ),
          ),
        ),
      ),
    ),
    h('div', { class: 'card', style: 'margin-top:18px' }, h('div', { class: 'card-head' }, h('h2', {}, 'Add somebody')), form),
  );

  function fields() {
    form.replaceChildren(
      labelled('Name', h('input', { name: 'name', required: true })),
      labelled('Email', h('input', { name: 'email', type: 'email', required: true })),
      labelled('Password', h('input', { name: 'password', type: 'password', required: true, minlength: 8 }), 'At least 8 characters.'),
      labelled(
        'Role',
        h('select', { name: 'role' }, ['viewer', 'editor', 'admin'].map((role) => h('option', { value: role }, role))),
      ),
      h('button', { class: 'primary', type: 'submit' }, 'Add account'),
    );
  }
  fields();

  async function add(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      await api('/users', { method: 'POST', body });
      flash('Account added.');
      await loadRoute();
    } catch (error) {
      fail(error);
    }
  }

  async function update(user, changes) {
    try {
      await api(`/users/${user.id}`, { method: 'PUT', body: changes });
      await loadRoute();
    } catch (error) {
      fail(error);
    }
  }

  async function remove(user) {
    if (!confirm(`Remove ${user.name}?`)) return;
    try {
      await api(`/users/${user.id}`, { method: 'DELETE' });
      await loadRoute();
    } catch (error) {
      fail(error);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

function render() {
  root.className = '';

  if (!state.token || !state.user) {
    root.replaceChildren(gate());
    return;
  }

  const page =
    state.route.name === 'dashboard'
      ? dashboard()
      : state.route.name === 'register'
        ? registerPage()
        : state.route.name === 'import'
          ? importPage()
          : settingsPage();

  const shell = h(
    'div',
    { class: 'shell' },
    sidebar(),
    h(
      'div',
      { class: 'main' },
      topbar(),
      h(
        'div',
        { class: 'content' },
        state.error ? h('div', { class: 'error', style: 'margin-bottom:12px' }, state.error) : null,
        state.notice ? h('div', { class: 'notice', style: 'margin-bottom:12px' }, state.notice) : null,
        page,
      ),
    ),
  );

  // `replaceChildren(null)` appends the *string* "null", which spent a while
  // sitting in the corner of every page.
  root.replaceChildren(...[shell, state.drawer ? drawer() : null].filter(Boolean));
}

boot();
