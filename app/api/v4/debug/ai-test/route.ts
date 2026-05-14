/**
 * Smoke test Multi-Provider Gateway — wykonuje minimal call do Anthropic Haiku
 * i Gemini Flash przez wspolny callAi(), porownuje wyniki. Pomaga zweryfikowac
 * ze oba providery dzialaja po deployu i ze routing wybiera wlasciwy provider
 * po model ID.
 *
 * Uzycie: GET /api/v4/debug/ai-test
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { callAi, inferProvider } from "@/lib/v4AiProviders";

export const runtime = "nodejs";
export const maxDuration = 30;

const PROMPT_SYSTEM = "Odpowiadaj WYŁĄCZNIE jednym slowem.";
const PROMPT_USER = "Stolica Polski to:";
const EXPECTED = "warszawa";

async function testProvider(modelId: string) {
  const start = Date.now();
  try {
    const res = await callAi({
      model: modelId,
      system: PROMPT_SYSTEM,
      user: PROMPT_USER,
      maxTokens: 20,
      temperature: 0,
    });
    const text = res.text.trim();
    const correct = text.toLowerCase().includes(EXPECTED);
    return {
      ok: true,
      provider: res.provider,
      model: res.model,
      text,
      correct,
      tokens_in: res.inputTokens,
      tokens_out: res.outputTokens,
      latency_ms: res.latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      provider: inferProvider(modelId),
      model: modelId,
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    };
  }
}

export async function GET(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Rownolegle — laczne ~2-5s zamiast 4-10s sekwencyjnie
  const [anthropic, gemini] = await Promise.all([
    testProvider("claude-haiku-4-5-20251001"),
    testProvider("gemini-2.5-flash"),
  ]);

  const verdict =
    anthropic.ok && gemini.ok
      ? "BOTH PROVIDERS WORK"
      : anthropic.ok && !gemini.ok
        ? "ONLY ANTHROPIC WORKS"
        : !anthropic.ok && gemini.ok
          ? "ONLY GEMINI WORKS"
          : "BOTH PROVIDERS FAILED";

  return NextResponse.json({
    verdict,
    anthropic,
    gemini,
    prompt: { system: PROMPT_SYSTEM, user: PROMPT_USER, expected_contains: EXPECTED },
  });
}
