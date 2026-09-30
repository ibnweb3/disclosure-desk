import type { AppEnv } from "./types";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  model: string;
  provider: "workers-ai" | "openai-compatible";
}

export class NoLlmError extends Error {}

/** Qwen3 models "think" by default; the soft switch keeps latency and neuron cost down. */
const withNoThink = (msgs: ChatMsg[], model: string): ChatMsg[] => {
  if (!/qwen3/i.test(model)) return msgs;
  const out = msgs.map((m) => ({ ...m }));
  const last = out[out.length - 1];
  if (last && last.role === "user") last.content += " /no_think";
  return out;
};

const stripThinking = (s: string): string =>
  s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*<\/think>/i, "")
    .trim();

interface OpenAiLike {
  response?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  result?: { response?: unknown };
}

/** Workers AI returns `response` as a parsed OBJECT when the model's output is valid JSON, so accept objects too. */
const extract = (r: unknown): string => {
  const o = (r ?? {}) as OpenAiLike;
  for (const c of [o.choices?.[0]?.message?.content, o.response, o.result?.response]) {
    if (typeof c === "string" && c.trim()) return c;
    if (c && typeof c === "object") return JSON.stringify(c);
  }
  return "";
};

export async function chat(env: AppEnv, messages: ChatMsg[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<ChatResult> {
  const maxTokens = opts.maxTokens ?? 500;
  const temperature = opts.temperature ?? 0.2;

  if (env.LLM_BASE_URL && env.LLM_API_KEY) {
    const model = env.LLM_MODEL || "qwen3.8-max";
    const res = await fetch(`${env.LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({ model, messages: withNoThink(messages, model), max_tokens: maxTokens, temperature }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`llm ${res.status}`);
    const text = stripThinking(extract(await res.json()));
    if (!text) throw new Error("llm empty");
    return { text, model, provider: "openai-compatible" };
  }

  if (env.AI) {
    const model = (env.LLM_MODEL || "@cf/qwen/qwen3-30b-a3b-fp8") as "@cf/qwen/qwen3-30b-a3b-fp8";
    const r = await env.AI.run(model, { messages: withNoThink(messages, model), max_tokens: maxTokens, temperature });
    const text = stripThinking(extract(r));
    if (!text) throw new Error(`llm empty: ${JSON.stringify(r).slice(0, 320)}`);
    return { text, model, provider: "workers-ai" };
  }

  throw new NoLlmError("no LLM configured");
}
