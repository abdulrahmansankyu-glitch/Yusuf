/**
 * The API and the browser app, in one process.
 *
 * Everything the browser knows about the registers — their columns, labels,
 * types and options — is served from `/api/config`, so the UI is never a second
 * source of truth for the workbook's shape.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import express from 'express';
import multer from 'multer';

import { REGISTERS, fieldMap, getRegister, registerCatalogue } from './registers.js';
import { todayIso } from './dates.js';
import { openStore } from './store.js';
import { decorate, matrixCoverage, summarise } from './summary.js';
import { readWorkbook, readWorkbookAs, writeTemplate, writeWorkbook } from './excel.js';
import { nextNumber } from './autonumber.js';
import {
  ROLES,
  allowedRegisters,
  can,
  createUser,
  isLastAdmin,
  mayUseRegister,
  publicUser,
  signToken,
  verifyPassword,
  verifyToken,
} from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 4200);
const DATA_FILE = process.env.DATA_FILE || path.join(here, '..', 'data', 'tracker.json');
const ACCESS_CODE = process.env.ACCESS_CODE || '';

/**
 * A generated secret means sessions do not survive a restart, which is a worse
 * experience than it sounds on a host that restarts several times a day. It is
 * still the right default: a hard-coded fallback would be the same secret in
 * every deployment of this app.
 */
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');

const ALL_REGISTER_IDS = REGISTERS.map((r) => r.id);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

export async function createApp({ store }) {
  const app = express();
  /**
   * Express 4 does not catch a rejected promise from a route handler: it
   * becomes an unhandled rejection, and Node's default is to end the process.
   * One bad export therefore took the whole server down for everybody. Every
   * handler is wrapped so a failure becomes a 500 for that one caller.
   */
  catchAsync(app);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(here, '..', 'public')));

  /* ---------------------------------------------------------------- *
   * Who is asking
   * ---------------------------------------------------------------- */

  async function currentUser(req) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-session') || '';
    const payload = verifyToken(SESSION_SECRET, token, 'session');
    if (!payload) return null;
    const users = await store.users();
    return users.find((u) => u.id === payload.sub) ?? null;
  }

  const need = (capability) => async (req, res, next) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first.' });
    if (!can(user, capability)) return res.status(403).json({ error: 'Your account may not do that.' });
    req.user = user;
    next();
  };

  /**
   * Refusals happen on the server, not by hiding buttons.
   *
   * A hidden button is for clarity. An account limited to IWS that asks for MOC
   * directly is refused here, or the register list would be a suggestion.
   */
  function guardRegister(req, res, registerId) {
    const register = getRegister(registerId);
    if (!register) {
      res.status(404).json({ error: `Unknown register: ${registerId}` });
      return null;
    }
    if (!mayUseRegister(req.user, registerId)) {
      res.status(403).json({ error: `Your account does not cover ${register.name}.` });
      return null;
    }
    return register;
  }

  const visibleRegisters = (user) => allowedRegisters(user, ALL_REGISTER_IDS);

  /* ---------------------------------------------------------------- *
   * Health and setup
   * ---------------------------------------------------------------- */

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, storage: store.kind, today: todayIso() });
  });

  app.get('/api/setup', async (req, res) => {
    const users = await store.users();
    res.json({ needsSetup: users.length === 0, requiresAccessCode: Boolean(ACCESS_CODE) });
  });

  /**
   * The first person to open a fresh deployment creates the administrator, and
   * must supply the access code to do it — otherwise whoever finds the URL first
   * claims the installation.
   */
  app.post('/api/setup', async (req, res) => {
    const users = await store.users();
    if (users.length > 0) return res.status(409).json({ error: 'This installation is already set up.' });

    const { email, name, password, accessCode } = req.body ?? {};
    if (ACCESS_CODE && accessCode !== ACCESS_CODE) {
      return res.status(403).json({ error: 'That access code is not right.' });
    }
    if (!email || !password || String(password).length < 8) {
      return res.status(400).json({ error: 'An email and a password of at least 8 characters are needed.' });
    }

    const user = await createUser({ email, name: name || email, role: 'admin', password });
    await store.saveUser(user);
    await store.log({ actor: user.name, action: 'setup', summary: 'Created the first administrator.' });
    res.status(201).json({ token: signToken(SESSION_SECRET, { sub: user.id }), user: publicUser(user) });
  });

  app.post('/api/session', async (req, res) => {
    const { email, password } = req.body ?? {};
    const users = await store.users();
    const user = users.find((u) => u.email === String(email ?? '').trim().toLowerCase());
    // The same answer either way: which half was wrong is not the caller's
    // business, and saying so is how an account list gets enumerated.
    const ok = user ? await verifyPassword(String(password ?? ''), user.password) : false;
    if (!ok) return res.status(401).json({ error: 'That email and password do not match.' });
    res.json({ token: signToken(SESSION_SECRET, { sub: user.id }), user: publicUser(user) });
  });

  app.get('/api/me', need('read'), (req, res) => {
    res.json({
      user: publicUser(req.user),
      registers: visibleRegisters(req.user),
      can: {
        write: can(req.user, 'write'),
        import: can(req.user, 'import'),
        admin: can(req.user, 'admin'),
      },
    });
  });

  /* ---------------------------------------------------------------- *
   * The register definitions
   * ---------------------------------------------------------------- */

  app.get('/api/config', need('read'), (req, res) => {
    const visible = new Set(visibleRegisters(req.user));
    res.json({
      registers: registerCatalogue().filter((r) => visible.has(r.id)),
      today: todayIso(),
    });
  });

  /* ---------------------------------------------------------------- *
   * Records
   * ---------------------------------------------------------------- */

  app.get('/api/registers/:id/records', need('read'), async (req, res) => {
    const register = guardRegister(req, res, req.params.id);
    if (!register) return;
    const records = await store.list(register.id);
    const today = todayIso();
    res.json({
      records: records.map((r) => decorate(r, today)).filter(Boolean),
      coverage: matrixCoverage(register, records),
    });
  });

  app.post('/api/registers/:id/records', need('write'), async (req, res) => {
    const register = guardRegister(req, res, req.params.id);
    if (!register) return;
    const data = cleanData(register, req.body?.data ?? {});
    if (register.computeRow) Object.assign(data, register.computeRow(data));
    const record = await store.create(register.id, data, req.user.name);
    await store.log({
      actor: req.user.name,
      registerId: register.id,
      recordId: record.id,
      action: 'create',
      summary: describe(register, data),
    });
    res.status(201).json({ record: decorate(record) });
  });

  app.put('/api/records/:id', need('write'), async (req, res) => {
    const existing = await store.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'That entry no longer exists.' });
    const register = guardRegister(req, res, existing.registerId);
    if (!register) return;

    const data = cleanData(register, req.body?.data ?? {});
    if (register.computeRow) Object.assign(data, register.computeRow(data));
    const record = await store.update(existing.id, data, req.user.name);
    await store.log({
      actor: req.user.name,
      registerId: register.id,
      recordId: record.id,
      action: 'update',
      summary: describe(register, data),
    });
    res.json({ record: decorate(record) });
  });

  app.delete('/api/records/:id', need('write'), async (req, res) => {
    const existing = await store.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'That entry no longer exists.' });
    const register = guardRegister(req, res, existing.registerId);
    if (!register) return;
    await store.remove(existing.id);
    await store.log({
      actor: req.user.name,
      registerId: register.id,
      recordId: existing.id,
      action: 'delete',
      summary: describe(register, existing.data),
    });
    res.status(204).end();
  });

  /**
   * The next document number, as a preview.
   *
   * It is not a reservation — opening the form and thinking better of it
   * consumes nothing and leaves no gap in the sequence. The number is issued for
   * real when Save is pressed, and the server allocates it: "read the highest,
   * add one, insert" is a race with a database round trip in the middle of it.
   */
  app.get('/api/registers/:id/next-number', need('write'), async (req, res) => {
    const register = guardRegister(req, res, req.params.id);
    if (!register) return;
    if (!register.autoNumber) return res.json({ number: null });
    const records = await store.list(register.id);
    const existing = records.map((r) => r.data?.[register.autoNumber.field]);
    res.json({ number: nextNumber(existing, register.autoNumber) });
  });

  /* ---------------------------------------------------------------- *
   * Dashboard
   * ---------------------------------------------------------------- */

  app.get('/api/summary', need('read'), async (req, res) => {
    const records = await store.list();
    const visible = visibleRegisters(req.user);
    // Per-column coverage for the people sheets, so the dashboard can say which
    // course the fewest people hold without a request per register.
    const matrix = visible
      .map((id) => getRegister(id))
      .filter((register) => register?.matrix)
      .map((register) => ({
        id: register.id,
        name: register.name,
        cellLabel: register.matrix.cellLabel,
        coverageOrder: register.matrix.coverageOrder ?? 'thinnest',
        ...matrixCoverage(register, records),
      }))
      .filter((entry) => entry.people > 0);

    res.json({
      ...summarise(records, visible),
      matrix,
      // A restricted account's dashboard covers only its own registers and says
      // so, because a partial view reads as the whole department's position.
      restricted: visible.length !== ALL_REGISTER_IDS.length,
      registerCount: visible.length,
    });
  });

  app.get('/api/activity', need('read'), async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 40, 200);
    const visible = new Set(visibleRegisters(req.user));
    const entries = await store.activity(limit * 2);
    res.json({ activity: entries.filter((e) => !e.registerId || visible.has(e.registerId)).slice(0, limit) });
  });

  /* ---------------------------------------------------------------- *
   * Excel
   * ---------------------------------------------------------------- */

  /** Read an uploaded workbook and describe what is in it. Nothing is stored. */
  app.post('/api/import/inspect', need('import'), upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
    try {
      const { sheets } = await readWorkbook(req.file.buffer);
      const visible = new Set(visibleRegisters(req.user));
      res.json({
        sheets: sheets.map(({ rows, ...rest }) => ({
          ...rest,
          allowed: !rest.registerId || visible.has(rest.registerId),
          sample: (rows ?? []).slice(0, 3),
        })),
      });
    } catch (error) {
      res.status(400).json({ error: `That file could not be read: ${error.message}` });
    }
  });

  /** Commit the choices made against an inspected workbook. */
  app.post('/api/import/commit', need('import'), upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });

    let choices;
    try {
      choices = JSON.parse(req.body.choices ?? '[]');
    } catch {
      return res.status(400).json({ error: 'The sheet choices could not be read.' });
    }

    for (const choice of choices) {
      if (!guardRegister(req, res, choice.registerId)) return;
    }

    try {
      const parsed = await readWorkbookAs(req.file.buffer, choices);
      const results = [];
      for (const sheet of parsed) {
        const register = getRegister(sheet.registerId);
        let removed = 0;
        if (sheet.mode === 'replace') removed = await store.clearRegister(register.id);
        const rows = sheet.rows.map((data) => cleanData(register, data));
        await store.createMany(register.id, rows, req.user.name);
        await store.log({
          actor: req.user.name,
          registerId: register.id,
          action: 'import',
          summary: `${sheet.mode === 'replace' ? 'Replaced' : 'Added to'} ${register.name} from “${sheet.sheet}”: ${rows.length} rows${removed ? `, ${removed} removed` : ''}${sheet.skipped ? `, ${sheet.skipped} legend rows ignored` : ''}.`,
        });
        results.push({ sheet: sheet.sheet, registerId: register.id, imported: rows.length, removed, skipped: sheet.skipped });
      }
      res.json({ results });
    } catch (error) {
      res.status(400).json({ error: `That file could not be imported: ${error.message}` });
    }
  });

  app.get('/api/export', need('export'), async (req, res) => {
    const visible = visibleRegisters(req.user);
    const only = String(req.query.register ?? '').trim();
    const ids = only ? visible.filter((id) => id === only) : visible;
    if (!ids.length) return res.status(403).json({ error: 'Nothing to export.' });

    const records = await store.list();
    const byRegister = new Map();
    for (const record of records) {
      if (!ids.includes(record.registerId)) continue;
      const list = byRegister.get(record.registerId) ?? [];
      list.push(record);
      byRegister.set(record.registerId, list);
    }

    const buffer = await writeWorkbook({
      recordsByRegister: byRegister,
      summary: only ? null : summarise(records, ids),
      registerIds: ids,
    });

    const name = only ? `${only}-${todayIso()}.xlsx` : `engineering-planning-${todayIso()}.xlsx`;
    sendWorkbook(res, name, buffer);
  });

  app.get('/api/template/:id', need('export'), async (req, res) => {
    const register = guardRegister(req, res, req.params.id);
    if (!register) return;
    sendWorkbook(res, `${register.id}-template.xlsx`, await writeTemplate(register.id));
  });

  /* ---------------------------------------------------------------- *
   * Accounts
   * ---------------------------------------------------------------- */

  app.get('/api/users', need('admin'), async (req, res) => {
    res.json({ users: (await store.users()).map(publicUser), roles: ROLES, registers: ALL_REGISTER_IDS });
  });

  app.post('/api/users', need('admin'), async (req, res) => {
    const { email, name, role, registers, password } = req.body ?? {};
    if (!email || !password || String(password).length < 8) {
      return res.status(400).json({ error: 'An email and a password of at least 8 characters are needed.' });
    }
    const users = await store.users();
    if (users.some((u) => u.email === String(email).trim().toLowerCase())) {
      return res.status(409).json({ error: 'That email already has an account.' });
    }
    const user = await createUser({ email, name: name || email, role, registers: registers ?? [], password });
    await store.saveUser(user);
    await store.log({ actor: req.user.name, action: 'user-create', summary: `Added ${user.name} as ${user.role}.` });
    res.status(201).json({ user: publicUser(user) });
  });

  app.put('/api/users/:id', need('admin'), async (req, res) => {
    const users = await store.users();
    const user = users.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'No such account.' });

    const { name, role, registers } = req.body ?? {};
    if (role && role !== user.role && user.role === 'admin' && isLastAdmin(users, user.id)) {
      return res.status(409).json({ error: 'This is the last administrator — promote somebody else first.' });
    }
    if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role.' });

    const updated = { ...user, name: name ?? user.name, role: role ?? user.role, registers: registers ?? user.registers };
    await store.saveUser(updated);
    await store.log({ actor: req.user.name, action: 'user-update', summary: `Updated ${updated.name}.` });
    res.json({ user: publicUser(updated) });
  });

  app.delete('/api/users/:id', need('admin'), async (req, res) => {
    const users = await store.users();
    const user = users.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'No such account.' });
    if (isLastAdmin(users, user.id)) {
      return res.status(409).json({ error: 'This is the last administrator and cannot be removed.' });
    }
    await store.removeUser(user.id);
    await store.log({ actor: req.user.name, action: 'user-delete', summary: `Removed ${user.name}.` });
    res.status(204).end();
  });

  /** The single-page app answers anything that is not an API call. */
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(here, '..', 'public', 'index.html'));
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(500).json({ error: error.message });
  });

  return app;
}

function catchAsync(app) {
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    const original = app[method].bind(app);
    app[method] = (path, ...handlers) =>
      original(
        path,
        ...handlers.map((handler) =>
          handler.length >= 4
            ? handler
            : (req, res, next) => {
                try {
                  Promise.resolve(handler(req, res, next)).catch(next);
                } catch (error) {
                  next(error);
                }
              },
        ),
      );
  }
}

function sendWorkbook(res, filename, buffer) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
}

/**
 * Keep the register's own fields and any `extra:` column the sheet carried;
 * discard anything else the browser sent.
 *
 * A form posting a key no register declares is a bug or a probe, and storing it
 * would make it appear as a column in the next export.
 */
function cleanData(register, input) {
  const fields = fieldMap(register);
  const data = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!fields.has(key) && !key.startsWith('extra:')) continue;
    if (value === null || value === undefined) continue;
    const text = typeof value === 'string' ? value.trim() : value;
    if (text === '') continue;
    data[key] = text;
  }
  return data;
}

/** A one-line description of a row, for the activity feed. */
function describe(register, data) {
  const roles = register.roles ?? {};
  const parts = [data?.[roles.ref], data?.[roles.title]].filter(Boolean).map(String);
  const text = parts.join(' — ') || 'an entry';
  return `${register.name}: ${text.length > 90 ? `${text.slice(0, 87)}…` : text}`;
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function main() {
  const store = await openStore({ file: DATA_FILE });

  // An administrator from the environment, so a deployment can come up ready to
  // use without anybody meeting the setup screen.
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const users = await store.users();
    if (!users.some((u) => u.email === process.env.ADMIN_EMAIL.toLowerCase())) {
      await store.saveUser(
        await createUser({
          email: process.env.ADMIN_EMAIL,
          name: process.env.ADMIN_NAME || process.env.ADMIN_EMAIL,
          role: 'admin',
          password: process.env.ADMIN_PASSWORD,
        }),
      );
      console.log(`Created administrator ${process.env.ADMIN_EMAIL}`);
    }
  }

  const app = await createApp({ store });
  app.listen(PORT, () => {
    console.log(`Maintenance Planning Tracker on http://localhost:${PORT} (storage: ${store.kind})`);
    if (!process.env.SESSION_SECRET) {
      console.warn('SESSION_SECRET is not set — sessions will not survive a restart.');
    }
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
