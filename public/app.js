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
  dashboardView: 'overview',
  summary: null,
  activity: [],
  records: [],
  coverage: null,
  filters: {},
  sort: { key: 'dueDate', dir: 1 },
  drawer: null,
  importing: null,
  users: [],
  editingUser: null,
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

function svg(tag, props = {}, ...children) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    element.setAttribute(key, String(value));
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
      h('div', {}, h('h1', {}, 'Maintenance Planning Tracker'), h('p', {}, mode === 'signin' ? 'Sign in to continue.' : 'Create the administrator account.')),
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

  // Repaint only when the answer changes the form.
  //
  // `/api/setup` arrives a moment after the page does, and repainting
  // unconditionally called `replaceChildren` on the fields — wiping whatever
  // had already been typed into them. Anybody quick enough to start typing
  // before the round trip finished lost it, which reads as the password field
  // silently refusing to keep a password.
  api('/setup')
    .then((info) => {
      const next = info.needsSetup ? 'setup' : 'signin';
      if (next === mode) return;
      mode = next;
      paint();
    })
    .catch(() => {});

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
    h('div', { class: 'brand' }, h('strong', {}, 'Planning Tracker'), h('span', {}, 'Maintenance department')),
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

/**
 * Three views over the same figures.
 *
 * They answer different questions and are read by different people: the shift
 * lead wants the list of what is late, the manager wants the shape of the
 * backlog, the supervisor wants to know who is carrying it. One page trying to
 * do all three ends up doing none of them.
 */
const DASHBOARD_VIEWS = [
  { id: 'overview', label: 'Overview', hint: 'What is late, and what changed' },
  { id: 'charts', label: 'Charts', hint: 'The shape of the work' },
  { id: 'plant', label: '3D view', hint: 'The whole department as one landscape' },
  { id: 'people', label: 'People', hint: 'Who is carrying it, and what is missing' },
];

function dashboard() {
  const summary = state.summary;
  if (!summary) return h('div', { class: 'empty' }, 'Loading…');

  const view = DASHBOARD_VIEWS.find((v) => v.id === state.dashboardView) ?? DASHBOARD_VIEWS[0];

  return h(
    'div',
    {},
    summary.restricted
      ? h('div', { class: 'notice' }, `This account covers ${summary.registerCount} of the registers, so these figures are for those only.`)
      : null,
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Dashboard'), h('p', {}, `${view.hint} · position on ${fmtDate(summary.today)}`)),
    ),
    h(
      'div',
      { class: 'tabs', role: 'tablist' },
      DASHBOARD_VIEWS.map((tab) =>
        h(
          'button',
          {
            class: 'tab',
            role: 'tab',
            'aria-selected': String(tab.id === view.id),
            onclick: () => {
              state.dashboardView = tab.id;
              render();
            },
          },
          tab.label,
        ),
      ),
    ),
    view.id === 'overview'
      ? overviewView(summary)
      : view.id === 'charts'
        ? chartsView(summary)
        : view.id === 'plant'
          ? plantView(summary)
          : peopleView(summary),
  );
}

/* ---------------------------------------------------------------- Bars */

/**
 * A stacked horizontal bar.
 *
 * The segments carry a 2px surface gap so two adjacent states never read as one
 * block, and every segment names its own figure on hover. Zero-length segments
 * are dropped rather than rendered at hairline width, which would print a
 * colour for a state that has nothing in it.
 */
function stackedBar(segments, total, max) {
  const sum = total || segments.reduce((n, s) => n + s.value, 0) || 1;
  // Bar length carries magnitude, segment length carries composition. Scaling
  // every bar to its own total instead would make a register holding one job
  // exactly as long as one holding eleven — which is the answer to a question
  // nobody asked, on a chart headed "workload".
  const width = max ? (sum / max) * 100 : 100;
  return h(
    'span',
    { class: 'track-outer' },
    h(
      'span',
      { class: 'track', style: `width:${Math.max(width, 1.5)}%` },
      segments
        .filter((segment) => segment.value > 0)
        .map((segment) =>
          h('span', {
            class: `seg s-${segment.key}`,
            style: `width:${(segment.value / sum) * 100}%`,
            title: `${segment.label}: ${segment.value}`,
          }),
        ),
    ),
  );
}

/**
 * One labelled bar.
 *
 * `total` sizes the bar; `value` is what gets printed beside it. They are
 * separate because they are not always the same thing — a coverage row is
 * sized by the size of the team and reads "5", the number who hold the course,
 * not "23" repeated down the column.
 */
/**
 * A donut, for part-to-whole at a glance.
 *
 * Legal here and not much else: five slices of one total, each a named state
 * rather than a quantity to compare. Anything that wants two amounts compared
 * gets a bar — a reader cannot judge two similar arcs, and the numbers are
 * printed beside it precisely because the arcs are approximate.
 *
 * Drawn with a dashed stroke rather than paths: the arithmetic is one length
 * and one offset per segment, which is far harder to get subtly wrong than arc
 * flags and sweep directions.
 */
const DONUT = { size: 150, radius: 56, width: 24, gap: 3 };

function donut(segments, { total, centreLabel } = {}) {
  const sum = total ?? segments.reduce((n, seg) => n + seg.value, 0);
  const circumference = 2 * Math.PI * DONUT.radius;
  const present = segments.filter((seg) => seg.value > 0);
  // With one slice there is nothing to separate, and a gap would print a notch
  // in what is really a full ring.
  const gap = present.length > 1 ? DONUT.gap : 0;

  const centre = DONUT.size / 2;
  let offset = 0;
  const arcs = present.map((seg) => {
    const length = (seg.value / sum) * circumference;
    const drawn = Math.max(0, length - gap);
    const arc = svg('circle', {
      cx: centre,
      cy: centre,
      r: DONUT.radius,
      fill: 'none',
      stroke: `var(--${seg.key})`,
      'stroke-width': DONUT.width,
      'stroke-dasharray': `${drawn} ${circumference - drawn}`,
      'stroke-dashoffset': -offset,
    });
    arc.append(svg('title', {}, `${seg.label}: ${seg.value} (${Math.round((seg.value / sum) * 100)}%)`));
    offset += length;
    return arc;
  });

  const ring = svg(
    'svg',
    { viewBox: `0 0 ${DONUT.size} ${DONUT.size}`, class: 'donut', role: 'img' },
    // The track, so a mostly-empty ring still reads as a ring rather than as a
    // stray arc floating on the page.
    svg('circle', {
      cx: centre,
      cy: centre,
      r: DONUT.radius,
      fill: 'none',
      stroke: 'var(--line-soft)',
      'stroke-width': DONUT.width,
    }),
    arcs,
    svg('text', { x: centre, y: centre - 2, class: 'donut-total' }, String(sum)),
    svg('text', { x: centre, y: centre + 17, class: 'donut-label' }, centreLabel ?? ''),
  );

  return h(
    'div',
    { class: 'donut-wrap' },
    ring,
    h(
      'div',
      { class: 'donut-key' },
      segments.map((seg) =>
        h(
          'div',
          { class: 'donut-key-row' },
          h('i', { style: `background:var(--${seg.key})` }),
          h('span', { class: 'donut-key-label' }, seg.label),
          h('b', {}, String(seg.value)),
          h('span', { class: 'donut-key-pct' }, sum ? `${Math.round((seg.value / sum) * 100)}%` : '—'),
        ),
      ),
    ),
  );
}

function chartRow(label, segments, { total, value, sub, max } = {}) {
  const sum = total ?? segments.reduce((n, seg) => n + seg.value, 0);
  return h(
    'div',
    { class: 'chart-row' },
    h('span', { class: 'chart-label', title: label }, label, sub ? h('span', { class: 'sub' }, sub) : null),
    stackedBar(segments, sum, max),
    h('span', { class: 'chart-value' }, String(value ?? sum)),
  );
}

function legend(series) {
  return h(
    'div',
    { class: 'legend' },
    series.map((s) => h('span', {}, h('i', { style: `background:var(--${s.key})` }), s.label)),
  );
}

function card(title, note, body) {
  return h(
    'div',
    { class: 'card', style: 'margin-top:14px' },
    h('div', { class: 'card-head' }, h('h2', {}, title), h('div', { class: 'spacer' }), note ? h('span', { class: 'who' }, note) : null),
    h('div', { class: 'card-body' }, body),
  );
}

/* ---------------------------------------------------------------- Overview */

function overviewView(summary) {
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
    h('div', { class: 'kpis' }, kpis.map((k) =>
      h(
        'div',
        { class: `kpi ${k.className ?? ''}` },
        h('div', { class: 'label' }, k.label),
        h('div', { class: 'value' }, String(k.value)),
        h('div', { class: 'note' }, k.note ?? ''),
      ),
    )),
    card(
      'Every job, by state',
      `${t.total} across ${summary.registerCount} registers`,
      donut(
        [
          { key: 'overdue', label: 'Overdue', value: t.overdue },
          { key: 'due-soon', label: 'Due soon', value: t.dueSoon },
          { key: 'scheduled', label: 'Scheduled', value: t.scheduled },
          { key: 'undated', label: 'No date', value: t.undated },
          { key: 'closed', label: 'Closed', value: t.closed },
        ],
        { total: t.total, centreLabel: 'jobs' },
      ),
    ),
    h('div', { class: 'register-grid', style: 'margin-top:14px' }, summary.registers.map(registerCard)),
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

/* ---------------------------------------------------------------- Charts */

/** The sequential ramp, tied to the grade rather than to its row number. */
const PRIORITY_TOKEN = {
  Critical: 'pri-1',
  High: 'pri-2',
  Medium: 'pri-3',
  Low: 'pri-4',
  Planned: 'pri-5',
};

const STATE_SERIES = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'due-soon', label: 'Due soon' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'undated', label: 'No date' },
  { key: 'closed', label: 'Closed' },
];

function chartsView(summary) {
  const jobs = summary.registers.filter((r) => r.kind === 'jobs');
  const busiest = [...jobs].filter((r) => r.total > 0).sort((a, b) => b.overdue - a.overdue || b.total - a.total);
  const buckets = summary.charts.dueBuckets;
  const peak = Math.max(buckets.overdue, buckets.later, ...buckets.weeks.map((w) => w.count), 1);
  const t = summary.totals;

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'donut-grid' },
      card(
        'Every job, by state',
        'All registers',
        donut(
          [
            { key: 'overdue', label: 'Overdue', value: t.overdue },
            { key: 'due-soon', label: 'Due soon', value: t.dueSoon },
            { key: 'scheduled', label: 'Scheduled', value: t.scheduled },
            { key: 'undated', label: 'No date', value: t.undated },
            { key: 'closed', label: 'Closed', value: t.closed },
          ],
          { total: t.total, centreLabel: 'jobs' },
        ),
      ),
      card(
        'Open work, by priority',
        null,
        donut(
          // Keyed by the priority itself, not by its position in the list, so a
          // grade with nothing in it does not shift every colour below it.
          summary.charts.byPriority.map((row) => ({
            key: PRIORITY_TOKEN[row.priority] ?? 'pri-5',
            label: row.priority,
            value: row.total,
          })),
          { centreLabel: 'open' },
        ),
      ),
    ),
    card(
      'Workload by register',
      `${jobs.length} registers`,
      busiest.length
        ? h(
            'div',
            {},
            h(
              'div',
              { class: 'chart' },
              busiest.map((r) =>
                chartRow(
                  r.name,
                  STATE_SERIES.map((s) => ({
                    key: s.key,
                    label: s.label,
                    value: s.key === 'due-soon' ? r.dueSoon : r[s.key] ?? 0,
                  })),
                  { total: r.total, max: Math.max(...busiest.map((x) => x.total)) },
                ),
              ),
            ),
            legend(STATE_SERIES),
          )
        : h('div', { class: 'empty' }, 'Nothing imported yet.'),
    ),

    card(
      'When open work falls due',
      'Next 12 weeks',
      h(
        'div',
        {},
        h(
          'div',
          { class: 'columns' },
          [
            { label: 'Late', full: 'Already overdue', count: buckets.overdue, key: 'overdue' },
            ...buckets.weeks.map((w) => ({ label: w.label, full: w.label, count: w.count, key: 'scheduled' })),
            { label: '12w+', full: 'Beyond 12 weeks', count: buckets.later, key: 'scheduled' },
            { label: 'None', full: 'No date set', count: buckets.undated, key: 'undated' },
          ].map((bar) =>
            h(
              'div',
              { class: 'column', title: `${bar.full}: ${bar.count}` },
              h('span', { class: 'column-value' }, bar.count || ''),
              h('span', {
                class: `column-fill s-${bar.key}`,
                // A bar with nothing in it keeps a 2px stub so the week is
                // visibly present and empty, rather than absent from the axis.
                style: `height:${bar.count ? Math.max(4, (bar.count / peak) * 100) : 0}%`,
              }),
              h('span', { class: 'column-label' }, bar.label),
            ),
          ),
        ),
        h('div', { class: 'field-note' }, 'Open jobs only. The first bar is work that has already slipped; the last two are work beyond the horizon and work with no date on it.'),
      ),
    ),

    card(
      'Open work by priority',
      null,
      summary.charts.byPriority.length
        ? h(
            'div',
            {},
            h(
              'div',
              { class: 'chart' },
              summary.charts.byPriority.map((row) =>
                chartRow(
                  row.priority,
                  [
                    { key: 'overdue', label: 'Overdue', value: row.overdue },
                    { key: 'scheduled', label: 'On track', value: row.total - row.overdue },
                  ],
                  { total: row.total, max: Math.max(...summary.charts.byPriority.map((x) => x.total)) },
                ),
              ),
            ),
            legend([
              { key: 'overdue', label: 'Overdue' },
              { key: 'scheduled', label: 'On track' },
            ]),
          )
        : h('div', { class: 'empty' }, 'No open work.'),
    ),
  );
}

/* ---------------------------------------------------------------- 3D view */

/**
 * The department as a landscape: one column per register, its height the work
 * still open on it and its colour the worst state anything on it is in.
 *
 * Built from CSS 3D transforms rather than a 3D library. The app has no build
 * step and runs on a plant network, so half a megabyte of WebGL fetched from a
 * CDN would be a real cost for a decorative gain — and this is genuine
 * perspective, not a drawing of it: the columns really are boxes, and dragging
 * really rotates the camera around them.
 */
const PLANT = {
  /** Floor cell size, and how much of it the column occupies. */
  cell: 96,
  footprint: 56,
  /** The tallest a column gets, whatever the busiest register holds. */
  /* Headroom matters more than drama: at a shallow tilt a column takes far more
     screen height than it does looking down, and a clipped roof looks broken. */
  maxHeight: 172,
  columns: 4,
};

/*
 * The camera. `rx` is positive on purpose: the stage's +Z is the column's up,
 * and only a positive X rotation maps it to screen-up. Negative tilts the world
 * the other way and the columns grow down through the floor.
 */
const plantCamera = { rx: 58, rz: -32, spin: true };

function plantView(summary) {
  // Tallest at the back. Placed in register order the tall columns land wherever
  // they happen to fall, hiding the short ones behind them and stacking their
  // labels on top of each other; sorted, the landscape steps down towards the
  // reader and every label has clear air above it.
  const registers = [...summary.registers]
    .filter((r) => r.kind === 'jobs')
    .sort((a, b) => b.open - a.open || b.total - a.total);
  const busiest = Math.max(1, ...registers.map((r) => r.open));

  const stage = h('div', { class: 'stage' });
  const scene = h('div', { class: 'scene' }, h('div', { class: 'floor-wrap' }, stage));

  const rows = Math.ceil(registers.length / PLANT.columns);
  const width = PLANT.columns * PLANT.cell;
  const depth = rows * PLANT.cell;

  // The floor, and the grid the columns stand on.
  const floor = h('div', {
    class: 'floor',
    style: `width:${width}px;height:${depth}px;background-size:${PLANT.cell}px ${PLANT.cell}px`,
  });
  stage.append(floor);

  registers.forEach((register, i) => {
    const column = i % PLANT.columns;
    const row = Math.floor(i / PLANT.columns);
    const height = register.open ? Math.max(14, (register.open / busiest) * PLANT.maxHeight) : 6;
    // Worst state wins: a register with anything overdue on it reads red from
    // across the room, which is the only reason to look at this from a distance.
    const tone = register.overdue ? 'overdue' : register.dueSoon ? 'due-soon' : register.open ? 'scheduled' : 'undated';

    const x = column * PLANT.cell + (PLANT.cell - PLANT.footprint) / 2 - width / 2;
    const y = row * PLANT.cell + (PLANT.cell - PLANT.footprint) / 2 - depth / 2;

    const box = h(
      'div',
      {
        class: `column3d t-${tone}`,
        style: `--w:${PLANT.footprint}px;--h:${height}px;transform:translate3d(${x}px,${y}px,0)`,
        title: `${register.name}: ${register.open} open, ${register.overdue} overdue, ${register.closed} closed`,
        onclick: () => go({ name: 'register', id: register.id }),
      },
      // Four walls and a lid. The underside is never seen — the camera is
      // clamped above the floor — so it is not built.
      h('span', { class: 'face front' }),
      h('span', { class: 'face back' }),
      h('span', { class: 'face left' }),
      h('span', { class: 'face right' }),
      // The count sits on the roof, counter-rotated about Z only so it reads
      // level with the page instead of lying along the column's own axis.
      h('span', { class: 'face top' }, h('span', { class: 'top-text' }, register.open || '')),
      // Billboarded: counter-rotating by the camera angles keeps the label
      // facing the reader instead of lying flat on the column.
      h('span', { class: 'pin' }, h('span', { class: 'pin-text' }, register.short)),
    );
    stage.append(box);
  });

  function applyCamera() {
    scene.style.setProperty('--rx', `${plantCamera.rx}deg`);
    scene.style.setProperty('--rz', `${plantCamera.rz}deg`);
    scene.classList.toggle('spinning', plantCamera.spin);
  }
  applyCamera();

  /* Drag to look around. Rotation about X is clamped so the camera never drops
     below the floor or tips over the top, where the scene reads as nonsense. */
  let dragging = null;
  scene.addEventListener('pointerdown', (event) => {
    dragging = { x: event.clientX, y: event.clientY, rx: plantCamera.rx, rz: plantCamera.rz };
    plantCamera.spin = false;
    scene.setPointerCapture(event.pointerId);
    applyCamera();
  });
  scene.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    plantCamera.rz = dragging.rz + (event.clientX - dragging.x) * 0.4;
    // Clamped: below about 12° the floor is edge-on and the scene is unreadable;
    // above 85° it is a plan view with no height in it at all.
    plantCamera.rx = Math.min(85, Math.max(12, dragging.rx + (event.clientY - dragging.y) * 0.3));
    applyCamera();
  });
  const stop = () => {
    dragging = null;
  };
  scene.addEventListener('pointerup', stop);
  scene.addEventListener('pointercancel', stop);

  const legendSeries = [
    { key: 'overdue', label: 'Something overdue' },
    { key: 'due-soon', label: 'Due within the month' },
    { key: 'scheduled', label: 'Open, on track' },
    { key: 'undated', label: 'Nothing open' },
  ];

  return h(
    'div',
    {},
    card(
      'The department, as a landscape',
      `${registers.length} registers · tallest is ${busiest} open`,
      h(
        'div',
        {},
        scene,
        h(
          'div',
          { class: 'scene-controls' },
          h(
            'button',
            {
              class: 'small',
              onclick: () => {
                plantCamera.spin = !plantCamera.spin;
                applyCamera();
              },
            },
            'Spin on / off',
          ),
          h(
            'button',
            {
              class: 'small',
              onclick: () => {
                plantCamera.rx = 58;
                plantCamera.rz = -32;
                plantCamera.spin = true;
                applyCamera();
              },
            },
            'Reset view',
          ),
          h('span', { class: 'who' }, 'Drag to look around · click a column to open that register'),
        ),
        legend(legendSeries),
        h('div', { class: 'field-note' }, 'Height is how much is still open on that register. Colour is the worst state anything on it is in.'),
      ),
    ),
  );
}

/* ---------------------------------------------------------------- People */

function peopleView(summary) {
  const owners = summary.charts.byOwner;
  const sheets = summary.registers.filter((r) => r.kind === 'people');

  return h(
    'div',
    {},
    card(
      'Who is carrying the open work',
      owners.length ? `${owners.length} names` : null,
      owners.length
        ? h(
            'div',
            {},
            h(
              'div',
              { class: 'chart' },
              owners.map((o) =>
                chartRow(
                  o.owner,
                  [
                    { key: 'overdue', label: 'Overdue', value: o.overdue },
                    { key: 'scheduled', label: 'On track', value: o.total - o.overdue },
                  ],
                  { total: o.total, max: Math.max(...owners.map((x) => x.total)) },
                ),
              ),
            ),
            legend([
              { key: 'overdue', label: 'Overdue' },
              { key: 'scheduled', label: 'On track' },
            ]),
            h('div', { class: 'field-note' }, 'Taken from whichever column each register uses to say who has it — Action By, Assigned To, or the supplier on a rental.'),
          )
        : h('div', { class: 'empty' }, 'No open work has an owner against it.'),
    ),

    sheets.length
      ? card(
          'People sheets',
          `${summary.people.people} people`,
          h(
            'div',
            { class: 'chart' },
            sheets.map((sheet) =>
              chartRow(
                sheet.name,
                [
                  { key: 'closed', label: 'Filled', value: sheet.cellsFilled },
                  { key: 'undated', label: 'Blank', value: Math.max(0, sheet.cellsTotal - sheet.cellsFilled) },
                ],
                {
                  total: sheet.cellsTotal,
                  value: `${sheet.coverage ?? 0}%`,
                  sub: `${sheet.total} people · ${sheet.cellsFilled}/${sheet.cellsTotal} cells`,
                },
              ),
            ),
          ),
        )
      : null,

    ...(summary.matrix ?? []).map((sheet) => {
      const columns = sheet.coverageOrder === 'declared' ? sheet.columns : [...sheet.columns].sort((a, b) => a.percent - b.percent);
      return card(
        `${sheet.name} — ${sheet.cellLabel.toLowerCase()} coverage`,
        `${sheet.people} people`,
        h(
          'div',
          { class: 'chart' },
          columns.map((column) =>
            chartRow(
              column.label,
              [
                { key: 'closed', label: 'Held', value: column.held },
                { key: 'undated', label: 'Missing', value: column.missing },
              ],
              {
                total: sheet.people,
                value: column.held,
                sub: column.missing ? `${column.missing} missing` : 'everybody',
              },
            ),
          ),
        ),
      );
    }),
  );
}

function registerCard(entry) {
  if (entry.kind === 'log') {
    return h(
      'button',
      { class: 'register-card', onclick: () => go({ name: 'register', id: entry.id }) },
      h('div', { class: 'rc-top' }, h('strong', {}, entry.name), h('span', { class: 'total' }, String(entry.total))),
      h('div', { class: 'rc-desc' }, registerById(entry.id)?.description ?? ''),
      h('div', { class: 'bar' }, h('span', { class: 's-scheduled', style: 'width:100%' })),
      h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--scheduled)' }), 'Entries ', h('b', {}, String(entry.total)))),
    );
  }
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
  const registerOptions = state.registers.map((r) => ({ id: r.id, name: r.name }));

  /**
   * The register allow-list, as a checklist.
   *
   * An empty list means every register, which is the common case and must not
   * need all fifteen ticking. Ticking nothing therefore means "all", and the
   * label says so rather than leaving it to be guessed.
   */
  function registerPicker(selected, onChange) {
    const chosen = new Set(selected ?? []);
    const summary = h('div', { class: 'field-note' });

    /**
     * An explicit list is a list of *these* registers, and a register added to
     * the app afterwards is not on it. That is the right way round for a
     * permission — it fails closed — but it is invisible: somebody's colleague
     * simply does not have the new tab and nobody knows why. So the note says
     * so, and there is one click to hand back everything including whatever
     * comes next.
     */
    const paint = () => {
      const missing = registerOptions.length - chosen.size;
      summary.replaceChildren(
        chosen.size === 0
          ? document.createTextNode('Nothing ticked — this account sees every register, including any added later.')
          : document.createTextNode(
              `${chosen.size} of ${registerOptions.length} registers · ${missing} hidden from this account, and registers added later will be hidden too.`,
            ),
      );
    };
    paint();

    const list = h(
      'div',
      { class: 'checklist' },
      registerOptions.map((register) =>
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: chosen.has(register.id),
            onchange: (event) => {
              if (event.target.checked) chosen.add(register.id);
              else chosen.delete(register.id);
              paint();
              onChange?.([...chosen]);
            },
          }),
          h('span', {}, register.name),
        ),
      ),
    );
    const grantAll = h(
      'button',
      {
        type: 'button',
        class: 'small',
        onclick: () => {
          // Clearing the list, not ticking every box: an empty list means every
          // register now and in future, where sixteen ticks would freeze this
          // account at today's sixteen.
          chosen.clear();
          for (const box of list.querySelectorAll('input')) box.checked = false;
          paint();
          onChange?.([]);
        },
      },
      'Allow every register',
    );

    return {
      node: h('div', {}, list, h('div', { style: 'margin-top:6px' }, grantAll), summary),
      get: () => [...chosen],
    };
  }

  /* ---------------- Add somebody ---------------- */

  const addPicker = registerPicker([]);
  const addForm = h(
    'form',
    {
      class: 'card-body',
      style: 'display:grid;gap:12px;max-width:520px',
      onsubmit: (event) => {
        event.preventDefault();
        add();
      },
    },
    labelled('Name', h('input', { name: 'name', required: true, autocomplete: 'off' })),
    labelled('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'off' })),
    labelled(
      'Password',
      h('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }),
      'At least 8 characters. They can be told it once and change it later.',
    ),
    labelled(
      'Role',
      h(
        'select',
        { name: 'role' },
        [
          ['viewer', 'Viewer — read and export, nothing else'],
          ['editor', 'Editor — add, edit, delete and import'],
          ['admin', 'Admin — everything, plus accounts'],
        ].map(([value, text]) => h('option', { value }, text)),
      ),
    ),
    labelled('Registers', addPicker.node),
    h('button', { class: 'primary', type: 'submit' }, 'Add account'),
  );

  /* ---------------- The people already here ---------------- */

  const rows = state.users.map((user) => {
    const editing = state.editingUser === user.id;
    const picker = editing ? registerPicker(user.registers ?? []) : null;

    return [
      h(
        'tr',
        {},
        h('td', {}, user.name, user.id === state.user?.id ? h('span', { class: 'sub' }, 'you') : null),
        h('td', {}, user.email),
        h(
          'td',
          {},
          h(
            'select',
            { onchange: (event) => update(user, { role: event.target.value }) },
            ['viewer', 'editor', 'admin'].map((role) =>
              h('option', { value: role, selected: user.role === role }, role),
            ),
          ),
        ),
        h(
          'td',
          {},
          user.registers?.length
            ? h(
                'span',
                {},
                `${user.registers.length} of ${registerOptions.length}`,
                h('span', { class: 'sub' }, `${registerOptions.length - user.registers.length} hidden`),
              )
            : 'All',
          ' ',
          h(
            'button',
            {
              class: 'small',
              onclick: () => {
                state.editingUser = editing ? null : user.id;
                render();
              },
            },
            editing ? 'Close' : 'Change',
          ),
        ),
        h('td', { class: 'row-actions' }, h('button', { class: 'small danger', onclick: () => remove(user) }, 'Remove')),
      ),
      editing
        ? h(
            'tr',
            {},
            h(
              'td',
              { colspan: 5 },
              picker.node,
              h(
                'div',
                { style: 'margin-top:8px' },
                h(
                  'button',
                  {
                    class: 'small primary',
                    onclick: async () => {
                      await update(user, { registers: picker.get() });
                      state.editingUser = null;
                      render();
                    },
                  },
                  'Save registers',
                ),
              ),
            ),
          )
        : null,
    ];
  });

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, 'Accounts'),
        h('p', {}, 'The role says what kind of thing somebody may do; the register list says where.'),
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'People'), h('div', { class: 'spacer' }), h('span', { class: 'who' }, `${state.users.length} ${state.users.length === 1 ? 'account' : 'accounts'}`)),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Registers', ''].map((c) => h('th', {}, c)))),
          h('tbody', {}, rows),
        ),
      ),
    ),
    h(
      'div',
      { class: 'card', style: 'margin-top:18px' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Add somebody')),
      addForm,
    ),
  );

  async function add() {
    const data = Object.fromEntries(new FormData(addForm).entries());
    try {
      await api('/users', { method: 'POST', body: { ...data, registers: addPicker.get() } });
      flash(`${data.name} can now sign in.`);
      await loadRoute();
    } catch (error) {
      fail(error);
    }
  }

  async function update(user, changes) {
    try {
      await api(`/users/${user.id}`, { method: 'PUT', body: changes });
      flash('Saved.');
      await loadRoute();
    } catch (error) {
      fail(error);
    }
  }

  async function remove(user) {
    if (!confirm(`Remove ${user.name}? They will not be able to sign in again.`)) return;
    try {
      await api(`/users/${user.id}`, { method: 'DELETE' });
      flash(`${user.name} removed.`);
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
