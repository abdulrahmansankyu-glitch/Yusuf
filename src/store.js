/**
 * Where the data lives: Postgres, or a JSON file, behind one interface.
 *
 * With no `DATABASE_URL` everything goes to `data/tracker.json` — enough to try
 * the app on one machine. Point `DATABASE_URL` at Postgres and the same calls go
 * there instead, which is what makes the team see one another's edits.
 *
 * Records are stored as `{ registerId, data }` with `data` exactly as the sheet
 * gave it. Nothing normalises on the way in: derivation happens on the way out,
 * so a change to how a status word is read applies to rows already stored rather
 * than only to rows imported afterwards.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_ACTIVITY = 500;

const now = () => new Date().toISOString();

function emptyState() {
  return { records: [], activity: [], users: [], meta: { version: 1 } };
}

/* ------------------------------------------------------------------ *
 * JSON file
 * ------------------------------------------------------------------ */

class JsonStore {
  constructor(file) {
    this.file = file;
    this.state = emptyState();
    this.writing = Promise.resolve();
  }

  async init() {
    try {
      this.state = { ...emptyState(), ...JSON.parse(await fs.readFile(this.file, 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await this.flush();
    }
    return this;
  }

  /**
   * Write to a neighbour and rename over the original.
   *
   * A crash halfway through a plain write leaves a truncated file, and this is
   * the only copy of the team's data on a single-machine deployment.
   */
  async flush() {
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.state, null, 2));
    await fs.rename(temp, this.file);
  }

  save() {
    this.writing = this.writing.then(() => this.flush()).catch(() => {});
    return this.writing;
  }

  async records(registerId) {
    return registerId ? this.state.records.filter((r) => r.registerId === registerId) : this.state.records.slice();
  }

  async record(id) {
    return this.state.records.find((r) => r.id === id) ?? null;
  }

  async insert(rows) {
    this.state.records.push(...rows);
    await this.save();
    return rows;
  }

  async update(id, data, actor) {
    const record = this.state.records.find((r) => r.id === id);
    if (!record) return null;
    record.data = data;
    record.updatedAt = now();
    record.updatedBy = actor;
    await this.save();
    return record;
  }

  async remove(ids) {
    const set = new Set(ids);
    const before = this.state.records.length;
    this.state.records = this.state.records.filter((r) => !set.has(r.id));
    await this.save();
    return before - this.state.records.length;
  }

  async removeRegister(registerId) {
    const before = this.state.records.length;
    this.state.records = this.state.records.filter((r) => r.registerId !== registerId);
    await this.save();
    return before - this.state.records.length;
  }

  async logActivity(entry) {
    this.state.activity.unshift(entry);
    this.state.activity = this.state.activity.slice(0, MAX_ACTIVITY);
    await this.save();
  }

  async activity(limit) {
    return this.state.activity.slice(0, limit);
  }

  async users() {
    return this.state.users.slice();
  }

  async saveUser(user) {
    const i = this.state.users.findIndex((u) => u.id === user.id);
    if (i === -1) this.state.users.push(user);
    else this.state.users[i] = user;
    await this.save();
    return user;
  }

  async removeUser(id) {
    this.state.users = this.state.users.filter((u) => u.id !== id);
    await this.save();
  }
}

/* ------------------------------------------------------------------ *
 * Postgres
 * ------------------------------------------------------------------ */

/**
 * Tables live in their own schema.
 *
 * Sharing a database with another application is normal on a small deployment,
 * and a migration tool that drops what it does not recognise in `public` must
 * not be able to reach these.
 */
const SCHEMA = process.env.DATABASE_SCHEMA || 'planning';

const DDL = `
CREATE SCHEMA IF NOT EXISTS ${SCHEMA};

CREATE TABLE IF NOT EXISTS ${SCHEMA}.records (
  id           TEXT PRIMARY KEY,
  register_id  TEXT NOT NULL,
  data         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);
CREATE INDEX IF NOT EXISTS records_register_idx ON ${SCHEMA}.records (register_id);

CREATE TABLE IF NOT EXISTS ${SCHEMA}.activity (
  id           TEXT PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor        TEXT,
  register_id  TEXT,
  record_id    TEXT,
  action       TEXT NOT NULL,
  summary      TEXT
);
CREATE INDEX IF NOT EXISTS activity_at_idx ON ${SCHEMA}.activity (at DESC);

CREATE TABLE IF NOT EXISTS ${SCHEMA}.users (
  id         TEXT PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL,
  registers  JSONB NOT NULL DEFAULT '[]'::jsonb,
  password   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

class PgStore {
  constructor(pool) {
    this.pool = pool;
  }

  async init() {
    await this.pool.query(DDL);
    return this;
  }

  static rowToRecord(row) {
    return {
      id: row.id,
      registerId: row.register_id,
      data: row.data,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  async records(registerId) {
    const { rows } = registerId
      ? await this.pool.query(`SELECT * FROM ${SCHEMA}.records WHERE register_id = $1`, [registerId])
      : await this.pool.query(`SELECT * FROM ${SCHEMA}.records`);
    return rows.map(PgStore.rowToRecord);
  }

  async record(id) {
    const { rows } = await this.pool.query(`SELECT * FROM ${SCHEMA}.records WHERE id = $1`, [id]);
    return rows[0] ? PgStore.rowToRecord(rows[0]) : null;
  }

  async insert(records) {
    if (!records.length) return records;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of records) {
        await client.query(
          `INSERT INTO ${SCHEMA}.records (id, register_id, data, created_at, created_by, updated_at, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [r.id, r.registerId, r.data, r.createdAt, r.createdBy, r.updatedAt, r.updatedBy],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return records;
  }

  async update(id, data, actor) {
    const { rows } = await this.pool.query(
      `UPDATE ${SCHEMA}.records SET data = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
      [id, data, actor],
    );
    return rows[0] ? PgStore.rowToRecord(rows[0]) : null;
  }

  async remove(ids) {
    if (!ids.length) return 0;
    const { rowCount } = await this.pool.query(`DELETE FROM ${SCHEMA}.records WHERE id = ANY($1)`, [ids]);
    return rowCount;
  }

  async removeRegister(registerId) {
    const { rowCount } = await this.pool.query(`DELETE FROM ${SCHEMA}.records WHERE register_id = $1`, [registerId]);
    return rowCount;
  }

  async logActivity(entry) {
    await this.pool.query(
      `INSERT INTO ${SCHEMA}.activity (id, at, actor, register_id, record_id, action, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [entry.id, entry.at, entry.actor, entry.registerId, entry.recordId, entry.action, entry.summary],
    );
  }

  async activity(limit) {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${SCHEMA}.activity ORDER BY at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      at: r.at instanceof Date ? r.at.toISOString() : r.at,
      actor: r.actor,
      registerId: r.register_id,
      recordId: r.record_id,
      action: r.action,
      summary: r.summary,
    }));
  }

  async users() {
    const { rows } = await this.pool.query(`SELECT * FROM ${SCHEMA}.users ORDER BY name`);
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      role: r.role,
      registers: r.registers ?? [],
      password: r.password,
    }));
  }

  async saveUser(user) {
    await this.pool.query(
      `INSERT INTO ${SCHEMA}.users (id, email, name, role, registers, password)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE
         SET email = EXCLUDED.email, name = EXCLUDED.name, role = EXCLUDED.role,
             registers = EXCLUDED.registers, password = EXCLUDED.password`,
      [user.id, user.email, user.name, user.role, JSON.stringify(user.registers ?? []), user.password],
    );
    return user;
  }

  async removeUser(id) {
    await this.pool.query(`DELETE FROM ${SCHEMA}.users WHERE id = $1`, [id]);
  }
}

/* ------------------------------------------------------------------ *
 * The interface the rest of the app uses
 * ------------------------------------------------------------------ */

export async function openStore({ databaseUrl = process.env.DATABASE_URL, file } = {}) {
  const backend = databaseUrl ? await openPg(databaseUrl) : await new JsonStore(file).init();
  return new Store(backend, Boolean(databaseUrl));
}

/**
 * SSL parameters carried in the connection string itself.
 *
 * Hosted Postgres hands you a URL ending `?sslmode=require&channel_binding=require`
 * — Neon's does, and it is the string people paste. `pg` parses `sslmode` out of
 * that string and applies it, and its current reading of `require` is the
 * strictest one (`verify-full`), which silently outranks whatever `ssl` option
 * the caller passed. Setting `DATABASE_SSL=no-verify` therefore had no effect at
 * all, and the connection failed on certificate verification:
 *
 *     FAILED: self-signed certificate
 *
 * When `DATABASE_SSL` says what to do, these are removed so that it is the thing
 * that decides. With `DATABASE_SSL` unset the string is left exactly as pasted,
 * so a URL that asks for full verification still gets it.
 */
function stripSslParams(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('channel_binding');
    return url.toString();
  } catch {
    // Not a URL `new URL` can parse — a libpq keyword/value string, say. Leave
    // it alone rather than mangling a connection string that may be perfectly
    // valid for pg.
    return databaseUrl;
  }
}

export function connectionSettings(databaseUrl, mode = process.env.DATABASE_SSL) {
  if (mode === 'disable') return { connectionString: stripSslParams(databaseUrl), ssl: false };
  if (mode === 'no-verify') {
    return { connectionString: stripSslParams(databaseUrl), ssl: { rejectUnauthorized: false } };
  }
  return { connectionString: databaseUrl };
}

async function openPg(databaseUrl) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool(connectionSettings(databaseUrl));
  return new PgStore(pool).init();
}

export class Store {
  constructor(backend, persistent) {
    this.backend = backend;
    this.persistent = persistent;
  }

  get kind() {
    return this.persistent ? 'postgres' : 'file';
  }

  list(registerId) {
    return this.backend.records(registerId);
  }

  get(id) {
    return this.backend.record(id);
  }

  async create(registerId, data, actor) {
    const record = {
      id: randomUUID(),
      registerId,
      data,
      createdAt: now(),
      createdBy: actor,
      updatedAt: now(),
      updatedBy: actor,
    };
    await this.backend.insert([record]);
    return record;
  }

  async createMany(registerId, rows, actor) {
    const stamp = now();
    const records = rows.map((data) => ({
      id: randomUUID(),
      registerId,
      data,
      createdAt: stamp,
      createdBy: actor,
      updatedAt: stamp,
      updatedBy: actor,
    }));
    await this.backend.insert(records);
    return records;
  }

  update(id, data, actor) {
    return this.backend.update(id, data, actor);
  }

  remove(ids) {
    return this.backend.remove(Array.isArray(ids) ? ids : [ids]);
  }

  clearRegister(registerId) {
    return this.backend.removeRegister(registerId);
  }

  log({ actor, registerId, recordId, action, summary }) {
    return this.backend.logActivity({
      id: randomUUID(),
      at: now(),
      actor: actor ?? null,
      registerId: registerId ?? null,
      recordId: recordId ?? null,
      action,
      summary: summary ?? null,
    });
  }

  activity(limit = 40) {
    return this.backend.activity(limit);
  }

  users() {
    return this.backend.users();
  }

  saveUser(user) {
    return this.backend.saveUser(user);
  }

  removeUser(id) {
    return this.backend.removeUser(id);
  }
}
