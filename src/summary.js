/**
 * What the dashboard, the export's Summary sheet and the register pages all read.
 *
 * One function, so the figure somebody quotes in a meeting and the figure on the
 * screen behind them cannot disagree.
 */

import { daysUntil, toDateOnly, todayIso } from './dates.js';
import {
  CLOSED_STATUSES,
  DUE_SOON_DAYS,
  PRIORITY_RANK,
  deriveRecord,
  dueState,
  getRegister,
} from './registers.js';

/** A stored record plus everything derivable from it today. */
export function decorate(record, today = todayIso()) {
  const register = getRegister(record.registerId);
  if (!register) return null;
  // `deriveRecord` is handed its date parser, so the register definitions hold no
  // opinion about how a cell becomes a calendar day.
  const derived = deriveRecord(register, record.data, { toDateOnly });
  const days = derived.dueDate ? daysUntil(derived.dueDate, today) : null;
  return {
    ...record,
    derived,
    state: dueState(derived.dueDate, derived.status, (d) => daysUntil(d, today)),
    daysToDue: days,
    kind: register.kind,
  };
}

const emptyCounts = () => ({
  total: 0,
  open: 0,
  closed: 0,
  overdue: 0,
  dueSoon: 0,
  scheduled: 0,
  undated: 0,
});

function count(counts, item) {
  counts.total += 1;
  if (CLOSED_STATUSES.has(item.derived.status)) counts.closed += 1;
  else counts.open += 1;
  if (item.state === 'overdue') counts.overdue += 1;
  else if (item.state === 'due-soon') counts.dueSoon += 1;
  else if (item.state === 'scheduled') counts.scheduled += 1;
  else if (item.state === 'undated') counts.undated += 1;
}

/**
 * Roll everything the reader may open into headline figures, a line per
 * register, and the list of what actually needs somebody this month.
 */
export function summarise(records, registerIds, today = todayIso()) {
  const allowed = new Set(registerIds);
  const items = records
    .filter((r) => allowed.has(r.registerId))
    .map((r) => decorate(r, today))
    .filter(Boolean);

  const totals = emptyCounts();
  const perRegister = new Map();
  const attention = [];

  for (const item of items) {
    const register = getRegister(item.registerId);
    if (!perRegister.has(item.registerId)) {
      perRegister.set(item.registerId, {
        id: register.id,
        name: register.name,
        short: register.short,
        kind: register.kind,
        group: register.group,
        ...emptyCounts(),
        // People sheets are matrices: the question they answer is how much of
        // the grid is filled, not when something is due.
        cellsFilled: 0,
        cellsTotal: 0,
      });
    }
    const entry = perRegister.get(item.registerId);

    if (register.kind === 'people') {
      entry.total += 1;
      entry.cellsFilled += item.derived.filledCells ?? 0;
      entry.cellsTotal += item.derived.totalCells ?? 0;
      continue;
    }

    count(entry, item);
    count(totals, item);

    if (item.state === 'overdue' || item.state === 'due-soon') {
      attention.push({
        id: item.id,
        registerId: item.registerId,
        registerName: register.name,
        registerShort: register.short,
        ref: item.derived.ref,
        title: item.derived.title,
        dueDate: item.derived.dueDate,
        daysToDue: item.daysToDue,
        state: item.state,
        priority: item.derived.priority,
        actionBy: item.derived.actionBy ?? item.derived.supplier ?? item.derived.initiator,
      });
    }
  }

  // Soonest first, then by how urgent the row itself says it is — two rows due
  // the same day are not equally pressing.
  attention.sort(
    (a, b) =>
      (a.daysToDue ?? 0) - (b.daysToDue ?? 0) ||
      (PRIORITY_RANK.get(a.priority) ?? 9) - (PRIORITY_RANK.get(b.priority) ?? 9),
  );

  const registers = [...perRegister.values()].map((entry) => ({
    ...entry,
    coverage: entry.cellsTotal ? Math.round((entry.cellsFilled / entry.cellsTotal) * 100) : null,
  }));

  // A register the reader may open but has never imported still belongs on the
  // dashboard: "nothing here yet" is an answer, and an absent ring reads as a
  // register that does not exist.
  for (const id of registerIds) {
    if (perRegister.has(id)) continue;
    const register = getRegister(id);
    if (!register) continue;
    registers.push({
      id: register.id,
      name: register.name,
      short: register.short,
      kind: register.kind,
      group: register.group,
      ...emptyCounts(),
      cellsFilled: 0,
      cellsTotal: 0,
      coverage: register.kind === 'people' ? 0 : null,
    });
  }

  registers.sort((a, b) => registerIds.indexOf(a.id) - registerIds.indexOf(b.id));

  return {
    today,
    dueSoonDays: DUE_SOON_DAYS,
    totals,
    people: peopleTotals(registers),
    registers,
    attention,
  };
}

function peopleTotals(registers) {
  const sheets = registers.filter((r) => r.kind === 'people');
  const cellsFilled = sheets.reduce((n, r) => n + r.cellsFilled, 0);
  const cellsTotal = sheets.reduce((n, r) => n + r.cellsTotal, 0);
  return {
    sheets: sheets.length,
    people: sheets.reduce((n, r) => n + r.total, 0),
    cellsFilled,
    cellsTotal,
    coverage: cellsTotal ? Math.round((cellsFilled / cellsTotal) * 100) : null,
  };
}

/**
 * Per-column coverage for one people sheet: which course the fewest people hold,
 * which month the fewest have planned.
 *
 * A single "62% covered" figure hides the one course only three people have,
 * which is the only thing anybody can act on.
 */
export function matrixCoverage(register, records) {
  if (!register.matrix) return null;
  const people = records.filter((r) => r.registerId === register.id);
  return {
    people: people.length,
    columns: register.matrix.cells.map((key) => {
      const field = register.fields.find((f) => f.key === key);
      const held = people.filter((r) => String(r.data?.[key] ?? '').trim() !== '').length;
      return {
        key,
        label: field?.label ?? key,
        held,
        missing: people.length - held,
        percent: people.length ? Math.round((held / people.length) * 100) : 0,
      };
    }),
  };
}
