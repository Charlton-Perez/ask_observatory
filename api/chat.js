export const config = { runtime: 'edge' }

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Reading University Atmospheric Observatory assistant. The observatory is in Reading, UK (51.4°N, 0.9°W), with one of the longest continuous instrumental weather records in the world.

You will receive a pre-computed context object containing: WMO climatological normals (30-year means for the current standard period, auto-updated per WMO convention); all-time ranked extremes; record months; per-calendar-month top-10 rankings; seasonal top-10 rankings for spring/summer/autumn/winter (meteorological seasons MAM/JJA/SON/DJF, winter attributed to year of Jan/Feb); decade and annual summaries; and top-10 longest consecutive runs. Additional raw daily records are included when a specific date, range, or recent period is mentioned.

When comparing any value to "average" or "normal", always use the wmoNormals section and state which period it covers (e.g. "compared to the 1991–2020 average of…").

Answer concisely and directly using only the data provided. Use **bold** for key values and dates. Use bullet lists or short tables for comparisons and rankings. Do not invent values or add lengthy meteorological theory — just tell the user what the data shows at Reading.

If asked about hourly, sub-daily, or time-of-day data (e.g. "what time did it reach 30°C", "hourly temperature", "morning vs afternoon"), politely explain that the dataset contains daily observations only and hourly records are not available here.

Fields: Tx = daily max temp (°C), Tn = daily min temp (°C), Tdry = 09 UTC dry-bulb temp (°C), Twet = wet-bulb temp (°C), Pmsl = pressure (hPa), RH = relative humidity (%), RR = rainfall (mm), sss = sunshine (hrs), sd_cm = snow depth (cm), af = air frost day (1=yes), gf = ground frost day (1=yes).`

// ── Provider adapters ─────────────────────────────────────────────────────────
// Each adapter takes the same normalised arguments and returns { answer: string }.
// Adding a new provider = adding one function here + one case in the router.

async function callAnthropic({ model, systemPrompt, messages }) {
  const apiKey = process.env.MODEL_API_KEY || process.env.ANTHROPIC_API_KEY
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 2048, system: systemPrompt, messages }),
  })
  if (!res.ok) throw new Error(await res.text())
  const data = await res.json()
  return data.content?.[0]?.text ?? ''
}

// Covers: Ollama, OpenAI, Groq, Mistral — all speak the OpenAI chat format.
async function callOpenAICompatible({ model, systemPrompt, messages, baseUrl, apiKey }) {
  const url = `${baseUrl}/v1/chat/completions`
  // Convert Anthropic message format to OpenAI format (system goes into messages array)
  const oaiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ]
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages: oaiMessages, max_tokens: 2048 }),
  })
  if (!res.ok) throw new Error(await res.text())
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

async function callGemini({ model, systemPrompt, messages }) {
  const apiKey = process.env.MODEL_API_KEY
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  // Gemini uses a different message format — system instruction is separate
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 2048 },
    }),
  })
  if (!res.ok) throw new Error(await res.text())
  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

// ── Provider router ───────────────────────────────────────────────────────────
// Controlled entirely by environment variables — no code changes to switch model.
//
// MODEL_PROVIDER  = anthropic | ollama | openai | groq | mistral | gemini
// MODEL_NAME      = the model ID for that provider (see README)
// MODEL_BASE_URL  = base URL (required for ollama; optional override for others)
// MODEL_API_KEY   = API key (falls back to ANTHROPIC_API_KEY for anthropic)
//
// Provider defaults (used when env vars are not set):
const PROVIDER_DEFAULTS = {
  anthropic: { baseUrl: 'https://api.anthropic.com',               model: 'claude-haiku-4-5-20251001'  },
  openai:    { baseUrl: 'https://api.openai.com',                  model: 'gpt-4o-mini'                },
  groq:      { baseUrl: 'https://api.groq.com/openai',             model: 'llama-3.1-70b-versatile'    },
  mistral:   { baseUrl: 'https://api.mistral.ai',                  model: 'mistral-small-latest'       },
  gemini:    { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash'         },
  ollama:    { baseUrl: 'http://localhost:11434',                   model: 'qwen2.5:14b'               },
}

async function callModel(messages) {
  const provider = (process.env.MODEL_PROVIDER || 'anthropic').toLowerCase()
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.anthropic
  const model   = process.env.MODEL_NAME     || defaults.model
  const baseUrl = process.env.MODEL_BASE_URL || defaults.baseUrl
  const apiKey  = process.env.MODEL_API_KEY  || process.env.ANTHROPIC_API_KEY

  const args = { model, systemPrompt: SYSTEM_PROMPT, messages, baseUrl, apiKey }

  switch (provider) {
    case 'anthropic': return callAnthropic(args)
    case 'gemini':    return callGemini(args)
    case 'ollama':
    case 'openai':
    case 'groq':
    case 'mistral':   return callOpenAICompatible(args)
    default:          return callAnthropic(args)
  }
}

// ── Retry with backoff ────────────────────────────────────────────────────────

async function callWithRetry(messages, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await callModel(messages)
    } catch (err) {
      const msg = err.message || ''
      const isTransient = msg.includes('overload') || msg.includes('529') || msg.includes('503')
      if (!isTransient || attempt === maxAttempts - 1) throw err
      await new Promise(r => setTimeout(r, (attempt + 1) * 1500))
    }
  }
}

// ── Request handler ───────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const { question, context, dailyRows, calendarSlices, recentRows, today, history, token } = await req.json()

  if (token !== process.env.INVITE_TOKEN) return new Response('Unauthorized', { status: 401 })
  if (!question || !context) return new Response('Missing question or context', { status: 400 })

  const todayStr = today || new Date().toISOString().slice(0, 10)

  // Build data context block (sent as the first user turn, once per conversation)
  const dataContext = [`Today's date: ${todayStr}\n\nDataset context:\n${JSON.stringify(context)}`]
  if (dailyRows?.length > 0)
    dataContext.push(`Raw daily record(s) for the date(s) mentioned:\n${JSON.stringify(dailyRows)}`)
  if (calendarSlices && Object.keys(calendarSlices).length > 0)
    dataContext.push(`All historical records for the calendar day(s) mentioned (sorted by Tx descending):\n${JSON.stringify(calendarSlices)}`)
  if (recentRows?.length > 0)
    dataContext.push(`Daily records for the recent period requested (${recentRows.length} days, chronological):\n${JSON.stringify(recentRows)}`)

  // Build full message list: context preamble + capped history + current question
  const recentHistory = (history || []).slice(-20)
  const priorMessages = recentHistory
    .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
    .filter((m, i, arr) => i === 0 || m.role !== arr[i - 1].role)

  const messages = [
    { role: 'user',      content: dataContext.join('\n\n') },
    { role: 'assistant', content: 'Understood — I have the full dataset context loaded. What would you like to know?' },
    ...priorMessages,
    { role: 'user',      content: question },
  ]

  try {
    const answer = await callWithRetry(messages)
    return new Response(JSON.stringify({ answer }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error('Model error:', err.message)
    const friendly = (err.message || '').toLowerCase().includes('overload')
      ? 'The AI service is busy right now — please try again in a moment.'
      : `Something went wrong: ${err.message}`
    return new Response(JSON.stringify({ answer: friendly }), { headers: { 'Content-Type': 'application/json' } })
  }
}
