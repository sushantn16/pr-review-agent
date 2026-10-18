// One call to an OpenAI-compatible /chat/completions endpoint: GitHub Models, OpenAI, OpenRouter, Groq, Mistral, a local
// Ollama, Claude through Anthropic's OpenAI-compatible endpoint, and so on. The model gets no tools: it only returns text.

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Completion {
  content: string;
  /** The model the provider says it served. */
  model: string;
  usage: { input: number; output: number } | null;
}

export class LlmError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function chat(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Message[];
  fetch?: typeof fetch;
  /** Waits between retries in ms; tests pass zeros. */
  backoff?: number[];
}): Promise<Completion> {
  const doFetch = opts.fetch ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const backoff = opts.backoff ?? [5_000, 20_000];
  // JSON mode where the provider supports it; some reject the field, so a 400 drops it and tries once more.
  let json = true;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json", "user-agent": "pr-review-agent" },
        body: JSON.stringify({ model: opts.model, messages: opts.messages, ...(json ? { response_format: { type: "json_object" } } : {}) }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      if (attempt < backoff.length) {
        await sleep(backoff[attempt]!);
        continue;
      }
      throw new LlmError(0, `model API unreachable at ${url}: ${(e as Error).message}`);
    }
    if (res.ok) {
      const data = (await res.json()) as { model?: string; choices?: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new LlmError(res.status, "the model returned no content");
      const u = data.usage;
      return { content, model: data.model || opts.model, usage: u ? { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0 } : null };
    }
    const text = (await res.text()).slice(0, 500);
    if (res.status === 400 && json) {
      json = false;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < backoff.length) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 60_000) : backoff[attempt]!);
      continue;
    }
    throw new LlmError(res.status, `model API: HTTP ${res.status} ${text}`);
  }
}
