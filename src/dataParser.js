import Papa from 'papaparse'

// ── Column definitions ────────────────────────────────────────────────────────
// Each entry describes a numeric field in the CSV.
// label: human-readable name used in the summary sent to Claude.
// higher: true = higher values are "more extreme" (used for top-20 ranking direction).
export const FIELDS = [
  { key: 'Tx',    label: 'Daily max temp (°C)',         higher: true  },
  { key: 'Tn',    label: 'Daily min temp (°C)',          higher: false },
  { key: 'Tdry',  label: '09 UTC dry-bulb temp (°C)',   higher: null  }, // no natural extreme direction
  { key: 'Twet',  label: 'Wet-bulb temp (°C)',          higher: null  },
  { key: 'Pmsl',  label: 'Mean sea level pressure (hPa)', higher: true },
  { key: 'RH',    label: 'Relative humidity (%)',        higher: null  },
  { key: 'RR',    label: 'Rainfall (mm)',                higher: true  },
  { key: 'sss',   label: 'Sunshine duration (hrs)',      higher: true  },
  { key: 'sd_cm', label: 'Snow depth (cm)',              higher: true  },
  { key: 'af',    label: 'Air frost (1=yes)',            higher: null  },
  { key: 'gf',    label: 'Ground frost (1=yes)',         higher: null  },
]

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

function num(v) {
  const n = parseFloat(v)
  return isNaN(n) ? null : n
}

function pad(n) { return String(n).padStart(2, '0') }
function dateFmt(year, month, day) { return `${year}-${pad(month)}-${pad(day)}` }

// ── Parse ─────────────────────────────────────────────────────────────────────
export function parseCSV(text) {
  const { data } = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim(),
  })
  return data
}

// ── Day index: "YYYY-MM-DD" → row (for specific date lookups) ────────────────
export function buildDayIndex(rows) {
  const index = {}
  for (const row of rows) {
    const year = parseInt(row.year), month = parseInt(row.month), day = parseInt(row.day)
    if (!year || !month || !day) continue
    const key = dateFmt(year, month, day)
    const entry = { date: key }
    for (const { key: f } of FIELDS) entry[f] = num(row[f])
    index[key] = entry
  }
  return index
}

// ── Calendar-day index: "MM-DD" → all historical records for that date ────────
// Used for questions like "warmest 3rd January", "wettest 25th December" etc.
// Each entry is an array of { year, ...fields } sorted by Tx descending.
export function buildCalendarDayIndex(rows) {
  const index = {}
  for (const row of rows) {
    const year = parseInt(row.year), month = parseInt(row.month), day = parseInt(row.day)
    if (!year || !month || !day) continue
    const key = `${pad(month)}-${pad(day)}`
    if (!index[key]) index[key] = []
    const entry = { year }
    for (const { key: f } of FIELDS) entry[f] = num(row[f])
    index[key].push(entry)
  }
  // Pre-sort by Tx descending so Claude can read off rankings directly
  for (const key of Object.keys(index)) {
    index[key].sort((a, b) => (b.Tx ?? -999) - (a.Tx ?? -999))
  }
  return index
}

// ── Run/spell computation ─────────────────────────────────────────────────────
// Conditions to pre-compute. label is sent to Claude; test(row) returns bool.
// Add new conditions here as needed — nothing else changes.
const RUN_CONDITIONS = [
  { label: 'days with Tx >= 25°C (warm days)',      test: r => r.Tx != null && r.Tx >= 25 },
  { label: 'days with Tx >= 30°C (hot days)',       test: r => r.Tx != null && r.Tx >= 30 },
  { label: 'days with Tx >= 20°C',                  test: r => r.Tx != null && r.Tx >= 20 },
  { label: 'days with Tx < 5°C (cold days)',        test: r => r.Tx != null && r.Tx < 5  },
  { label: 'days with Tx < 0°C (ice days)',         test: r => r.Tx != null && r.Tx < 0  },
  { label: 'nights with Tn < 0°C (air frost)',      test: r => r.Tn != null && r.Tn < 0  },
  { label: 'dry days (RR = 0 mm)',                  test: r => r.RR != null && r.RR === 0 },
  { label: 'wet days (RR > 1 mm)',                  test: r => r.RR != null && r.RR > 1  },
  { label: 'days with any sunshine (sss > 0 hrs)', test: r => r.sss != null && r.sss > 0 },
  { label: 'days with no sunshine (sss = 0 hrs)',  test: r => r.sss != null && r.sss === 0 },
  { label: 'days with snow on ground (sd_cm > 0)', test: r => r.sd_cm != null && r.sd_cm > 0 },
]

// Compute the top-10 longest consecutive runs for each condition.
// Returns an object keyed by condition label.
function computeRuns(rows, n = 10) {
  // Sort rows chronologically (they usually are, but be safe)
  const sorted = [...rows]
    .map(r => ({ ...r, year: parseInt(r.year), month: parseInt(r.month), day: parseInt(r.day) }))
    .filter(r => r.year && r.month && r.day)
    .sort((a, b) => dateFmt(a.year, a.month, a.day).localeCompare(dateFmt(b.year, b.month, b.day)))

  const results = {}

  for (const { label, test } of RUN_CONDITIONS) {
    const topRuns = []
    let runStart = null, runLen = 0

    const closeRun = (endDate) => {
      if (runLen > 0) {
        topRuns.push({ start: runStart, end: endDate, days: runLen })
        topRuns.sort((a, b) => b.days - a.days)
        if (topRuns.length > n) topRuns.pop()
      }
    }

    for (const row of sorted) {
      const date = dateFmt(row.year, row.month, row.day)
      const numeric = {}
      for (const { key: f } of FIELDS) numeric[f] = num(row[f])

      if (test(numeric)) {
        if (runLen === 0) runStart = date
        runLen++
      } else {
        const prevDate = sorted[sorted.indexOf(row) - 1]
        closeRun(prevDate ? dateFmt(prevDate.year, prevDate.month, prevDate.day) : date)
        runStart = null
        runLen = 0
      }
    }
    // Close any open run at end of data
    const last = sorted[sorted.length - 1]
    closeRun(dateFmt(last.year, last.month, last.day))

    results[label] = topRuns
  }

  return results
}

// ── Main context: everything Claude needs, built once ─────────────────────────
export function buildContext(rows) {
  // Monthly accumulators
  const monthly = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1, name: MONTH_NAMES[i],
    values: Object.fromEntries(FIELDS.map(f => [f.key, []])),
    frostDays: { af: 0, gf: 0 },
    n: 0,
  }))

  // Annual accumulators
  const annual = {}

  // All-day lists for ranking (only fields with a clear extreme direction)
  const rankable = FIELDS.filter(f => f.higher !== null)
  const allDays = Object.fromEntries(rankable.map(f => [f.key, []]))

  let startDate = null, endDate = null, totalDays = 0

  for (const row of rows) {
    const year = parseInt(row.year), month = parseInt(row.month), day = parseInt(row.day)
    if (!year || !month || !day) continue
    totalDays++
    const d = dateFmt(year, month, day)
    if (!startDate || d < startDate) startDate = d
    if (!endDate   || d > endDate)   endDate   = d

    const m = monthly[month - 1]
    m.n++

    for (const { key: f } of FIELDS) {
      const v = num(row[f])
      if (v !== null) {
        if (f === 'af' || f === 'gf') { if (v === 1) m.frostDays[f]++ }
        else m.values[f].push(v)
      }
    }

    // Annual
    if (!annual[year]) annual[year] = Object.fromEntries(FIELDS.map(f => [f.key, []]))
    for (const { key: f } of FIELDS) {
      const v = num(row[f])
      if (v !== null && f !== 'af' && f !== 'gf') annual[year][f].push(v)
    }

    // Rankable all-day lists
    for (const { key: f } of rankable) {
      const v = num(row[f])
      if (v !== null) allDays[f].push({ date: d, value: v })
    }
  }

  const mean  = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null
  const max   = arr => arr.length ? Math.max(...arr) : null
  const min   = arr => arr.length ? Math.min(...arr) : null
  const total = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0)).toFixed(1) : null
  const top   = (arr, n = 20) => [...arr].sort((a, b) => b.value - a.value).slice(0, n)
  const bot   = (arr, n = 20) => [...arr].sort((a, b) => a.value - b.value).slice(0, n)

  // All-time extremes with top/bottom 20 ranked lists
  const extremes = {}
  for (const { key: f, higher } of rankable) {
    extremes[f] = higher
      ? { top20: top(allDays[f]) }
      : { bottom20: bot(allDays[f]) }
    // Pressure gets both directions
    if (f === 'Pmsl') extremes[f] = { top20: top(allDays[f]), bottom20: bot(allDays[f]) }
  }

  // Monthly summary
  const byMonth = monthly.map(m => {
    const out = { month: m.month, name: m.name, daysInRecord: m.n }
    for (const { key: f } of FIELDS) {
      if (f === 'af' || f === 'gf') {
        out[`${f}_days`] = m.frostDays[f]
      } else {
        const arr = m.values[f]
        out[f] = { mean: mean(arr), max: max(arr), min: min(arr) }
      }
    }
    return out
  })

  // Annual summary
  const byYear = Object.entries(annual).sort(([a], [b]) => a - b).map(([year, fields]) => {
    const out = { year: parseInt(year) }
    for (const { key: f } of FIELDS) {
      if (f === 'af' || f === 'gf') continue
      const arr = fields[f]
      if (f === 'RR' || f === 'sss') out[f] = total(arr)      // totals make more sense annually
      else out[`${f}_mean`] = mean(arr)
    }
    out.Tx_max = max(annual[year].Tx)
    out.Tn_min = min(annual[year].Tn)
    return out
  })

  return {
    overview: { startDate, endDate, totalDays },
    allTimeExtremes: extremes,
    longestRuns: computeRuns(rows),
    byMonth,
    byYear,
  }
}

// ── Date extraction from question text ───────────────────────────────────────
const MONTH_MAP = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12,
}

// Returns { specificDates: ["YYYY-MM-DD",...], calendarDays: ["MM-DD",...] }
export function extractDates(question) {
  const dates = new Set()
  const calendarDays = new Set()

  // ISO: 1987-10-14
  for (const m of question.matchAll(/\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/g))
    dates.add(`${m[1]}-${pad(m[2])}-${pad(m[3])}`)

  // DMY: 14/10/1987
  for (const m of question.matchAll(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/g))
    dates.add(`${m[3]}-${pad(m[2])}-${pad(m[1])}`)

  // "14 October 1987" / "14th October 1987"
  for (const m of question.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{4})\b/gi)) {
    const mo = MONTH_MAP[m[2].toLowerCase()]
    if (mo) dates.add(`${m[3]}-${pad(mo)}-${pad(m[1])}`)
  }

  // "October 14 1987" / "October 14th, 1987"
  for (const m of question.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b/gi)) {
    const mo = MONTH_MAP[m[1].toLowerCase()]
    if (mo) dates.add(`${m[3]}-${pad(mo)}-${pad(m[2])}`)
  }

  // Calendar day without year: "3rd January", "January 3rd", "3 January" etc.
  // Only add as a calendar day if it wasn't already captured as a full specific date
  const fullDateStrings = [...dates]
  for (const m of question.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/gi)) {
    const mo = MONTH_MAP[m[2].toLowerCase()]
    if (!mo) continue
    const key = `${pad(mo)}-${pad(m[1])}`
    if (!fullDateStrings.some(d => d.endsWith(`-${key.replace('-', '-')}`)))
      calendarDays.add(key)
  }
  for (const m of question.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi)) {
    const mo = MONTH_MAP[m[1].toLowerCase()]
    if (!mo) continue
    const key = `${pad(mo)}-${pad(m[2])}`
    if (!fullDateStrings.some(d => d.endsWith(`-${pad(m[2])}`)))
      calendarDays.add(key)
  }

  return { specificDates: [...dates], calendarDays: [...calendarDays] }
}
