/**
 * AI auto-fill placeholderow '⚠️ DO UZUPEŁNIENIA: <opis>' wartościami z
 * extracted_structured plikow referencyjnych.
 *
 * Flow:
 * 1. Pobierz wszystkie placeholdery w projekcie (text + callout elementy)
 * 2. Pobierz wszystkie refDocs z extracted_structured
 * 3. Przekaz do AI: lista placeholderow + paczka structured values
 * 4. AI zwraca per placeholder: { element_id, new_value } albo null
 * 5. Server zastapuje placeholder w treści (atomicznie per element)
 *
 * Krytyczna funkcja: zamienia 'wartość SAR head' placeholder na faktyczne '0.414 W/kg'
 * znalezione w sar_report.sar_head_max.value_w_per_kg.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { logAiCall } from "@/lib/v4AiLog";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PLACEHOLDER_RE = /⚠️\s*DO\s+UZUPE[ŁL]NIENIA\s*[:：]?\s*(.+)/i;

const FillSchema = z.object({
  fills: z.array(z.object({
    element_id: z.string().describe("ID elementu z listy placeholderow"),
    new_value: z.string().describe("Wartosc do wstawienia w miejsce '⚠️ DO UZUPELNIENIA: X' (sama wartosc, bez prefiksu DO UZUPELNIENIA)"),
    confidence: z.enum(["high", "medium", "low"]).describe("Pewnosc dopasowania (high=znaleziono w refDocs, low=zgaduje)"),
    source: z.string().describe("Z jakiego pliku/pola pochodzi wartosc np. 'sar_report.sar_head_max'"),
  })).describe("Lista propozycji wypelnien — TYLKO te dla ktorych wartosc faktycznie znaleziono w refDocs"),
  unfilled_count: z.number().describe("Ile placeholderow zostalo bez propozycji (brak danych)"),
});

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 503 });
  }

  const { id: projectId } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email, ai_input")
    .eq("id", projectId)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const aiInput = (project.ai_input ?? {}) as Record<string, unknown>;
  const modelName = typeof aiInput.model_name === "string" ? aiInput.model_name : null;
  const modelCode = typeof aiInput.model_code === "string" ? aiInput.model_code : null;

  // 1. Zbierz placeholdery z calego projektu.
  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, title")
    .eq("project_id", projectId);
  if (!pages || pages.length === 0) {
    return NextResponse.json({ error: "Brak stron w projekcie" }, { status: 400 });
  }
  const pageIds = pages.map((p) => p.id);
  const pageMap = new Map(pages.map((p) => [p.id, p]));

  const { data: elements } = await sb
    .from("gen4_elements")
    .select("id, page_id, type, properties")
    .in("page_id", pageIds);

  interface PlaceholderEl {
    element_id: string;
    page_number: number;
    page_title: string | null;
    type: string;
    full_content: string;
    placeholder_label: string;
  }
  const placeholders: PlaceholderEl[] = [];
  for (const el of elements ?? []) {
    if (el.type !== "text" && el.type !== "callout") continue;
    const props = el.properties as { content?: string };
    const content = props?.content;
    if (typeof content !== "string") continue;
    const match = content.match(PLACEHOLDER_RE);
    if (!match) continue;
    const page = pageMap.get(el.page_id);
    if (!page) continue;
    placeholders.push({
      element_id: el.id,
      page_number: page.page_number,
      page_title: page.title,
      type: el.type,
      full_content: content,
      placeholder_label: match[1].trim(),
    });
  }

  if (placeholders.length === 0) {
    return NextResponse.json({
      ok: true,
      filled: 0,
      placeholders_found: 0,
      message: "Brak placeholderow DO UZUPELNIENIA w projekcie.",
    });
  }

  // 2. Zbierz refDocs z extracted_structured + extracted_summary.
  const { data: refDocs } = await sb
    .from("gen4_reference_docs")
    .select("id, kind, name, extracted_summary, extracted_structured")
    .eq("project_id", projectId)
    .not("extracted_structured", "is", null);

  if (!refDocs || refDocs.length === 0) {
    return NextResponse.json({
      ok: true,
      filled: 0,
      placeholders_found: placeholders.length,
      message: "Brak refDocs z wyekstrahowanymi wartosciami. Uruchom najpierw '✨ Wyekstrahuj wartosci AI' dla plikow.",
    });
  }

  // 3. AI: dopasuj placeholdery do values z refDocs.
  const system = `Jestes asystentem ktory dopasowuje placeholdery '⚠️ DO UZUPEŁNIENIA: <opis>' z dokumentu QSG do konkretnych wartosci wyekstrahowanych z plikow referencyjnych.

Twoja praca:
1. Dla kazdego placeholdera (label + kontekst strony) sprawdz czy wartosc jest w referencyjnych structured values.
2. Jezeli TAK — zwroc element_id + new_value (sama wartosc, NIE z prefiksem "DO UZUPELNIENIA").
3. Jezeli NIE — pomin (nie wymyslaj wartosci).
4. confidence: high (jasne dopasowanie), medium (prawdopodobne), low (zgadujesz).
5. source: z jakiego refDoc.field wzieta wartosc.

WAZNE: zwracasz TYLKO te placeholdery dla ktorych masz dane. Brakujace zostaja w 'unfilled_count'.

${modelName && modelCode ? `Model docelowy: ${modelName} (${modelCode}). Pomijaj wartosci dla innych modeli.` : ""}`;

  const userPrompt = [
    "PLACEHOLDERY DO WYPELNIENIA:",
    JSON.stringify(placeholders.map((p) => ({
      element_id: p.element_id,
      page_number: p.page_number,
      page_title: p.page_title,
      label: p.placeholder_label,
      context: p.full_content.slice(0, 200),
    })), null, 2),
    "",
    "WARTOSCI Z PLIKOW REFERENCYJNYCH:",
    JSON.stringify(refDocs.map((d) => ({
      file_name: d.name,
      kind: d.kind,
      summary: d.extracted_summary?.slice(0, 200),
      structured: d.extracted_structured,
    })), null, 2),
    "",
    "Dopasuj kazdy placeholder. Zwroc TYLKO te dla ktorych masz dane.",
  ].join("\n");

  const startedAt = Date.now();
  try {
    const ai = await callClaude({
      system,
      user: userPrompt,
      model: EDIT_MODEL,
      maxTokens: 8000,
      outputSchema: {
        name: "submit_placeholder_fills",
        description: "Dopasowane wypelnienia placeholderow z refDocs",
        schema: FillSchema,
      },
    });
    if (!ai.parsed) {
      return NextResponse.json({ error: "AI did not return structured output" }, { status: 502 });
    }

    const fills = ai.parsed.fills;
    // Aktualizuj kazdy element — zastap '⚠️ DO UZUPELNIENIA: X' na new_value.
    let appliedCount = 0;
    const applied: Array<{ element_id: string; new_value: string; source: string; confidence: string }> = [];
    for (const fill of fills) {
      const ph = placeholders.find((p) => p.element_id === fill.element_id);
      if (!ph) continue;
      // Replace placeholder w content (zostaw resztę treści).
      const newContent = ph.full_content.replace(PLACEHOLDER_RE, fill.new_value);
      const { data: el } = await sb
        .from("gen4_elements")
        .select("properties")
        .eq("id", fill.element_id)
        .single();
      if (!el) continue;
      const newProps = { ...(el.properties as Record<string, unknown>), content: newContent };
      const { error: updateErr } = await sb
        .from("gen4_elements")
        .update({ properties: newProps })
        .eq("id", fill.element_id);
      if (!updateErr) {
        appliedCount++;
        applied.push({
          element_id: fill.element_id,
          new_value: fill.new_value,
          source: fill.source,
          confidence: fill.confidence,
        });
      }
    }

    void logAiCall({
      project_id: projectId,
      endpoint: "projects/autofill-placeholders",
      context_type: "project",
      user_instruction: `autofill ${placeholders.length} placeholders`,
      system_prompt: system,
      user_prompt: userPrompt,
      model: ai.model,
      max_tokens: 8000,
      response_text: JSON.stringify(ai.parsed),
      tokens_in: ai.inputTokens,
      tokens_out: ai.outputTokens,
      duration_ms: Date.now() - startedAt,
      user_email: auth.email,
    });

    return NextResponse.json({
      ok: true,
      filled: appliedCount,
      placeholders_found: placeholders.length,
      unfilled: placeholders.length - appliedCount,
      applied,
      tokens_in: ai.inputTokens,
      tokens_out: ai.outputTokens,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
