/**
 * Auto-split przepełnionych stron.
 *
 * Problem: czasem sekcja ma za dużo treści dla jednej strony — overflow,
 * niemożliwy do rozwiązania overlap, lub clamp musiał skrócić elementy do
 * minimalnych wymiarów. User: "Jeżeli czasem zdarza się, że w jednej sekcji
 * należy zawrzeć dużo informacji, to można i powinno się rozbijać taką sekcję
 * na więcej niż jedną stronę."
 *
 * Strategia:
 *  1. Detekcja: per page sprawdź heurystyki (overcrowded / unresolved overlap).
 *  2. AI Claude: dla każdej kwalifikującej się strony zaproponuj split — zwraca
 *     2 sety elementów (część (1/2) i (2/2)), oba mieszczą się w bounds.
 *  3. Aplikacja: update obecnej strony, INSERT nowej strony po, shift następnych
 *     page_number +1, update title z " (1/2)" / " (2/2)".
 *
 * SSE — heartbeat 10s, do 5min, chunked w razie potrzeby.
 */

import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { findOverlapGroups } from "@/lib/v4OverlapResolver";
import { hasOutOfBoundsElements } from "@/lib/v4BoundsClamp";
import { z } from "zod";
import { logAiCall } from "@/lib/v4AiLog";

export const runtime = "nodejs";
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ElementSchema = z.object({
  type: z.string(),
  x_mm: z.number(),
  y_mm: z.number(),
  w_mm: z.number(),
  h_mm: z.number(),
  z_index: z.number().nullable().optional(),
  rotation_deg: z.number().nullable().optional(),
  properties: z.record(z.string(), z.unknown()),
});

const SplitOutputSchema = z.object({
  page_1_elements: z.array(ElementSchema).describe("Elementy dla strony 1/2 — pierwsze połowy treści, max 6-7 elementów"),
  page_2_elements: z.array(ElementSchema).describe("Elementy dla strony 2/2 — kontynuacja, max 6-7 elementów"),
  page_1_title_suffix: z.string().describe("Suffix tytułu strony 1 — zwykle '(1/2)'"),
  page_2_title_suffix: z.string().describe("Suffix tytułu strony 2 — zwykle '(2/2)'"),
});

const SPLIT_SYSTEM = `Jesteś ekspertem layoutu drukowanych instrukcji. Otrzymujesz stronę która jest przepełniona — zbyt dużo treści dla wymiarów strony lub elementy zachodzą na siebie w niemożliwy do rozwiązania sposób. Twoje zadanie: ROZBIĆ stronę na 2 strony zachowując 100% treści.

Zasady:
1. Logiczny podział — pierwsza strona zawiera wstęp/pierwsze kroki, druga kontynuację.
2. Każdy element musi mieścić się w bounds nowej strony (x_mm + w_mm <= pageWidth - 3, y_mm + h_mm <= pageHeight - 3, x_mm/y_mm >= 3).
3. Elementy NIE MOGĄ się nakładać (text-text overlap to bug).
4. Spójność fontów — używaj tych samych font_size_pt na obu stronach.
5. Page title dostaje suffix '(1/2)' i '(2/2)' — wyraźnie pokazuje że to kontynuacja.
6. Jeśli na stronie 1 jest page_number element, ZACHOWAJ go (dla pierwszej strony) i UWZGLĘDNIJ że strona 2 dostanie własny.
7. Jeśli jest tytuł sekcji (np. "Krok 3: Konfiguracja"), zachowaj go na obu stronach (z (1/2)/(2/2)).
8. Zachowaj page_number element jeśli był (zmień na placeholder, renderer zaktualizuje).
9. NIE wymyślaj nowej treści — tylko ROZŁÓŻ istniejącą.

Zwracaj WYLACZNIE strukturalny JSON wg schema submit_page_split.`;

async function detectOverflowPages(projectId: string): Promise<Array<{
  id: string;
  page_number: number;
  title: string | null;
  template: string;
  width_mm: number;
  height_mm: number;
  reasons: string[];
}>> {
  const sb = getSupabaseAdmin();
  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, title, template, width_mm, height_mm")
    .eq("project_id", projectId)
    .order("page_number", { ascending: true });

  if (!pages) return [];

  const candidates: Array<{ id: string; page_number: number; title: string | null; template: string; width_mm: number; height_mm: number; reasons: string[] }> = [];

  for (const page of pages) {
    // Pomijaj cover, toc, warranty_stamp — to specjalne strony bez treści do splitu
    if (["cover", "toc", "warranty_stamp", "blank"].includes(page.template)) continue;

    const { data: elements } = await sb
      .from("gen4_elements")
      .select("id, type, x_mm, y_mm, w_mm, h_mm, z_index")
      .eq("page_id", page.id);

    if (!elements || elements.length === 0) continue;

    const reasons: string[] = [];

    // Heurystyka 1: nadal jest out-of-bounds (clamp nie pomógł)
    if (hasOutOfBoundsElements(elements, page.width_mm, page.height_mm, 3)) {
      reasons.push("element wystaje poza margines mimo clamp");
    }

    // Heurystyka 2: niemożliwy text-text overlap (nawet po dedupe iterative)
    const groups = findOverlapGroups(elements);
    if (groups.length > 0) {
      reasons.push(`nakładające bloki tekstu: ${groups.length} grup`);
    }

    // Heurystyka 3: overcrowded — suma h_mm wszystkich text elementów (z gap 1mm)
    // przekracza dostępną wysokość strony minus margin
    const textEls = elements.filter((e) => e.type === "text" || e.type === "callout");
    if (textEls.length >= 4) {
      const totalH = textEls.reduce((sum, e) => sum + e.h_mm, 0) + (textEls.length - 1) * 1;
      const available = page.height_mm - 2 * 3;
      if (totalH > available + 5) {
        reasons.push(`overcrowded: ${textEls.length} bloków tekstu razem ${totalH.toFixed(0)}mm > ${available}mm dostępne`);
      }
    }

    if (reasons.length > 0) {
      candidates.push({
        id: page.id,
        page_number: page.page_number,
        title: page.title,
        template: page.template,
        width_mm: page.width_mm,
        height_mm: page.height_mm,
        reasons,
      });
    }
  }

  return candidates;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), { status: 503 });
  }

  const { id: projectId } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", projectId)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const sse = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const heartbeat = setInterval(() => {
        try { send("ping", { elapsed_ms: Date.now() - startedAt }); } catch { /* */ }
      }, 10000);

      try {
        const candidates = await detectOverflowPages(projectId);
        send("started", {
          total_pages: candidates.length,
          candidates: candidates.map((c) => ({ page_number: c.page_number, title: c.title, reasons: c.reasons })),
        });

        if (candidates.length === 0) {
          clearInterval(heartbeat);
          send("done", { ok: true, splits: 0, message: "Brak stron wymagających splitu — wszystkie mieszczą się w bounds." });
          controller.close();
          return;
        }

        let splitCount = 0;
        const errors: Array<{ page_number: number; error: string }> = [];

        for (let i = 0; i < candidates.length; i++) {
          const page = candidates[i];
          send("progress", {
            current: i + 1,
            total: candidates.length,
            page_number: page.page_number,
            title: page.title,
            status: "starting",
            reasons: page.reasons,
          });

          try {
            // Pobierz pełne elementy
            const { data: elements } = await sb
              .from("gen4_elements")
              .select("type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties")
              .eq("page_id", page.id)
              .order("z_index", { ascending: true });

            const userPrompt = `Strona ${page.page_number} "${page.title ?? "(bez tytułu)"}"\nTemplate: ${page.template}\nWymiary: ${page.width_mm}×${page.height_mm} mm\n\nProblemy wykryte:\n${page.reasons.map((r) => `  - ${r}`).join("\n")}\n\nElementy obecnej strony (${elements?.length ?? 0}):\n${JSON.stringify(elements, null, 2)}\n\nZrób split tej strony na 2 (zachowaj 100% treści, rozłóż logicznie). Bounds: x_mm/y_mm >= 3, x_mm + w_mm <= ${page.width_mm - 3}, y_mm + h_mm <= ${page.height_mm - 3}.`;

            const ai = await callClaude({
              system: SPLIT_SYSTEM,
              user: userPrompt,
              model: EDIT_MODEL,
              maxTokens: 6000,
              outputSchema: {
                name: "submit_page_split",
                description: "Split strony na 2 z elementami rozłożonymi logicznie",
                schema: SplitOutputSchema,
              },
            });

            const result = ai.parsed;
            if (!result) throw new Error("AI nie zwrócił poprawnego JSON splitu");

            // STEP A: shift następnych stron +1 (żeby zrobić miejsce na nową)
            const { data: laterPages } = await sb
              .from("gen4_pages")
              .select("id, page_number")
              .eq("project_id", projectId)
              .gt("page_number", page.page_number)
              .order("page_number", { ascending: false }); // od najwyzszego, zeby nie kolidowac
            for (const lp of laterPages ?? []) {
              await sb.from("gen4_pages").update({ page_number: lp.page_number + 1 }).eq("id", lp.id);
            }

            // STEP B: update obecną stronę — nowy title + nowe elementy (page_1)
            const newTitle1 = page.title ? `${page.title} ${result.page_1_title_suffix}` : result.page_1_title_suffix;
            await sb.from("gen4_pages").update({ title: newTitle1 }).eq("id", page.id);
            await sb.from("gen4_elements").delete().eq("page_id", page.id);
            if (result.page_1_elements.length > 0) {
              await sb.from("gen4_elements").insert(
                result.page_1_elements.map((el, idx) => ({
                  page_id: page.id,
                  type: el.type,
                  x_mm: el.x_mm, y_mm: el.y_mm, w_mm: el.w_mm, h_mm: el.h_mm,
                  z_index: el.z_index ?? idx,
                  rotation_deg: el.rotation_deg ?? 0,
                  properties: el.properties,
                  origin: "ai",
                })),
              );
            }

            // STEP C: insert nową stronę 2/2 z page_number = page.page_number + 1
            const newTitle2 = page.title ? `${page.title} ${result.page_2_title_suffix}` : result.page_2_title_suffix;
            const { data: newPage, error: insertErr } = await sb
              .from("gen4_pages")
              .insert({
                project_id: projectId,
                page_number: page.page_number + 1,
                template: page.template,
                title: newTitle2,
                width_mm: page.width_mm,
                height_mm: page.height_mm,
              })
              .select("id")
              .single();
            if (insertErr || !newPage) throw new Error(`insert new page failed: ${insertErr?.message}`);

            if (result.page_2_elements.length > 0) {
              await sb.from("gen4_elements").insert(
                result.page_2_elements.map((el, idx) => ({
                  page_id: newPage.id,
                  type: el.type,
                  x_mm: el.x_mm, y_mm: el.y_mm, w_mm: el.w_mm, h_mm: el.h_mm,
                  z_index: el.z_index ?? idx,
                  rotation_deg: el.rotation_deg ?? 0,
                  properties: el.properties,
                  origin: "ai",
                })),
              );
            }

            void logAiCall({
              project_id: projectId,
              page_id: page.id,
              endpoint: "auto-split-pages",
              context_type: "page",
              system_prompt: SPLIT_SYSTEM,
              user_prompt: userPrompt,
              model: ai.model,
              max_tokens: 6000,
              response_text: JSON.stringify(result).slice(0, 5000),
              tokens_in: ai.inputTokens,
              tokens_out: ai.outputTokens,
              duration_ms: Date.now() - startedAt,
              user_email: auth.email,
            });

            splitCount++;
            send("progress", {
              current: i + 1,
              total: candidates.length,
              page_number: page.page_number,
              title: page.title,
              status: "split-done",
              page_1_elements: result.page_1_elements.length,
              page_2_elements: result.page_2_elements.length,
              new_total_pages_offset: i + 1, // każdy split dodaje 1 stronę
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push({ page_number: page.page_number, error: msg.slice(0, 200) });
            send("progress", {
              current: i + 1,
              total: candidates.length,
              page_number: page.page_number,
              status: "error",
              error: msg.slice(0, 200),
            });
          }
        }

        clearInterval(heartbeat);
        send("done", {
          ok: true,
          splits: splitCount,
          errors,
          duration_ms: Date.now() - startedAt,
        });
        controller.close();
      } catch (err) {
        clearInterval(heartbeat);
        const msg = err instanceof Error ? err.message : String(err);
        send("error", { error: msg });
        controller.close();
      }
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
