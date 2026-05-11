import Anthropic from "@anthropic-ai/sdk";

/**
 * Server-only Anthropic client. ANTHROPIC_API_KEY lives in the project env;
 * never import this file from a "use client" component.
 *
 * Model selection:
 * - INITIAL_MODEL — used for the one-shot full-project generation (large output,
 *   benefits from stronger reasoning). Sonnet 4.6 is a good balance.
 * - EDIT_MODEL    — used for iterative edits and per-element actions. Haiku 4.5
 *   is plenty for "shorten/lengthen/translate this" type tasks.
 */
export const INITIAL_MODEL = "claude-sonnet-4-6";
export const EDIT_MODEL = "claude-haiku-4-5-20251001";

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
  model: string;
  latencyMs: number;
}

/** Calls Claude with a system prompt + user message, returns plain text.
 *  Throws on empty or non-text content blocks. */
export async function callClaude(opts: {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
}): Promise<AiResponse> {
  const client = getAnthropicClient();
  const model = opts.model ?? INITIAL_MODEL;
  const start = Date.now();
  const message = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 16000,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });
  const latencyMs = Date.now() - start;

  // Concatenate any text blocks from the structured response.
  const text = message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  if (!text) throw new Error("anthropic returned no text content");

  return {
    text,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    model: message.model,
    latencyMs,
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
