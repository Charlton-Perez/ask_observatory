// ── Browser-side tool executor ────────────────────────────────────────────────
// Executes the model's tool calls against the parsed daily record.
// Four composable primitives cover the vast majority of questions:
//
//   get_days   — raw rows for a short date window (capped)
//   aggregate  — mean/min/max/sum/count with filters + grouping
//   find_runs  — consecutive-day spells (dry spells, heatwaves, frost runs…)
//   rank_days  — top-N days by any field, with filters
//
// Every function is deterministic and returns compact JSON, so the model
// narrates real computed numbers instead of tallying raw rows itself.
//
// This module is intentionally self-contained (no imports) so it can be unit
// tested in Node and reused server-side later if the data ever moves there.

const NUMERIC_FIELDS = [
  'Tx', 'Tn', 'Tdry', 'Twet', 'Pmsl', 'RH', 'RR', 'rd',
  'sss', 'sd_cm', 'af', 'gf', 'ff_ms', 'dd', 'ww',
]

const OPS = {
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '>':  (a, b) => a > b,
  '<':  (a, b) => a < b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
}

const MAX_RAW_ROWS = 400
const MAX_RANK_N   = 50
const MAX_RUNS_N   = 25
const MAX_GROUPS   = 250

const round = (v, dp = 2) => (v == null ? null : +v.toFixed(dp))

// ── Scope helpers ─────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CALDAY_RE = /^\d{2}-\d{2}$/

function validateScope({ start, end, months, calendar_day }) {
  if (start && !DATE_RE.test(start)) return `Invalid start date "${start}" — use YYYY-MM-DD.`
  if (end && !DATE_RE.test(end)) return `Invalid end date "${end}" — use YYYY-MM-DD.`
  if (start && end && start > end) return `start (${start}) is after end (${end}).`
  if (calendar_day && !CALDAY_RE.test(calendar_day)) return `Invalid calendar_day "${calendar_day}" — use MM-DD.`
  if (months && (!Array.isArray(months) || months.some(m => !Number.isInteger(m) || m < 1 || m > 12)))
    return 'months must be an array of integers 1–12.'
  return null
}

function inScope(row, { start, end, months, calendar_day }) {
  if (start && row.date < start) return false
  if (end && row.date > end) return false
  if (months && !months.includes(parseInt(row.date.slice(5, 7)))) return false
  if (calendar_day && row.date.slice(5) !== calendar_day) return false
  return true
}

function validateFilters(filters) {
  if (!filters) return null
  if (!Array.isArray(filters)) return 'filters must be an array of {field, op, value}.'
  for (const f of filters) {
    if (!NUMERIC_FIELDS.includes(f.field)) return `Unknown filter field "${f.field}". Valid fields: ${NUMERIC_FIELDS.join(', ')}.`
    if (!OPS[f.op]) return `Unknown filter op "${f.op}". Valid ops: ${Object.keys(OPS).join(' ')}.`
    if (typeof f.value !== 'number') return `Filter value for ${f.field} must be a number.`
  }
  return null
}

// A row passes only if every filter field is present AND every comparison holds.
function passesFilters(row, filters) {
  if (!filters) return true
  for (const f of filters) {
    const v = row[f.field]
    if (v == null || !OPS[f.op](v, f.value)) return false
  }
  return true
}

function groupKey(date, groupBy) {
  switch (groupBy) {
    case 'year':       return date.slice(0, 4)
    case 'month':      return date.slice(5, 7)                          // calendar month across all years
    case 'year_month': return date.slice(0, 7)
    case 'decade':     return `${date.slice(0, 3)}0s`
    default:           return 'all'
  }
}

const nextDay = (dateStr) => {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// ── Executor factory ──────────────────────────────────────────────────────────
// dayIndex: { "YYYY-MM-DD": { date, Tx, Tn, ... } } from buildDayIndex().
// Returns execute(name, input) → { result, isError }.

export function createToolExecutor(dayIndex) {
  const rows = Object.values(dayIndex).sort((a, b) => a.date.localeCompare(b.date))
  const firstDate = rows[0]?.date
  const lastDate = rows[rows.length - 1]?.date

  const err = (message) => ({ result: { error: message }, isError: true })
  const ok = (result) => ({ result, isError: false })

  // ── get_days ────────────────────────────────────────────────────────────────
  function getDays({ start, end, fields }) {
    if (!start || !end) return err('Both start and end are required (YYYY-MM-DD).')
    const bad = validateScope({ start, end })
    if (bad) return err(bad)
    if (fields) {
      const unknown = fields.filter(f => !NUMERIC_FIELDS.includes(f))
      if (unknown.length) return err(`Unknown field(s): ${unknown.join(', ')}. Valid: ${NUMERIC_FIELDS.join(', ')}.`)
    }
    const scoped = rows.filter(r => inScope(r, { start, end }))
    if (scoped.length > MAX_RAW_ROWS)
      return err(`Range covers ${scoped.length} days — max ${MAX_RAW_ROWS} raw rows. Narrow the range, or use aggregate / rank_days / find_runs instead.`)
    const keep = fields?.length ? fields : NUMERIC_FIELDS
    return ok({
      days: scoped.map(r => {
        const o = { date: r.date }
        for (const f of keep) o[f] = r[f]
        return o
      }),
      n: scoped.length,
      note: scoped.length === 0 ? `No records in range. Record covers ${firstDate} to ${lastDate}.` : undefined,
    })
  }

  // ── aggregate ───────────────────────────────────────────────────────────────
  function aggregate({ field, stat, group_by = 'none', filters, start, end, months, calendar_day }) {
    if (!stat || !['mean', 'min', 'max', 'sum', 'count'].includes(stat))
      return err('stat must be one of: mean, min, max, sum, count.')
    if (stat !== 'count' && !NUMERIC_FIELDS.includes(field))
      return err(`field is required for ${stat} and must be one of: ${NUMERIC_FIELDS.join(', ')}.`)
    if (!['none', 'year', 'month', 'year_month', 'decade'].includes(group_by))
      return err('group_by must be one of: none, year, month, year_month, decade.')
    const bad = validateScope({ start, end, months, calendar_day }) || validateFilters(filters)
    if (bad) return err(bad)

    const scope = { start, end, months, calendar_day }
    const groups = new Map()
    let missing = 0

    for (const r of rows) {
      if (!inScope(r, scope)) continue
      const key = groupKey(r.date, group_by)
      if (!groups.has(key)) groups.set(key, { values: [], minRow: null, maxRow: null, match: 0, total: 0 })
      const g = groups.get(key)

      if (stat === 'count') {
        g.total++
        if (passesFilters(r, filters)) g.match++
        continue
      }

      if (!passesFilters(r, filters)) continue
      const v = r[field]
      if (v == null) { missing++; continue }
      g.values.push(v)
      if (!g.minRow || v < g.minRow.v) g.minRow = { date: r.date, v }
      if (!g.maxRow || v > g.maxRow.v) g.maxRow = { date: r.date, v }
    }

    if (groups.size === 0) return err(`No records match that scope. Record covers ${firstDate} to ${lastDate}.`)
    if (groups.size > MAX_GROUPS)
      return err(`${groups.size} groups — max ${MAX_GROUPS}. Restrict the date range or use a coarser group_by (e.g. year or decade).`)

    const results = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, g]) => {
      if (stat === 'count')
        return { group: key, count: g.match, days_in_scope: g.total, percent: g.total ? round(100 * g.match / g.total, 1) : null }
      const n = g.values.length
      const base = { group: key, n }
      if (n === 0) return { ...base, value: null }
      switch (stat) {
        case 'mean': return { ...base, value: round(g.values.reduce((a, b) => a + b, 0) / n) }
        case 'sum':  return { ...base, value: round(g.values.reduce((a, b) => a + b, 0), 1) }
        case 'min':  return { ...base, value: g.minRow.v, date: g.minRow.date }
        case 'max':  return { ...base, value: g.maxRow.v, date: g.maxRow.date }
      }
    })

    const out = { stat, field: stat === 'count' ? undefined : field, group_by, filters, scope: { start, end, months, calendar_day } }
    if (group_by === 'none') {
      Object.assign(out, results[0])
      delete out.group
    } else {
      out.groups = results
      // Summary over group values so the model needn't do arithmetic across groups.
      const vals = results.map(r => stat === 'count' ? r.count : r.value).filter(v => v != null)
      if (vals.length) {
        const maxI = results.reduce((best, r, i) => ((stat === 'count' ? r.count : r.value) ?? -Infinity) > ((stat === 'count' ? results[best].count : results[best].value) ?? -Infinity) ? i : best, 0)
        const minI = results.reduce((best, r, i) => ((stat === 'count' ? r.count : r.value) ?? Infinity) < ((stat === 'count' ? results[best].count : results[best].value) ?? Infinity) ? i : best, 0)
        out.group_summary = {
          mean_of_groups: round(vals.reduce((a, b) => a + b, 0) / vals.length),
          highest: { group: results[maxI].group, value: stat === 'count' ? results[maxI].count : results[maxI].value },
          lowest:  { group: results[minI].group, value: stat === 'count' ? results[minI].count : results[minI].value },
        }
      }
    }
    if (missing) out.days_with_missing_value_excluded = missing
    return ok(out)
  }

  // ── find_runs ───────────────────────────────────────────────────────────────
  function findRuns({ field, op, value, min_length = 3, start, end, months, top_n = 10 }) {
    if (!NUMERIC_FIELDS.includes(field)) return err(`Unknown field "${field}". Valid: ${NUMERIC_FIELDS.join(', ')}.`)
    if (!OPS[op]) return err(`Unknown op "${op}". Valid: ${Object.keys(OPS).join(' ')}.`)
    if (typeof value !== 'number') return err('value must be a number.')
    if (!Number.isInteger(min_length) || min_length < 1) return err('min_length must be a positive integer.')
    const bad = validateScope({ start, end, months })
    if (bad) return err(bad)
    top_n = Math.min(Math.max(1, top_n), MAX_RUNS_N)

    const scope = { start, end, months }
    const wantHigh = op === '>=' || op === '>'
    const runs = []
    let cur = null
    let prevDate = null

    const close = () => {
      if (cur && cur.length >= min_length) runs.push(cur)
      cur = null
    }

    for (const r of rows) {
      if (!inScope(r, scope)) { close(); prevDate = null; continue }
      const contiguous = prevDate && r.date === nextDay(prevDate)
      const v = r[field]
      const hit = v != null && OPS[op](v, value)
      if (hit) {
        if (!cur || !contiguous) { close(); cur = { start: r.date, end: r.date, length: 0, peak: { date: r.date, value: v } } }
        cur.end = r.date
        cur.length++
        if (wantHigh ? v > cur.peak.value : v < cur.peak.value) cur.peak = { date: r.date, value: v }
      } else {
        close()
      }
      prevDate = r.date
    }
    close()

    const byDecade = {}
    for (const run of runs) {
      const d = `${run.start.slice(0, 3)}0s`
      byDecade[d] = (byDecade[d] || 0) + 1
    }
    const sorted = [...runs].sort((a, b) => b.length - a.length || a.start.localeCompare(b.start))

    return ok({
      condition: `${field} ${op} ${value} for >= ${min_length} consecutive days`,
      scope: { start, end, months },
      total_runs: runs.length,
      mean_run_length: runs.length ? round(runs.reduce((a, r) => a + r.length, 0) / runs.length, 1) : null,
      longest_runs: sorted.slice(0, top_n).map(r => ({
        start: r.start, end: r.end, days: r.length,
        [wantHigh ? 'peak' : 'lowest']: r.peak,
      })),
      runs_per_decade: byDecade,
      note: 'Runs require consecutive calendar dates; gaps in the record break a run. months restricts which days may belong to a run.',
    })
  }

  // ── rank_days ───────────────────────────────────────────────────────────────
  function rankDays({ field, order = 'desc', n = 10, filters, start, end, months, calendar_day }) {
    if (!NUMERIC_FIELDS.includes(field)) return err(`Unknown field "${field}". Valid: ${NUMERIC_FIELDS.join(', ')}.`)
    if (!['asc', 'desc'].includes(order)) return err('order must be "asc" or "desc".')
    const bad = validateScope({ start, end, months, calendar_day }) || validateFilters(filters)
    if (bad) return err(bad)
    n = Math.min(Math.max(1, n), MAX_RANK_N)

    const scope = { start, end, months, calendar_day }
    const candidates = rows.filter(r => inScope(r, scope) && r[field] != null && passesFilters(r, filters))
    if (!candidates.length) return err(`No matching records. Record covers ${firstDate} to ${lastDate}.`)

    candidates.sort((a, b) => order === 'desc' ? b[field] - a[field] : a[field] - b[field])
    const extras = ['Tx', 'Tn', 'RR'].filter(f => f !== field)

    return ok({
      field, order, scope, filters,
      n_candidates: candidates.length,
      days: candidates.slice(0, n).map(r => {
        const o = { date: r.date, [field]: r[field] }
        for (const f of extras) o[f] = r[f]
        return o
      }),
    })
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────
  return function execute(name, input = {}) {
    try {
      switch (name) {
        case 'get_days':  return getDays(input)
        case 'aggregate': return aggregate(input)
        case 'find_runs': return findRuns(input)
        case 'rank_days': return rankDays(input)
        default: return err(`Unknown tool "${name}".`)
      }
    } catch (e) {
      return err(`Tool execution failed: ${e.message}`)
    }
  }
}

// Human-readable one-liner for the UI activity trail.
export function describeToolCall(name, input = {}) {
  const scope = [
    input.start && input.end ? `${input.start}→${input.end}` : input.start ? `from ${input.start}` : input.end ? `to ${input.end}` : null,
    input.months?.length ? `months ${input.months.join(',')}` : null,
    input.calendar_day ? `every ${input.calendar_day}` : null,
  ].filter(Boolean).join(', ')
  const f = (input.filters || []).map(x => `${x.field}${x.op}${x.value}`).join(' & ')
  switch (name) {
    case 'get_days':  return `fetch days ${scope}`
    case 'aggregate': return `${input.stat} ${input.field ?? ''}${f ? ` where ${f}` : ''}${input.group_by && input.group_by !== 'none' ? ` by ${input.group_by}` : ''}${scope ? ` (${scope})` : ''}`
    case 'find_runs': return `runs of ${input.field} ${input.op} ${input.value}, ≥${input.min_length ?? 3} days${scope ? ` (${scope})` : ''}`
    case 'rank_days': return `top ${input.n ?? 10} ${input.field} (${input.order ?? 'desc'})${f ? ` where ${f}` : ''}${scope ? ` (${scope})` : ''}`
    default: return name
  }
}
