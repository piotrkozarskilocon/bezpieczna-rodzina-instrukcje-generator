/**
 * AI auto-categorize obrazkow projektu — Gemini Flash Vision rozpoznaje co
 * przedstawia kazdy obrazek i sugeruje preferred_page_id na podstawie listy
 * stron projektu.
 *
 * Bonus: gdy obrazek nie ma description, AI dodaje krotki opis (jezeli user
 * pominal field przy upload).
 *
 * SSE z progress. Idempotent: pomija obrazki z juz ustawionym preferred_page_id
 * (chyba ze ?force=1).
 */

import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callGeminiWithRetry, GEMINI_FLASH } from "@/lib/v4Gemini";
import { logAiCall } from "@/lib/v4AiLog";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 300;

const BUCKET = "gen4-images";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const SuggestSchema = z.object({
  description_pl: z.string().describe("Krotki opis (1-2 zdania po polsku) tego co widac na obrazku"),
  suggested_page_id: z.string().nullable().describe("ID strony do ktorej obrazek najbardziej pasuje (z listy w prompt), null jezeli zaden nie pasuje wyraźnie"),
  page_match_reason: z.string().describe("Krotki powod dlaczego ta strona pasuje (lub dlaczego zadna)"),
  confidence: z.enum(["high", "medium", "low"]).describe("Pewnosc dopasowania strony"),
});

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  if (!process.env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: "GEMINI_API_KEY not configured" }), { status: 503 });
  }

  const { id: projectId } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project } = await sb.from("gen4_projects").select("owner_email").eq("id", projectId).single();
  if (!project || project.owner_email !== auth.email) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  const force = new URL(request.url).searchParams.get("force") === "1";

  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, template, title")
    .eq("project_id", projectId)
    .order("page_number", { ascending: true });
  const pagesList = (pages ?? []).filter((p) => p.template !== "cover" && p.template !== "toc");

  const { data: images } = await sb
    .from("gen4_images")
    .select("id, name, description, preferred_page_id, mime_type, path")
    .eq("project_id", projectId);
  const targets = force ? (images ?? []) : (images ?? []).filter((img) => !img.preferred_page_id);

  if (targets.length === 0) {
    return new Response(JSON.stringify({
      error: "Brak obrazkow do kategoryzacji (wszystkie maja preferred_page_id). Uzyj ?force=1.",
    }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const sse = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("started", { total: targets.length });
      const heartbeat = setInterval(() => {
        try { send("ping", { elapsed_ms: Date.now() - startedAt }); } catch { /* */ }
      }, 10000);

      let okCount = 0;
      let errCount = 0;

      const sys = `Jestes ekspertem ktory rozpoznaje obrazki w kontekscie instrukcji obslugi smartwatcha/trackera.

Twoja praca:
1. Opisz krotko (1-2 zdania po polsku) co widac na obrazku (np. "Tylna czesc zegarka ze stykami ładowania", "Przycisk SOS na boku obudowy", "Ekran z menu glownym aplikacji").
2. Wybierz STRONE z listy do ktorej obrazek najlepiej pasuje (zwroc jej ID).
3. Krotki powod (1 zdanie).
4. Confidence: high (jasne dopasowanie), medium (prawdopodobne), low (slabe).`;

      for (let i = 0; i < targets.length; i++) {
        const img = targets[i];
        send("progress", { current: i + 1, total: targets.length, image_name: img.name, status: "starting" });

        try {
          const { data: dl, error: dlErr } = await sb.storage.from(BUCKET).download(img.path);
          if (dlErr || !dl) throw new Error(`download fail: ${dlErr?.message ?? "no data"}`);
          const buf = Buffer.from(await dl.arrayBuffer());
          const base64 = buf.toString("base64");
          const mime = img.mime_type || "image/png";

          const userPrompt = `Plik: ${img.name}
${img.description ? `Aktualny opis: ${img.description}` : "(brak opisu)"}

Lista stron projektu (wybierz id najlepiej pasujacej):
${pagesList.map((p) => `- id="${p.id}" — strona ${p.page_number}: "${p.title ?? "(brak tytulu)"}" [template=${p.template ?? "blank"}]`).join("\n")}

Co przedstawia obrazek? Ktora strona najlepiej pasuje?`;

          const ai = await callGeminiWithRetry({
            system: sys,
            user: userPrompt,
            model: GEMINI_FLASH,
            maxTokens: 1000,
            outputSchema: { name: "suggest_image_page", description: "Sugestia strony dla obrazka", schema: SuggestSchema },
            inlineFiles: [{ mimeType: mime, data: base64 }],
          });
          if (!ai.parsed) throw new Error("Gemini did not return parsed");
          const result = ai.parsed;

          // Walidacja: czy suggested_page_id jest na liście dopuszczalnych stron
          const validPageId = result.suggested_page_id && pagesList.some((p) => p.id === result.suggested_page_id)
            ? result.suggested_page_id
            : null;

          const updates: Record<string, unknown> = {};
          if (validPageId) updates.preferred_page_id = validPageId;
          if (!img.description && result.description_pl) updates.description = result.description_pl;
          if (Object.keys(updates).length > 0) {
            await sb.from("gen4_images").update(updates).eq("id", img.id);
          }

          void logAiCall({
            project_id: projectId,
            endpoint: "images/auto-categorize",
            context_type: "project",
            user_instruction: `categorize image ${img.name}`,
            system_prompt: sys,
            user_prompt: userPrompt,
            model: ai.model,
            max_tokens: 1000,
            response_text: JSON.stringify(result),
            tokens_in: ai.inputTokens,
            tokens_out: ai.outputTokens,
            duration_ms: 0,
            user_email: auth.email,
          });

          okCount++;
          send("progress", {
            current: i + 1,
            total: targets.length,
            image_name: img.name,
            status: "done",
            description: result.description_pl,
            suggested_page_id: validPageId,
            confidence: result.confidence,
          });
        } catch (err) {
          errCount++;
          const msg = err instanceof Error ? err.message : String(err);
          send("progress", { current: i + 1, total: targets.length, image_name: img.name, status: "error", error: msg.slice(0, 200) });
        }
      }

      clearInterval(heartbeat);
      send("done", { total: targets.length, ok: okCount, err: errCount, duration_ms: Date.now() - startedAt });
      controller.close();
    },
  });

  return new Response(sse, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
