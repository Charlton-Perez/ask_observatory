import Papa from 'papaparse'

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
]

export const MONTH_MAP = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12,
}

function num(v) {
  const n = parseFloat(v)
  return isNaN(n) ? null : n
}

function dateStr(year, month, day) {
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
}

export function parseCSV(text) {
  const result = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim(),
  })
  return result.data
}

// "YYYY-MM-DD" → full row object (for specific date lookups)
export function buildDayIndex(rows) {
  const index = {}
  for (const row of rows) {
    const year = parseInt(row.year), month = parseInt(row.month), day = parseInt(row.day)
    if (!year || !month || !day) continue
    const key = dateStr(year, month, day)
    index[key] = { date: key, Tx: num(row.Tx), Tn: num(row.Tn), Tdry: num(row.Tdry), Pmsl: num(row.Pmsl), RH: num(row.RH) }
  }
  return index
}

// "MM-DD" → array of { year, Tx, Tn, Tdry, Pmsl, RH } sorted by Tx desc
// Covers "all-time Nth of Month" ranking questions
export function buildCalendarDayIndex(rows) {
  const index = {}
  for (const row of rows) {
    const year = parseInt(row.year), month = parseInt(row.month), day = parseInt(row.day)
    if (!year || !month || !day) continue
    const key = `${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
    if (!index[key]) index[key] = []
    index[key].push({ year, Tx: num(row.Tx), Tn: num(row.Tn), Tdry: num(row.Tdry), Pmsl: num(row.Pmsl), RH: num(row.RH) })
  }
  // Sort each calendar day by Tx descending so Claude can rank directly
  for (const key of Object.keys(index)) {
    index[key].sort((a, b) => (b.Tx ?? -999) - (a.Tx ?? -999))
  }
  return index
}

// ── Date / calendar-day extraction from free text ────────────────────────────

// Returns { specificDates: ["YYYY-MM-DD",...], calendarDays: ["MM-DD",...] }
export function extractDateReferences(question) {
  const specificDates = new Set()
  const calendarDays = new Set()

  // Specific full dates ─────────────────────────────────────────────────────
  // ISO: 1987-10-14
  for (const m of question.matchAll(/\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/g))
    specificDates.add(`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`)

  // DMY: 14/10/1987 or 14-10-1987
  for (const m of question.matchAll(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/g))
    specificDates.add(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`)

  // "14 October 1987" / "14th October 1987"
  for (const m of question.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{4})\b/gi)) {
    const mo = MONTH_MAP[m[2].toLowerCase()]
    if (mo) specificDates.add(`${m[3]}-${String(mo).padStart(2,'0')}-${m[1].padStart(2,'0')}`)
  }

  // "October 14 1987" / "October 14th, 1987"
  for (const m of question.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b/gi)) {
    const mo = MONTH_MAP[m[1].toLowerCase()]
    if (mo) specificDates.add(`${m[3]}-${String(mo).padStart(2,'0')}-${m[2].padStart(2,'0')}`)
  }

  // Calendar day only (no year) ─────────────────────────────────────────────
  // "2nd June", "June 2", "June 2nd", "2 June" — without a year following
  for (const m of question.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/gi)) {
    if (!question.match(new RegExp(m[0] + '\\s+\\d{4}'))) { // skip if already matched as full date
      const mo = MONTH_MAP[m[2].toLowerCase()]
      if (mo) calendarDays.add(`${String(mo).padStart(2,'0')}-${m[1].padStart(2,'0')}`)
    }
  }
  for (const m of question.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi)) {
    if (!question.match(new RegExp(m[0] + '[,\\s]+\\d{4}'))) {
      const mo = MONTH_MAP[m[1].toLowerCase()]
      if (mo) calendarDays.add(`${String(mo).padStart(2,'0')}-${m[2].padStart(2,'0')}`)
    }
  }

  return { specificDates: [...specificDates], calendarDays: [...calendarDays] }
}

// ── Summary ──────────────────────────────────────────────────────────────────

export function buildSummary(rows) {
  const byMonth = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1, name: MONTH_NAMES[i],
    recordMax: null, recordMaxDate: null,
    recordMin: null, recordMinDate: null,
    txValues: [], tnValues: [], tdryValues: [], pmslValues: [], rhValues: [],
  }))

  let allTimeMax = null, allTimeMaxDate = null
  let allTimeMin = null, allTimeMinDate = null
  let startDate = null, endDate = null
  let totalRows = 0, missingRows = 0
  const byYear = {}

  for (const row of rows) {
    const year = parseInt(row.year), month = parseInt(row.month), day = parseInt(row.day)
    if (!year || !month || !day) continue
    totalRows++
    const d = dateStr(year, month, day)
    if (!startDate || d < startDate) startDate = d
    if (!endDate || d > endDate) endDate = d

    const tx = num(row.Tx), tn = num(row.Tn), tdry = num(row.Tdry)
    const pmsl = num(row.Pmsl), rh = num(row.RH)
    if (tx === null && tn === null) missingRows++

    const m = byMonth[month - 1]
    if (tx !== null) {
      m.txValues.push(tx)
      if (m.recordMax === null || tx > m.recordMax) { m.recordMax = tx; m.recordMaxDate = d }
      if (allTimeMax === null || tx > allTimeMax) { allTimeMax = tx; allTimeMaxDate = d }
    }
    if (tn !== null) {
      m.tnValues.push(tn)
      if (m.recordMin === null || tn < m.recordMin) { m.recordMin = tn; m.recordMinDate = d }
      if (allTimeMin === null || tn < allTimeMin) { allTimeMin = tn; allTimeMinDate = d }
    }
    if (tdry !== null) m.tdryValues.push(tdry)
    if (pmsl !== null) m.pmslValues.push(pmsl)
    if (rh !== null) m.rhValues.push(rh)

    if (!byYear[year]) byYear[year] = { txValues: [], tnValues: [], pmslValues: [] }
    if (tx !== null) byYear[year].txValues.push(tx)
    if (tn !== null) byYear[year].tnValues.push(tn)
    if (pmsl !== null) byYear[year].pmslValues.push(pmsl)
  }

  const mean = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null

  return {
    overview: { startDate, endDate, totalDays: totalRows, daysWithMissingTemps: missingRows },
    allTime: { recordMax: allTimeMax, recordMaxDate: allTimeMaxDate, recordMin: allTimeMin, recordMinDate: allTimeMinDate },
    byMonth: byMonth.map(m => ({
      month: m.month, name: m.name,
      recordMax: m.recordMax, recordMaxDate: m.recordMaxDate,
      recordMin: m.recordMin, recordMinDate: m.recordMinDate,
      meanDailyMax: mean(m.txValues), meanDailyMin: mean(m.tnValues),
      meanTemp: mean(m.tdryValues), meanPressure: mean(m.pmslValues), meanRH: mean(m.rhValues),
      n: m.txValues.length,
    })),
    byYear: Object.entries(byYear).sort(([a],[b]) => a-b).map(([year, d]) => ({
      year: parseInt(year),
      meanMax: mean(d.txValues), meanMin: mean(d.tnValues),
      annualMax: d.txValues.length ? +Math.max(...d.txValues).toFixed(1) : null,
      annualMin: d.tnValues.length ? +Math.min(...d.tnValues).toFixed(1) : null,
    })),
  }
}
