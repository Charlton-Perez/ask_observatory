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

// "YYYY-MM-DD" → full row object (all fields; sliced at query time)
export function buildDayIndex(rows) {
  const index = {}
  for (const row of rows) {
    const year = parseInt(row.year), month = parseInt(row.month), day = parseInt(row.day)
    if (!year || !month || !day) continue
    const key = dateStr(year, month, day)
    // Store all known numeric fields so new ones are picked up automatically
    const entry = { date: key }
    for (const f of ALL_FIELDS) entry[f] = num(row[f])
    index[key] = entry
  }
  return index
}

// "MM-DD" → array of { year, ...allFields } sorted by Tx desc
export function buildCalendarDayIndex(rows) {
  const index = {}
  for (const row of rows) {
    const year = parseInt(row.year), month = parseInt(row.month), day = parseInt(row.day)
    if (!year || !month || !day) continue
    const key = `${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
    if (!index[key]) index[key] = []
    const entry = { year }
    for (const f of ALL_FIELDS) entry[f] = num(row[f])
    index[key].push(entry)
  }
  for (const key of Object.keys(index)) {
    index[key].sort((a, b) => (b.Tx ?? -999) - (a.Tx ?? -999))
  }
  return index
}

// Query helpers — call these at question time with the detected field list
export function getDayRows(dayIndex, dates, fields) {
  return dates.map(d => dayIndex[d]).filter(Boolean).map(r => pickFields(r, fields))
}

export function getCalendarSlices(calendarIndex, calendarDays, fields) {
  return calendarDays.reduce((acc, key) => {
    if (calendarIndex[key]) acc[key] = calendarIndex[key].map(r => pickFields(r, fields))
    return acc
  }, {})
}

// ── Field detection ───────────────────────────────────────────────────────────
// Maps each data field to the keywords that imply it's relevant.
// To add a new field: add it here and to ALL_FIELDS below. Nothing else changes.
const FIELD_KEYWORDS = {
  // Temperature
  Tx:     ['temperature', 'temp', 'hot', 'warm', 'heat', 'max', 'maximum', 'highest', 'degrees', '°c', 'summer', 'heatwave', 'rank', 'ranking'],
  Tn:     ['temperature', 'temp', 'cold', 'cool', 'freeze', 'frost', 'min', 'minimum', 'lowest', 'degrees', '°c', 'winter', 'rank', 'ranking'],
  Tdry:   ['dry bulb', 'drybulb', 'observation temp', '09 utc', 'morning temp'],
  Twet:   ['wet bulb', 'wetbulb', 'wet-bulb', 'dew point', 'apparent temperature'],
  // Pressure
  Pmsl:   ['pressure', 'hpa', 'millibar', 'mbar', 'anticyclone', 'depression', 'cyclone', 'isobar', 'high pressure', 'low pressure', 'barometric'],
  // Humidity
  RH:     ['humidity', 'humid', 'damp', 'muggy', 'relative humidity', 'moisture'],
  // Wind
  ff_mph: ['wind', 'windy', 'gust', 'speed', 'mph', 'breeze', 'gale', 'storm', 'breezy'],
  dd_pt:  ['wind', 'direction', 'westerly', 'easterly', 'northerly', 'southerly', 'from the'],
  // Cloud & weather
  N10:    ['cloud', 'cloudy', 'overcast', 'clear', 'sunshine', 'sky', 'cover'],
  ww:     ['weather code', 'present weather', 'synoptic', 'ww'],
  // Precipitation
  RR:     ['rain', 'rainfall', 'precipitation', 'wet', 'flood', 'downpour', 'shower', 'mm'],
  rd:     ['rain day', 'rain fell', 'did it rain', 'rainy'],
  // Frost & snow
  af:     ['air frost', 'frost', 'freeze', 'freezing', 'frozen', 'icy'],
  gf:     ['ground frost', 'frost', 'freeze', 'frozen', 'icy'],
  tx0:    ['below zero', 'freezing', 'ice day', 'tx0'],
  sd_cm:  ['snow', 'snowy', 'snowfall', 'snow depth', 'blizzard', 'sleet', 'cm'],
  // Sunshine
  sss:    ['sunshine', 'sunny', 'sun hours', 'bright', 'solar', 'daylight', 'cloudy', 'overcast'],
}

// ALL_FIELDS is the authoritative list — must match CSV column headers exactly.
export const ALL_FIELDS = Object.keys(FIELD_KEYWORDS)

// Given a question string, return the subset of fields that are relevant.
// Falls back to ALL_FIELDS if nothing specific is detected.
export function detectFields(question) {
  const q = question.toLowerCase()
  const matched = ALL_FIELDS.filter(field =>
    FIELD_KEYWORDS[field].some(kw => q.includes(kw))
  )
  return matched.length > 0 ? matched : ALL_FIELDS
}

// Slice a row object down to only the requested fields (always keep year/date).
function pickFields(row, fields) {
  const out = {}
  if (row.date) out.date = row.date
  if (row.year) out.year = row.year
  for (const f of fields) if (f in row) out[f] = row[f]
  return out
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
    txValues: [], tnValues: [], tdryValues: [], twetValues: [],
    pmslValues: [], rhValues: [], ffValues: [],
    rrValues: [], sssValues: [], n10Values: [],
    afDays: 0, gfDays: 0, snowDays: 0,
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

    const tx = num(row.Tx), tn = num(row.Tn), tdry = num(row.Tdry), twet = num(row.Twet)
    const pmsl = num(row.Pmsl), rh = num(row.RH)
    const ff = num(row.ff_mph), rr = num(row.RR), sss = num(row.sss), sdcm = num(row.sd_cm)
    const af = num(row.af), gf = num(row.gf), n10 = num(row.N10)
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
    if (twet !== null) m.twetValues.push(twet)
    if (pmsl !== null) m.pmslValues.push(pmsl)
    if (rh   !== null) m.rhValues.push(rh)
    if (ff   !== null) m.ffValues.push(ff)
    if (rr   !== null) m.rrValues.push(rr)
    if (sss  !== null) m.sssValues.push(sss)
    if (n10  !== null) m.n10Values.push(n10)
    if (af === 1) m.afDays++
    if (gf === 1) m.gfDays++
    if (sdcm !== null && sdcm > 0) m.snowDays++

    if (!byYear[year]) byYear[year] = { txValues: [], tnValues: [], pmslValues: [], rrValues: [], sssValues: [] }
    if (tx   !== null) byYear[year].txValues.push(tx)
    if (tn   !== null) byYear[year].tnValues.push(tn)
    if (pmsl !== null) byYear[year].pmslValues.push(pmsl)
    if (rr   !== null) byYear[year].rrValues.push(rr)
    if (sss  !== null) byYear[year].sssValues.push(sss)
  }

  const mean = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null
  const sum  = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0)).toFixed(1) : null

  return {
    overview: { startDate, endDate, totalDays: totalRows, daysWithMissingTemps: missingRows },
    allTime: { recordMax: allTimeMax, recordMaxDate: allTimeMaxDate, recordMin: allTimeMin, recordMinDate: allTimeMinDate },
    byMonth: byMonth.map(m => ({
      month: m.month, name: m.name,
      recordMax: m.recordMax, recordMaxDate: m.recordMaxDate,
      recordMin: m.recordMin, recordMinDate: m.recordMinDate,
      meanDailyMax: mean(m.txValues), meanDailyMin: mean(m.tnValues),
      meanTemp: mean(m.tdryValues), meanWetBulb: mean(m.twetValues),
      meanPressure: mean(m.pmslValues), meanRH: mean(m.rhValues),
      meanWindMph: mean(m.ffValues),
      meanRainfallMm: mean(m.rrValues), meanSunshinHrs: mean(m.sssValues),
      meanCloudCover: mean(m.n10Values),
      meanAirFrostDays: m.afDays, meanGroundFrostDays: m.gfDays, meanSnowDays: m.snowDays,
      n: m.txValues.length,
    })),
    byYear: Object.entries(byYear).sort(([a],[b]) => a-b).map(([year, d]) => ({
      year: parseInt(year),
      meanMax: mean(d.txValues), meanMin: mean(d.tnValues),
      annualMax: d.txValues.length ? +Math.max(...d.txValues).toFixed(1) : null,
      annualMin: d.tnValues.length ? +Math.min(...d.tnValues).toFixed(1) : null,
      totalRainfallMm: sum(d.rrValues),
      totalSunshineHrs: sum(d.sssValues),
    })),
  }
}
