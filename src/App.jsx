import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseCSV, buildContext, buildDayIndex, buildCalendarDayIndex, buildMonthFieldIndex, computeMonthExceedance, computeAnnualExceedanceCounts, extractDates, extractRecentDays, extractDateRange, getRecentRows, getDateRangeRows } from './dataParser'
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

const MONTH_MAP_APP = {
  january:1,february:2,march:3,april:4,may:5,june:6,
  july:7,august:8,september:9,october:10,november:11,december:12,
  jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12,
}

const PRE_COMPUTED_TX = [20, 25, 28, 30]
const PRE_COMPUTED_TN = [0, 5]
const PRE_COMPUTED_RR = [1, 5, 10]
const MONTH_NAMES_APP = ['January','February','March','April','May','June','July','August','September','October','November','December']

// Detect threshold/frequency questions and compute exceedance on the fly.
// Returns a result combining:
//   historical — climatological background (% per era for a month, or per-year counts)
//   currentPeriod — actual count for "this year", "this month", or a specific year/month
// Pre-computed thresholds skip historical (already in context) but still compute currentPeriod.
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
  // Everything else → Tx, direction >=
  // Note: "warmer/hotter than X" and "above X" are treated as >= X (inclusive),
  // matching common meteorological and public usage.
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

  // Detect time scope indicators
  const thisYearQ  = /\b(this year|so far|year to date|ytd|current year|already this year)\b/.test(q)
  const thisMonthQ = /\b(this month|month to date|so far this month)\b/.test(q)
  const allYears   = [...question.matchAll(/\b((?:19|20)\d{2})\b/g)].map(m => parseInt(m[1]))

  // Named month in question
  const monthM     = q.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i)
  const namedMonth = monthM ? MONTH_MAP_APP[monthM[1].toLowerCase()] : null

  const wantsCurrentPeriod = thisYearQ || thisMonthQ || allYears.length > 0

  // Pre-computed + no current-period request → already in context, skip
  if (isPreComputed && !wantsCurrentPeriod) return null

  const result = { type: 'threshold_query', field, threshold, dir }

  // Historical background (skip if pre-computed — already in monthlyExceedance context)
  if (!isPreComputed) {
    const histYears = allYears.filter(y => !(thisYearQ && y === curYear))
    if (namedMonth && !thisMonthQ) {
      result.historical = computeMonthExceedance(mfIndex, namedMonth, field, threshold, dir)
    } else if (!namedMonth) {
      const sy = histYears.length ? Math.min(...histYears) : null
      const ey = histYears.length ? Math.max(...histYears) : null
      result.historical = computeAnnualExceedanceCounts(mfIndex, field, threshold, dir, sy, ey)
    }
  } else {
    result.historicalNote = `Historical exceedance data for ${field}${dir}${threshold} is in the monthlyExceedance context.`
  }

  // Current-period actual count — computed from dayIndex when a specific period is requested
  if (wantsCurrentPeriod && dayIndex) {
    const scopeYear  = thisYearQ ? curYear
                     : allYears.length === 1 ? allYears[0]
                     : allYears.length > 1  ? Math.max(...allYears)
                     : curYear
    const scopeMonth = thisMonthQ ? curMonth : namedMonth

    const rows = Object.values(dayIndex).filter(r => {
      if (!r.date) return false
      const ry = parseInt(r.date.slice(0, 4))
      const rm = parseInt(r.date.slice(5, 7))
      if (ry !== scopeYear) return false
      if (scopeMonth && rm !== scopeMonth) return false
      if (scopeYear === curYear && r.date > today) return false
      return true
    })
    const matchRows = rows.filter(r => {
      const v = r[field]; return v != null && (dir === '>=' ? v >= threshold : v < threshold)
    }).sort((a, b) => a.date.localeCompare(b.date))
    const monthLabel = scopeMonth ? `${MONTH_NAMES_APP[scopeMonth - 1]} ` : ''
    const partial    = scopeYear === curYear ? ` (to ${today})` : ''

    // Per-month breakdown — prevents Claude from attributing May events to June context
    const byMonth = {}
    for (const r of matchRows) {
      const mName = MONTH_NAMES_APP[parseInt(r.date.slice(5, 7)) - 1]
      byMonth[mName] = (byMonth[mName] || 0) + 1
    }

    result.currentPeriod = {
      scope: `${monthLabel}${scopeYear}${partial}`,
      daysInRecord: rows.length,
      count: matchRows.length,
      byMonth,
      // Include actual dates when count is small enough to list sensibly
      ...(matchRows.length <= 20 && {
        matchingDays: matchRows.map(r => ({ date: r.date, [field]: r[field] })),
      }),
    }
  }

  return result
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

  // Detect target year
  let targetYear = null
  if (/\b(this year|so far|year to date|ytd|current year)\b/.test(q)) targetYear = curYear
  else {
    const ym = question.match(/\b((19|20)\d{2})\b/)
    if (ym) targetYear = parseInt(ym[1])
  }
  if (!targetYear) return null

  // Detect optional target month
  const monthM = q.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i)
  const targetMonth = monthM ? MONTH_MAP_APP[monthM[1].toLowerCase()] : null

  // Filter dayIndex
  const rows = Object.values(dayIndex).filter(r => {
    if (!r.date) return false
    const y = parseInt(r.date.slice(0, 4))
    const m = parseInt(r.date.slice(5, 7))
    if (y !== targetYear) return false
    if (targetMonth && m !== targetMonth) return false
    if (targetYear === curYear && r.date > curDate) return false  // exclude future
    return true
  })
  if (!rows.length) return null

  const count = (fn) => rows.filter(fn).length
  return {
    type:       'etccdi_slice',
    year:       targetYear,
    month:      targetMonth || 'full year',
    daysInRecord: rows.length,
    SU:  count(r => r.Tx != null && r.Tx >  25),
    TR:  count(r => r.Tn != null && r.Tn >  20),
    ID:  count(r => r.Tx != null && r.Tx <  0),
    FD:  count(r => r.Tn != null && r.Tn <  0),
    R10: count(r => r.RR != null && r.RR >= 10),
    R20: count(r => r.RR != null && r.RR >= 20),
    note: targetYear === curYear ? `Partial year to ${curDate}` : 'Full year',
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

      // If exceedanceSlice has a currentPeriod count, suppress recentRows for the same
      // window — sending raw rows alongside a pre-computed count causes Claude to recount
      // and get confused when rows near the threshold appear but don't qualify.
      const finalRecentRows = exceedanceSlice?.currentPeriod ? [] : recentRows

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
