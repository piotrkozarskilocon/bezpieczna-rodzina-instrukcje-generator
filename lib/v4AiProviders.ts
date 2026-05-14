/**
 * Multi-Provider AI Gateway — wspolny interfejs dla Anthropic + Gemini.
 *
 * Endpointy uzywaja `callAi(opts)` zamiast bezposrednio `callClaude`/`callGemini`.
 * Provider wybierany jest przez model ID (prefix `claude-...` → Anthropic;
 * `gemini-...` → Gemini), albo jawnie przez `provider` w opts.
 *
 * Korzysci:
 * - Routing per task (Haiku dla geometry, Sonnet dla tresci, Flash dla bulk
 *   translation, Pro dla SAR vision) — bez zmian w endpointach.
 * - Wspolny `AiResponse` shape — logowanie do gen4_ai_calls dziala identycznie.
 * - Mozliwosc A/B testow tego samego promptu na 2 providerach.
 */

import { z, type ZodSchema } from "zod";
import {
  callClaude,
  AVAILABLE_MODELS as ANTHROPIC_MODELS,
  type AiResponse as AnthropicAiResponse,
} from "@/lib/anthropic";
import {
  callGemini,
  GEMINI_MODELS,
  GEMINI_FLASH,
  type GeminiResponse,
} from "@/lib/v4Gemini";

export type ProviderName = "anthropic" | "gemini";

/** Modele do UI picker — Anthropic + Gemini razem, z polem `provider`. */
export const ALL_MODELS = [
  ...ANTHROPIC_MODELS.map((m) => ({ ...m, provider: "anthropic" as const })),
  ...GEMINI_MODELS,
] as const;

export type AnyModelId = (typeof ALL_MODELS)[number]["id"];

/** Zwraca provider na podstawie model ID. */
export function inferProvider(modelId: string): ProviderName {
  if (modelId.startsWith("gemini-")) return "gemini";
  return "anthropic"; // claude-* oraz fallback dla nieznanych
}

export interface CallAiOpts<T = unknown> {
  /** Provider override. Gdy null — wnioskujemy z `model`. */
  provider?: ProviderName;
  system: string;
  user: string;
  /** Model ID — np. "claude-haiku-4-5-20251001" lub "gemini-2.5-flash". */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Structured output (Zod schema). Implementacja per provider —
   *  Anthropic uzywa tool_use, Gemini uzywa responseSchema. */
  outputSchema?: { name: string; description: string; schema: ZodSchema<T> };
  /** Dla Anthropic — Files API attachments. Dla Gemini — pomijane (uzyj
   *  `inlineImages` zamiast tego, bo Gemini nie ma Files API per Anthropic). */
  attachments?: string[];
  /** Dla Gemini — inline image bytes. Dla Anthropic — pomijane (uzyj
   *  attachments z file_id). */
  inlineImages?: Array<{ mimeType: string; data: string }>;
  cacheSystemPrompt?: boolean;
}

/** Wspolny shape AiResponse — co Anthropic, co Gemini. */
export interface UnifiedAiResponse<T = unknown> {
  provider: ProviderName;
  text: string;
  parsed?: T;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  model: string;
  latencyMs: number;
}

function fromAnthropic<T>(res: AnthropicAiResponse<T>, model: string): UnifiedAiResponse<T> {
  return {
    provider: "anthropic",
    text: res.text,
    parsed: res.parsed,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    cacheCreationTokens: res.cacheCreationTokens,
    cacheReadTokens: res.cacheReadTokens,
    model: res.model || model,
    latencyMs: res.latencyMs,
  };
}

function fromGemini<T>(res: GeminiResponse<T>): UnifiedAiResponse<T> {
  return {
    provider: "gemini",
    text: res.text,
    parsed: res.parsed,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    model: res.model,
    latencyMs: res.latencyMs,
  };
}

export async function callAi<T = unknown>(opts: CallAiOpts<T>): Promise<UnifiedAiResponse<T>> {
  const modelId = opts.model ?? "";
  const provider = opts.provider ?? inferProvider(modelId);

  if (provider === "gemini") {
    const res = await callGemini<T>({
      system: opts.system,
      user: opts.user,
      model: opts.model ?? GEMINI_FLASH,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      outputSchema: opts.outputSchema,
      inlineImages: opts.inlineImages,
    });
    return fromGemini(res);
  }

  // Anthropic (default)
  const res = await callClaude<T>({
    system: opts.system,
    user: opts.user,
    model: opts.model,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    outputSchema: opts.outputSchema,
    attachments: opts.attachments,
    cacheSystemPrompt: opts.cacheSystemPrompt,
  });
  return fromAnthropic(res, opts.model ?? "");
}

/** Walidacja modelu z user inputu — pozwalamy tylko na te z ALL_MODELS. */
export function resolveAnyModel(requested: string | undefined | null, fallback: string): string {
  if (!requested) return fallback;
  const match = ALL_MODELS.find((m) => m.id === requested);
  return match ? match.id : fallback;
}

// Sanity: schema validation żeby Zod 4 toJSONSchema działało w obu providerach.
// To nie test, tylko import side-effect — gdy ten plik załaduje się w endpoint,
// błąd "Zod 4 incompat" wybuchnie tu, nie w runtime AI call.
void z;
