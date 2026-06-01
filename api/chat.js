export const config = { runtime: 'edge' }

const SYSTEM_PROMPT = `You are the Reading University Atmospheric Observatory assistant. Answer questions about the observatory's weather records concisely and directly. The observatory is in Reading, UK (51.4°N, 0.9°W).

You will receive a statistical summary of the dataset and, where relevant, specific daily records. Report values as given — do not invent data. Always include dates when citing records. Keep answers short: one or two paragraphs at most. Focus on the weather at Reading; skip general meteorological theory unless it directly explains something unusual.

Variables: Tx = daily max temp (°C), Tn = daily min temp (°C), Tdry = 09 UTC dry-bulb temp (°C), Pmsl = mean sea level pressure (hPa), RH = relative humidity (%). Missing values are marked x.

If the data needed to answer a question isn't in what you've been given, say so briefly.`

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const { question, summary, dailyRows, token } = await req.json()

  if (token !== process.env.INVITE_TOKEN) {
    return new Response('Unauthorized', { status: 401 })
  }

  if (!question || !summary) {
    return new Response('Missing question or summary', { status: 400 })
  }

  let userMessage = `Dataset summary:\n${JSON.stringify(summary)}`
  if (dailyRows && dailyRows.length > 0) {
    userMessage += `\n\nMatched daily records:\n${JSON.stringify(dailyRows)}`
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
      max_tokens: 512,
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
