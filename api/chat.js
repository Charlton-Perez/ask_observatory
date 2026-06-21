export const config = { runtime: 'edge' }

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Reading University Atmospheric Observatory assistant. The observatory is in Reading, UK (51.4°N, 0.9°W), with one of the longest continuous instrumental weather records in the world.

You will receive a pre-computed context object containing: WMO climatological normals (30-year means for the current standard period, auto-updated per WMO convention); all-time ranked extremes; record months; per-calendar-month top-10 rankings; seasonal top-10 rankings for spring/summer/autumn/winter (meteorological seasons MAM/JJA/SON/DJF, winter attributed to year of Jan/Feb); decade and annual summaries; and top-10 longest consecutive runs. Additional raw daily records are included when a specific date, range, or recent period is mentioned.

When comparing any value to "average" or "normal", always use the wmoNormals section and state which period it covers (e.g. "compared to the 1991–2020 average of…").

Answer concisely and directly using only the data provided. Use **bold** for key values and dates. Use bullet lists or short tables for comparisons and rankings. Do not invent values or add lengthy meteorological theory — just tell the user what the data shows at Reading.

**WMO ETCCDI climate indices:** The context includes \`etccdiNormals\` (mean annual counts per climate era) and per-year counts in \`byYear\`, plus per-calendar-month top-10s in \`monthlyTopTens\` (mostSummerDays, mostTropNights). Indices: SU = Summer Days (Tx > 25°C), TR = Tropical Nights (Tn > 20°C), ID = Ice Days (Tx < 0°C), FD = Frost Days (Tn < 0°C), R10 = Heavy Rain Days (RR ≥ 10mm), R20 = Very Heavy Rain Days (RR ≥ 20mm). These are the internationally agreed ETCCDI standard. For questions about a specific year or partial year ("this year so far", "in June 2023"), an \`etccdiSlice\` with exact computed counts will be provided — use it directly and compare against \`etccdiNormals\` for context.

**Heatwaves:** The context includes a \`heatwaves\` section with all individual heatwave events in the record (UK Met Office SE England definition: Tx ≥ 28°C for ≥ 3 consecutive days). Each event has start date, end date, duration in days, peak Tx, and mean Tx. The section also includes \`longestEvent\`, \`hottestEvent\`, \`byDecade\` counts, \`byYear\` counts (sparse — only years with at least one heatwave), and \`gapStats\` (shortest/longest/mean gap in days between consecutive heatwaves). Use this for questions about heatwave frequency, trends, the hottest or longest heatwave, how many heatwaves occurred in a given year or decade, and how long the typical wait between heatwaves is.

**Exceedance probabilities and climatological chance questions:**
The context includes a \`monthlyExceedance\` section. For each calendar month it gives the historical percentage of days meeting conditions like Tx>=20, Tx>=25, Tx>=28, Tx>=30 (warm/hot days), Tn<0 (frost nights), Tn<5 (cold nights), RR>=1 (rain day), RR>=5 (moderate rain), RR>=10 (heavy rain). Each condition is broken down by era: \`all\` (full record), \`1961-1990\`, \`1991-2020\`, \`2001-now\`. Use this to answer questions like:
- "What's the probability of exceeding 28°C in June?" → look up June \`Tx>=28\` → \`all\` value
- "Has the chance of a hot July day changed?" → compare July \`Tx>=25\` across eras
- "How likely is frost in April?" → April \`Tn<0\` → \`all\`
State the era and sample size context when relevant. For probability on a **specific calendar date** (e.g. "15th June"), the raw annual records for that date are provided in \`calendarSlices\` — count how many years had Tx ≥ threshold and divide by total years to get the probability, stating the sample size.

If asked about hourly, sub-daily, or time-of-day data (e.g. "what time did it reach 30°C", "hourly temperature", "morning vs afternoon"), politely explain that the dataset contains daily observations only and hourly records are not available here.

Fields: Tx = daily max temp (°C), Tn = daily min temp (°C), Tdry = 09 UTC dry-bulb temp (°C), Twet = wet-bulb temp (°C), Pmsl = pressure (hPa), RH = relative humidity (%), RR = rainfall (mm), rd = rain day (1=yes), sss = sunshine (hrs), sd_cm = snow depth (cm), af = air frost day (1=yes), gf = ground frost day (1=yes), ff_ms = wind speed (m/s; multiply by 2.237 for mph, 1.944 for knots), dd = wind direction in units of 10° (multiply by 10 for degrees: 0/360=N, 9=E, 18=S, 27=W; 0 also used for calm).

WMO present weather codes (ww): 0–3 cloud development; 4 smoke/haze; 5 haze; 10 mist; 11–12 shallow fog; 17 thunderstorm no precip; 20 drizzle (past hour); 21 rain (past hour); 22 snow (past hour); 25 rain showers (past hour); 29 thunderstorm (past hour); 30–35 duststorm/sandstorm; 36–39 drifting snow; 40–49 fog (45=obscuring fog, 48=fog depositing rime); 50–55 drizzle (50/51 slight, 52/53 moderate, 54/55 heavy); 56–57 freezing drizzle; 60–61 slight rain; 62–63 moderate rain; 64–65 heavy rain; 66–67 freezing rain; 68–69 rain/snow mix; 70–75 snowfall (70/71 slight, 72/73 moderate, 74/75 heavy); 77 snow grains; 79 ice pellets; 80 slight rain showers; 81 moderate/heavy rain showers; 82 violent rain showers; 83–84 rain and snow showers; 85–86 snow showers; 87–88 hail/snow pellet showers; 89–90 hail showers; 95 thunderstorm slight/moderate; 96 thunderstorm with hail; 97 heavy thunderstorm; 99 thunderstorm with heavy hail. When reporting ww, always translate the code to a plain-English description.`

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

  const { question, context, dailyRows, calendarSlices, recentRows, exceedanceSlice, etccdiSlice, today, history, token } = await req.json()

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
  if (exceedanceSlice)
    dataContext.push(`On-demand threshold computation for this query (computed from full daily record in the browser):\n${JSON.stringify(exceedanceSlice)}\nIMPORTANT: The 'currentPeriod.count' value is the authoritative pre-computed answer — use it directly and do NOT recount from any other data. Thresholds are always inclusive (≥ for warm/wet, < for cold/frost), so "warmer than 30°C" = Tx ≥ 30°C. The result may also contain 'historical' (climatological background by era) for comparison context.`)
  if (etccdiSlice)
    dataContext.push(`WMO ETCCDI index counts for the period specified in this query (computed from full daily record in the browser):\n${JSON.stringify(etccdiSlice)}\nUse these figures directly. SU=Summer Days (Tx>25°C), TR=Tropical Nights (Tn>20°C), ID=Ice Days (Tx<0°C), FD=Frost Days (Tn<0°C), R10=Heavy Rain Days (≥10mm), R20=Very Heavy Rain Days (≥20mm).`)

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
    const msg = (err.message || '').toLowerCase()
    const friendly = msg.includes('overload')
      ? 'The AI service is busy right now — please try again in a moment.'
      : msg.includes('rate_limit') || msg.includes('rate limit')
      ? 'We\'ve hit the usage limit for this minute — please wait a few seconds and try again.'
      : `Something went wrong: ${err.message}`
    return new Response(JSON.stringify({ answer: friendly }), { headers: { 'Content-Type': 'application/json' } })
  }
}
