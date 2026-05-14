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
  /** PNG/JPG bytes do inline image input. Dla wiekszosci use cases — vision. */
  inlineImages?: Array<{ mimeType: string; data: string /* base64 */ }>;
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
  for (const img of opts.inlineImages ?? []) {
    userParts.unshift({ inlineData: { mimeType: img.mimeType, data: img.data } });
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
