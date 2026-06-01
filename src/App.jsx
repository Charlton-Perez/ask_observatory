import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseCSV, buildContext, buildDayIndex, buildCalendarDayIndex, extractDates } from './dataParser'
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

function checkAccess() {
  return new URLSearchParams(window.location.search).get('token') === INVITE_TOKEN
}

export default function App() {
  const [hasAccess] = useState(checkAccess)
  const [context, setContext]         = useState(null)  // sent with every query
  const [dayIndex, setDayIndex]       = useState(null)  // "YYYY-MM-DD" lookups
  const [calIndex, setCalIndex]       = useState(null)  // "MM-DD" all-years lookups
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
      const { specificDates, calendarDays } = extractDates(text)
      // Specific dates: e.g. "14 October 1987" → one row
      const dailyRows = specificDates.map(d => dayIndex[d]).filter(Boolean)
      // Calendar days: e.g. "3rd January" → all ~118 Jan 3rd records across all years
      const calendarSlices = calendarDays.reduce((acc, key) => {
        if (calIndex[key]) acc[key] = calIndex[key]
        return acc
      }, {})

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text, context, dailyRows, calendarSlices, history: messages, token }),
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
