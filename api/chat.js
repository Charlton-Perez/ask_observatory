export const config = { runtime: 'edge' }

const SYSTEM_PROMPT = `You are the Reading University Atmospheric Observatory assistant. The observatory is in Reading, UK (51.4°N, 0.9°W), with one of the longest continuous instrumental weather records in the world.

You will receive a pre-computed context object containing everything known about the dataset — all-time ranked extremes, record months, monthly statistics, decade summaries, annual summaries, and top-10 longest consecutive runs for common weather conditions — followed by the user's question. Additional raw daily records are included when a specific date, calendar day, or recent period is mentioned.

Answer concisely and directly using only the data provided. Use **bold** for key values and dates. Use bullet lists or short tables for comparisons and rankings. Do not invent values or add lengthy meteorological theory — just tell the user what the data shows at Reading.

If asked about hourly, sub-daily, or time-of-day data (e.g. "what time did it reach 30°C", "hourly temperature", "morning vs afternoon"), politely explain that the dataset contains daily observations only and hourly records are not available here.

Fields: Tx = daily max temp (°C), Tn = daily min temp (°C), Tdry = 09 UTC dry-bulb temp (°C), Twet = wet-bulb temp (°C), Pmsl = pressure (hPa), RH = relative humidity (%), RR = rainfall (mm), sss = sunshine (hrs), sd_cm = snow depth (cm), af = air frost day (1=yes), gf = ground frost day (1=yes).`

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const { question, context, dailyRows, calendarSlices, recentRows, today, history, token } = await req.json()

  if (token !== process.env.INVITE_TOKEN) return new Response('Unauthorized', { status: 401 })
  if (!question || !context) return new Response('Missing question or context', { status: 400 })

  const todayStr = today || new Date().toISOString().slice(0, 10)

  // The dataset context is only sent once, as the first user turn, so it doesn't
  // repeat with every message and inflate costs as the conversation grows.
  const dataContext = [`Today's date: ${todayStr}\n\nDataset context:\n${JSON.stringify(context)}`]
  if (dailyRows?.length > 0)
    dataContext.push(`Raw daily record(s) for the date(s) mentioned:\n${JSON.stringify(dailyRows)}`)
  if (calendarSlices && Object.keys(calendarSlices).length > 0)
    dataContext.push(`All historical records for the calendar day(s) mentioned (sorted by Tx descending):\n${JSON.stringify(calendarSlices)}`)
  if (recentRows?.length > 0)
    dataContext.push(`Daily records for the recent period requested (${recentRows.length} days, chronological):\n${JSON.stringify(recentRows)}`)

  // Build the full message list: context preamble + prior turns + current question.
  // Cap history at the last 20 messages (10 exchanges) to keep costs predictable.
  const recentHistory = (history || []).slice(-20)

  // Anthropic requires strict user/assistant alternation.
  // Map roles and filter out any consecutive duplicates that could break alternation.
  const priorMessages = recentHistory
    .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
    .filter((m, i, arr) => i === 0 || m.role !== arr[i - 1].role)

  const messages = [
    { role: 'user',      content: dataContext.join('\n\n') },
    { role: 'assistant', content: 'Understood — I have the full dataset context loaded. What would you like to know?' },
    ...priorMessages,
    { role: 'user',      content: question },
  ]

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages,
  })

  // Retry up to 3 times on overloaded / 529 errors, with exponential backoff.
  let response, attempt = 0
  while (attempt < 3) {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
    })
    if (response.ok) break
    const errText = await response.text()
    const isOverloaded = response.status === 529 ||
      (response.status === 500 && errText.includes('overloaded'))
    if (!isOverloaded || attempt === 2) {
      console.error('Anthropic API error:', errText)
      const friendly = isOverloaded
        ? 'The AI service is busy right now — please try again in a moment.'
        : `API error: ${errText}`
      return new Response(JSON.stringify({ answer: friendly }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    await new Promise(r => setTimeout(r, (attempt + 1) * 1500))
    attempt++
  }

  const data = await response.json()
  return new Response(
    JSON.stringify({ answer: data.content?.[0]?.text ?? 'No response received.' }),
    { headers: { 'Content-Type': 'application/json' } }
  )
}
