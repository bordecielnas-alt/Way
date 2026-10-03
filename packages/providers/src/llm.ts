import Anthropic from '@anthropic-ai/sdk';
import { fetchJson, HttpError } from './http.ts';

// Most LLMs of the chain (Gemini, Groq, GitHub Models, OpenRouter, Mistral,
// Cerebras, DeepSeek, OpenAI, Ollama) expose an OpenAI-compatible chat
// completions endpoint: one adapter covers them all. Claude goes through
// Anthropic's own SDK (anthropicChat below).

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

/** OpenAI reasoning models (gpt-5…, o1, o3…) refuse `max_tokens` and any temperature but the default. */
const REASONING = /(^|\/)(gpt-5|o\d)/;

export async function chat(req: ChatRequest): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`;
  const reasoning = REASONING.test(req.model);
  const r = await fetchJson<ChatResponse>(`${req.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: req.model,
      ...(reasoning
        // Their thinking counts in the budget: room for it on top of the answer.
        ? { max_completion_tokens: (req.maxTokens ?? 2500) * 4 }
        : { temperature: 0.1, max_tokens: req.maxTokens ?? 2500 }),
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

/** Models a key may use, from the OpenAI-compatible `/models` list (empty when unavailable). */
export async function listModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  try {
    const r = await fetchJson<{ data?: { id?: string }[] }>(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      timeoutMs: 15_000,
      retries: 0,
    });
    return (r.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

export interface AnthropicChatRequest extends Omit<ChatRequest, 'baseUrl'> {
  apiKey: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * Claude through the Messages API. There is no JSON mode: the system prompt
 * asks for JSON and parseJsonObject tolerates the rest. SDK errors become
 * HttpError so the router's quota breaker sees 429/402 as it does elsewhere.
 */
export async function anthropicChat(req: AnthropicChatRequest): Promise<string> {
  const client = new Anthropic({ apiKey: req.apiKey, timeout: req.timeoutMs ?? 60_000, maxRetries: 0 });
  try {
    const r = await client.beta.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 16_000,
      output_config: { effort: req.effort ?? 'low' },
      // On a policy decline, the API re-runs the request on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: req.json ? `${req.system}\nRéponds uniquement par un objet JSON, sans texte autour.` : req.system,
      messages: [{ role: 'user', content: req.user }],
    });
    if (r.stop_reason === 'refusal') throw new Error(`refusal (${r.stop_details?.category ?? 'no category'})`);
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    if (!text) throw new Error(`empty completion (${r.stop_reason})`);
    return text;
  } catch (e) {
    if (e instanceof Anthropic.APIError && e.status) throw new HttpError(e.status, e.message);
    throw e;
  }
}

/** Extracts the JSON object from a completion (tolerates code fences and preambles). */
export function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in completion');
  return JSON.parse(text.slice(start, end + 1));
}
