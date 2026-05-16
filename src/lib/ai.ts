type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type AiResult = {
  condition: string
  severity: 'mild' | 'moderate' | 'severe'
  score: number
  recommendation: string
  confidence: number
}

const GEMINI_URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export async function sendChat(messages: ChatMessage[], customApiKey?: string): Promise<string> {
  const apiKey = customApiKey || import.meta.env.VITE_GEMINI_API_KEY
  const model = import.meta.env.VITE_GEMINI_MODEL || 'gemini-2.5-flash'

  if (!apiKey) {
    throw new Error('Missing Gemini API Key. Please provide one in the UI.')
  }

  const systemInstructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')

  const contents = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }))

  const response = await fetch(`${GEMINI_URL_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      systemInstruction: systemInstructions ? { parts: [{ text: systemInstructions }] } : undefined,
      contents,
      generationConfig: {
        temperature: 0.2,
      },
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Gemini error: ${response.status} ${text}`)
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>
      }
    }>
  }
  const content = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim()
  if (!content) {
    throw new Error('Gemini returned an empty response')
  }
  return content
}

export function tryParseFinal(content: string): AiResult | null {
  const trimmed = content.trim()
  const candidate = extractJson(trimmed)
  if (!candidate) return null

  try {
    const parsed = JSON.parse(candidate) as AiResult
    if (!parsed || typeof parsed !== 'object') return null
    if (
      typeof parsed.condition !== 'string' ||
      typeof parsed.recommendation !== 'string' ||
      typeof parsed.score !== 'number' ||
      typeof parsed.confidence !== 'number'
    ) {
      return null
    }
    if (!['mild', 'moderate', 'severe'].includes(parsed.severity)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function extractJson(content: string): string | null {
  if (content.startsWith('{') && content.endsWith('}')) {
    return content
  }
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return content.slice(start, end + 1)
}
