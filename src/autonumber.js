/**
 * Document numbers the app issues: `IWS-2608-01`.
 *
 * A prefix, the two-digit year, the two-digit month, then a serial that restarts
 * at 01 each month. Only entries created by hand are numbered — an imported
 * sheet keeps whatever numbers it already carries.
 */

const pattern = (prefix) => new RegExp(`^${prefix}-(\\d{2})(\\d{2})-(\\d+)$`, 'i');

export function periodKey(date = new Date()) {
  const year = String(date.getFullYear() % 100).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}${month}`;
}

export function formatNumber(prefix, period, serial) {
  return `${prefix}-${period}-${String(serial).padStart(2, '0')}`;
}

/**
 * The next serial is the highest already issued this month plus one — never the
 * count of records.
 *
 * Counting would reissue a number the moment an entry was deleted, and these
 * appear on paperwork that has already left the building. Past 99 the number
 * simply gets longer rather than wrapping.
 */
export function nextNumber(existing, { prefix }, date = new Date()) {
  const period = periodKey(date);
  const re = pattern(prefix);
  let highest = 0;

  for (const value of existing) {
    const match = re.exec(String(value ?? '').trim());
    if (!match) continue;
    if (`${match[1]}${match[2]}` !== period) continue;
    highest = Math.max(highest, Number(match[3]));
  }

  return formatNumber(prefix, period, highest + 1);
}
