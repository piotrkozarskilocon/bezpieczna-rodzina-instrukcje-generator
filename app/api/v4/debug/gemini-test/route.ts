/**
 * Endpoint diagnostyczny — sprawdza czy GEMINI_API_KEY dziala.
 * Wykonuje minimal call do Gemini API (lista modeli) bez dependency.
 *
 * Uzycie: GET /api/v4/debug/gemini-test
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 30;

function maskKey(key: string): string {
  if (key.length < 12) return "***";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export async function GET(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "GEMINI_API_KEY env var not set in this deployment" },
      { status: 503 },
    );
  }

  // 1. Sprawdz dostepne modele (lekki call, weryfikuje klucz + auth)
  const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  let listResult: { ok: boolean; status: number; modelCount?: number; sample?: string[]; error?: unknown } = {
    ok: false,
    status: 0,
  };
  try {
    const res = await fetch(listUrl);
    listResult.status = res.status;
    if (res.ok) {
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const models = data.models ?? [];
      listResult.ok = true;
      listResult.modelCount = models.length;
      listResult.sample = models
        .map((m) => m.name.replace(/^models\//, ""))
        .filter((n) => n.includes("gemini-2") || n.includes("flash") || n.includes("pro"))
        .slice(0, 10);
    } else {
      listResult.error = await res.text();
    }
  } catch (err) {
    listResult.error = err instanceof Error ? err.message : String(err);
  }

  // 2. Minimalna generacja — Flash, "say hi", structured output sanity check
  const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
  let genResult: { ok: boolean; status: number; text?: string; tokensIn?: number; tokensOut?: number; error?: unknown } = {
    ok: false,
    status: 0,
  };
  try {
    const res = await fetch(genUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Reply with exactly the word: PONG" }] }],
        generationConfig: { maxOutputTokens: 10, temperature: 0 },
      }),
    });
    genResult.status = res.status;
    if (res.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
      genResult.ok = true;
      genResult.text = typeof text === "string" ? text.trim() : null;
      genResult.tokensIn = data?.usageMetadata?.promptTokenCount;
      genResult.tokensOut = data?.usageMetadata?.candidatesTokenCount;
    } else {
      genResult.error = await res.text();
    }
  } catch (err) {
    genResult.error = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json({
    key_present: true,
    key_masked: maskKey(key),
    list_models: listResult,
    generate_pong: genResult,
    verdict: listResult.ok && genResult.ok ? "GEMINI API KEY WORKS" : "GEMINI API KEY FAILED",
  });
}
