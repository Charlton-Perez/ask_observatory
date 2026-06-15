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

// Detect threshold/probability questions and compute exceedance on the fly.
// Returns null if the question isn't about a specific threshold, or if the
// pre-computed monthlyExceedance table already covers it (avoids duplication).
// When it fires it returns a compact object: { field, threshold, dir, monthName, pct_all, byEra }
const PRE_COMPUTED_TX = [20, 25, 28, 30]
const PRE_COMPUTED_TN = [0, 5]
const PRE_COMPUTED_RR = [1, 5, 10]

function detectAndComputeExceedance(question, mfIndex) {
  if (!mfIndex) return null
  const q = question.toLowerCase()

  // Must look like a threshold/frequency/probability query
  const isProbQuery = /\b(probabilit|chance|likelihood|likel|how often|how frequent|how many days|number of days|what.{0,10}(percent|%|fraction)|exceed|exceeded|warmer than|hotter than|colder than|cooler than|above|over|below|under|frost|hot day|warm day|how warm|how hot|how cold|how likely|how rare|how common)\b/i.test(q)
  if (!isProbQuery) return null

  // Extract numeric threshold — accepts "27°C", "27°", "27 degrees C", "27 degrees", "27 deg"
  const threshM = q.match(/(\d+(?:\.\d+)?)\s*(?:°\s*c(?:elsius)?|degrees?\s*c(?:elsius)?|deg\s*c)\b/i) ||
                  q.match(/(\d+(?:\.\d+)?)\s*(?:degrees?|deg|°)\b/i)
  if (!threshM) return null
  const threshold = parseFloat(threshM[1])
  if (threshold < -50 || threshold > 60) return null  // sanity check

  // Determine field and direction
  let field, dir
  if (/\b(min|minimum|night|overnight|tn|frost)\b/.test(q) || /\b(below|under)\b/.test(q)) {
    field = 'Tn'; dir = threshold <= 5 ? '<' : '>='
  } else {
    field = 'Tx'; dir = '>='
  }

  // Check if this is already in the pre-computed table (avoid sending duplicate info)
  const preComputed = (field === 'Tx' && dir === '>=' && PRE_COMPUTED_TX.includes(threshold)) ||
                      (field === 'Tn' && dir === '<'  && PRE_COMPUTED_TN.includes(threshold)) ||
                      (field === 'RR' && dir === '>=' && PRE_COMPUTED_RR.includes(threshold))
  if (preComputed) return null

  // Try to extract a month
  const monthM = q.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i)
  const month = monthM ? MONTH_MAP_APP[monthM[1].toLowerCase()] : null

  if (month) {
    // Month-level: return exceedance % per era
    return computeMonthExceedance(mfIndex, month, field, threshold, dir)
  } else {
    // No month: return annual day counts, optionally filtered by year range
    const yearMatches = [...question.matchAll(/\b((?:19|20)\d{2})\b/g)].map(m => parseInt(m[1]))
    const startYear = yearMatches.length ? Math.min(...yearMatches) : null
    const endYear   = yearMatches.length ? Math.max(...yearMatches) : null
    return computeAnnualExceedanceCounts(mfIndex, field, threshold, dir, startYear, endYear)
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

      // 5. On-demand exceedance: detect threshold questions not in pre-computed table.
      //    Extracts field, threshold, direction and month from the question text,
      //    computes the exceedance % per era in the browser, and sends only the result.
      const exceedanceSlice = detectAndComputeExceedance(text, mfIndex)

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text, context, dailyRows, calendarSlices, recentRows, exceedanceSlice, today, history: messages, token }),
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
