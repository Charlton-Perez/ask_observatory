import { useState, useRef, useEffect } from 'react'
import { parseCSV, buildSummary } from './dataParser'
import styles from './App.module.css'

const INVITE_TOKEN = import.meta.env.VITE_INVITE_TOKEN

const EXAMPLE_QUESTIONS = [
  'What is the hottest temperature ever recorded in October?',
  'Which month has the highest average daily maximum temperature?',
  'What was the coldest day on record and when did it occur?',
  'How has the annual mean maximum temperature changed over the decades?',
  'What is the average pressure in January?',
]

function checkAccess() {
  const params = new URLSearchParams(window.location.search)
  return params.get('token') === INVITE_TOKEN
}

export default function App() {
  const [hasAccess] = useState(checkAccess)
  const [summary, setSummary] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [messages, setMessages] = useState([])
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const bottomRef = useRef(null)
  const token = new URLSearchParams(window.location.search).get('token')

  useEffect(() => {
    if (!hasAccess) return
    fetch('/ruao_data.csv')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text() })
      .then(text => setSummary(buildSummary(parseCSV(text))))
      .catch(e => setLoadError('Could not load dataset: ' + e.message))
  }, [hasAccess])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, asking])

  const askQuestion = async (q) => {
    const text = (q || question).trim()
    if (!text || !summary || asking) return
    setQuestion('')
    setMessages(prev => [...prev, { role: 'user', text }])
    setAsking(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text, summary, token }),
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
        {!summary && !loadError && (
          <div className={styles.loading}>
            <p>Loading observatory data&hellip;</p>
          </div>
        )}

        {loadError && (
          <div className={styles.loading}>
            <p className={styles.error}>{loadError}</p>
          </div>
        )}

        {summary && (
          <>
            <div className={styles.dataCard}>
              <span className={styles.dataTag}>Dataset loaded</span>
              <span className={styles.dataInfo}>
                {summary.overview.totalDays.toLocaleString()} daily records &mdash; {summary.overview.startDate} to {summary.overview.endDate}
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
                  <p className={styles.bubbleText}>{m.text}</p>
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
