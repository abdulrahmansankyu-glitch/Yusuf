/**
 * Tests over the parts that would otherwise fail silently.
 *
 * The fixtures are built here rather than checked in as a sample workbook: the
 * real file carries employees' names and residency numbers, and that does not
 * belong in a git repository. Every quirk it has — the banner rows, the legend
 * under the header, the vertically merged headings, the month columns headed
 * with dates — is reproduced below.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';

import { toDateOnly, formatDate, daysUntil } from '../src/dates.js';
import {
  REGISTERS,
  deriveRecord,
  dueState,
  getRegister,
  normalisePriority,
  normaliseStatus,
} from '../src/registers.js';
import { detectHeader, readSheet, readWorkbook, suggestRegister, writeWorkbook } from '../src/excel.js';
import { nextNumber } from '../src/autonumber.js';
import { hashPassword, isLastAdmin, signToken, verifyPassword, verifyToken, mayUseRegister } from '../src/auth.js';
import { connectionSettings } from '../src/store.js';
import { stampAssets } from '../src/server.js';
import { summarise } from '../src/summary.js';

const iso = (v) => toDateOnly(v);

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

test('two-digit years are read as this century', () => {
  assert.equal(iso('13/08/25'), '2025-08-13');
  assert.equal(iso('22/9/25'), '2025-09-22');
});

test('the workbook is day-first, so 09/08/25 is 9 August', () => {
  assert.equal(iso('09/08/25'), '2025-08-09');
});

test('a four-digit leading group can only be a year', () => {
  assert.equal(iso('2026-09-03'), '2026-09-03');
});

test('an Excel serial becomes the day it prints as', () => {
  // 2026-08-26 as an Excel serial.
  const serial = Math.round(Date.UTC(2026, 7, 26) / 86400000) + 25569;
  assert.equal(iso(serial), '2026-08-26');
});

test('a phrase in a date column is not a date', () => {
  assert.equal(iso('Next Shutdown'), null);
  assert.equal(iso('SEP'), null);
  assert.equal(iso('RELEASED'), null);
});

test('a date that has wrapped out of range is refused rather than parked overdue', () => {
  assert.equal(iso('25/03/1935'), null);
  assert.equal(iso('1935-03-25'), null);
});

test('display keeps the convention the sheets are written in', () => {
  assert.equal(formatDate('2026-08-26'), '26/08/2026');
  assert.equal(formatDate('Next Shutdown'), 'Next Shutdown');
});

test('days until counts whole calendar days', () => {
  assert.equal(daysUntil('2026-08-26', '2026-08-20'), 6);
  assert.equal(daysUntil('2026-08-14', '2026-08-20'), -6);
});

/* ------------------------------------------------------------------ *
 * Vocabularies
 * ------------------------------------------------------------------ */

test("SAP's Normal work is the default grade, not a low-value job", () => {
  assert.equal(normalisePriority('Normal work'), 'Low');
  assert.equal(normalisePriority('Urgent'), 'Critical');
  assert.equal(normalisePriority('P1'), 'Critical');
});

test("the sheets' own status legends are read exactly", () => {
  assert.equal(normaliseStatus('Open'), 'In Progress');
  assert.equal(normaliseStatus('Close'), 'Completed');
  assert.equal(normaliseStatus('Pending'), 'Not Started');
  assert.equal(normaliseStatus('Approved'), 'In Progress');
  assert.equal(normaliseStatus('In progress'), 'In Progress');
});

test('a sentence is read before it is given up on', () => {
  assert.equal(normaliseStatus('waiting for the quotation'), 'In Progress');
  assert.equal(normaliseStatus('job completed'), 'Completed');
});

test('a sentence holding both words is read as still outstanding', () => {
  assert.equal(normaliseStatus('TO BE COMPLETED'), 'In Progress');
});

test('"Overdue" describes the date, not the work', () => {
  assert.equal(normaliseStatus('Overdue'), 'In Progress');
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function sheetWith(workbook, name, rows, { merges = [] } = {}) {
  const worksheet = workbook.addWorksheet(name);
  rows.forEach((row, i) => {
    row.forEach((value, c) => {
      if (value !== null && value !== undefined) worksheet.getRow(i + 1).getCell(c + 1).value = value;
    });
  });
  for (const range of merges) worksheet.mergeCells(range);
  return worksheet;
}

/** The IWS sheet as it really is: a banner, a header, then a dropdown legend. */
function iwsWorkbook() {
  const workbook = new ExcelJS.Workbook();
  sheetWith(workbook, 'IWS', [
    ['IWS STATUS'],
    ['Sr', 'Priorty', 'IWS No', 'IWS Details', 'Equipment', 'Issued Date', 'Expiry Date', 'ETC', 'IWO', 'PR no', 'Resources', 'Supplier', 'Remarks'],
    [null, null, null, null, null, null, null, null, 'Yes', null, 'manpower ', 'Contractor'],
    [null, null, null, null, null, null, null, null, 'NO', null, 'material', 'Inhouse'],
    [null, null, null, null, null, null, null, null, null, null, 'Machinery'],
    [1, 'P2', 'IWS-2026-001', 'Replace slope piping', '113-G-0022B', '01/08/26', '01/12/26', '15/09/26', 'Yes', 'PR-77', 'manpower', 'Contractor', ''],
    [2, 'Normal work', 'IWS-2026-002', 'Tank shell inspection', 'TK-201', '02/08/26', null, 'Next Shutdown', 'NO', null, 'material', 'Inhouse', ''],
  ], { merges: ['A1:M1'] });
  return workbook;
}

test('every sheet in the workbook resolves to its own register', async () => {
  const workbook = new ExcelJS.Workbook();
  // One sheet per register, headed exactly as the real workbook heads it.
  for (const register of REGISTERS) {
    const header = register.fields
      .filter((f) => !f.monthIndex)
      .map((f) => f.label);
    const months = register.fields.filter((f) => f.monthIndex).map((f) => new Date(Date.UTC(2026, f.monthIndex - 1, 26)));
    sheetWith(workbook, register.sheetName, [[register.banner || null], ['Sr', ...header, ...months]]);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const { sheets } = await readWorkbook(buffer);

  for (const register of REGISTERS) {
    const sheet = sheets.find((s) => s.name === register.sheetName);
    assert.ok(sheet, `no sheet read for ${register.sheetName}`);
    assert.equal(sheet.registerId, register.id, `${register.sheetName} resolved to ${sheet.registerId}`);
  }
});

test('the header is found under the banner, not assumed to be row 1', async () => {
  const buffer = await iwsWorkbook().xlsx.writeBuffer();
  const { sheets } = await readWorkbook(buffer);
  const iws = sheets.find((s) => s.name === 'IWS');
  assert.equal(iws.headerRow, 2);
  assert.equal(iws.registerId, 'iws');
});

test('the dropdown legend under the header does not become three jobs', async () => {
  const buffer = await iwsWorkbook().xlsx.writeBuffer();
  const { sheets } = await readWorkbook(buffer);
  const iws = sheets.find((s) => s.name === 'IWS');
  assert.equal(iws.rowCount, 2);
  assert.equal(iws.skipped, 3);
  assert.deepEqual(
    iws.rows.map((r) => r.iwsNo),
    ['IWS-2026-001', 'IWS-2026-002'],
  );
});

test('a phrase in the ETC column survives import as written', async () => {
  const buffer = await iwsWorkbook().xlsx.writeBuffer();
  const { sheets } = await readWorkbook(buffer);
  const rows = sheets.find((s) => s.name === 'IWS').rows;
  assert.equal(rows[0].etc, '2026-09-15');
  assert.equal(rows[1].etc, 'Next Shutdown');
});

test('the serial column is dropped, so a numbered empty row is not a record', async () => {
  const workbook = new ExcelJS.Workbook();
  sheetWith(workbook, 'Sankyu DCU MP', [
    ['ANNUAL VACATION PLAN'],
    [null, null, null, null, 'Year 2026'],
    ['Sr ', 'Emp No', 'Name', 'Position ', ...Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, i, 26)))],
    [1, 'SM E 2969', 'A PERSON', 'Rotating Supervisor', 'V', null, null, null, null, null, null, null, null, null, null, null],
    [2, null, null, null],
    [3, null, null, null],
  ], { merges: ['A1:P1'] });

  const buffer = await workbook.xlsx.writeBuffer();
  const { sheets } = await readWorkbook(buffer);
  const plan = sheets.find((s) => s.name === 'Sankyu DCU MP');
  assert.equal(plan.registerId, 'dcu-manpower');
  assert.equal(plan.rowCount, 1);
  assert.equal(plan.rows[0].m1, 'V');
});

test('month columns headed with dates map to the right month', async () => {
  const workbook = new ExcelJS.Workbook();
  sheetWith(workbook, 'Sankyu SS MP', [
    ['SANKYU SUPPORT SERVICE / FABRICATION WORKSHOP MANPOWER '],
    [null, null, null, null, 'Year 2026 '],
    ['Sr ', 'Emp No', 'Name', 'Position ', ...Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, i, 26)))],
    [1, 'E1', 'SOMEBODY', 'Welder', null, null, null, null, null, null, 'Leave', null, null, null, null, 'Leave'],
  ]);
  const buffer = await workbook.xlsx.writeBuffer();
  const { sheets } = await readWorkbook(buffer);
  const row = sheets.find((s) => s.name === 'Sankyu SS MP').rows[0];
  assert.equal(row.m7, 'Leave');
  assert.equal(row.m12, 'Leave');
  assert.equal(row.m1, undefined);
});

test('a header split over two rows is read from both', async () => {
  const workbook = new ExcelJS.Workbook();
  sheetWith(workbook, 'JTS', [
    ['JTS PROGRAM'],
    [null, null, null, null, 'Q1', 'Q2', 'Q3', 'Q4', 'Total Task', 'STATUS'],
    ['Sr ', 'Emp No', 'Name', 'Position ', 'Assigned Task', 'Assigned Task', 'Assigned Task', 'Assigned Task'],
    [1, 'SM E 2969', 'A PERSON', 'Foreman', 2, 3, null, 1],
  ], { merges: ['A1:I1', 'I2:I3', 'J2:J3'] });

  const buffer = await workbook.xlsx.writeBuffer();
  const { sheets } = await readWorkbook(buffer);
  const jts = sheets.find((s) => s.name === 'JTS');
  assert.equal(jts.registerId, 'jts');
  assert.equal(jts.headerSpan, 2);
  assert.equal(jts.rowCount, 1);
  assert.equal(jts.rows[0].q2, 3);
  // Recomputed, never trusted from the sheet.
  assert.equal(jts.rows[0].totalTask, 6);
});

test('a row that is only the shadow of a merged header is not a person', async () => {
  const workbook = new ExcelJS.Workbook();
  const headings = getRegister('safety').fields.filter((f) => f.key !== 'remarks').map((f) => f.label);
  const worksheet = sheetWith(workbook, 'Safety', [
    ['SAFETY TRAINING STATUS'],
    ['SR', ...headings],
    [],
    [1, 'SM E 1', 'A PERSON', 'Welder', 'P3', 'yes'],
  ]);
  // Every heading merged down over rows 2 and 3, as the real sheet has them.
  for (let c = 1; c <= headings.length + 1; c += 1) worksheet.mergeCells(2, c, 3, c);

  const buffer = await workbook.xlsx.writeBuffer();
  const { sheets } = await readWorkbook(buffer);
  const safety = sheets.find((s) => s.name === 'Safety');
  assert.equal(safety.registerId, 'safety');
  assert.equal(safety.rowCount, 1);
  assert.equal(safety.rows[0].name, 'A PERSON');
});

test('an unrecognised column is kept rather than dropped', async () => {
  const workbook = new ExcelJS.Workbook();
  sheetWith(workbook, 'GAF', [
    ['General Activities follow up'],
    ['Sr', 'Tag No', 'Job Descripton', 'Assigned to', 'Issued date', 'ETC', 'Status', 'Cost Centre'],
    [1, 'P-101', 'Change gasket', 'Peter', '01/08/26', '09/08/26', 'Open', 'CC-42'],
  ]);
  const buffer = await workbook.xlsx.writeBuffer();
  const { sheets } = await readWorkbook(buffer);
  const gaf = sheets.find((s) => s.name === 'GAF');
  assert.deepEqual(gaf.extraColumns, ['Cost Centre']);
  assert.equal(gaf.rows[0]['extra:Cost Centre'], 'CC-42');
});

test('the columns decide the register, and the sheet name only breaks a tie', async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = sheetWith(workbook, 'Sheet1', [
    ['MOC'],
    ['Sr', 'MOC NO', 'Tag No / Area', 'MOC Description ', 'Status', 'Initiator', 'Resources', 'Start Date', 'End Date', 'ETC', 'IFC no / Drawing No'],
  ]);
  assert.equal(suggestRegister(worksheet).register.id, 'moc');
});

test('a sheet that matches nothing is reported rather than guessed at', async () => {
  const workbook = new ExcelJS.Workbook();
  sheetWith(workbook, 'Notes', [['Some notes'], ['a', 'b']]);
  const buffer = await workbook.xlsx.writeBuffer();
  const { sheets } = await readWorkbook(buffer);
  assert.equal(sheets[0].registerId, null);
});

test('spelling drift in a heading still resolves', () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = sheetWith(workbook, 'Anything', [
    ['RESOURCES'],
    ['Sr', 'PR NO', 'Equipmnet ', 'Eq Serial No', 'Req Area', 'Supplier', 'Mobilization ', 'Activities', 'Demobilization '],
  ]);
  const header = detectHeader(worksheet, getRegister('rental-equipment'));
  assert.ok(header.matched >= 8);
});

/* ------------------------------------------------------------------ *
 * Derivation
 * ------------------------------------------------------------------ */

const derive = (id, data) => deriveRecord(getRegister(id), data, { toDateOnly });

test('a due date and a phrase are told apart', () => {
  const dated = derive('iws', { etc: '2026-09-15', iwsNo: 'A' });
  assert.equal(dated.dueDate, '2026-09-15');
  assert.equal(dated.dueText, null);

  const phrase = derive('iws', { etc: 'Next Shutdown', iwsNo: 'B' });
  assert.equal(phrase.dueDate, null);
  assert.equal(phrase.dueText, 'Next Shutdown');
});

test('a PM order with an execution date is done whatever SAP still says', () => {
  const record = derive('planner-pm', { order: '1', userStatus: 'APPR', executionDate: '2026-08-01' });
  assert.equal(record.status, 'Completed');
});

test('a closed row is never overdue', () => {
  const closed = derive('commercial', { prNo: 'PR1', prStatus: 'Close', prClosingDate: '2020-01-01' });
  assert.equal(dueState(closed.dueDate, closed.status, (d) => daysUntil(d, '2026-08-20')), 'closed');
});

test('an undated row is undated, not scheduled', () => {
  const record = derive('commercial', { prNo: 'PR2', prStatus: 'Open' });
  assert.equal(dueState(record.dueDate, record.status, (d) => daysUntil(d, '2026-08-20')), 'undated');
});

test('a people row reports how much of its own grid is filled', () => {
  const record = derive('safety', { name: 'A', loto: 'yes', h2s: '2026-01-01' });
  assert.equal(record.filledCells, 2);
  assert.equal(record.totalCells, 15);
});

test('progress reads the same whether the sheet wrote 80, 80% or 0.8', () => {
  assert.equal(derive('fab-ws', { jobDescription: 'x', progress: 80 }).progress, 80);
  assert.equal(derive('fab-ws', { jobDescription: 'x', progress: '80%' }).progress, 80);
  assert.equal(derive('fab-ws', { jobDescription: 'x', progress: 0.8 }).progress, 80);
});

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

test('the dashboard counts each register and lists what needs attention', () => {
  const records = [
    { id: '1', registerId: 'iws', data: { iwsNo: 'A', details: 'Late job', etc: '2026-08-01' } },
    { id: '2', registerId: 'iws', data: { iwsNo: 'B', details: 'Soon', etc: '2026-09-01' } },
    { id: '3', registerId: 'iws', data: { iwsNo: 'C', details: 'Done', etc: '2026-08-01', status: 'Completed' } },
    { id: '4', registerId: 'iws', data: { iwsNo: 'D', details: 'No date' } },
    { id: '5', registerId: 'safety', data: { name: 'Somebody', loto: 'yes' } },
  ];
  const summary = summarise(records, ['iws', 'safety'], '2026-08-20');

  assert.equal(summary.totals.total, 4, 'people sheets are not jobs');
  assert.equal(summary.totals.overdue, 1);
  assert.equal(summary.totals.dueSoon, 1);
  assert.equal(summary.totals.closed, 1);
  assert.equal(summary.totals.undated, 1);
  assert.equal(summary.attention.length, 2);
  assert.equal(summary.attention[0].ref, 'A', 'soonest first');
  assert.equal(summary.people.people, 1);
});

test('a register with nothing in it still appears on the dashboard', () => {
  const summary = summarise([], ['moc'], '2026-08-20');
  assert.equal(summary.registers.length, 1);
  assert.equal(summary.registers[0].total, 0);
});

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

test('an export re-imports cleanly, and dates come back as dates', async () => {
  const records = new Map([
    [
      'iws',
      [
        { id: '1', data: { iwsNo: 'IWS-2026-001', details: 'Replace slope piping', etc: '2026-09-15', iwo: 'Yes', status: 'In Progress' } },
        { id: '2', data: { iwsNo: 'IWS-2026-002', details: 'Tank shell', etc: 'Next Shutdown' } },
      ],
    ],
  ]);
  const buffer = await writeWorkbook({ recordsByRegister: records, summary: null, registerIds: ['iws'] });
  const { sheets } = await readWorkbook(buffer);
  const iws = sheets.find((s) => s.registerId === 'iws');

  assert.equal(iws.rowCount, 2);
  assert.equal(iws.rows[0].etc, '2026-09-15');
  // A phrase is not a date and is left exactly as written.
  assert.equal(iws.rows[1].etc, 'Next Shutdown');
  assert.equal(iws.rows[0].status, 'In Progress');
});

test('a column the sheet brought in survives the round trip', async () => {
  const records = new Map([['gaf', [{ id: '1', data: { tagNo: 'P-101', jobDescription: 'x', 'extra:Cost Centre': 'CC-42' } }]]]);
  const buffer = await writeWorkbook({ recordsByRegister: records, summary: null, registerIds: ['gaf'] });
  const { sheets } = await readWorkbook(buffer);
  assert.equal(sheets[0].rows[0]['extra:Cost Centre'], 'CC-42');
});

/* ------------------------------------------------------------------ *
 * Document numbers
 * ------------------------------------------------------------------ */

test('the serial restarts each month and counts the highest, not the rows', () => {
  const august = new Date(2026, 7, 20);
  assert.equal(nextNumber([], { prefix: 'IWS' }, august), 'IWS-2608-01');
  assert.equal(nextNumber(['IWS-2608-01', 'IWS-2608-02'], { prefix: 'IWS' }, august), 'IWS-2608-03');
  // The second was deleted; the number must not be issued twice.
  assert.equal(nextNumber(['IWS-2608-01', 'IWS-2608-05'], { prefix: 'IWS' }, august), 'IWS-2608-06');
  assert.equal(nextNumber(['IWS-2607-09'], { prefix: 'IWS' }, august), 'IWS-2608-01');
});

test('past 99 the number gets longer rather than wrapping', () => {
  assert.equal(nextNumber(['IWS-2608-99'], { prefix: 'IWS' }, new Date(2026, 7, 20)), 'IWS-2608-100');
});

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

test('a password is verified against its own hash and nothing else', async () => {
  const stored = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', stored), true);
  assert.equal(await verifyPassword('wrong', stored), false);
  assert.equal(await verifyPassword('correct horse battery', 'plaintext'), false);
});

test('a session token cannot be replayed as a password confirmation', () => {
  const token = signToken('secret', { sub: 'u1' }, 'session');
  assert.ok(verifyToken('secret', token, 'session'));
  assert.equal(verifyToken('secret', token, 'confirm'), null);
});

test('a token signed by another secret is refused', () => {
  const token = signToken('secret', { sub: 'u1' });
  assert.equal(verifyToken('other', token), null);
});

test('an expired token is refused', () => {
  const token = signToken('secret', { sub: 'u1' }, 'session', -1000);
  assert.equal(verifyToken('secret', token), null);
});

test('an empty register list means every register, not none', () => {
  assert.equal(mayUseRegister({ registers: [] }, 'moc'), true);
  assert.equal(mayUseRegister({ registers: ['iws'] }, 'moc'), false);
  assert.equal(mayUseRegister({ registers: ['iws'] }, 'iws'), true);
});

test('the last administrator cannot be demoted', () => {
  const users = [{ id: 'a', role: 'admin' }, { id: 'b', role: 'editor' }];
  assert.equal(isLastAdmin(users, 'a'), true);
  assert.equal(isLastAdmin([...users, { id: 'c', role: 'admin' }], 'a'), false);
});

test('a hired trade the sheet marks RELEASED is closed, not permanently overdue', () => {
  const released = derive('rental-manpower', { name: 'A', demobilize: '2025-10-27', remarks: 'RELEASED' });
  assert.equal(released.status, 'Completed');
  assert.equal(dueState(released.dueDate, released.status, (d) => daysUntil(d, '2026-08-20')), 'closed');

  const stillHere = derive('rental-manpower', { name: 'B', demobilize: '2025-10-27' });
  assert.equal(stillHere.status, 'Not Started');
  assert.equal(dueState(stillHere.dueDate, stillHere.status, (d) => daysUntil(d, '2026-08-20')), 'overdue');
});

test('the app’s own status column outranks the sheet’s remark', () => {
  const record = derive('rental-manpower', { name: 'A', status: 'In Progress', remarks: 'RELEASED' });
  assert.equal(record.status, 'In Progress');
});

test('a register whose name holds a slash still exports', async () => {
  const buffer = await writeWorkbook({
    recordsByRegister: new Map([['ss-manpower', [{ id: '1', data: { name: 'A PERSON', m3: 'V' } }]]]),
    summary: null,
    registerIds: ['ss-manpower'],
  });
  const { sheets } = await readWorkbook(buffer);
  // Named after the sheet it came from, which is the tab the team recognises.
  assert.equal(sheets[0].name, 'Sankyu SS MP');
  assert.equal(sheets[0].rows[0].m3, 'V');
});

test('every exported column carries a width, including the narrow ones', async () => {
  const buffer = await writeWorkbook({
    recordsByRegister: new Map([['iws', [{ id: '1', data: { iwsNo: 'A', details: 'x', priority: 'High' } }]]]),
    summary: null,
    registerIds: ['iws'],
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.getWorksheet('IWS');
  const missing = [];
  worksheet.getRow(2).eachCell((cell, col) => {
    if (worksheet.getColumn(col).width === undefined) missing.push(String(cell.value));
  });
  assert.deepEqual(missing, []);
});

test('deleting an older entry does not shift the next number', () => {
  const august = new Date(2026, 7, 20);
  // 03 was deleted. The next is still 06, not 05: the numbers below the highest
  // have already gone out and must not be handed to a second document.
  assert.equal(nextNumber(['IWS-2608-01', 'IWS-2608-02', 'IWS-2608-05'], { prefix: 'IWS' }, august), 'IWS-2608-06');
});

test('deleting the most recent entry does release its number', () => {
  const august = new Date(2026, 7, 20);
  // The limit of reading the highest from the records that still exist, pinned
  // here so it is a known behaviour rather than a surprise: closing it needs a
  // stored high-water mark per month, which the app does not keep.
  assert.equal(nextNumber(['IWS-2608-01', 'IWS-2608-02'], { prefix: 'IWS' }, august), 'IWS-2608-03');
  assert.equal(nextNumber(['IWS-2608-01'], { prefix: 'IWS' }, august), 'IWS-2608-02');
});

/* ------------------------------------------------------------------ *
 * Connection strings
 * ------------------------------------------------------------------ */

test('DATABASE_SSL wins over an sslmode carried in the connection string', () => {
  // Neon hands out exactly this shape, and it is the string people paste.
  const neon = 'postgres://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

  const relaxed = connectionSettings(neon, 'no-verify');
  assert.deepEqual(relaxed.ssl, { rejectUnauthorized: false });
  // Left in place, `pg` reads `require` as verify-full and the explicit ssl
  // option is ignored — the connection then fails on certificate verification.
  assert.ok(!relaxed.connectionString.includes('sslmode'));
  assert.ok(!relaxed.connectionString.includes('channel_binding'));
  // Everything that identifies the database survives.
  assert.ok(relaxed.connectionString.startsWith('postgres://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb'));

  const off = connectionSettings(neon, 'disable');
  assert.equal(off.ssl, false);
  assert.ok(!off.connectionString.includes('sslmode'));
});

test('an unset DATABASE_SSL leaves the connection string exactly as pasted', () => {
  const neon = 'postgres://u:p@host/db?sslmode=verify-full';
  const settings = connectionSettings(neon, undefined);
  assert.equal(settings.connectionString, neon);
  assert.equal('ssl' in settings, false, 'nothing is imposed on a string that already says what it wants');
});

test('a connection string that is not a URL is passed through untouched', () => {
  const libpq = 'host=localhost port=5432 dbname=planning';
  assert.equal(connectionSettings(libpq, 'no-verify').connectionString, libpq);
});

/* ------------------------------------------------------------------ *
 * Dashboard aggregations
 * ------------------------------------------------------------------ */

test('the due chart separates already-late from the weeks ahead', () => {
  const records = [
    { id: '1', registerId: 'iws', data: { iwsNo: 'A', details: 'Late', etc: '2026-08-01' } },
    { id: '2', registerId: 'iws', data: { iwsNo: 'B', details: 'This week', etc: '2026-08-24' } },
    { id: '3', registerId: 'iws', data: { iwsNo: 'C', details: 'Next week', etc: '2026-08-31' } },
    { id: '4', registerId: 'iws', data: { iwsNo: 'D', details: 'Far off', etc: '2027-06-01' } },
    { id: '5', registerId: 'iws', data: { iwsNo: 'E', details: 'A phrase', etc: 'Next Shutdown' } },
    { id: '6', registerId: 'iws', data: { iwsNo: 'F', details: 'Done', etc: '2026-08-01', status: 'Completed' } },
  ];
  const { dueBuckets } = summarise(records, ['iws'], '2026-08-22').charts;

  assert.equal(dueBuckets.overdue, 1, 'the completed one is not counted as late');
  assert.equal(dueBuckets.weeks[0].count, 1);
  assert.equal(dueBuckets.weeks[1].count, 1);
  assert.equal(dueBuckets.later, 1, 'past the horizon, not dropped');
  assert.equal(dueBuckets.undated, 1, 'a phrase is undated, not overdue');
});

test('open work is counted by priority, closed work is not', () => {
  const records = [
    { id: '1', registerId: 'iws', data: { iwsNo: 'A', details: 'x', priority: 'Critical', etc: '2026-08-01' } },
    { id: '2', registerId: 'iws', data: { iwsNo: 'B', details: 'x', priority: 'Critical', etc: '2026-09-30' } },
    { id: '3', registerId: 'iws', data: { iwsNo: 'C', details: 'x', priority: 'Critical', status: 'Completed' } },
  ];
  const rows = summarise(records, ['iws'], '2026-08-22').charts.byPriority;
  const critical = rows.find((r) => r.priority === 'Critical');
  assert.equal(critical.total, 2);
  assert.equal(critical.overdue, 1);
});

test('the owner chart falls back to whichever column names who has it', () => {
  const records = [
    // Action By.
    { id: '1', registerId: 'gaf', data: { tagNo: 'T', jobDescription: 'x', assignedTo: 'Peter', etc: '2026-08-01' } },
    // No owner column at all — the supplier is who it is waiting on.
    { id: '2', registerId: 'rental-equipment', data: { equipment: 'Manlift', supplier: 'Ejar', demobilization: '2026-08-01' } },
    // Closed work is nobody's load.
    { id: '3', registerId: 'gaf', data: { tagNo: 'T2', jobDescription: 'y', assignedTo: 'Peter', status: 'Completed' } },
  ];
  const owners = summarise(records, ['gaf', 'rental-equipment'], '2026-08-22').charts.byOwner;
  assert.deepEqual(
    owners.map((o) => [o.owner, o.total, o.overdue]),
    [
      ['Peter', 1, 1],
      ['Ejar', 1, 1],
    ],
  );
});

test('people sheets never reach the job charts', () => {
  const records = [
    { id: '1', registerId: 'safety', data: { name: 'Somebody', loto: 'Yes' } },
    { id: '2', registerId: 'iws', data: { iwsNo: 'A', details: 'x', etc: '2026-08-01' } },
  ];
  const { charts, totals } = summarise(records, ['iws', 'safety'], '2026-08-22');
  assert.equal(totals.total, 1);
  assert.equal(charts.dueBuckets.overdue, 1);
  assert.equal(charts.byOwner.length, 0);
});

/* ------------------------------------------------------------------ *
 * The browser app is served with a version on it
 * ------------------------------------------------------------------ */

test('the asset stamp follows the content, so a deploy cannot be cached away', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const nodePath = await import('node:path');

  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'assets-'));
  const write = (name, body) => fs.writeFile(nodePath.join(dir, name), body);
  await write('app.js', 'console.log(1)');
  await write('styles.css', 'body{}');

  const first = await stampAssets(dir);
  assert.match(first, /^[a-f0-9]{10}$/);

  // Same content, same stamp — a redeploy that changes nothing must not force
  // everybody to download the app again.
  assert.equal(await stampAssets(dir), first);

  // A change to either file changes it, which is what makes the URL change.
  await write('app.js', 'console.log(2)');
  assert.notEqual(await stampAssets(dir), first);

  const cssOnly = await stampAssets(dir);
  await write('styles.css', 'body{color:red}');
  assert.notEqual(await stampAssets(dir), cssOnly, 'a stylesheet-only change still busts the cache');

  await fs.rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Equipment history — the wide layout
 * ------------------------------------------------------------------ */

/** The team's shape: a Date, a column per unit, then columns shared by the row. */
function historyWorkbook() {
  const workbook = new ExcelJS.Workbook();
  sheetWith(workbook, 'Rotary Joint', [
    ['ROTARY JOINTS HISTORY'],
    ['Date', 'RJ DRUM1', 'RJ DRUM2', 'RJ DRUM3', 'ACTIVITY DURATION', 'REMARKS', 'RESOURCES', null, 'Rotary Joint spare'],
    ['23/7/26', null, null, 'Bearing stuck, not rotating', '12 to 16 hours', 'Replaced with overhauled one', 'Hydratight crew'],
    // One shutdown touching two drums at once.
    ['24/7/26', 'Seal renewed', 'Seal renewed', null, '4 hours', 'Routine', 'Two technicians'],
    // The spare-parts list parked off to the right of the table: not an event.
    [null, null, null, null, null, null, null, null, '11027683', 'O RNG;VITON'],
  ], { merges: ['A1:G1'] });
  return workbook;
}

test('a wide history sheet becomes one record per unit that was touched', async () => {
  const buffer = await historyWorkbook().xlsx.writeBuffer();
  const { sheets } = await readWorkbook(buffer);
  const history = sheets.find((s) => s.registerId === 'equipment-history');

  assert.ok(history, 'the sheet was not recognised as equipment history');
  assert.equal(history.rowCount, 3, 'two drums on one row are two records');

  assert.deepEqual(history.rows[0], {
    equipment: 'Rotary Joint',
    unit: 'RJ DRUM3',
    event: 'Bearing stuck, not rotating',
    date: '2026-07-23',
    duration: '12 to 16 hours',
    remarks: 'Replaced with overhauled one',
    resources: 'Hydratight crew',
  });

  // The columns shared by the row are copied onto every record it produces.
  assert.deepEqual(
    history.rows.slice(1).map((r) => [r.unit, r.event, r.duration]),
    [
      ['RJ DRUM1', 'Seal renewed', '4 hours'],
      ['RJ DRUM2', 'Seal renewed', '4 hours'],
    ],
  );
});

test('a row naming no unit is counted, not silently dropped', async () => {
  const buffer = await historyWorkbook().xlsx.writeBuffer();
  const { sheets } = await readWorkbook(buffer);
  const history = sheets.find((s) => s.registerId === 'equipment-history');
  // The spare-parts row. It is not history, but the import must say so rather
  // than quietly losing it.
  assert.equal(history.skipped, 1);
});

test('a two-row header names the columns under a merged heading', async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = sheetWith(workbook, 'Buckets & Wires', [
    ['BUCKET WIRE ROPE 38 MM DIA'],
    ['Date', 'BUCKET 23', null, 'BUCKET 24', null],
    [null, 'Open /close', 'Equalizer', 'Open /close', 'Equalizer'],
    ['01/08/26', 'Rope replaced', null, null, 'Sheave changed'],
  ]);
  worksheet.mergeCells('B2:C2');
  worksheet.mergeCells('D2:E2');
  worksheet.mergeCells('A2:A3');

  const buffer = await workbook.xlsx.writeBuffer();
  const { sheets } = await readWorkbook(buffer);
  const history = sheets.find((s) => s.registerId === 'equipment-history');

  // Without reading both rows the sub-header imports as four events called
  // "Open /close" and "Equalizer", and the two columns under one bucket are
  // indistinguishable because the merge reports the same name for both.
  assert.equal(history.rowCount, 2);
  assert.deepEqual(
    history.rows.map((r) => [r.unit, r.event]),
    [
      ['BUCKET 23 · Open /close', 'Rope replaced'],
      ['BUCKET 24 · Equalizer', 'Sheave changed'],
    ],
  );
});

test('history never reaches the overdue counts', () => {
  const records = [
    { id: '1', registerId: 'equipment-history', data: { equipment: 'Rotary Joint', unit: 'RJ DRUM4', event: 'Bearing stuck', date: '2020-01-01' } },
    { id: '2', registerId: 'iws', data: { iwsNo: 'A', details: 'Late', etc: '2026-08-01' } },
  ];
  const summary = summarise(records, ['iws', 'equipment-history'], '2026-08-22');

  assert.equal(summary.totals.total, 1, 'a completed job from 2020 is not a job');
  assert.equal(summary.totals.overdue, 1);
  assert.equal(summary.totals.undated, 0, 'nor is it undated work');
  assert.equal(summary.charts.byOwner.length, 0);

  const log = summary.registers.find((r) => r.id === 'equipment-history');
  assert.equal(log.kind, 'log');
  assert.equal(log.total, 1, 'but it is still counted on its own line');
});

test('an exported history sheet reads back in its flat shape', async () => {
  const records = new Map([
    ['equipment-history', [
      { id: '1', data: { equipment: 'PZVs', unit: '1640 A', event: 'Removed', date: '2026-07-26', remarks: 'Calibration' } },
    ]],
  ]);
  const buffer = await writeWorkbook({ recordsByRegister: records, summary: null, registerIds: ['equipment-history'] });
  const { sheets } = await readWorkbook(buffer);

  assert.equal(sheets[0].registerId, 'equipment-history');
  assert.equal(sheets[0].rowCount, 1);
  assert.deepEqual(sheets[0].rows[0], {
    equipment: 'PZVs',
    unit: '1640 A',
    event: 'Removed',
    date: '2026-07-26',
    remarks: 'Calibration',
  });
});
