import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseCSV, buildContext, buildDayIndex, buildCalendarDayIndex, buildMonthFieldIndex, computeMonthExceedance, computeAnnualExceedanceCounts, countExceedanceInRange, extractDates, extractRecentDays, extractDateRange, getRecentRows, getDateRangeRows, MONTH_NAMES, MONTH_MAP, MONTH_NAME_RE } from './dataParser'
import styles from './App.module.css'

const INVITE_TOKEN = import.meta.env.VITE_INVITE_TOKEN

const EXAMPLE_QUESTIONS = [
  'What is the hottest temperature ever recorded?',
  'What was the wettest day on record?',
  'Which year had the most sunshine?',
  'What was the weather like on 14 October 1987?',
  'Which month tends to be the driest?',
  'How many air frost days does January typically have?',
]

const pad2 = n => String(n).padStart(2, '0')
const lastDayOf = (year, month) => new Date(year, month, 0).getDate()

// Thresholds whose monthly-% climatology is already pre-computed in buildContext's
// monthlyExceedance table — for these, a named-month climatology query needs no slice.
const PRE_COMPUTED_TX = [20, 25, 28, 30]
const PRE_COMPUTED_TN = [0, 5]
const PRE_COMPUTED_RR = [1, 5, 10]

// Detect threshold/frequency questions ("how many days above X …") and answer them
// with code-computed numbers so Claude never tallies raw rows itself.
//
// The result always carries { field, threshold, dir }. Then exactly one of two shapes:
//   • BOUNDED scope (a year, a month+year, a date range, or the current period):
//       an authoritative `count` for that window, plus `byMonth`, optional
//       `matchingDays`, and `climatology` (era means) for "compared to normal".
//   • CLIMATOLOGY only (no concrete period): per-era monthly % (named month) or
//       per-era annual day counts (whole year).
// Returns null when the question isn't a threshold question, or when the answer is
// already fully covered by the pre-computed monthlyExceedance context.
function detectAndComputeExceedance(question, mfIndex, dayIndex, today) {
  if (!mfIndex) return null
  const q = question.toLowerCase()
  const curYear  = parseInt(today.slice(0, 4))
  const curMonth = parseInt(today.slice(5, 7))

  const isProbQuery = /\b(probabilit|chance|likelihood|likel|how often|how frequent|how many days|number of days|what.{0,10}(percent|%|fraction)|exceed|exceeded|warmer than|hotter than|colder than|cooler than|above|over|below|under|frost|hot day|warm day|how warm|how hot|how cold|how likely|how rare|how common)\b/i.test(q)
  if (!isProbQuery) return null

  // Match threshold in order of specificity:
  // 1. explicit unit: "30°C", "30 degrees C", "30 deg C"
  // 2. degree marker alone: "30°", "30 degrees", "30 deg"
  // 3. bare number after a direction word: "above 30", "over 34", "exceeded 27"
  const threshM = q.match(/(\d+(?:\.\d+)?)\s*(?:°\s*c(?:elsius)?|degrees?\s*c(?:elsius)?|deg\s*c)\b/i) ||
                  q.match(/(\d+(?:\.\d+)?)\s*(?:degrees?|deg|°)\b/i) ||
                  q.match(/(?:above|over|exceed(?:s|ed|ing)?|warmer than|hotter than|colder than|cooler than|below|under)\s+(\d+(?:\.\d+)?)\b/i)
  if (!threshM) return null
  const threshold = parseFloat(threshM[1])
  if (threshold < -50 || threshold > 60) return null

  // "colder/cooler than" or "below/under" → Tn, direction <
  // Everything else → Tx, direction >=  (inclusive, matching common public usage of
  // "warmer than 30" / "above 30" to mean 30 and above).
  let field, dir
  if (/\b(min|minimum|night|overnight|tn)\b/.test(q) ||
      /\b(colder than|cooler than|below|under)\b/.test(q) ||
      (/\bfrost\b/.test(q) && threshold <= 5)) {
    field = 'Tn'; dir = '<'
  } else {
    field = 'Tx'; dir = '>='
  }

  const isPreComputed = (field === 'Tx' && dir === '>=' && PRE_COMPUTED_TX.includes(threshold)) ||
                        (field === 'Tn' && dir === '<'  && PRE_COMPUTED_TN.includes(threshold)) ||
                        (field === 'RR' && dir === '>=' && PRE_COMPUTED_RR.includes(threshold))

  // ── Determine the query scope ────────────────────────────────────────────────
  const thisYearQ  = /\b(this year|so far|year to date|ytd|current year|already this year)\b/.test(q)
  const thisMonthQ = /\b(this month|month to date|so far this month)\b/.test(q)
  const allYears   = [...question.matchAll(/\b((?:19|20)\d{2})\b/g)].map(m => parseInt(m[1]))
  const monthM     = q.match(new RegExp(`\\b(${MONTH_NAME_RE})\\b`, 'i'))
  const namedMonth = monthM ? MONTH_MAP[monthM[1].toLowerCase()] : null
  const dateRange  = extractDateRange(question)   // explicit range OR month+year

  // Build a bounded [start, end] window if the question names a concrete period.
  // notAfter caps partial current-year windows at today.
  let scope = null
  if (dateRange) {
    scope = { start: dateRange.start, end: dateRange.end, label: `${dateRange.start} to ${dateRange.end}` }
  } else if (thisMonthQ) {
    scope = { start: `${curYear}-${pad2(curMonth)}-01`, end: today, notAfter: today,
              label: `${MONTH_NAMES[curMonth - 1]} ${curYear} (to ${today})` }
  } else if (thisYearQ) {
    scope = { start: `${curYear}-01-01`, end: today, notAfter: today, label: `${curYear} (to ${today})` }
  } else if (allYears.length) {
    const y0 = Math.min(...allYears), y1 = Math.max(...allYears)
    if (namedMonth && y0 === y1) {
      scope = { start: `${y0}-${pad2(namedMonth)}-01`, end: `${y0}-${pad2(namedMonth)}-${pad2(lastDayOf(y0, namedMonth))}`,
                notAfter: y0 === curYear ? today : null, label: `${MONTH_NAMES[namedMonth - 1]} ${y0}` }
    } else {
      scope = { start: `${y0}-01-01`, end: `${y1}-12-31`,
                notAfter: y1 === curYear ? today : null, label: y0 === y1 ? `${y0}` : `${y0}–${y1}` }
    }
  }

  // ── Bounded scope → authoritative code-computed count ────────────────────────
  if (scope && dayIndex) {
    const counted = countExceedanceInRange(dayIndex, field, threshold, dir, scope.start, scope.end, scope.notAfter)
    return {
      type: 'threshold_count', field, threshold, dir,
      scope: scope.label,
      ...counted,
      // Long-term context for "compared to normal" — era means only (no bulky per-year list).
      climatology: namedMonth
        ? computeMonthExceedance(mfIndex, namedMonth, field, threshold, dir)
        : { byEra: computeAnnualExceedanceCounts(mfIndex, field, threshold, dir, null, null).byEra },
    }
  }

  // ── Climatology only (no concrete period) ────────────────────────────────────
  if (namedMonth) {
    // Named calendar month, all years: percentage of days per era.
    // Pre-computed thresholds are already in the monthlyExceedance context.
    if (isPreComputed) return null
    return computeMonthExceedance(mfIndex, namedMonth, field, threshold, dir)
  }
  // Whole year, all years: mean days-per-year by era + full per-year list.
  return {
    ...computeAnnualExceedanceCounts(mfIndex, field, threshold, dir, null, null),
    note: 'Monthly exceedance percentages are also in the monthlyExceedance context.',
  }
}

// Detect ETCCDI index queries for a specific year or month+year and compute
// counts from dayIndex in the browser. Covers "this year so far", "in 2023",
// "in June 2023" without sending raw rows to the API.
const ETCCDI_TERMS = /\b(summer days?|tropical nights?|frost days?|ice days?|heavy rain days?|SU\b|TR\b|FD\b|ID\b|R10|R20|warm days?|hot days?)\b/i
function detectAndComputeEtccdi(question, dayIndex, today) {
  if (!dayIndex) return null
  if (!ETCCDI_TERMS.test(question)) return null

  const q        = question.toLowerCase()
  const curYear  = parseInt(today.slice(0, 4))
  const curDate  = today

  // Detect target year(s) — a single year, a range ("2000 to 2010"), or the current year.
  let startYear = null, endYear = null
  if (/\b(this year|so far|year to date|ytd|current year)\b/.test(q)) {
    startYear = endYear = curYear
  } else {
    const years = [...question.matchAll(/\b((?:19|20)\d{2})\b/g)].map(m => parseInt(m[1]))
    if (years.length) { startYear = Math.min(...years); endYear = Math.max(...years) }
  }
  if (startYear == null) return null

  // Detect optional target month (only meaningful for a single year)
  const monthM = q.match(new RegExp(`\\b(${MONTH_NAME_RE})\\b`, 'i'))
  const targetMonth = (monthM && startYear === endYear) ? MONTH_MAP[monthM[1].toLowerCase()] : null

  // Filter dayIndex to the requested window (capped at today for the current year)
  const rows = Object.values(dayIndex).filter(r => {
    if (!r.date) return false
    const y = parseInt(r.date.slice(0, 4))
    const m = parseInt(r.date.slice(5, 7))
    if (y < startYear || y > endYear) return false
    if (targetMonth && m !== targetMonth) return false
    if (endYear === curYear && r.date > curDate) return false  // exclude future
    return true
  })
  if (!rows.length) return null

  const count = (fn) => rows.filter(fn).length
  const yearsSpanned = endYear - startYear + 1
  return {
    type:       'etccdi_slice',
    yearRange:  startYear === endYear ? `${startYear}` : `${startYear}–${endYear}`,
    yearsSpanned,
    month:      targetMonth ? MONTH_NAMES[targetMonth - 1] : 'full year',
    daysInRecord: rows.length,
    // These are TOTALS across the whole window (not per-year). Divide by yearsSpanned for an annual average.
    SU:  count(r => r.Tx != null && r.Tx >  25),
    TR:  count(r => r.Tn != null && r.Tn >  20),
    ID:  count(r => r.Tx != null && r.Tx <  0),
    FD:  count(r => r.Tn != null && r.Tn <  0),
    R10: count(r => r.RR != null && r.RR >= 10),
    R20: count(r => r.RR != null && r.RR >= 20),
    note: endYear === curYear && startYear === endYear ? `Partial year to ${curDate}` : `Totals across ${yearsSpanned} year(s)`,
  }
}

function checkAccess() {
  return new URLSearchParams(window.location.search).get('token') === INVITE_TOKEN
}

export default function App() {
  const [hasAccess] = useState(checkAccess)
  const [context, setContext]         = useState(null)  // sent with every query
  const [dayIndex, setDayIndex]       = useState(null)  // "YYYY-MM-DD" lookups
  const [calIndex, setCalIndex]       = useState(null)  // "MM-DD" all-years lookups
  const [mfIndex, setMfIndex]         = useState(null)  // month→field→[{year,value}] for on-demand exceedance
  const [loadError, setLoadError] = useState(null)
  const [messages, setMessages] = useState([])
  const [question, setQuestion] = useState('')
  const [asking, setAsking]     = useState(false)
  const bottomRef = useRef(null)
  const token = new URLSearchParams(window.location.search).get('token')

  // Load and parse the dataset once on mount
  useEffect(() => {
    if (!hasAccess) return
    fetch('/ruao_data.csv')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text() })
      .then(text => {
        const rows = parseCSV(text)
        setContext(buildContext(rows))
        setDayIndex(buildDayIndex(rows))
        setCalIndex(buildCalendarDayIndex(rows))
        setMfIndex(buildMonthFieldIndex(rows))
      })
      .catch(e => setLoadError('Could not load dataset: ' + e.message))
  }, [hasAccess])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, asking])

  const askQuestion = async (q) => {
    const text = (q || question).trim()
    if (!text || !context || asking) return
    setQuestion('')
    setMessages(prev => [...prev, { role: 'user', text }])
    setAsking(true)
    try {
      const today = new Date().toISOString().slice(0, 10)

      // 1. Explicit date range: "25 May to 1 June" → every row in that span
      const dateRange = extractDateRange(text)

      // 2. Recent period: "last 30 days / this week" → rows from today backwards
      const recentN = !dateRange ? extractRecentDays(text) : null
      const recentRows = dateRange
        ? getDateRangeRows(dayIndex, dateRange.start, dateRange.end)
        : recentN ? getRecentRows(dayIndex, recentN, today) : []

      // 3. Specific individual dates — skip if already covered by a range/recent query
      const { specificDates, calendarDays } = extractDates(text)
      const dailyRows = (dateRange || recentN)
        ? []  // range/recent already covers any dates mentioned
        : specificDates.map(d => dayIndex[d]).filter(Boolean)

      // 4. Calendar-day slices: "3rd January" → all historical Jan 3rd records
      const calendarSlices = calendarDays.reduce((acc, key) => {
        if (calIndex[key]) acc[key] = calIndex[key]
        return acc
      }, {})

      // 5. ETCCDI index queries for a specific year / month+year (computed from dayIndex)
      const etccdiSlice = detectAndComputeEtccdi(text, dayIndex, today)

      // 6. On-demand exceedance: detect threshold questions not in pre-computed table.
      //    Extracts field, threshold, direction and month from the question text,
      //    computes the exceedance % per era in the browser, and sends only the result.
      const exceedanceSlice = detectAndComputeExceedance(text, mfIndex, dayIndex, today)

      // When we've produced an authoritative code-computed count, suppress the raw
      // rows for the same window — sending both causes Claude to recount and get
      // confused when near-threshold rows appear but don't qualify. (etccdiSlice and
      // the bounded exceedance count both carry the definitive numbers already.)
      const hasComputedCount = exceedanceSlice?.count != null || etccdiSlice != null
      const finalRecentRows = hasComputedCount ? [] : recentRows

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text, context, dailyRows, calendarSlices, recentRows: finalRecentRows, exceedanceSlice, etccdiSlice, today, history: messages, token }),
      })
      if (!res.ok) throw new Error(await res.text())
      const { answer } = await res.json()
      setMessages(prev => [...prev, { role: 'assistant', text: answer }])
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', text: `Sorry, something went wrong: ${e.message}`, error: true }])
    } finally {
      setAsking(false)
    }
  }

  const onKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askQuestion() }
  }

  if (!hasAccess) {
    return (
      <div className={styles.gateWrap}>
        <div className={styles.gate}>
          <div className={styles.gateLogo}>&#9728;</div>
          <h1>Reading Atmospheric Observatory</h1>
          <p>This tool is available to invited users only.<br />Please use the link provided to you.</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.headerIcon}>&#9728;</span>
        <div>
          <h1 className={styles.headerTitle}>Reading Atmospheric Observatory</h1>
          <p className={styles.headerSub}>Ask questions about 100+ years of daily weather records</p>
        </div>
      </header>

      <main className={styles.main}>
        {!context && !loadError && (
          <div className={styles.loading}><p>Loading observatory data&hellip;</p></div>
        )}
        {loadError && (
          <div className={styles.loading}><p className={styles.error}>{loadError}</p></div>
        )}

        {context && (
          <>
            <div className={styles.dataCard}>
              <span className={styles.dataTag}>Dataset loaded</span>
              <span className={styles.dataInfo}>
                {context.overview.totalDays.toLocaleString()} daily records &mdash; {context.overview.startDate} to {context.overview.endDate}
              </span>
            </div>

            {messages.length === 0 && (
              <div className={styles.examples}>
                <p className={styles.examplesLabel}>Try asking&hellip;</p>
                <div className={styles.exampleList}>
                  {EXAMPLE_QUESTIONS.map(q => (
                    <button key={q} className={styles.exampleBtn} onClick={() => askQuestion(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className={styles.chatArea}>
              {messages.map((m, i) => (
                <div key={i} className={`${styles.bubble} ${m.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant} ${m.error ? styles.bubbleError : ''}`}>
                  {m.role === 'assistant' && <span className={styles.bubbleLabel}>Observatory AI</span>}
                  {m.role === 'user'
                    ? <p className={styles.bubbleText}>{m.text}</p>
                    : <div className={styles.markdown}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                      </div>
                  }
                </div>
              ))}
              {asking && (
                <div className={`${styles.bubble} ${styles.bubbleAssistant}`}>
                  <span className={styles.bubbleLabel}>Observatory AI</span>
                  <p className={styles.typing}><span /><span /><span /></p>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            <div className={styles.inputRow}>
              <textarea
                className={styles.input}
                placeholder="Ask about the weather records…"
                value={question}
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
                disabled={asking}
              />
              <button
                className={styles.sendBtn}
                onClick={() => askQuestion()}
                disabled={!question.trim() || asking}
              >
                Ask
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
