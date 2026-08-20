/**
 * Dates, in one place.
 *
 * The workbook holds four spellings of the same day at once — `13/08/25`,
 * `23/7/2025`, an Excel serial, and a real `Date` — because some rows were typed
 * and some were pasted. Every one of them has to become the same `YYYY-MM-DD`
 * string, or the same job sorts into two different places.
 *
 * It also holds cells in date columns that are not dates at all: `Next Shutdown`,
 * `SEP`, `RELEASED`. Those are deliberate entries and are kept as written; the
 * job simply has no calendar date behind it.
 */

/**
 * Two-digit years are read as 20xx.
 *
 * Every date in the source workbook is 2025 or 2026, and the rental sheets write
 * them as `13/08/25`. Treating `25` as 1925 would park the row a century overdue
 * at the top of every list.
 */
const CENTURY = 2000;

/**
 * Outside this range a value is a mistake, not a date.
 *
 * A five-year addition that wrapped, or a serial number that landed in a date
 * column, otherwise becomes a permanently overdue row nobody can close.
 */
const MIN_YEAR = 1990;
const MAX_YEAR = 2100;

const pad = (n) => String(n).padStart(2, '0');

/**
 * The team's workbooks are written day/month/year — `13/08/25` is 13 August.
 * The two conventions disagree for every day up to the twelfth, so this is not
 * a cosmetic setting: it decides what the row means.
 */
export const DAY_FIRST = true;

/** How the app prints a date. Change here and the table, the export and the
 *  printed sheet all follow, because all three call `formatDate`. */
export const DATE_FORMAT = 'dd/mm/yyyy';

/** Coerce any cell to `YYYY-MM-DD`, or null when it is not a date at all. */
export function toDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : clamp(value);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    // An Excel serial is days since 1899-12-30 — the epoch that absorbs the
    // 1900 leap-year bug Excel inherited from Lotus.
    if (value < 1 || value > 2958465) return null;
    return clamp(new Date(Math.round((value - 25569) * 86400000)));
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // dd/mm/yy, dd-mm-yyyy, dd.mm.yyyy — how the rental and IWS sheets write them.
  const parts = raw.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (parts) {
    const [, a, b, c] = parts;
    // A four-digit leading group can only be a year: `2026-09-03`.
    if (a.length === 4) return clamp(utc(Number(a), Number(b), Number(c)));
    const year = expandYear(Number(c));
    const first = Number(a);
    const second = Number(b);
    // Day-first unless the first number cannot be a day, which is how a stray
    // `09/25/2025` from an American-formatted paste still lands correctly.
    const dayFirst = DAY_FIRST ? second <= 12 : first > 12;
    return clamp(dayFirst ? utc(year, second, first) : utc(year, first, second));
  }

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return clamp(utc(Number(iso[1]), Number(iso[2]), Number(iso[3])));

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : clamp(parsed);
}

function utc(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

function expandYear(year) {
  return year >= 100 ? year : CENTURY + year;
}

function clamp(date) {
  const year = date.getUTCFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  // A due date has no time of day. Keeping one would make "due today" depend on
  // which side of midnight the reader's browser is.
  return `${year}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Today, as the host's local calendar sees it. Set `TZ` to the plant's zone. */
export function todayIso(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whole days from `from` to `iso`; negative once the date has passed. */
export function daysUntil(iso, from = todayIso()) {
  if (!iso) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * A date as the team reads it. Anything that is not a plain date — `Next
 * Shutdown`, `SEP` — is passed through untouched, because it is a note.
 */
export function formatDate(value) {
  const raw = String(value ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return raw;
  return DATE_FORMAT === 'mm/dd/yyyy' ? `${m[2]}/${m[3]}/${m[1]}` : `${m[3]}/${m[2]}/${m[1]}`;
}

/** Turn `YYYY-MM-DD` back into a Date, so Excel receives a date and not a string. */
export function toExcelDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? ''))) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return utc(y, m, d);
}
