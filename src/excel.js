/**
 * Reading the team's workbook, and writing one that reads back in.
 *
 * The file this app was built around is a live working spreadsheet, not an
 * export, and the reader is shaped by what is actually in it:
 *
 *  * **The header is not row 1.** Thirteen of the fifteen sheets open with a
 *    merged banner (`IWS STATUS`, `RESOURCES`), two of them with a second banner
 *    under it (`RENTAL EQUIPMENT 2025`, `Year 2026`), and one — the SAP export —
 *    opens with a blank row. The header is found by matching column names, never
 *    by counting rows.
 *  * **Two sheets split their header across two rows.** `Q1`–`Q4` sit above four
 *    columns all labelled `Assigned Task`. Both rows are read and the more
 *    specific label wins.
 *  * **The month columns are dates, not words.** The annual plans head their
 *    twelve columns with real dates, so those columns are matched on which month
 *    the date falls in.
 *  * **Spelling drifts and is expected.** `Equipmnet`, `Job Initaitor `,
 *    `Serice Provider`, `Priorty`, `Assinged Jobs` — matching ignores case,
 *    spacing and punctuation, and every field carries the spellings the real
 *    workbook uses.
 *  * **The legend under the header is not data.** IWS lists `Yes`/`NO` and
 *    `manpower`/`material`/`Machinery` in the three rows beneath its header;
 *    Commercial lists `Open`/`Close`; MOC lists `Pending`/`Approved`/`In
 *    progress`. Those are the sheet's own dropdown, and importing them would
 *    create six jobs that describe nothing.
 *  * **An unrecognised column is kept**, not dropped. Losing a column on import
 *    is worse than carrying one the app has no opinion about.
 */

import ExcelJS from 'exceljs';

import { REGISTERS, exportTitle, fieldMap, getRegister, normaliseKey } from './registers.js';
import { formatDate, toDateOnly, toExcelDate } from './dates.js';

/** How many leading rows to consider when hunting for the header. */
const HEADER_SEARCH_ROWS = 12;

/** Below this many recognised columns, a row is not a header. */
const MIN_HEADER_MATCHES = 3;

/**
 * Row-number columns, dropped rather than stored.
 *
 * Every sheet opens with one and spells it differently — `Sr`, `sr`, `SR`,
 * `Sr `, `SL NO`. It is a position, not data: it is wrong the moment anybody
 * sorts or inserts. Ignoring it also fixes row detection, because the manpower
 * sheets carry pre-numbered empty rows (`16`–`20` with nothing beside them)
 * waiting for people who have not joined yet.
 */
const SERIAL_HEADERS = new Set(['slno', 'sl', 'sno', 'srno', 'sr', 'ser', 'serial', 's', 'no', 'item']);

/**
 * Columns the app adds on export and ignores on the way in.
 *
 * Download the master file, edit it offline, upload it back is a normal round
 * trip here. Without this, each pass would bolt another copy of the app's own
 * computed columns onto every row.
 */
const COMPUTED_HEADERS = new Set(['daystodue', 'duestate', 'duein', 'lastupdated', 'updatedby']);

/** Every spelling that resolves to a field, for one register. */
function aliasIndex(register) {
  const index = new Map();
  for (const field of register.fields) {
    for (const spelling of [field.key, field.label, ...(field.aliases ?? [])]) {
      const key = normaliseKey(spelling);
      if (key && !index.has(key)) index.set(key, field.key);
    }
  }
  return index;
}

const ALIAS_INDEXES = new Map(REGISTERS.map((r) => [r.id, aliasIndex(r)]));
const MONTH_FIELDS = new Map(
  REGISTERS.map((r) => [r.id, new Map(r.fields.filter((f) => f.monthIndex).map((f) => [f.monthIndex, f.key]))]),
);

/**
 * Flatten an ExcelJS cell to something plain.
 *
 * Cells arrive as rich-text runs, formula wrappers and hyperlink objects as well
 * as primitives; `String(value)` on any of those yields `[object Object]`.
 */
export function cellValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text ?? '').join('');
    if ('result' in value) return cellValue(value.result);
    if ('text' in value) return String(value.text ?? '');
    if ('hyperlink' in value) return String(value.hyperlink ?? '');
    if ('error' in value) return '';
    return '';
  }
  return value;
}

function cellLabel(value) {
  const flat = cellValue(value);
  if (flat instanceof Date) return '';
  return String(flat ?? '').trim();
}

function cellString(value) {
  const flat = cellValue(value);
  if (flat instanceof Date) return flat;
  return typeof flat === 'string' ? flat.trim() : flat;
}

/* ------------------------------------------------------------------ *
 * Header detection
 * ------------------------------------------------------------------ */

/** Column number → label, for one row. */
function rowLabels(worksheet, rowNumber) {
  const row = worksheet.getRow(rowNumber);
  const labels = new Map();
  const dates = new Map();
  if (!row || !row.cellCount) return { labels, dates };
  row.eachCell({ includeEmpty: false }, (cell, col) => {
    const flat = cellValue(cell.value);
    if (flat instanceof Date) {
      dates.set(col, flat);
      return;
    }
    const label = String(flat ?? '').trim();
    if (label) labels.set(col, label);
  });
  return { labels, dates };
}

function mapColumns(register, labels, dates) {
  const index = ALIAS_INDEXES.get(register.id);
  const months = MONTH_FIELDS.get(register.id);
  const columnMap = new Map();
  const unmapped = [];
  const claimed = new Set();

  for (const [col, label] of labels) {
    const key = normaliseKey(label);
    if (!key || SERIAL_HEADERS.has(key) || COMPUTED_HEADERS.has(key)) continue;
    const field = index.get(key);
    // A repeated header maps once; a second occurrence is kept as an extra
    // column rather than silently overwriting the first.
    if (field && !claimed.has(field)) {
      claimed.add(field);
      columnMap.set(col, { field, label });
    } else {
      unmapped.push({ col, label });
    }
  }

  // The annual plans head their month columns with real dates. Match on which
  // month the date falls in — the year drifts every January, the month does not.
  for (const [col, value] of dates) {
    if (columnMap.has(col)) continue;
    const field = months.get(value.getUTCMonth() + 1);
    if (field && !claimed.has(field)) {
      claimed.add(field);
      columnMap.set(col, { field, label: formatDate(toDateOnly(value)) });
    }
  }

  return { columnMap, unmapped, matched: columnMap.size };
}

/**
 * Find the header row for `register` in `worksheet`, and which column holds
 * which field. Null when the sheet does not look like this register at all.
 */
export function detectHeader(worksheet, register) {
  const limit = Math.min(worksheet.rowCount || HEADER_SEARCH_ROWS, HEADER_SEARCH_ROWS);
  let best = null;

  for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
    const own = rowLabels(worksheet, rowNumber);
    const candidates = [{ rowNumber, span: 1, ...own }];

    // A header split over two rows: `Q1` above, `Assigned Task` below. Take the
    // upper label where there is one, because it is the one that distinguishes
    // the four columns from each other.
    if (rowNumber < limit) {
      const below = rowLabels(worksheet, rowNumber + 1);
      const labels = new Map(below.labels);
      for (const [col, label] of own.labels) labels.set(col, label);
      const dates = new Map(below.dates);
      for (const [col, value] of own.dates) dates.set(col, value);
      candidates.push({ rowNumber, span: 2, labels, dates });
    }

    for (const candidate of candidates) {
      const mapped = mapColumns(register, candidate.labels, candidate.dates);
      if (mapped.matched < MIN_HEADER_MATCHES) continue;
      // Prefer more columns; on a tie prefer the single row, because a two-row
      // read that scores no better has only borrowed the first row of data.
      const better =
        !best ||
        mapped.matched > best.matched ||
        (mapped.matched === best.matched && candidate.span < best.span);
      if (better) best = { rowNumber: candidate.rowNumber, span: candidate.span, ...mapped };
    }
  }

  return best;
}

/** Rank every register against a sheet and return the closest fit. */
export function suggestRegister(worksheet) {
  const sheetKey = normaliseKey(worksheet.name);
  let best = null;

  for (const register of REGISTERS) {
    const header = detectHeader(worksheet, register);
    if (!header) continue;

    // Sheet-name agreement breaks a tie and never contributes to the score. The
    // two annual plans have identical columns and different names, so the name
    // is what separates them — but a sheet renamed by whoever last saved it must
    // not outrank a register whose columns genuinely fit better.
    const nameMatch =
      normaliseKey(register.sheetName) === sheetKey ||
      register.sheetAliases.some((alias) => normaliseKey(alias) === sheetKey);

    const better =
      !best ||
      header.matched > best.header.matched ||
      (header.matched === best.header.matched && nameMatch && !best.nameMatch);

    if (better) best = { register, header, score: header.matched, nameMatch };
  }

  return best;
}

/* ------------------------------------------------------------------ *
 * Reading rows
 * ------------------------------------------------------------------ */

/**
 * A row is a record when it names something.
 *
 * Not "some cell is filled": the three rows under the IWS header fill IWO,
 * Resources and Supplier and describe no job at all — they are the sheet's
 * dropdown legend. A row has to carry one of the register's identifying columns
 * before it counts, which is also what keeps the pre-numbered empty rows on the
 * manpower sheets from importing as twelve nameless people.
 */
function isRecord(register, data) {
  return register.identityFields.some((key) => String(data[key] ?? '').trim() !== '');
}

/** Read every data row of one sheet as one register. */
export function readSheet(worksheet, register, header = detectHeader(worksheet, register)) {
  if (!header) {
    return { rows: [], skipped: 0, legend: [], extraColumns: [], header: null };
  }

  const fields = fieldMap(register);
  const firstDataRow = header.rowNumber + header.span;
  const rows = [];
  const legend = new Set();
  let skipped = 0;

  for (let rowNumber = firstDataRow; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    if (!row || !row.cellCount) continue;
    if (isMergeShadow(worksheet, rowNumber, header)) continue;

    const data = {};
    let anyValue = false;

    for (const [col, { field }] of header.columnMap) {
      const value = readCell(row.getCell(col), fields.get(field));
      if (value === '' || value === null || value === undefined) continue;
      data[field] = value;
      anyValue = true;
    }

    for (const { col, label } of header.unmapped) {
      const value = cellString(row.getCell(col).value);
      const text = value instanceof Date ? toDateOnly(value) : String(value ?? '').trim();
      if (!text) continue;
      // Kept under the sheet's own heading, and editable in the app.
      data[`extra:${label}`] = text;
      anyValue = true;
    }

    if (!anyValue) continue;

    if (!isRecord(register, data)) {
      skipped += 1;
      // Whatever the legend rows offered is worth reporting: it is how the team
      // documents the values a column is supposed to take.
      for (const value of Object.values(data)) {
        const text = String(value).trim();
        if (text && text.length <= 40) legend.add(text);
      }
      continue;
    }

    if (register.computeRow) Object.assign(data, register.computeRow(data));
    rows.push({ data, sourceRow: rowNumber });
  }

  return {
    rows,
    skipped,
    legend: [...legend],
    extraColumns: header.unmapped.map((u) => u.label),
    header,
  };
}

/**
 * The row underneath a vertically merged header is not a row.
 *
 * The Safety sheet merges each of its twenty headings down over rows 2 and 3,
 * and a merged cell reports the master's value from every one of its cells — so
 * row 3 reads back as a complete copy of the header and imported as a person
 * called `NAME` holding a course called `H2S Awarness`. A row whose every filled
 * cell belongs to a merge that began above it carries nothing of its own.
 */
function isMergeShadow(worksheet, rowNumber, header) {
  let filled = 0;
  for (const [col] of header.columnMap) {
    const cell = worksheet.getCell(rowNumber, col);
    const value = cellString(cell.value);
    if (value === '' || value === null || value === undefined) continue;
    filled += 1;
    if (!cell.isMerged || (cell.master?.row ?? rowNumber) >= rowNumber) return false;
  }
  return filled > 0;
}

function readCell(cell, field) {
  const value = cellString(cell?.value);
  if (value === null || value === undefined || value === '') return '';

  if (field?.type === 'date') {
    // A phrase in a date column — `Next Shutdown`, `SEP` — is a deliberate
    // entry. Keep it as written; the job simply has no calendar date behind it.
    const iso = toDateOnly(value);
    return iso ?? String(value).trim();
  }

  if (value instanceof Date) return toDateOnly(value) ?? '';

  if (field?.type === 'number') {
    const n = Number(String(value).replace('%', '').trim());
    return Number.isFinite(n) ? n : String(value).trim();
  }

  // Everything else is text, including the Iqama numbers — a fourteen-digit
  // number Excel has rendered as 2.5773E+09 is not an Iqama number any more.
  return typeof value === 'number' ? String(value) : String(value).trim();
}

/** Open an uploaded workbook and describe every sheet in it. */
export async function readWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheets = [];
  for (const worksheet of workbook.worksheets) {
    const suggestion = suggestRegister(worksheet);
    if (!suggestion) {
      sheets.push({ name: worksheet.name, registerId: null, rowCount: 0, skipped: 0, reason: 'No column names matched any register.' });
      continue;
    }
    const read = readSheet(worksheet, suggestion.register, suggestion.header);
    sheets.push({
      name: worksheet.name,
      registerId: suggestion.register.id,
      registerName: suggestion.register.name,
      confidence: suggestion.score,
      nameMatch: suggestion.nameMatch,
      headerRow: suggestion.header.rowNumber,
      headerSpan: suggestion.header.span,
      rowCount: read.rows.length,
      skipped: read.skipped,
      legend: read.legend,
      extraColumns: read.extraColumns,
      rows: read.rows.map((r) => r.data),
    });
  }
  return { sheets };
}

/** Re-read one sheet as a register the person chose instead of the suggested one. */
export async function readWorkbookAs(buffer, choices) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const out = [];

  for (const choice of choices) {
    const worksheet = workbook.worksheets.find((w) => w.name === choice.sheet);
    if (!worksheet) continue;
    const register = getRegister(choice.registerId);
    if (!register) continue;
    const read = readSheet(worksheet, register);
    out.push({
      sheet: choice.sheet,
      registerId: register.id,
      mode: choice.mode === 'replace' ? 'replace' : 'append',
      rows: read.rows.map((r) => r.data),
      skipped: read.skipped,
      matched: read.header ? read.header.matched : 0,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

const BANNER_FILL = 'FFF2F2F2';
const HEADER_FILL = 'FFE9EDF2';
const BORDER = { style: 'thin', color: { argb: 'FF9AA3AF' } };
const EDGES = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };

/** Excel's own number format for a date, kept in one place. */
const EXCEL_DATE_FORMAT = 'dd/mm/yyyy';

/**
 * Width sized to what is in the column, not to a fixed allowance.
 *
 * Fixed widths meant Priorty and Status took their full share while sitting
 * empty and the Description column — the one people actually read — was crushed
 * into two wrapped lines beside them.
 */
function columnWidth(label, values, wraps) {
  const longest = values.reduce((max, v) => Math.max(max, String(v ?? '').length), String(label).length);
  const cap = wraps ? 46 : 26;
  // The floor is 10 rather than 9 because ExcelJS treats a width of exactly 9 as
  // "unset" and omits it from the file, so a narrow column silently reverted to
  // Excel's own default while every column beside it kept the width it was given.
  return Math.max(10, Math.min(cap, longest + 2));
}

/**
 * Excel refuses `* ? : \ / [ ]` in a sheet name and caps it at 31 characters.
 *
 * The export is named after the sheet the register came from rather than after
 * the register — the file goes back to the same team, and a tab called
 * `Rental Resourecs MP` is the one they know. `SS / Workshop Plan` was the name
 * that found this: the slash is illegal, and it took the whole export down.
 */
function sheetName(register) {
  const name = (register.sheetName || register.name).replace(/[*?:\\/[\]]/g, '-').trim();
  return name.slice(0, 31) || register.id.slice(0, 31);
}

function writeSheet(workbook, register, records) {
  const worksheet = workbook.addWorksheet(sheetName(register));
  const fields = register.fields.filter((f) => !f.hidden);
  const width = fields.length;

  // Every extra column any row picked up, so a round trip cannot lose one.
  const extras = new Set();
  for (const record of records) {
    for (const key of Object.keys(record.data ?? {})) {
      if (key.startsWith('extra:')) extras.add(key.slice(6));
    }
  }
  const extraList = [...extras];
  const totalWidth = width + extraList.length + 1;

  let rowNumber = 1;

  const banner = exportTitle(register);
  if (banner) {
    const row = worksheet.getRow(rowNumber);
    row.getCell(1).value = banner;
    worksheet.mergeCells(rowNumber, 1, rowNumber, totalWidth);
    row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    row.getCell(1).font = { bold: true, size: 14 };
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BANNER_FILL } };
    row.height = 24;
    rowNumber += 1;
  }

  if (register.subBanner) {
    const label = register.subBanner === 'Year' ? `Year ${new Date().getFullYear()}` : `${register.subBanner} ${new Date().getFullYear()}`;
    const row = worksheet.getRow(rowNumber);
    row.getCell(1).value = label;
    worksheet.mergeCells(rowNumber, 1, rowNumber, totalWidth);
    row.getCell(1).alignment = { horizontal: 'center' };
    row.getCell(1).font = { bold: true };
    rowNumber += 1;
  }

  const headerRowNumber = rowNumber;
  const headerRow = worksheet.getRow(headerRowNumber);
  headerRow.getCell(1).value = 'Sr';
  fields.forEach((field, i) => {
    headerRow.getCell(i + 2).value = field.label;
  });
  extraList.forEach((label, i) => {
    headerRow.getCell(fields.length + 2 + i).value = label;
  });
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle', wrapText: true };
  headerRow.eachCell({ includeEmpty: false }, (cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.border = EDGES;
  });
  rowNumber += 1;

  const columnValues = new Map();
  records.forEach((record, i) => {
    const row = worksheet.getRow(rowNumber + i);
    row.getCell(1).value = i + 1;
    fields.forEach((field, c) => {
      const cell = row.getCell(c + 2);
      const raw = record.data?.[field.key];
      // A date column is written as a date, not as the text it happened to be
      // stored as — otherwise the column cannot be sorted or filtered, which is
      // the first thing anybody does with the exported file.
      if (field.type === 'date') {
        const asDate = toExcelDate(raw);
        if (asDate) {
          cell.value = asDate;
          cell.numFmt = EXCEL_DATE_FORMAT;
        } else {
          // A phrase is not a date and gets no date format, which would render
          // it blank.
          cell.value = raw ?? null;
        }
      } else if (field.type === 'number') {
        const n = Number(raw);
        cell.value = raw === '' || raw === null || raw === undefined || !Number.isFinite(n) ? raw ?? null : n;
      } else {
        cell.value = raw ?? null;
      }
      if (field.type === 'longtext') cell.alignment = { wrapText: true, vertical: 'top' };
      const list = columnValues.get(c + 2) ?? [];
      list.push(field.type === 'date' ? formatDate(raw) : raw);
      columnValues.set(c + 2, list);
    });
    extraList.forEach((label, e) => {
      row.getCell(fields.length + 2 + e).value = record.data?.[`extra:${label}`] ?? null;
    });
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.border = EDGES;
    });
  });

  worksheet.getColumn(1).width = 6;
  fields.forEach((field, c) => {
    worksheet.getColumn(c + 2).width = columnWidth(
      field.label,
      columnValues.get(c + 2) ?? [],
      field.type === 'longtext',
    );
  });
  extraList.forEach((label, e) => {
    worksheet.getColumn(fields.length + 2 + e).width = Math.max(12, Math.min(30, label.length + 2));
  });

  // Ready to print: landscape, one page wide, as many pages down as it needs,
  // with the banner and headings repeated at the top of each.
  worksheet.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
  };
  worksheet.headerFooter = { oddFooter: '&LEngineering Planning Tracker&RPage &P of &N' };
  worksheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];
  worksheet.pageSetup.printTitlesRow = `1:${headerRowNumber}`;

  return worksheet;
}

function writeSummary(workbook, summary) {
  const worksheet = workbook.addWorksheet('Summary');
  const columns = ['Register', 'Total', 'Open', 'Closed', 'Overdue', 'Due ≤30d', 'Undated'];

  worksheet.getCell('A1').value = 'ENGINEERING PLANNING TRACKER';
  worksheet.mergeCells(1, 1, 1, columns.length);
  worksheet.getCell('A1').alignment = { horizontal: 'center' };
  worksheet.getCell('A1').font = { bold: true, size: 14 };
  worksheet.getCell('A2').value = `Exported ${formatDate(summary.today)}`;
  worksheet.mergeCells(2, 1, 2, columns.length);
  worksheet.getCell('A2').alignment = { horizontal: 'center' };

  const headerRow = worksheet.getRow(3);
  columns.forEach((label, i) => {
    headerRow.getCell(i + 1).value = label;
  });
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.border = EDGES;
  });

  summary.registers.forEach((entry, i) => {
    const row = worksheet.getRow(4 + i);
    row.getCell(1).value = entry.name;
    row.getCell(2).value = entry.total;
    row.getCell(3).value = entry.open;
    row.getCell(4).value = entry.closed;
    row.getCell(5).value = entry.overdue;
    row.getCell(6).value = entry.dueSoon;
    row.getCell(7).value = entry.undated;
    row.eachCell((cell) => {
      cell.border = EDGES;
    });
  });

  worksheet.getColumn(1).width = 26;
  for (let c = 2; c <= columns.length; c += 1) worksheet.getColumn(c).width = 11;
  return worksheet;
}

/**
 * One workbook: a Summary sheet, then one sheet per register laid out like the
 * file it replaces. It re-imports cleanly, which is what makes editing offline
 * and uploading back a supported way to work rather than a one-way door.
 */
export async function writeWorkbook({ recordsByRegister, summary, registerIds }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Engineering Planning Tracker';
  workbook.created = new Date();

  if (summary) writeSummary(workbook, summary);

  for (const register of REGISTERS) {
    if (registerIds && !registerIds.includes(register.id)) continue;
    writeSheet(workbook, register, recordsByRegister.get(register.id) ?? []);
  }

  return workbook.xlsx.writeBuffer();
}

/** An empty workbook with the right headers for one register. */
export async function writeTemplate(registerId) {
  const register = getRegister(registerId);
  if (!register) throw new Error(`Unknown register: ${registerId}`);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Engineering Planning Tracker';
  writeSheet(workbook, register, []);
  return workbook.xlsx.writeBuffer();
}
