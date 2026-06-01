import Papa from 'papaparse'

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
]

function num(v) {
  const n = parseFloat(v)
  return isNaN(n) ? null : n
}

function dateStr(row) {
  return `${row.year}-${String(row.month).padStart(2,'0')}-${String(row.day).padStart(2,'0')}`
}

export function parseCSV(text) {
  const result = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim(),
  })
  return result.data
}

// Build a date-keyed index: "YYYY-MM-DD" → cleaned row object
export function buildIndex(rows) {
  const index = {}
  for (const row of rows) {
    const year = parseInt(row.year)
    const month = parseInt(row.month)
    const day = parseInt(row.day)
    if (!year || !month || !day) continue
    const key = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
    index[key] = {
      date: key,
      Tx: num(row.Tx), Tn: num(row.Tn), Tdry: num(row.Tdry),
      Pmsl: num(row.Pmsl), RH: num(row.RH),
    }
  }
  return index
}

const MONTH_MAP = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12,
}

// Extract specific dates mentioned in a free-text question.
// Returns array of "YYYY-MM-DD" strings.
export function extractDates(question) {
  const q = question.toLowerCase()
  const dates = new Set()

  // ISO / numeric: 1987-10-14, 14/10/1987, 14-10-1987
  const iso = /\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/g
  for (const m of question.matchAll(iso)) {
    dates.add(`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`)
  }
  const dmy = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/g
  for (const m of question.matchAll(dmy)) {
    dates.add(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`)
  }

  // Natural language: "14 October 1987", "October 14 1987", "14th October 1987"
  const nl1 = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{4})\b/gi
  for (const m of question.matchAll(nl1)) {
    const mo = MONTH_MAP[m[2].toLowerCase()]
    if (mo) dates.add(`${m[3]}-${String(mo).padStart(2,'0')}-${m[1].padStart(2,'0')}`)
  }
  const nl2 = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b/gi
  for (const m of question.matchAll(nl2)) {
    const mo = MONTH_MAP[m[1].toLowerCase()]
    if (mo) dates.add(`${m[3]}-${String(mo).padStart(2,'0')}-${m[2].padStart(2,'0')}`)
  }

  return [...dates]
}

export function buildSummary(rows) {
  // Per-month accumulators
  const byMonth = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    name: MONTH_NAMES[i],
    recordMax: null, recordMaxDate: null,
    recordMin: null, recordMinDate: null,
    txValues: [], tnValues: [], tdryValues: [], pmslValues: [], rhValues: [],
  }))

  // All-time
  let allTimeMax = null, allTimeMaxDate = null
  let allTimeMin = null, allTimeMinDate = null
  let startDate = null, endDate = null
  let totalRows = 0, missingRows = 0

  // Per-year accumulators
  const byYear = {}

  for (const row of rows) {
    const year = parseInt(row.year)
    const month = parseInt(row.month)
    const day = parseInt(row.day)
    if (!year || !month || !day) continue

    totalRows++
    const d = dateStr(row)
    if (!startDate || d < startDate) startDate = d
    if (!endDate || d > endDate) endDate = d

    const tx = num(row.Tx)
    const tn = num(row.Tn)
    const tdry = num(row.Tdry)
    const pmsl = num(row.Pmsl)
    const rh = num(row.RH)

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

    // Annual
    if (!byYear[year]) byYear[year] = { txValues: [], tnValues: [], pmslValues: [] }
    if (tx !== null) byYear[year].txValues.push(tx)
    if (tn !== null) byYear[year].tnValues.push(tn)
    if (pmsl !== null) byYear[year].pmslValues.push(pmsl)
  }

  const mean = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null

  const monthSummaries = byMonth.map(m => ({
    month: m.month,
    name: m.name,
    recordMax: m.recordMax,
    recordMaxDate: m.recordMaxDate,
    recordMin: m.recordMin,
    recordMinDate: m.recordMinDate,
    meanDailyMax: mean(m.txValues),
    meanDailyMin: mean(m.tnValues),
    meanTemp: mean(m.tdryValues),
    meanPressure: mean(m.pmslValues),
    meanRH: mean(m.rhValues),
    n: m.txValues.length,
  }))

  const annualSummaries = Object.entries(byYear)
    .sort(([a], [b]) => a - b)
    .map(([year, d]) => ({
      year: parseInt(year),
      meanMax: mean(d.txValues),
      meanMin: mean(d.tnValues),
      annualMax: d.txValues.length ? +Math.max(...d.txValues).toFixed(1) : null,
      annualMin: d.tnValues.length ? +Math.min(...d.tnValues).toFixed(1) : null,
    }))

  return {
    overview: { startDate, endDate, totalDays: totalRows, daysWithMissingTemps: missingRows },
    allTime: {
      recordMax: allTimeMax, recordMaxDate: allTimeMaxDate,
      recordMin: allTimeMin, recordMinDate: allTimeMinDate,
    },
    byMonth: monthSummaries,
    byYear: annualSummaries,
  }
}
