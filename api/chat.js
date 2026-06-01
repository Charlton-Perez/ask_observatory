export const config = { runtime: 'edge' }

const SYSTEM_PROMPT = `You are the Reading University Atmospheric Observatory assistant. The observatory is in Reading, UK (51.4°N, 0.9°W), with one of the longest continuous instrumental weather records in the world.

You will receive a pre-computed context object containing everything known about the dataset — all-time ranked extremes, monthly statistics, annual summaries, and top-10 longest consecutive runs for common weather conditions (hot spells, dry spells, frost runs, etc.) — followed by the user's question. If a specific date was mentioned, the raw record for that day is also included.

Answer concisely and directly using only the data provided. Use **bold** for key values and dates. Use bullet lists or short tables for comparisons and rankings. Do not invent values or add lengthy meteorological theory — just tell the user what the data shows at Reading.

Fields: Tx = daily max temp (°C), Tn = daily min temp (°C), Tdry = 09 UTC dry-bulb temp (°C), Twet = wet-bulb temp (°C), Pmsl = pressure (hPa), RH = relative humidity (%), RR = rainfall (mm), sss = sunshine (hrs), sd_cm = snow depth (cm), af = air frost day, gf = ground frost day.`

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const { question, context, dailyRows, calendarSlices, token } = await req.json()

  if (token !== process.env.INVITE_TOKEN) return new Response('Unauthorized', { status: 401 })
  if (!question || !context) return new Response('Missing question or context', { status: 400 })

  let userMessage = `Dataset context:\n${JSON.stringify(context)}`
  if (dailyRows?.length > 0) {
    userMessage += `\n\nRaw daily record(s) for the date(s) mentioned:\n${JSON.stringify(dailyRows)}`
  }
  if (calendarSlices && Object.keys(calendarSlices).length > 0) {
    userMessage += `\n\nAll historical records for the calendar day(s) mentioned (sorted by Tx descending — use these for ranking questions):\n${JSON.stringify(calendarSlices)}`
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

  if (!response.ok) return new Response(`API error: ${await response.text()}`, { status: 502 })

  const data = await response.json()
  return new Response(
    JSON.stringify({ answer: data.content?.[0]?.text ?? 'No response received.' }),
    { headers: { 'Content-Type': 'application/json' } }
  )
}
