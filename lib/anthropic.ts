import Anthropic from "@anthropic-ai/sdk";

/**
 * Server-only Anthropic client. ANTHROPIC_API_KEY lives in the project env;
 * never import this file from a "use client" component.
 *
 * Model selection:
 * - INITIAL_MODEL — used for the one-shot full-project generation. Domyślnie
 *   Haiku 4.5 — szybsze (3x), tańsze (3x), wystarcza dla generacji struktury
 *   wg sztywnego szablonu. Sonnet 4.6 zostawiony jako opcja override gdy
 *   potrzebujemy lepszej jakości tekstowej (np. wymyślania marketingu).
 *   Vercel Hobby plan ma 60s hard cap — Sonnet 4.6 z max_tokens 32000 nie
 *   mieści się dla ~14-stronnych projektów.
 * - EDIT_MODEL    — used for iterative edits and per-element actions. Haiku
 *   jest plenty dla "shorten/lengthen/translate this" type tasks.
 * - PREMIUM_MODEL — explicit override (Sonnet 4.6) dla wywołań które są dłuższe
 *   ale wymagają lepszej jakości; używać tylko gdy działamy w trybie tła.
 */
export const INITIAL_MODEL = "claude-haiku-4-5-20251001";
export const EDIT_MODEL = "claude-haiku-4-5-20251001";
export const PREMIUM_MODEL = "claude-sonnet-4-6";

export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  return new Anthropic({ apiKey });
}

/** Result of an Anthropic call — exposed verbatim so we can persist token
 *  counts for telemetry / cost tracking in gen4_ai_history. */
export interface AiResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Tokeny które trafiły do CREATE cache (typowo system prompt długi + cache_control).
   *  Płatne tym samym co input ale ZAPISANE — kolejne wywołania z tym samym
   *  prefiksem czytają z cache za 10% kosztu input. */
  cacheCreationTokens?: number;
  /** Tokeny ODCZYTANE z cache (90% taniej niż normalny input). */
  cacheReadTokens?: number;
  model: string;
  latencyMs: number;
  /** Temperature użyte przy wywołaniu (potrzebne do A/B variants gdzie róznicujemy). */
  temperature?: number;
}

/** Calls Claude with a system prompt + user message, returns plain text.
 *  Throws on empty or non-text content blocks.
 *
 *  Używa streamingu (`messages.stream(...).finalMessage()`), bo Anthropic
 *  od końca 2025 wymusza streaming dla operacji potencjalnie > 10 min
 *  (large max_tokens + wolniejsze modele jak Sonnet 4.6). API zwraca
 *  ten sam typ Message co .create(), więc reszta kodu nie wymaga zmian.
 *
 *  attachments — opcjonalne PDF file_id z Anthropic Files API. Trafiają
 *  jako document blocks razem z tekstem user message, dzięki czemu Claude
 *  czyta zawartość plików bezpośrednio (np. raport SAR -> wartości w wpisach). */
export async function callClaude(opts: {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  attachments?: string[]; // Anthropic file_id list
  /** Włącz prompt caching dla system prompta. Pierwszy call tworzy cache
   *  (płaci za normalny input + 25%); kolejne calls z identycznym system
   *  prompt czytają z cache (10% normalnego kosztu input). Zostaje 5 minut. */
  cacheSystemPrompt?: boolean;
  /** Temperature dla generacji. Default 1.0 (Anthropic default). A/B variants
   *  używają 0.7 i 0.9 dla różnicowania wyników. */
  temperature?: number;
}): Promise<AiResponse> {
  const client = getAnthropicClient();
  const model = opts.model ?? INITIAL_MODEL;
  const start = Date.now();

  // Buduj content array: tekst + opcjonalne document blocks (PDF attachments).
  // TS SDK Anthropic jeszcze nie ma stabilnej deklaracji dla document blocks z
  // file_id (beta files API), więc używamy `unknown` cast — runtime jest OK.
  const userContent: unknown[] = [{ type: "text", text: opts.user }];
  for (const fileId of opts.attachments ?? []) {
    userContent.unshift({
      type: "document",
      source: { type: "file", file_id: fileId },
    });
  }

  // System prompt — jeśli włączony caching, owijamy w content block z cache_control.
  // Inaczej zwykły string (tańsza wersja gdy prompt krótki i się zmienia).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const systemParam: any = opts.cacheSystemPrompt
    ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }]
    : opts.system;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streamParams: any = {
    model,
    max_tokens: opts.maxTokens ?? 16000,
    system: systemParam,
    messages: [{ role: "user", content: opts.attachments?.length ? userContent : opts.user }],
  };
  if (typeof opts.temperature === "number") {
    streamParams.temperature = opts.temperature;
  }
  if (opts.attachments?.length) {
    streamParams.betas = ["files-api-2025-04-14"];
  }
  const message = await client.messages.stream(streamParams).finalMessage();
  const latencyMs = Date.now() - start;

  // Concatenate any text blocks from the structured response.
  const text = message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  if (!text) throw new Error("anthropic returned no text content");

  // Cache tokens reporting — Anthropic zwraca cache_creation_input_tokens
  // i cache_read_input_tokens w usage gdy caching aktywny.
  const usage = message.usage as unknown as Record<string, unknown>;
  return {
    text,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheCreationTokens: typeof usage.cache_creation_input_tokens === "number"
      ? usage.cache_creation_input_tokens
      : undefined,
    cacheReadTokens: typeof usage.cache_read_input_tokens === "number"
      ? usage.cache_read_input_tokens
      : undefined,
    model: message.model,
    latencyMs,
    temperature: opts.temperature,
  };
}

/** Wariant streamingowy callClaude — emituje fragmenty odpowiedzi via onChunk
 *  callback, dzięki czemu UI może pokazywać tekst pojawiający się stopniowo.
 *  Po skończeniu zwraca finalny AiResponse (jak callClaude).
 *  Caller decyduje co zrobić z tekstem — typowo parse + apply. */
export async function callClaudeStream(
  opts: {
    system: string;
    user: string;
    model?: string;
    maxTokens?: number;
    attachments?: string[];
    cacheSystemPrompt?: boolean;
    temperature?: number;
  },
  onChunk: (textDelta: string) => void,
): Promise<AiResponse> {
  const client = getAnthropicClient();
  const model = opts.model ?? INITIAL_MODEL;
  const start = Date.now();

  const userContent: unknown[] = [{ type: "text", text: opts.user }];
  for (const fileId of opts.attachments ?? []) {
    userContent.unshift({
      type: "document",
      source: { type: "file", file_id: fileId },
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const systemParam: any = opts.cacheSystemPrompt
    ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }]
    : opts.system;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streamParams: any = {
    model,
    max_tokens: opts.maxTokens ?? 16000,
    system: systemParam,
    messages: [{ role: "user", content: opts.attachments?.length ? userContent : opts.user }],
  };
  if (typeof opts.temperature === "number") streamParams.temperature = opts.temperature;
  if (opts.attachments?.length) streamParams.betas = ["files-api-2025-04-14"];

  const stream = client.messages.stream(streamParams);
  // Emit text fragments na bieżąco — Anthropic SDK ma event 'text' z deltą.
  stream.on("text", (delta: string) => {
    onChunk(delta);
  });
  const message = await stream.finalMessage();
  const latencyMs = Date.now() - start;
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");

  const usage = message.usage as unknown as Record<string, unknown>;
  return {
    text,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheCreationTokens: typeof usage.cache_creation_input_tokens === "number"
      ? usage.cache_creation_input_tokens : undefined,
    cacheReadTokens: typeof usage.cache_read_input_tokens === "number"
      ? usage.cache_read_input_tokens : undefined,
    model: message.model,
    latencyMs,
    temperature: opts.temperature,
  };
}

/** Strips an optional ```json ... ``` fence the model often wraps JSON in,
 *  then JSON.parse. Throws with a useful preview on failure. */
export function parseJsonFromAi<T = unknown>(text: string): T {
  let trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) trimmed = fenceMatch[1].trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    const preview = trimmed.slice(0, 400);
    throw new Error(
      `failed to parse AI JSON: ${err instanceof Error ? err.message : "?"}\nPreview: ${preview}`,
    );
  }
}
