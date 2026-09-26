import { fetchJson } from './http.ts';

// Every LLM of the brief's chain (Gemini, Groq, GitHub Models, OpenRouter,
// Mistral, Ollama) exposes an OpenAI-compatible chat completions endpoint:
// one adapter covers them all.

export interface ChatRequest {
  baseUrl: string; // e.g. https://api.groq.com/openai/v1
  apiKey?: string;
  model: string;
  system: string;
  user: string;
  /** Ask for a JSON object (the caller still validates it). */
  json?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
}

interface ChatResponse {
  choices?: { message?: { content?: string | null } }[];
}

export async function chat(req: ChatRequest): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`;
  const r = await fetchJson<ChatResponse>(`${req.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: req.model,
      temperature: 0.1,
      max_tokens: req.maxTokens ?? 2500,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
    }),
    timeoutMs: req.timeoutMs ?? 60_000,
    retries: 0, // the provider router falls back instead of retrying
  });
  const text = r.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty completion');
  return text;
}

/** Extracts the JSON object from a completion (tolerates code fences and preambles). */
export function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in completion');
  return JSON.parse(text.slice(start, end + 1));
}
