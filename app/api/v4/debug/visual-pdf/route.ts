/**
 * Visual audit endpoint — accepts base64 PDF + prompt, returns Claude Vision verdict.
 * Used by tests/e2e/page-visual-via-proxy.mjs when local ANTHROPIC_API_KEY is stale.
 *
 * Limit Anthropic: 5MB per attachment; rozsądny rozmiar payloadu w jednym
 * wywołaniu to do ~3MB (base64 nadmiar ~33%). Per-page strona QSG <300KB.
 *
 * POST /api/v4/debug/visual-pdf
 *   body: { pdf_base64: string, prompt: string, model?: string }
 *   resp: { text, tokens_in, tokens_out, latency_ms }
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getAnthropicClient } from "@/lib/anthropic";

export const runtime = "nodejs";
export const maxDuration = 60;

interface VisualReq {
  pdf_base64: string;
  prompt: string;
  model?: string;
}

export async function POST(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json()) as VisualReq;
  if (!body.pdf_base64 || typeof body.pdf_base64 !== "string") {
    return NextResponse.json({ error: "missing pdf_base64" }, { status: 400 });
  }
  if (!body.prompt || typeof body.prompt !== "string") {
    return NextResponse.json({ error: "missing prompt" }, { status: 400 });
  }

  // Anthropic limit: ~5MB after b64 decode = ~6.7MB base64. Walidujmy proaktywnie.
  const approxBytes = Math.round((body.pdf_base64.length * 3) / 4);
  if (approxBytes > 4_500_000) {
    return NextResponse.json(
      { error: "pdf too large (>4.5MB) — chunkuj per stronę" },
      { status: 413 },
    );
  }

  const model = body.model ?? "claude-haiku-4-5-20251001";
  const client = getAnthropicClient();
  const start = Date.now();
  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 800,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: body.pdf_base64 },
            },
            { type: "text", text: body.prompt },
          ],
        },
      ],
    });
    const text = msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    return NextResponse.json({
      ok: true,
      text,
      tokens_in: msg.usage.input_tokens,
      tokens_out: msg.usage.output_tokens,
      latency_ms: Date.now() - start,
      model: msg.model,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latency_ms: Date.now() - start,
      },
      { status: 500 },
    );
  }
}
