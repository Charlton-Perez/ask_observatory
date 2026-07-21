export const config = { runtime: 'edge' }

// ── Architecture ──────────────────────────────────────────────────────────────
// This endpoint is a stateless relay in a client-driven tool loop:
//
//   browser ──messages──▶ /api/chat ──▶ model (with TOOLS)
//   browser ◀─content────┘
//   browser executes any tool_use blocks locally against the parsed CSV,
//   appends tool_results to messages, and calls /api/chat again.
//   Loop ends when the model returns plain text (stop_reason: end_turn).
//
// The dataset never leaves the browser; the model decides what to compute.
// Messages always travel in Anthropic content-block format; adapters convert
// for OpenAI-compatible providers (openai / groq / mistral / ollama).

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Reading University Atmospheric Observatory assistant. The observatory is in Reading, UK (51.4°N, 0.9°W), with one of the longest continuous instrumental weather records in the world — daily observations from 1908 to the present.

You have tools that query the full daily record directly. The first user message contains a small station context: data coverage, WMO climatological normals for the current 30-year standard period, and all-time record extremes.

CORE RULES
- NEVER state a numeric answer you have not obtained from a tool result or the provided station context. Do not estimate, extrapolate, or answer from general knowledge of UK climate.
- Every date's figure must come from that date's own row. Never restate one day's value (e.g. a peak) as if it applied to other days — if you list several dates, each must show its own, often different, value exactly as the tool returned it. To attribute exact values to specific dates, read them from rank_days / get_days output, not from a count or a run's single peak.
- Be careful with DERIVED numbers — differences and comparisons like "X°C shy of", "X°C warmer than", "N% higher". Compute them only from two exact figures you already have, state BOTH underlying values so the gap is checkable (e.g. "34.9°C — 2.7°C below the 37.6°C record"), and double-check the subtraction. If unsure, give the two absolute values and skip the difference.
- Prefer aggregate, rank_days, find_runs and rank_windows — they compute over the whole record cheaply. Use get_days only for short windows (a specific day, week or month someone asks about directly).
- Any "N-day spell/period/stretch" ranking question ("sunniest 28-day spell", "wettest fortnight", "hottest week ever") is rank_windows — one call, done. NEVER try to compute a rolling window yourself by chaining get_days/aggregate calls across candidate date ranges: that's slow, easy to get wrong, and has caused real request timeouts. If rank_windows doesn't cover what's being asked, say so rather than manually iterating.
- Chain tool calls freely: complex questions often need 2–4 calls (e.g. compute a count per era, then rank the extremes). You may request several tools in one turn when they are independent.
- When comparing anything to "average" or "normal", use the wmoNormals in the station context and state the period (e.g. "compared with the 1991–2020 average of …").
- For climate-change comparisons, use these standard eras via start/end dates: 1961-01-01→1990-12-31, 1991-01-01→2020-12-31, 2001-01-01→present, and the full record. Present era comparisons as a small table.
- Meteorological seasons via the months parameter: spring [3,4,5], summer [6,7,8], autumn [9,10,11], winter [12,1,2]. For a NAMED winter (e.g. "winter 1963") use a date range instead: 1962-12-01 to 1963-02-28/29, attributed to the January/February year.
- ANNUAL groupings that are NOT the calendar year: group_by "year" alone means Jan–Dec, which splits any winter across two buckets. For a "frost year", "snow season", "water year", or any July–June / Oct–Sep style annual total, set year_start_month on aggregate (e.g. 7 for July–June) — do NOT use plain calendar-year grouping and do NOT sum monthly counts yourself. The tool then labels each period unambiguously (e.g. "1997/1998"); report that label. If a single named period is requested, an explicit start/end window works too. A calendar-year count and a July–June count for "the same year" are legitimately different numbers, so always make the period explicit in your answer.
- Probability/frequency questions: use aggregate with stat "count" and a filter — the result includes count, days_in_scope and percent. For a specific calendar date ("how often is 15 June above 25°C?") add calendar_day "06-15"; each day in scope is then one year, so percent ≈ probability. State the sample size.
- "This year / this month / recent" questions: the record's end date is in the station context; today's date is given. Use explicit date ranges capped at the record end.
- NEVER report, rank, or infer any day, period, spell or window that extends beyond the record's end date. There is NO forecast data — days after the last record simply do not exist. When searching for "hottest/wettest N-day periods" or similar, every candidate window must lie entirely within the record; a window whose end is in the future is only the handful of days that exist, NOT a complete period, so never treat or rank it as one. If a tool result contains a "warning" field, it means the window ran past the record end and is partial — heed it and discard or re-scope that window.
- If a tool returns an error, read it — it usually says how to fix the call (narrow the range, coarser grouping, etc.). Adjust and retry rather than giving up.
- The dataset is DAILY only. If asked about hourly, time-of-day, or sub-daily detail, explain politely that only daily observations are held here.
- Missing values are recorded as null (shown as 'x' historically, common for some fields in early decades). If missing data materially affects an answer, say so, using the excluded-days counts in tool results.
- Trace rainfall (< 0.05 mm) is stored as 0.0 mm by WMO convention, so a "dry day" / dry spell (RR == 0) means no measurable rain, which may include trace days.

FIELDS (use these exact keys in tool calls)
Tx = daily max temp (°C) · Tn = daily min temp (°C) · Tdry = 09 UTC dry-bulb temp (°C) · Twet = wet-bulb temp (°C) · Pmsl = mean sea-level pressure (hPa) · RH = relative humidity (%) · RR = rainfall (mm; a "rain day" is rd=1) · rd = rain day flag · sss = sunshine (hrs) · sd_cm = snow depth (cm) · af = air frost flag · gf = ground frost flag · ff_ms = wind speed (m/s; ×2.237 for mph, ×1.944 for knots) · dd = wind direction in tens of degrees (×10 for degrees: 0/360=N, 9=E, 18=S, 27=W; 0 also used for calm) · ww = WMO present weather code.
Extended fields (fewer years of coverage — soil temps from 1961, solar radiation from 1973, gusts from ~2007; missing where not measured): Pstn = station pressure (hPa) · VP = vapour pressure (hPa) · Ptemp = barometer temp (°C) · Tdew = dew point (°C) · Tg = grass minimum temp (°C) · Ts = soil minimum temp (°C) · Tc = concrete minimum temp (°C) · Tbar = mean daily temp (°C) · Tdiur = daily temp range (°C) · E5/E10/E20/E30/E50/E1m = soil temp at 5/10/20/30/50/100 cm depth (°C) · ggx_ms = max 3-sec gust (m/s) · ggx_ms1 = max 1-sec gust (m/s) · cc2 = wind run at 2 m (km/day) · Rdur = rain duration (hrs) · RR_gl = ground-level rainfall (mm) · RR_int = intercepted rainfall (mm) · skz = Kipp-Zonen sunshine (hrs) · tev = tank evaporation (mm) · srad = solar radiation (MJ/m²) · N8 = cloud cover in oktas (eighths of sky, 0 = clear, 8 = overcast; not an SI unit). These have shorter records — if a query spans years before a field existed, say so using the excluded/missing counts.

REFERENCE DEFINITIONS (all inclusive thresholds; compute via tools, don't assume pre-computed values)
Summer day: Tx > 25. Tropical night: Tn > 20. Ice day: Tx < 0. Frost day: Tn < 0. Heavy rain day: RR >= 10. Very heavy rain day: RR >= 20. UK Met Office heatwave (SE England / Reading): Tx >= 28 for >= 3 consecutive days (use find_runs). Dry spell: RR == 0 consecutive days.

WMO present weather codes (ww) — always translate to plain English: 0–3 cloud development; 4 smoke/haze; 5 haze; 10 mist; 11–12 shallow fog; 17 thunderstorm no precip; 20 drizzle (past hr); 21 rain (past hr); 22 snow (past hr); 25 rain showers (past hr); 29 thunderstorm (past hr); 30–35 dust/sandstorm; 36–39 drifting snow; 40–49 fog (45 obscuring, 48 rime); 50–55 drizzle (slight→heavy); 56–57 freezing drizzle; 60–65 rain (slight→heavy); 66–67 freezing rain; 68–69 rain/snow mix; 70–75 snow (slight→heavy); 77 snow grains; 79 ice pellets; 80–82 rain showers (slight→violent); 83–84 rain+snow showers; 85–86 snow showers; 87–90 hail showers; 95–99 thunderstorms (99 heavy with hail).

STYLE
Answer concisely and directly. Use **bold** for key values and dates, short tables for comparisons and rankings. Plain language only — never mention tool names, field keys, JSON, or internal mechanics in your answer. Just tell the user what the Reading record shows.`

// ── Tool definitions (Anthropic schema; converted for OpenAI-compatible) ──────

const FIELD_ENUM = ['Tx', 'Tn', 'Tdry', 'Twet', 'Pmsl', 'RH', 'RR', 'rd', 'sss', 'sd_cm', 'af', 'gf', 'ff_ms', 'dd', 'ww',
  'Pstn', 'VP', 'Ptemp', 'Tdew', 'Tg', 'Ts', 'Tc', 'Tbar', 'Tdiur',
  'E5', 'E10', 'E20', 'E30', 'E50', 'E1m',
  'ggx_ms', 'ggx_ms1', 'cc2', 'Rdur', 'RR_gl', 'RR_int', 'skz', 'tev', 'srad', 'N8']
const OP_ENUM = ['>=', '<=', '>', '<', '==', '!=']

const SCOPE_PROPS = {
  start: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive). Omit for start of record.' },
  end: { type: 'string', description: 'End date YYYY-MM-DD (inclusive). Omit for end of record.' },
  months: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 12 }, description: 'Restrict to these calendar months across the range, e.g. [6,7,8] for summer.' },
}
const FILTERS_PROP = {
  filters: {
    type: 'array',
    description: 'AND-combined day conditions, e.g. [{"field":"Tx","op":">=","value":30}]. Days with a missing filter field never match.',
    items: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: FIELD_ENUM },
        op: { type: 'string', enum: OP_ENUM },
        value: { type: 'number' },
      },
      required: ['field', 'op', 'value'],
    },
  },
}

const TOOLS = [
  {
    name: 'aggregate',
    description: 'The workhorse. Compute mean/min/max/sum/count of a daily field over any date scope, with optional filters and grouping. stat "count" counts days matching the filters and returns count, days_in_scope and percent (use this for frequency/probability questions). min/max include the date of the extreme. Grouped results include a group_summary (mean of groups, highest, lowest) — use it instead of doing arithmetic across groups yourself. calendar_day "MM-DD" restricts to one calendar date across all years (one day per year).',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: FIELD_ENUM, description: 'Field to aggregate. Required for mean/min/max/sum; ignored for count.' },
        stat: { type: 'string', enum: ['mean', 'min', 'max', 'sum', 'count'] },
        group_by: { type: 'string', enum: ['none', 'year', 'month', 'year_month', 'decade'], description: '"year" = calendar year (Jan–Dec) unless year_start_month is set. "month" = calendar month across all years. Default none. Max 250 groups.' },
        year_start_month: { type: 'integer', minimum: 1, maximum: 12, description: 'Only with group_by "year". Start each 12-month year in this month instead of January, so winter-spanning counts stay together. E.g. 7 groups Jul→Jun and labels groups "1997/1998". Use for frost/snow/heating "seasons" that straddle the new year. Default 1 (calendar year).' },
        ...FILTERS_PROP,
        ...SCOPE_PROPS,
        calendar_day: { type: 'string', description: 'MM-DD to restrict to a single calendar date across all years.' },
      },
      required: ['stat'],
    },
  },
  {
    name: 'rank_days',
    description: 'Top-N individual days by any field, ascending or descending, with optional filters and date/month scope. Returns date, the ranked value, and Tx/Tn/RR for context. Use for "hottest/wettest/windiest day" questions, record rankings, and extremes within a period. calendar_day "MM-DD" ranks all historical occurrences of one calendar date (e.g. every Christmas Day).',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: FIELD_ENUM },
        order: { type: 'string', enum: ['desc', 'asc'], description: 'desc = highest first (default).' },
        n: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10, max 50.' },
        ...FILTERS_PROP,
        ...SCOPE_PROPS,
        calendar_day: { type: 'string', description: 'MM-DD to rank one calendar date across all years.' },
      },
      required: ['field'],
    },
  },
  {
    name: 'find_runs',
    description: 'Find consecutive-day spells where a condition holds: heatwaves (Tx >= 28, min_length 3), dry spells (RR == 0), frost runs (Tn < 0), sunless streaks (sss == 0), etc. Returns the longest runs (start, end, days, peak value), total count of qualifying runs, mean length, and runs per decade. Gaps in the record break a run.',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: FIELD_ENUM },
        op: { type: 'string', enum: OP_ENUM },
        value: { type: 'number' },
        min_length: { type: 'integer', minimum: 1, description: 'Minimum run length in days to count. Default 3.' },
        top_n: { type: 'integer', minimum: 1, maximum: 25, description: 'How many longest runs to return. Default 10.' },
        ...SCOPE_PROPS,
      },
      required: ['field', 'op', 'value'],
    },
  },
  {
    name: 'rank_windows',
    description: 'Top-N fixed-length rolling windows, e.g. "sunniest 28-day spell ever", "wettest 14-day period", "hottest 7-day stretch". Computes every possible window of window_days consecutive calendar days (a gap or missing value breaks a window), ranks by total (stat "sum") or average (stat "mean"), and collapses heavily overlapping windows to the single best-ranked slice of each distinct spell — so results are N separate real-world events, not N near-identical overlapping slices of the same event. Use this instead of aggregate/get_days for ANY "N-day spell/period/stretch" ranking question — do not try to compute rolling windows yourself from get_days or aggregate output.',
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: FIELD_ENUM },
        stat: { type: 'string', enum: ['sum', 'mean'], description: 'sum = total over the window (e.g. total sunshine hours); mean = daily average over the window. Default sum.' },
        window_days: { type: 'integer', minimum: 2, maximum: 366, description: 'Window length in consecutive calendar days.' },
        order: { type: 'string', enum: ['desc', 'asc'], description: 'desc = highest first (sunniest/wettest/hottest). Default desc.' },
        n: { type: 'integer', minimum: 1, maximum: 20, description: 'How many distinct, non-overlapping windows to return. Default 5.' },
        ...SCOPE_PROPS,
      },
      required: ['field', 'window_days'],
    },
  },
  {
    name: 'get_days',
    description: 'Fetch raw daily rows for a short date window (max 400 days) — use ONLY when the user asks about specific dates or a short period ("what was 14 October 1987 like?", "last week"). For anything statistical over longer periods, use aggregate/rank_days/find_runs/rank_windows instead. Optionally restrict fields to keep results small.',
    input_schema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'YYYY-MM-DD inclusive. Required.' },
        end: { type: 'string', description: 'YYYY-MM-DD inclusive. Required.' },
        fields: { type: 'array', items: { type: 'string', enum: FIELD_ENUM }, description: 'Subset of fields to return. Default: all.' },
      },
      required: ['start', 'end'],
    },
  },
]

// ── Provider adapters ─────────────────────────────────────────────────────────
// Each returns a normalised { content: [...anthropic-style blocks], stop_reason }.

// Insert Anthropic prompt-cache breakpoints so repeated prefixes are billed at the
// ~10% cache-read rate instead of full price. Combined with the cached system+tools
// block, this covers the two biggest repeated chunks:
//   • the station-context first user message (~12 KB, identical all session), and
//   • the running conversation, so each tool-loop round reuses the prior rounds.
// (Up to 4 breakpoints; we use at most 3: system + first user + last block.)
function withPromptCaching(messages) {
  if (!messages?.length) return messages
  const asCachedText = (content) =>
    typeof content === 'string'
      ? [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
      : content

  const out = messages.map(m => ({ ...m }))

  // (1) Station context — the large, static first user turn.
  out[0] = { ...out[0], content: asCachedText(out[0].content) }

  // (2) Tail of the conversation — reused as a prefix on the next tool-loop round.
  const i = out.length - 1
  if (typeof out[i].content === 'string') {
    out[i] = { ...out[i], content: asCachedText(out[i].content) }
  } else if (Array.isArray(out[i].content) && out[i].content.length) {
    const blocks = out[i].content.map(b => ({ ...b }))
    const last = blocks.length - 1
    blocks[last] = { ...blocks[last], cache_control: { type: 'ephemeral' } }
    out[i] = { ...out[i], content: blocks }
  }
  return out
}

// Hard cap on a single model call. Without this, a slow response (e.g. the
// model trying to reason its way through something it should have used a
// tool for) just hangs the fetch until the *platform* kills the whole
// function — an opaque FUNCTION_INVOCATION_TIMEOUT with no chance for us to
// respond gracefully. Aborting client-side first, well under that ceiling,
// lets the catch block below return a normal, friendly chat message instead.
const MODEL_TIMEOUT_MS = 25_000

async function callAnthropic({ model, messages, apiKey }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      // cache the tools + system prefix (static across every call).
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages: withPromptCaching(messages),
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(await res.text())
  const data = await res.json()
  return { content: data.content ?? [], stop_reason: data.stop_reason ?? 'end_turn' }
}

// Convert Anthropic-format messages to OpenAI chat format (tool calls included).
function toOpenAIMessages(messages) {
  const out = [{ role: 'system', content: SYSTEM_PROMPT }]
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue }
    if (m.role === 'assistant') {
      const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      const toolCalls = m.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }))
      const msg = { role: 'assistant', content: text || null }
      if (toolCalls.length) msg.tool_calls = toolCalls
      out.push(msg)
    } else {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
          })
        }
      }
      const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      if (text) out.push({ role: 'user', content: text })
    }
  }
  return out
}

// Covers OpenAI, Groq, Mistral, Ollama — all speak OpenAI chat + tools format.
async function callOpenAICompatible({ model, messages, baseUrl, apiKey }) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      messages: toOpenAIMessages(messages),
      tools: TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(await res.text())
  const data = await res.json()
  const msg = data.choices?.[0]?.message ?? {}
  const content = []
  if (msg.content) content.push({ type: 'text', text: msg.content })
  for (const tc of msg.tool_calls ?? []) {
    let input = {}
    try { input = JSON.parse(tc.function?.arguments || '{}') } catch { /* leave empty; executor will error informatively */ }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input })
  }
  return { content, stop_reason: data.choices?.[0]?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn' }
}

// Gemini's tool format differs enough that it is text-only here for now.
async function callGemini({ model, messages, apiKey }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : m.content.map(b => b.text || JSON.stringify(b)).join('\n') }],
  }))
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: { maxOutputTokens: 3000 },
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(await res.text())
  const data = await res.json()
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' }
}

// ── Provider router (env-controlled, unchanged interface) ─────────────────────
// MODEL_PROVIDER = anthropic | openai | groq | mistral | ollama | gemini
// MODEL_NAME, MODEL_BASE_URL, MODEL_API_KEY as before.
// NOTE: gemini currently answers without tools (text-only fallback).

const PROVIDER_DEFAULTS = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5' },
  openai: { baseUrl: 'https://api.openai.com', model: 'gpt-4o-mini' },
  groq: { baseUrl: 'https://api.groq.com/openai', model: 'llama-3.1-70b-versatile' },
  mistral: { baseUrl: 'https://api.mistral.ai', model: 'mistral-small-latest' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash' },
  ollama: { baseUrl: 'http://localhost:11434', model: 'qwen2.5:14b' },
}

async function callModel(messages) {
  const provider = (process.env.MODEL_PROVIDER || 'anthropic').toLowerCase()
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.anthropic
  const model = process.env.MODEL_NAME || defaults.model
  const baseUrl = process.env.MODEL_BASE_URL || defaults.baseUrl
  const apiKey = process.env.MODEL_API_KEY || process.env.ANTHROPIC_API_KEY

  const args = { model, messages, baseUrl, apiKey }
  switch (provider) {
    case 'anthropic': return callAnthropic(args)
    case 'gemini': return callGemini(args)
    case 'ollama':
    case 'openai':
    case 'groq':
    case 'mistral': return callOpenAICompatible(args)
    default: return callAnthropic(args)
  }
}

async function callWithRetry(messages, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await callModel(messages)
    } catch (err) {
      // A timeout is deliberately NOT treated as transient — retrying would
      // just stack another MODEL_TIMEOUT_MS wait on top and risk hitting the
      // platform's own hard limit anyway. Fail straight to the friendly
      // message below instead.
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError'
      const msg = err.message || ''
      const isTransient = !isTimeout && (msg.includes('overload') || msg.includes('529') || msg.includes('503'))
      if (!isTransient || attempt === maxAttempts - 1) throw err
      await new Promise(r => setTimeout(r, (attempt + 1) * 1500))
    }
  }
}

// ── Request handler ───────────────────────────────────────────────────────────
// Body: { messages: [...anthropic-format], token }
// Reply: { content: [...blocks], stop_reason } — the client runs the loop.

const MAX_MESSAGES = 120        // hard sanity caps on relayed payloads
const MAX_BODY_BYTES = 1_500_000

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) return new Response('Payload too large', { status: 413 })

  let body
  try { body = JSON.parse(raw) } catch { return new Response('Invalid JSON', { status: 400 }) }
  const { messages, token } = body

  if (token !== process.env.INVITE_TOKEN) return new Response('Unauthorized', { status: 401 })
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES)
    return new Response('Missing or invalid messages', { status: 400 })

  try {
    const result = await callWithRetry(messages)
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error('Model error:', err.message)
    const msg = (err.message || '').toLowerCase()
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError'
    const friendly = isTimeout
      ? "That took too long to answer — try narrowing the question (a shorter date range, or one thing at a time) and asking again."
      : msg.includes('overload')
        ? 'The AI service is busy right now — please try again in a moment.'
        : msg.includes('rate_limit') || msg.includes('rate limit')
          ? "We've hit the usage limit for this minute — please wait a few seconds and try again."
          : `Something went wrong: ${err.message}`
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: friendly }],
      stop_reason: 'error',
    }), { headers: { 'Content-Type': 'application/json' } })
  }
}
