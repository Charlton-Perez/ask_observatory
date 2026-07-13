import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseCSV, buildContext, buildDayIndex } from './dataParser'
import { createToolExecutor, describeToolCall, summarizeToolResult } from './toolExecutor'
import styles from './App.module.css'

const INVITE_TOKEN = import.meta.env.VITE_INVITE_TOKEN
const OBSERVATORY_URL = 'https://research.reading.ac.uk/meteorology/atmospheric-observatory/'
const LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/'

const EXAMPLE_QUESTIONS = [
  'What is the hottest temperature ever recorded?',
  'What was the longest dry spell on record?',
  'How has the number of frost days changed since the 1960s?',
  'What was the weather like on 14 October 1987?',
  'How likely is a 25°C day in early June?',
  'Which decade had the wettest winters?',
]

// The model drives its own data access through tools, so a question can take a
// few round trips: model → tool calls → results → model → … → answer.
const MAX_TOOL_ROUNDS = 8

export default function App() {
  const [hasAccess] = useState(() => new URLSearchParams(window.location.search).get('token') === INVITE_TOKEN)
  const [overview, setOverview] = useState(null)   // header card info
  const [slimContext, setSlimContext] = useState(null) // small context sent to the model
  const [executor, setExecutor] = useState(null)   // (name, input) => { result, isError }
  const [loadError, setLoadError] = useState(null)
  const [messages, setMessages] = useState([])     // UI transcript: { role, text, steps?, error? }
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [activity, setActivity] = useState(null)   // live "Computing: …" line while tools run
  const [betaAck, setBetaAck] = useState(() => localStorage.getItem('ruaoBetaAck') === '1')
  const bottomRef = useRef(null)
  const token = new URLSearchParams(window.location.search).get('token')

  const dismissBeta = () => { localStorage.setItem('ruaoBetaAck', '1'); setBetaAck(true) }

  // Load and parse the dataset once on mount
  useEffect(() => {
    if (!hasAccess) return
    fetch('/ruao_data.csv')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text() })
      .then(text => {
        const rows = parseCSV(text)
        const ctx = buildContext(rows)
        const dayIndex = buildDayIndex(rows)
        setOverview(ctx.overview)
        // Slim context: coverage + normals + all-time records. Everything else
        // the model computes on demand through its tools.
        setSlimContext({
          overview: ctx.overview,
          wmoNormals: ctx.wmoNormals,
          allTimeExtremes: ctx.allTimeExtremes,
        })
        const today = new Date().toISOString().slice(0, 10)
        setExecutor(() => createToolExecutor(dayIndex, today))
      })
      .catch(e => setLoadError('Could not load dataset: ' + e.message))
  }, [hasAccess])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, asking, activity])

  const askQuestion = async (q) => {
    const text = (q || question).trim()
    if (!text || !slimContext || !executor || asking) return
    setQuestion('')
    setMessages(prev => [...prev, { role: 'user', text }])
    setAsking(true)
    setActivity(null)

    try {
      const today = new Date().toISOString().slice(0, 10)

      // Prior visible transcript as plain alternating text turns.
      // (Tool exchanges from earlier questions aren't replayed — the final
      // answers already carry the numbers, which keeps payloads small.)
      const history = messages.slice(-20)
        .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
        .filter((m, i, arr) => m.content && (i === 0 || m.role !== arr[i - 1].role))

      // Anthropic-format message list; grows as the tool loop runs.
      const apiMessages = [
        {
          role: 'user',
          content: `Today's date: ${today}\n\nStation context (JSON):\n${JSON.stringify(slimContext)}`,
        },
        {
          role: 'assistant',
          content: 'Understood — I have the station context loaded and can query the full daily record with my tools. What would you like to know?',
        },
        ...history,
        { role: 'user', content: text },
      ]

      const steps = []
      let answer = null

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: apiMessages, token }),
        })
        if (!res.ok) throw new Error(await res.text())
        const { content, stop_reason } = await res.json()

        const toolUses = (content || []).filter(b => b.type === 'tool_use')
        const textOut = (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()

        if (stop_reason !== 'tool_use' || toolUses.length === 0) {
          answer = textOut || 'Sorry, I could not produce an answer for that question.'
          break
        }

        // Execute every requested tool locally against the parsed record.
        const results = toolUses.map(tu => {
          const desc = describeToolCall(tu.name, tu.input)
          setActivity(desc)
          const { result, isError } = executor(tu.name, tu.input)
          // Keep the exact returned values so the UI can show ground truth
          // verbatim, not depend on the model to transcribe them into prose.
          steps.push({ desc, facts: summarizeToolResult(tu.name, tu.input, result) })
          return {
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result),
            ...(isError ? { is_error: true } : {}),
          }
        })

        apiMessages.push({ role: 'assistant', content })
        apiMessages.push({ role: 'user', content: results })

        // Final round safety valve: tell the model to wrap up with what it has.
        if (round === MAX_TOOL_ROUNDS - 2) {
          apiMessages[apiMessages.length - 1].content = [
            ...results,
            { type: 'text', text: 'Please answer now using the data gathered so far — no further tool calls.' },
          ]
        }
      }

      if (answer == null) throw new Error('The question needed too many computation steps — please try asking it more specifically.')
      setMessages(prev => [...prev, { role: 'assistant', text: answer, steps }])
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', text: `Sorry, something went wrong: ${e.message}`, error: true }])
    } finally {
      setAsking(false)
      setActivity(null)
    }
  }

  const onKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askQuestion() }
  }

  if (!hasAccess) {
    return (
      <div className={styles.gateWrap}>
        <div className={styles.gate}>
          <img className={styles.gateLogo} src="/uor-logo.png" alt="University of Reading" />
          <h1>Atmospheric Observatory</h1>
          <p className={styles.gateSub}>Ask questions about 100+ years of daily weather records</p>
          <p className={styles.gateNote}>
            This tool is currently available to invited users only.<br />
            Please use the link provided to you.
          </p>
          <a className={styles.gateLink} href={OBSERVATORY_URL} target="_blank" rel="noreferrer">
            About the Atmospheric Observatory &rarr;
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <img className={styles.headerLogo} src="/uor-logo.png" alt="University of Reading" />
        <div className={styles.headerText}>
          <h1 className={styles.headerTitle}>Atmospheric Observatory</h1>
          <p className={styles.headerSub}>Ask questions about 100+ years of daily weather records</p>
        </div>
        <a className={styles.headerLink} href={OBSERVATORY_URL} target="_blank" rel="noreferrer">
          About the Observatory &rarr;
        </a>
      </header>

      <main className={styles.main}>
        {!betaAck && (
          <div className={styles.beta} role="alert">
            <span className={styles.betaTag}>Beta</span>
            <p className={styles.betaText}>
              This tool is in beta testing. Answers are generated automatically and may be
              incomplete or incorrect — please verify anything important. Provided <strong>as is,
              with no warranty</strong> of accuracy or fitness for any purpose.
            </p>
            <button className={styles.betaBtn} onClick={dismissBeta}>I understand</button>
          </div>
        )}

        {!overview && !loadError && (
          <div className={styles.loading}><p>Loading observatory data&hellip;</p></div>
        )}
        {loadError && (
          <div className={styles.loading}><p className={styles.error}>{loadError}</p></div>
        )}

        {overview && (
          <>
            <div className={styles.dataCard}>
              <span className={styles.dataTag}>Dataset loaded</span>
              <span className={styles.dataInfo}>
                {overview.totalDays.toLocaleString()} daily records &mdash; {overview.startDate} to {overview.endDate}
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
                  {m.steps?.length > 0 && (
                    <div className={styles.steps}>
                      <span className={styles.stepsLabel}>Computed from the daily record:</span>
                      {m.steps.map((s, j) => {
                        const desc = typeof s === 'string' ? s : s.desc
                        const facts = typeof s === 'string' ? [] : (s.facts || [])
                        return (
                          <div key={j} className={styles.step}>
                            <span className={styles.stepChip}>{desc}</span>
                            {facts.map((f, k) => <span key={k} className={styles.stepFact}>{f}</span>)}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
              {asking && (
                <div className={`${styles.bubble} ${styles.bubbleAssistant}`}>
                  <span className={styles.bubbleLabel}>Observatory AI</span>
                  <p className={styles.typing}><span /><span /><span /></p>
                  {activity && <p className={styles.activity}>Computing: {activity}</p>}
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

        <footer className={styles.footer}>
          <div className={styles.footerRow}>
            <a href={LICENSE_URL} target="_blank" rel="noreferrer" className={styles.ccLink}
               title="Creative Commons Attribution 4.0 International">
              <img className={styles.ccBadge} src="/cc-by.png" alt="Creative Commons BY 4.0" />
            </a>
            <p className={styles.footerText}>
              Data &amp; answers &copy; University of Reading, licensed under{' '}
              <a href={LICENSE_URL} target="_blank" rel="noreferrer">CC&nbsp;BY&nbsp;4.0</a>.
              Data collected at the{' '}
              <a href={OBSERVATORY_URL} target="_blank" rel="noreferrer">Atmospheric Observatory</a>.
              Beta — provided as is, with no warranty.
            </p>
          </div>
        </footer>
      </main>
    </div>
  )
}
