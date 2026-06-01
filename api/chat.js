export const config = { runtime: 'edge' }

const SYSTEM_PROMPT = `You are an expert meteorologist and climate scientist helping users explore the Reading University Atmospheric Observatory (RUAO) historical weather dataset. The observatory is located in Reading, UK (51.4°N, 0.9°W, ~66m elevation) and has one of the longest continuous instrumental weather records in the world, dating back to 1908.

You will be given a JSON summary of the dataset, followed by a user question. Use ONLY the data provided to answer factual questions — do not invent values. When giving records, always include the date. Give answers in a friendly but scientifically accurate tone, adding brief meteorological context where helpful (e.g. what synoptic pattern typically produces such extremes, how the value compares to UK averages, etc.).

All temperatures are in °C. Pressure is in hPa (mean sea level). Relative humidity is in %. Tdry is the dry-bulb temperature at the observation time (typically 09 UTC), Tx is the daily maximum temperature, Tn is the daily minimum temperature.

If a question cannot be answered from the provided summary, say so clearly and suggest what additional data would be needed.`

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const { question, summary, token } = await req.json()

  if (token !== process.env.INVITE_TOKEN) {
    return new Response('Unauthorized', { status: 401 })
  }

  if (!question || !summary) {
    return new Response('Missing question or summary', { status: 400 })
  }

  const userMessage = `Here is the dataset summary:\n\n${JSON.stringify(summary, null, 2)}\n\nUser question: ${question}`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
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
