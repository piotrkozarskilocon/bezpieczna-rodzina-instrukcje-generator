/**
 * Server-only Gemini client (Google AI Studio).
 * GEMINI_API_KEY w env (Vercel Settings → Environment Variables).
 *
 * Modele:
 * - GEMINI_FLASH — gemini-2.5-flash. Najtanszy i najszybszy. ~3-5x taniej niz
 *   Anthropic Haiku 4.5. Default dla bulk tasks (tlumaczenia, geometry fixes).
 * - GEMINI_PRO   — gemini-2.5-pro. Duzo lepszy reasoning + 1M context window.
 *   Default dla SAR extraction z duzych PDF (Vision) + auto-callouts z bounding
 *   boxes na zdjeciach produktow.
 *
 * Filozofia: NIE duplikujemy logiki Anthropic. Wspolny interfejs przez
 * lib/v4AiProviders.ts (callAi) — endpointy uzywaja TEGO, nie callClaude
 * ani callGemini bezposrednio (poza specjalnymi przypadkami).
 */

import { GoogleGenerativeAI, SchemaType, type GenerationConfig } from "@google/generative-ai";
import type { ZodSchema } from "zod";
import { z } from "zod";

export const GEMINI_FLASH = "gemini-2.5-flash";
export const GEMINI_PRO = "gemini-2.5-pro";

export const GEMINI_MODELS = [
  {
    id: GEMINI_FLASH,
    label: "Gemini 2.5 Flash",
    description: "Najszybszy + najtanszy z Gemini. Native vision. ~3-5x taniej niz Haiku 4.5.",
    speed: "fast",
    cost: "low",
    provider: "gemini" as const,
  },
  {
    id: GEMINI_PRO,
    label: "Gemini 2.5 Pro",
    description: "Najlepszy reasoning + 1M context. Native vision. Bounding boxes. Dla SAR, auto-callouts.",
    speed: "medium",
    cost: "medium",
    provider: "gemini" as const,
  },
] as const;

export type GeminiModelId = (typeof GEMINI_MODELS)[number]["id"];

let cachedClient: GoogleGenerativeAI | null = null;
export function getGeminiClient(): GoogleGenerativeAI {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  cachedClient = new GoogleGenerativeAI(apiKey);
  return cachedClient;
}

export interface GeminiResponse<T = unknown> {
  text: string;
  parsed?: T;
  inputTokens: number;
  outputTokens: number;
  model: string;
  latencyMs: number;
}

/** Sprowadza Zod schema do JSON Schema akceptowanego przez Gemini.
 *  Gemini wymaga `Schema` z `@google/generative-ai`, ktory ma wlasny enum
 *  SchemaType — uzywamy tu prostego konwertera. Zod 4 z.toJSONSchema() daje
 *  Draft 2020-12 z `type` jako string ("object"/"array"/...); mapujemy je
 *  do SchemaType. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonSchemaToGeminiSchema(schema: any): any {
  // Gemini SDK ma discriminated union (ObjectSchema/ArraySchema/etc.) — uzywamy
  // `any` przy budowie, bo runtime kontract z Gemini API jest plain JSON.
  const t = schema?.type;
  const mapType = (type: string): SchemaType => {
    switch (type) {
      case "object": return SchemaType.OBJECT;
      case "array": return SchemaType.ARRAY;
      case "string": return SchemaType.STRING;
      case "number": return SchemaType.NUMBER;
      case "integer": return SchemaType.INTEGER;
      case "boolean": return SchemaType.BOOLEAN;
      default: return SchemaType.STRING;
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = { type: mapType(typeof t === "string" ? t : "object") };
  if (schema?.description) result.description = schema.description;
  if (schema?.properties) {
    result.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      result.properties[k] = jsonSchemaToGeminiSchema(v);
    }
  }
  if (schema?.items) result.items = jsonSchemaToGeminiSchema(schema.items);
  if (schema?.required) result.required = schema.required;
  if (schema?.enum) result.enum = schema.enum;
  return result;
}

export interface CallGeminiOpts<T = unknown> {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  outputSchema?: { name: string; description: string; schema: ZodSchema<T> };
  /** Inline files do request (image/PDF/text). Dla PNG/JPG/PDF — vision input.
   *  Limit Gemini: <20MB inline (large files = Gemini Files API, ale na razie
   *  pomijamy bo Anthropic Files API i Gemini Files API to dwa rozne systemy
   *  i management mapowan tu by sie skomplikowal). */
  inlineFiles?: Array<{ mimeType: string; data: string /* base64 */ }>;
  /** @deprecated use inlineFiles — alias dla backwards compat. */
  inlineImages?: Array<{ mimeType: string; data: string }>;
}

export async function callGemini<T = unknown>(opts: CallGeminiOpts<T>): Promise<GeminiResponse<T>> {
  const client = getGeminiClient();
  const modelId = opts.model ?? GEMINI_FLASH;
  const start = Date.now();

  const generationConfig: GenerationConfig = {
    maxOutputTokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature,
  };

  let parsedOut: T | undefined;
  if (opts.outputSchema) {
    const json = z.toJSONSchema(opts.outputSchema.schema);
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = jsonSchemaToGeminiSchema(json);
  }

  const model = client.getGenerativeModel({
    model: modelId,
    systemInstruction: opts.system,
    generationConfig,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userParts: any[] = [{ text: opts.user }];
  const allInline = [...(opts.inlineFiles ?? []), ...(opts.inlineImages ?? [])];
  for (const f of allInline) {
    userParts.unshift({ inlineData: { mimeType: f.mimeType, data: f.data } });
  }

  const result = await model.generateContent({ contents: [{ role: "user", parts: userParts }] });
  const response = result.response;
  const text = response.text();

  if (opts.outputSchema) {
    try {
      const obj = JSON.parse(text);
      parsedOut = opts.outputSchema.schema.parse(obj);
    } catch (err) {
      console.warn(`[gemini] outputSchema parse failed for model ${modelId}:`, err instanceof Error ? err.message : err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usage: any = response.usageMetadata ?? {};
  return {
    text,
    parsed: parsedOut,
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    model: modelId,
    latencyMs: Date.now() - start,
  };
}

/** Czy blad od Gemini API jest retryable (przejsciowy). 503 (high demand),
 *  429 (rate limit), 504 (timeout), network errors — TAK. 400 (bad request),
 *  401/403 (auth), schema errors — NIE. */
function isRetryableGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Google SDK formatuje jako "[NNN Status]" w treści
  if (/\[503\b/.test(msg)) return true;
  if (/\[429\b/.test(msg)) return true;
  if (/\[504\b/.test(msg)) return true;
  if (/\bhigh demand\b/i.test(msg)) return true;
  if (/\boverloaded\b/i.test(msg)) return true;
  if (/network|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg)) return true;
  return false;
}

export interface RetryProgress {
  type: "retry" | "fallback";
  attempt: number;
  total_attempts: number;
  model: string;
  error: string;
  wait_ms: number;
}

/** Domyslny chain modeli: szybkie i tanie najpierw, potem starsze ktore zwykle
 *  maja mniejszy demand. Wszystkie maja native vision i structured output. */
export const GEMINI_RETRY_CHAIN = [
  GEMINI_FLASH,           // 2.5 flash (primary)
  "gemini-2.0-flash",     // 2.0 flash (fallback gdy 2.5 przeciazone)
  "gemini-flash-latest",  // alias do najnowszej Flash — w razie zmian Google
] as const;

/** Wrapper na callGemini z retry (exponential backoff) i model fallback.
 *  Probuje: model[0] x retries → model[1] x retries → ... az zadziala albo
 *  wszystko padnie. Niewazne ze np. final attempt to "ten sam model" co
 *  primary — chodzi o tolerance na 503 spike.
 *
 *  onProgress jest opcjonalny — endpoint SSE moze emitowac event 'retry' zeby
 *  user widzial w UI ze proba trwa. */
export async function callGeminiWithRetry<T = unknown>(
  opts: CallGeminiOpts<T>,
  options?: {
    models?: readonly string[];
    retriesPerModel?: number;
    baseBackoffMs?: number;
    onProgress?: (info: RetryProgress) => void;
  },
): Promise<GeminiResponse<T>> {
  const models = options?.models ?? GEMINI_RETRY_CHAIN;
  const retriesPerModel = options?.retriesPerModel ?? 2;
  const baseBackoff = options?.baseBackoffMs ?? 2000;
  const totalAttempts = models.length * retriesPerModel;

  let attemptIdx = 0;
  let lastErr: unknown = null;
  for (const model of models) {
    for (let r = 0; r < retriesPerModel; r++) {
      attemptIdx++;
      try {
        return await callGemini<T>({ ...opts, model });
      } catch (err) {
        lastErr = err;
        const retryable = isRetryableGeminiError(err);
        if (!retryable) throw err; // 400 / auth itp. — nie ma sensu probowac

        const isLast = attemptIdx >= totalAttempts;
        if (isLast) break;

        // Backoff exp w obrebie jednego modelu, reset przy zmianie modelu.
        const wait = baseBackoff * Math.pow(2, r);
        options?.onProgress?.({
          type: r === retriesPerModel - 1 ? "fallback" : "retry",
          attempt: attemptIdx,
          total_attempts: totalAttempts,
          model,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
          wait_ms: wait,
        });
        console.warn(`[gemini retry] model=${model} attempt=${r + 1}/${retriesPerModel} → wait ${wait}ms`);
        await new Promise((res) => setTimeout(res, wait));
      }
    }
  }
  throw lastErr ?? new Error("callGeminiWithRetry: all attempts failed");
}
