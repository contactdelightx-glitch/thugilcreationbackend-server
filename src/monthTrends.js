// Shared by the KPI cards on the Payments and Course Payments pages.
// Builds cumulative day-by-day series for a month and the month before it, so growth or loss is visible.

const TZ = 'Asia/Kolkata'; // months and days follow the business's local calendar
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
const shiftMonth = (y, m, by) => { const t = y * 12 + (m - 1) + by; return [Math.floor(t / 12), (t % 12) + 1]; };
const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const round2 = (n) => Math.round(n * 100) / 100;

/** cumulative [day1, day1+day2, ...] for `days` days from a {day: value} map */
function cumulative(byDay, days) {
  const out = [];
  let run = 0;
  for (let d = 1; d <= days; d++) { run += byDay[d] || 0; out.push(round2(run)); }
  return out;
}

/**
 * @param pool      pg pool
 * @param month     'YYYY-MM' or undefined for the current month
 * @param rowsSql   SELECT returning `month` ('YYYY-MM'), `day` (int) and one numeric column per metric.
 *                  Parameters: $1 = timezone, $2 = first date (inclusive), $3 = end date (exclusive).
 * @param firstSql  SELECT returning one column `m` ('YYYY-MM') = the earliest month with data. Parameter: $1 = timezone.
 * @param metrics   the metric column names to build series for, e.g. ['revenue', 'orders']
 * @param avg       optional { sum, count }: also build a running average of metrics[sum] / metrics[count]
 * @returns { status, body } where status is 200 or 400
 */
async function monthTrends(pool, { month, rowsSql, firstSql, metrics, avg }) {
  const now = (await pool.query(`SELECT to_char(NOW() AT TIME ZONE $1, 'YYYY-MM-DD') AS today`, [TZ])).rows[0].today;
  const [ty, tm, td] = now.split('-').map(Number);
  const currentMonth = ym(ty, tm);
  const chosen = month || currentMonth;
  if (!MONTH.test(chosen)) return { status: 400, body: { error: 'month must look like 2026-11' } };
  if (chosen > currentMonth) return { status: 400, body: { error: 'month is in the future' } };

  const [y, m] = chosen.split('-').map(Number);
  const [py, pm] = shiftMonth(y, m, -1);
  const [ny, nm] = shiftMonth(y, m, 1);
  const days = daysIn(y, m);
  const prevDays = daysIn(py, pm);
  const throughDay = chosen === currentMonth ? td : days; // current month: only up to today

  const { rows } = await pool.query(rowsSql, [TZ, `${ym(py, pm)}-01`, `${ym(ny, nm)}-01`]);
  const first = (await pool.query(firstSql, [TZ])).rows[0].m;

  const pick = (mon, key) => Object.fromEntries(rows.filter((r) => r.month === mon).map((r) => [r.day, Number(r[key])]));
  const build = (key) => {
    const cur = cumulative(pick(chosen, key), throughDay);
    const prev = cumulative(pick(ym(py, pm), key), prevDays);
    const upTo = Math.min(throughDay, prevDays);
    return { current: cur, previous: prev, total: cur.at(-1) ?? 0, previousToDate: prev[upTo - 1] ?? 0, previousFull: prev.at(-1) ?? 0 };
  };

  const out = Object.fromEntries(metrics.map((k) => [k, build(k)]));

  if (avg) {
    const s = out[avg.sum];
    const c = out[avg.count];
    const running = (sums, counts) => sums.map((v, i) => (counts[i] > 0 ? round2(v / counts[i]) : null));
    const ratio = (a, b) => (b ? round2(a / b) : 0);
    out.avg = {
      current: running(s.current, c.current),
      previous: running(s.previous, c.previous),
      total: ratio(s.total, c.total),
      previousToDate: ratio(s.previousToDate, c.previousToDate),
      previousFull: ratio(s.previousFull, c.previousFull),
    };
  }

  return {
    status: 200,
    body: {
      month: chosen,
      previousMonth: ym(py, pm),
      daysInMonth: days,
      previousDaysInMonth: prevDays,
      throughDay,
      isCurrentMonth: chosen === currentMonth,
      firstMonth: first || currentMonth,
      currentMonth,
      metrics: out,
    },
  };
}

module.exports = { monthTrends, TZ };
