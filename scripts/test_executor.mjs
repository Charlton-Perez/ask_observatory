// Ad-hoc test harness: node test_executor.mjs
import fs from 'node:fs'
import Papa from 'papaparse'
import { createToolExecutor, describeToolCall } from '../src/toolExecutor.js'

const FIELDS = ['Tx','Tn','Tdry','Twet','Pmsl','RH','RR','rd','sss','sd_cm','af','gf','ff_ms','dd','ww']
const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n }
const pad = n => String(n).padStart(2, '0')

const text = fs.readFileSync(new URL('../public/ruao_data.csv', import.meta.url), 'utf8')
const { data } = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: h => h.trim(), transform: (v, f) => (f === 'RR' && String(v).trim().toLowerCase() === 'tr') ? '0.0' : v })

const dayIndex = {}
for (const row of data) {
  const y = parseInt(row.year), m = parseInt(row.month), d = parseInt(row.day)
  if (!y || !m || !d) continue
  const key = `${y}-${pad(m)}-${pad(d)}`
  const entry = { date: key }
  for (const f of FIELDS) entry[f] = num(row[f])
  dayIndex[key] = entry
}
console.log('rows indexed:', Object.keys(dayIndex).length)

const exec = createToolExecutor(dayIndex)
const show = (name, input) => {
  const { result, isError } = exec(name, input)
  console.log('\n──', describeToolCall(name, input), isError ? '[ERROR]' : '')
  console.log(JSON.stringify(result, null, 1).slice(0, 1200))
}

// 1. Hottest 5 days ever
show('rank_days', { field: 'Tx', order: 'desc', n: 5 })
// 2. Days >= 30°C in 1976
show('aggregate', { stat: 'count', filters: [{ field: 'Tx', op: '>=', value: 30 }], start: '1976-01-01', end: '1976-12-31' })
// 3. Mean Tx by decade in summer
show('aggregate', { field: 'Tx', stat: 'mean', group_by: 'decade', months: [6, 7, 8] })
// 4. Longest dry spells
show('find_runs', { field: 'RR', op: '==', value: 0, min_length: 10, top_n: 5 })
// 5. Heatwaves (Met Office definition)
show('find_runs', { field: 'Tx', op: '>=', value: 28, min_length: 3, top_n: 3 })
// 6. Frost probability on 15 June (calendar day count)
show('aggregate', { stat: 'count', filters: [{ field: 'Tn', op: '<', value: 0 }], calendar_day: '06-15' })
// 7. 25°C probability on 5 June across all years
show('aggregate', { stat: 'count', filters: [{ field: 'Tx', op: '>=', value: 25 }], calendar_day: '06-05' })
// 8. Raw rows for the Great Storm week
show('get_days', { start: '1987-10-14', end: '1987-10-17', fields: ['Tx', 'Tn', 'RR', 'ff_ms', 'dd', 'ww'] })
// 9. Over-cap raw request → helpful error expected
show('get_days', { start: '1908-01-01', end: '2020-12-31' })
// 10. Too many groups → helpful error expected
show('aggregate', { field: 'Tx', stat: 'mean', group_by: 'year_month' })
// 11. Annual rainfall totals grouped by year, era window
show('aggregate', { field: 'RR', stat: 'sum', group_by: 'year', start: '1991-01-01', end: '2020-12-31' })
// 12. Frost days per decade (climate change demo)
show('aggregate', { stat: 'count', filters: [{ field: 'Tn', op: '<', value: 0 }], group_by: 'decade' })
// 13. Bad input handling
show('aggregate', { field: 'Temp', stat: 'mean' })
show('rank_days', { field: 'Tx', order: 'downwards' })
show('find_runs', { field: 'RR', op: '~=', value: 0 })
show('aggregate', { field: 'Tx', stat: 'mean', start: '2030-01-01', end: '2031-01-01' })
