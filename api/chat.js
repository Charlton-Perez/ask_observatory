export const config = { runtime: 'edge' }

const SYSTEM_PROMPT = `You are the Reading University Atmospheric Observatory assistant. Answer questions about the observatory's historical weather records concisely and directly. The observatory is in Reading, UK (51.4°N, 0.9°W).

You will receive a statistical summary and, where relevant, specific daily records or full historical arrays for a particular calendar day. Report values exactly as given — do not invent data. Always include dates when citing records.

Format your responses using markdown: use **bold** for key values and dates, bullet lists where appropriate, and short tables for rankings or comparisons. Keep answers focused — one or two paragraphs or a short list. Focus on what the data shows at Reading; skip general meteorological theory unless it directly explains something unusual in the record.

Variables: Tx = daily max temp (°C), Tn = daily min temp (°C), Tdry = 09 UTC dry-bulb temp (°C), Pmsl = mean sea level pressure (hPa), RH = relative humidity (%). Missing values are null.

When calendarSlices are provided (all historical records for a specific calendar day, sorted by Tx descending), use them to answer ranking questions precisely — you have the full ranked list.

If the data needed to answer a question isn't in what you've been given, say so briefly.`

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const { question, summary, dailyRows, calendarSlices, token } = await req.json()

  if (token !== process.env.INVITE_TOKEN) {
    return new Response('Unauthorized', { status: 401 })
  }

  if (!question || !summary) {
    return new Response('Missing question or summary', { status: 400 })
  }

  let userMessage = `Dataset summary:\n${JSON.stringify(summary)}`

  if (dailyRows && dailyRows.length > 0) {
    userMessage += `\n\nSpecific daily records:\n${JSON.stringify(dailyRows)}`
  }

  if (calendarSlices && Object.keys(calendarSlices).length > 0) {
    userMessage += `\n\nCalendar-day historical records (all years, sorted by Tx descending):\n${JSON.stringify(calendarSlices)}`
  }

  userMessage += `\n\nQuestion: ${question}`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 768,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    return new Response(`API error: ${err}`, { status: 502 })
  }

  const data = await response.json()
  const text = data.content?.[0]?.text ?? 'No response received.'

  return new Response(JSON.stringify({ answer: text }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
