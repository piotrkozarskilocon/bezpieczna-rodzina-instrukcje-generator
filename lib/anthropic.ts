import Anthropic from "@anthropic-ai/sdk";
import { z, type ZodSchema } from "zod";

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

/** Lista modeli dostepnych przez UI (picker per-call). Klucz to wartość
 *  którą user wybiera w dropdown; value to ID modelu Anthropic. Etykieta i
 *  opis pomagają usera zorientowac sie ktory wybrac.
 *
 *  WAZNE: dla Vercel Hobby (60s cap) Opus i Sonnet z większym max_tokens mogą
 *  przekroczyć timeout. Generator zwraca wtedy 504 — user zobaczy w panelu
 *  debug i moze przelaczyc na Haiku.
 */
export const AVAILABLE_MODELS = [
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    description: "Najszybszy i najtanszy. Domyslnie. Dobry do prostych edycji, layout, kontrastu.",
    speed: "fast",
    cost: "low",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    description: "Najlepszy do generacji tresci i bardziej zlozonych transformacji. ~5x drozszy od Haiku.",
    speed: "medium",
    cost: "medium",
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    description: "Najwyzsza jakosc rozumowania. Najdrozszy. Dla trudnych przypadkow gdzie inne modele nie radza sobie.",
    speed: "slow",
    cost: "high",
  },
] as const;

export type AvailableModelId = (typeof AVAILABLE_MODELS)[number]["id"];

/** Walidacja modelu z user inputu — pozwalamy tylko na te z listy. */
export function resolveModel(requested: string | undefined | null, fallback: string): string {
  if (!requested) return fallback;
  const match = AVAILABLE_MODELS.find((m) => m.id === requested);
  return match ? match.id : fallback;
}

export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  return new Anthropic({ apiKey });
}

/** Result of an Anthropic call — exposed verbatim so we can persist token
 *  counts for telemetry / cost tracking in gen4_ai_history. */
export interface AiResponse<T = unknown> {
  /** Text content from non-tool blocks. Gdy używamy outputSchema (tool_use),
   *  tekst jest zwykle pusty bo cała odpowiedź jest w `parsed`. */
  text: string;
  /** Sparsowany i zwalidowany Zod output. Wypełniony TYLKO gdy wywołanie
   *  używało outputSchema (tool_use). Null/undefined dla wywołań tekstowych. */
  parsed?: T;
  /** Surowy `input` z tool_use bloku (przed walidacją Zod). Pomocne do
   *  debugu gdy walidacja Zod się nie powiedzie. */
  rawToolInput?: unknown;
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

/** Konfiguracja narzędzia (tool) dla strukturalnej odpowiedzi.
 *  Anthropic używa pól `name`, `description`, `input_schema` w API tool_use. */
export interface OutputSchemaConfig<T> {
  /** Nazwa narzędzia — pojawi się w prompt'cie jako "submit_<name>". */
  name: string;
  /** Krótki opis dla AI co narzędzie robi. */
  description: string;
  /** Zod schema definiująca strukturę. Konwertowana do JSON Schema dla Anthropic. */
  schema: ZodSchema<T>;
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
export async function callClaude<T = unknown>(opts: {
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
  /** Structured output — wymusza zgodność odpowiedzi z Zod schema poprzez
   *  Anthropic tool_use. Eliminuje błędy parsowania JSON i fence stripping.
   *  Gdy podane, AiResponse.parsed zawiera sparsowany i zwalidowany obiekt. */
  outputSchema?: OutputSchemaConfig<T>;
}): Promise<AiResponse<T>> {
  const client = getAnthropicClient();
  const model = opts.model ?? INITIAL_MODEL;
  const start = Date.now();

  // Buduj content array: tekst + opcjonalne attachments.
  // Anthropic wymaga roznych blokow zaleznie od typu pliku:
  //   - PDF / text/*  -> { type: "document", source: { type: "file", file_id }}
  //   - image/*       -> { type: "image",    source: { type: "file", file_id }}
  // Z document API uzyte na image dostalo 400 "Only PDF and plaintext supported".
  // Sprawdzamy mime_type przez Files API (1 retrieve per attachment, ~10ms kazdy).
  // TS SDK jeszcze nie ma stabilnej deklaracji dla document/file source, wiec
  // wszedzie cast through unknown.
  const userContent: unknown[] = [{ type: "text", text: opts.user }];
  for (const fileId of opts.attachments ?? []) {
    let blockType: "document" | "image" = "document";
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meta: any = await (client as any).beta.files.retrieve(fileId);
      const mt = (meta?.mime_type ?? "") as string;
      const fname = (meta?.filename ?? "") as string;
      // mime_type bywa "application/octet-stream" (przegladarki drag&drop
      // czasem tak wysylaja PNG/JPG) — wtedy mime nie pomoze. Fallback to
      // sprawdzanie rozszerzenia nazwy pliku z metadata.
      const isImageByMime = mt.startsWith("image/");
      const isImageByExt = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(fname);
      if (isImageByMime || isImageByExt) {
        blockType = "image";
      }
    } catch (err) {
      console.warn(`[anthropic] files.retrieve ${fileId} failed, defaulting to document:`, err);
    }
    userContent.unshift({
      type: blockType,
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
  // Structured output via tool_use — wymuszamy zgodność z Zod schema.
  // Anthropic zwróci content block typu "tool_use" z polem `input` które
  // jest już sparsowanym i zwalidowanym JSON-em. Eliminuje to potrzebę
  // parsowania tekstu (i wszystkie błędy "Unexpected token", "fence-strip" itd.).
  if (opts.outputSchema) {
    // Zod 4 ma natywne z.toJSONSchema() — produkuje schema z `type: "object"`
    // na root, czego Anthropic API wymaga (input_schema.type: required).
    // Wczesniej uzywany `zod-to-json-schema` jest niekompatybilny z Zod 4
    // (zwraca pusty obiekt {} → 400 "input_schema.type: Field required").
    const jsonSchema = z.toJSONSchema(opts.outputSchema.schema);
    streamParams.tools = [{
      name: opts.outputSchema.name,
      description: opts.outputSchema.description,
      input_schema: jsonSchema,
    }];
    streamParams.tool_choice = { type: "tool", name: opts.outputSchema.name };
  }
  // Gdy są attachments (Files API beta), trzeba uderzać w dedicated beta endpoint
  // żeby API zaakceptowało source.type='file'. SDK ignoruje `betas` na non-beta
  // messages.stream — beta endpoint sam dorzuca header `anthropic-beta`.
  const stream = opts.attachments?.length
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (client as any).beta.messages.stream(streamParams)
    : client.messages.stream(streamParams);
  const message = await stream.finalMessage();
  const latencyMs = Date.now() - start;

  // Wyciągamy text z bloków typu "text" oraz tool_input z bloku "tool_use".
  // Gdy wymusiliśmy tool_choice, Anthropic zwraca głównie tool_use blok
  // (i czasem pusty/krótki text przed nim).
  const contentBlocks = message.content as Array<{ type: string; text?: string; input?: unknown; name?: string }>;
  const text = contentBlocks.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");
  let parsed: T | undefined;
  let rawToolInput: unknown;
  if (opts.outputSchema) {
    const toolBlock = contentBlocks.find((b) => b.type === "tool_use" && b.name === opts.outputSchema!.name);
    if (!toolBlock || toolBlock.input == null) {
      throw new Error(`anthropic did not return tool_use block for "${opts.outputSchema.name}". Response text: ${text.slice(0, 200)}`);
    }
    rawToolInput = toolBlock.input;
    const validation = opts.outputSchema.schema.safeParse(toolBlock.input);
    if (!validation.success) {
      throw new Error(`tool_use input failed Zod validation: ${JSON.stringify(validation.error.issues).slice(0, 500)}`);
    }
    parsed = validation.data;
  } else {
    // Tryb tekstowy (legacy) — wymuszamy obecność tekstu jak dotąd.
    if (!text) throw new Error("anthropic returned no text content");
  }

  // Cache tokens reporting — Anthropic zwraca cache_creation_input_tokens
  // i cache_read_input_tokens w usage gdy caching aktywny.
  const usage = message.usage as unknown as Record<string, unknown>;
  return {
    text,
    parsed,
    rawToolInput,
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

  // Beta endpoint dla Files API attachments (patrz komentarz w callClaude wyzej).
  const stream = opts.attachments?.length
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (client as any).beta.messages.stream(streamParams)
    : client.messages.stream(streamParams);
  // Emit text fragments na bieżąco — Anthropic SDK ma event 'text' z deltą.
  stream.on("text", (delta: string) => {
    onChunk(delta);
  });
  const message = await stream.finalMessage();
  const latencyMs = Date.now() - start;
  const text = (message.content as Array<{ type: string; text?: string }>)
    .map((b) => (b.type === "text" ? b.text ?? "" : ""))
    .join("");

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
