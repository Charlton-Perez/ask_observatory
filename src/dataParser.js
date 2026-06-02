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

// ── WMO climatological period ────────────────────────────────────────────────
// Returns the current WMO 30-year normal period based on today's year.
// Shifts automatically to 2001-2030 once 2031 is reached.
export function getWMOPeriod() {
  const year = new Date().getFullYear()
  if (year < 2031) return { start: 1991, end: 2020, label: '1991–2020' }
  return { start: 2001, end: 2030, label: '2001–2030' }
}

// ── Main context: everything Claude needs, built once ─────────────────────────
export function buildContext(rows) {
  const wmoPeriod = getWMOPeriod()
  // Monthly accumulators
  const monthly = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1, name: MONTH_NAMES[i],
    values: Object.fromEntries(FIELDS.map(f => [f.key, []])),
    frostDays: { af: 0, gf: 0 },
    n: 0,
  }))

  // Annual accumulators
  const annual = {}

  // Month-year accumulators: "YYYY-MM" → per-field values (for record month queries)
  const monthYear = {}

  // WMO normals accumulators — one bucket per calendar month, filled only from
  // rows within the active 30-year period.
  const normalsRaw = Array.from({ length: 12 }, () => ({
    Tx: [], Tn: [], Tdry: [], Twet: [], Pmsl: [], RH: [],
    RR: [], sss: [], af: 0, gf: 0, n: 0,
  }))

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

    // Month-year (for record month queries)
    const myKey = `${year}-${pad(month)}`
    if (!monthYear[myKey]) monthYear[myKey] = {
      label: `${MONTH_NAMES[month - 1]} ${year}`,
      values: Object.fromEntries(FIELDS.map(f => [f.key, []])),
      af: 0, gf: 0,
    }
    for (const { key: f } of FIELDS) {
      const v = num(row[f])
      if (v === null) continue
      if (f === 'af') { if (v === 1) monthYear[myKey].af++ }
      else if (f === 'gf') { if (v === 1) monthYear[myKey].gf++ }
      else monthYear[myKey].values[f].push(v)
    }

    // Rankable all-day lists
    for (const { key: f } of rankable) {
      const v = num(row[f])
      if (v !== null) allDays[f].push({ date: d, value: v })
    }

    // WMO normals — only accumulate rows in the active 30-year period
    if (year >= wmoPeriod.start && year <= wmoPeriod.end) {
      const nb = normalsRaw[month - 1]
      nb.n++
      const push = (key) => { const v = num(row[key]); if (v !== null) nb[key].push(v) }
      ;['Tx','Tn','Tdry','Twet','Pmsl','RH','RR','sss'].forEach(push)
      if (num(row.af) === 1) nb.af++
      if (num(row.gf) === 1) nb.gf++
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

  // Decade summary — far more compact than per-year and still answers trend questions.
  // Groups years into decades (1900s, 1910s, …) and averages across them.
  const decadeMap = {}
  for (const [year, fields] of Object.entries(annual)) {
    const decade = Math.floor(parseInt(year) / 10) * 10
    if (!decadeMap[decade]) decadeMap[decade] = Object.fromEntries(FIELDS.map(f => [f.key, []]))
    for (const { key: f } of FIELDS) {
      if (f === 'af' || f === 'gf') continue
      decadeMap[decade][f].push(...fields[f])
    }
  }
  const byDecade = Object.entries(decadeMap).sort(([a], [b]) => a - b).map(([decade, fields]) => {
    const out = { decade: `${decade}s` }
    for (const { key: f } of FIELDS) {
      if (f === 'af' || f === 'gf') continue
      const arr = fields[f]
      if (f === 'RR' || f === 'sss') out[f] = mean(arr)   // mean annual total across decade
      else out[`${f}_mean`] = mean(arr)
    }
    out.Tx_max = max(fields.Tx)
    out.Tn_min = min(fields.Tn)
    return out
  })

  // Keep per-year just for Tx_max and Tn_min — useful for "warmest year" questions
  // but much smaller than the full annual breakdown.
  const byYear = Object.entries(annual).sort(([a], [b]) => a - b).map(([year, fields]) => ({
    year: parseInt(year),
    Tx_max: max(fields.Tx),
    Tn_min: min(fields.Tn),
    RR_total: total(fields.RR),
    sss_total: total(fields.sss),
  }))

  // ── Per-calendar-month top-10s ───────────────────────────────────────────────
  // For each of the 12 calendar months, rank all historical instances by key metrics.
  // e.g. top 10 sunniest Marches, wettest Octobers, hottest Julys, etc.
  const topN = 10
  const rank = (arr, hi = true) => [...arr].filter(e => e.value !== null)
    .sort((a, b) => hi ? b.value - a.value : a.value - b.value).slice(0, topN)

  const monthlyTopTens = {}
  for (let mo = 1; mo <= 12; mo++) {
    const entries = Object.entries(monthYear)
      .filter(([k]) => parseInt(k.split('-')[1]) === mo)
      .map(([k, v]) => ({ year: parseInt(k.split('-')[0]), ...v }))

    monthlyTopTens[mo] = {
      name: MONTH_NAMES[mo - 1],
      hottestMonths:  rank(entries.map(e => ({ year: e.year, value: mean(e.values.Tx) }))),
      coldestMonths:  rank(entries.map(e => ({ year: e.year, value: mean(e.values.Tn) })), false),
      wettestMonths:  rank(entries.map(e => ({ year: e.year, value: total(e.values.RR) }))),
      driestMonths:   rank(entries.map(e => ({ year: e.year, value: total(e.values.RR) })), false),
      sunniestMonths: rank(entries.map(e => ({ year: e.year, value: total(e.values.sss) }))),
      gloomyMonths:   rank(entries.map(e => ({ year: e.year, value: total(e.values.sss) })), false),
      mostFrostDays:  rank(entries.map(e => ({ year: e.year, value: e.af }))),
    }
  }

  // ── Seasonal top-10s ─────────────────────────────────────────────────────────
  // Meteorological seasons: MAM=spring, JJA=summer, SON=autumn, DJF=winter.
  // Winter is attributed to the year of Jan/Feb (so Dec 1975 + Jan/Feb 1976 = winter 1976).
  const SEASONS = {
    spring: { months: [3, 4, 5],  label: m => `Spring ${m}` },
    summer: { months: [6, 7, 8],  label: m => `Summer ${m}` },
    autumn: { months: [9, 10, 11], label: m => `Autumn ${m}` },
    winter: { months: [12, 1, 2], label: m => `Winter ${m - 1}/${String(m).slice(-2)}` },
  }

  // Build season-year accumulator
  const seasonMap = {}  // "season-year" → { values: {field: []}, af: 0, gf: 0 }
  for (const [myKey, mv] of Object.entries(monthYear)) {
    const [yr, mo] = myKey.split('-').map(Number)
    for (const [sName, sDef] of Object.entries(SEASONS)) {
      if (!sDef.months.includes(mo)) continue
      const seasonYear = sName === 'winter' && mo === 12 ? yr + 1 : yr
      const sKey = `${sName}-${seasonYear}`
      if (!seasonMap[sKey]) seasonMap[sKey] = {
        season: sName, year: seasonYear,
        values: Object.fromEntries(FIELDS.map(f => [f.key, []])),
        af: 0, gf: 0,
      }
      for (const { key: f } of FIELDS) {
        if (f === 'af') seasonMap[sKey].af += mv.af
        else if (f === 'gf') seasonMap[sKey].gf += mv.gf
        else seasonMap[sKey].values[f].push(...mv.values[f])
      }
    }
  }

  const seasonalTopTens = {}
  for (const sName of Object.keys(SEASONS)) {
    const entries = Object.values(seasonMap).filter(e => e.season === sName)
    seasonalTopTens[sName] = {
      hottestSeasons:  rank(entries.map(e => ({ year: e.year, value: mean(e.values.Tx) }))),
      coldestSeasons:  rank(entries.map(e => ({ year: e.year, value: mean(e.values.Tn) })), false),
      wettestSeasons:  rank(entries.map(e => ({ year: e.year, value: total(e.values.RR) }))),
      driestSeasons:   rank(entries.map(e => ({ year: e.year, value: total(e.values.RR) })), false),
      sunniestSeasons: rank(entries.map(e => ({ year: e.year, value: total(e.values.sss) }))),
      mostFrostDays:   rank(entries.map(e => ({ year: e.year, value: e.af }))),
    }
  }

  // All-time record month (single best/worst of each metric across all months)
  const allMyEntries = Object.entries(monthYear)
  const recordMonths = {
    hottestMonth:         allMyEntries.map(([k,v]) => ({ label: v.label, value: mean(v.values.Tx) })).filter(e=>e.value!==null).sort((a,b)=>b.value-a.value)[0],
    coldestMonth:         allMyEntries.map(([k,v]) => ({ label: v.label, value: mean(v.values.Tn) })).filter(e=>e.value!==null).sort((a,b)=>a.value-b.value)[0],
    wettestMonth:         allMyEntries.map(([k,v]) => ({ label: v.label, value: total(v.values.RR) })).filter(e=>e.value!==null).sort((a,b)=>b.value-a.value)[0],
    driestMonth:          allMyEntries.map(([k,v]) => ({ label: v.label, value: total(v.values.RR) })).filter(e=>e.value!==null&&e.value>=0).sort((a,b)=>a.value-b.value)[0],
    sunniestMonth:        allMyEntries.map(([k,v]) => ({ label: v.label, value: total(v.values.sss) })).filter(e=>e.value!==null).sort((a,b)=>b.value-a.value)[0],
    mostAirFrostDaysMonth:allMyEntries.map(([k,v]) => ({ label: v.label, value: v.af })).sort((a,b)=>b.value-a.value)[0],
  }

  // Build WMO normals — monthly means over the active 30-year period.
  // For RR and sss, the normal is the mean of the 30 annual monthly totals
  // (i.e. average total per month), not the mean of daily values.
  const normals = normalsRaw.map((nb, i) => {
    // For RR and sss, sum per year-month then average those 30 sums.
    // We already have all daily values in nb.RR / nb.sss; divide by number of
    // years in the period to get mean monthly total.
    const yearsInPeriod = wmoPeriod.end - wmoPeriod.start + 1
    return {
      month: i + 1,
      name: MONTH_NAMES[i],
      meanDailyMax_Tx:   mean(nb.Tx),
      meanDailyMin_Tn:   mean(nb.Tn),
      meanTemp_Tdry:     mean(nb.Tdry),
      meanWetBulb_Twet:  mean(nb.Twet),
      meanPressure_Pmsl: mean(nb.Pmsl),
      meanRH:            mean(nb.RH),
      meanMonthlyRainfall_mm: nb.RR.length ? +(nb.RR.reduce((a,b)=>a+b,0) / yearsInPeriod).toFixed(1) : null,
      meanMonthlySunshine_hrs: nb.sss.length ? +(nb.sss.reduce((a,b)=>a+b,0) / yearsInPeriod).toFixed(1) : null,
      meanAirFrostDays:  +(nb.af / yearsInPeriod).toFixed(1),
      meanGroundFrostDays: +(nb.gf / yearsInPeriod).toFixed(1),
    }
  })

  return {
    overview: { startDate, endDate, totalDays },
    wmoNormals: { period: wmoPeriod.label, byMonth: normals },
    allTimeExtremes: extremes,
    recordMonths,
    monthlyTopTens,
    seasonalTopTens,
    longestRuns: computeRuns(rows),
    byMonth,
    byDecade,
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

// Detect "last N days / past N days / recent N days / last week / last month" etc.
// Returns number of days requested, or null if not found.
export function extractRecentDays(question) {
  const q = question.toLowerCase()
  const m = q.match(/\b(?:last|past|recent|previous)\s+(\d+)\s+(day|days|week|weeks|month|months)\b/)
  if (m) {
    const n = parseInt(m[1])
    if (m[2].startsWith('week'))  return n * 7
    if (m[2].startsWith('month')) return n * 30
    return n
  }
  if (/\blast\s+week\b/.test(q))   return 7
  if (/\bthis\s+week\b/.test(q))   return 7
  if (/\blast\s+month\b/.test(q))  return 30
  if (/\bthis\s+month\b/.test(q))  return 30
  if (/\blast\s+year\b/.test(q))   return 365
  if (/\bthis\s+year\b/.test(q))   return 365
  return null
}

// Detect explicit date ranges: "from X to Y", "between X and Y", "X to Y", "X through Y"
// Returns { start: "YYYY-MM-DD", end: "YYYY-MM-DD" } or null.
export function extractDateRange(question) {
  // Try to find two parseable dates with a range connector between them
  const connectors = /\s+(?:to|through|until|–|—|-|and)\s+/i
  const rangePat = /\b((?:\d{1,2}(?:st|nd|rd|th)?\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s*\d{0,4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\s+(?:to|through|until|–|—)\s+((?:\d{1,2}(?:st|nd|rd|th)?\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s*\d{0,4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/i

  // Parse the two dates from extractDates applied to just those substrings
  const m = question.match(rangePat)
  if (!m) return null
  const d1 = extractDates(m[1])
  const d2 = extractDates(m[2])
  if (!d1.specificDates.length || !d2.specificDates.length) return null
  const [start, end] = [d1.specificDates[0], d2.specificDates[0]].sort()
  return { start, end }
}

// Return all rows between two dates (inclusive), in chronological order.
export function getDateRangeRows(dayIndex, start, end) {
  return Object.values(dayIndex)
    .filter(r => r.date >= start && r.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date))
}

// Return the most recent N daily records relative to a reference date (today).
export function getRecentRows(dayIndex, nDays, today) {
  const refDate = today || new Date().toISOString().slice(0, 10)
  const cutoff = new Date(refDate)
  cutoff.setDate(cutoff.getDate() - nDays)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  return Object.values(dayIndex)
    .filter(r => r.date > cutoffStr && r.date <= refDate)
    .sort((a, b) => a.date.localeCompare(b.date))
}
