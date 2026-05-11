import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { parseJsonFromAi } from "@/lib/v4Generate";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface Mapping {
  image_id: string;
  image_name: string;
  image_description: string | null;
  suggested_page_id: string | null;
  suggested_page_number: number | null;
  suggested_page_title: string | null;
  confidence: "high" | "medium" | "low" | "none";
  reason: string;
}

/**
 * AI proponuje rozmieszczenie obrazków na stronach projektu. Nie zapisuje
 * niczego — frontend pokazuje propozycje do zatwierdzenia, potem osobne
 * wywołanie /apply zapisze wybrane preferred_page_id.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("id, owner_email, ai_input")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY nie skonfigurowany" },
      { status: 503 },
    );
  }

  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, template, title")
    .eq("project_id", id)
    .order("page_number", { ascending: true });
  const { data: images } = await sb
    .from("gen4_images")
    .select("id, name, description, preferred_page_id")
    .eq("project_id", id)
    .order("created_at", { ascending: false });

  if (!pages || !images) {
    return NextResponse.json({ error: "no pages or images" }, { status: 400 });
  }
  if (images.length === 0) {
    return NextResponse.json({ mappings: [], message: "Biblioteka pusta — wgraj obrazki najpierw." });
  }
  if (pages.length === 0) {
    return NextResponse.json({ error: "Projekt nie ma stron — wygeneruj szkielet" }, { status: 400 });
  }

  const aiInput = (project.ai_input ?? {}) as Record<string, unknown>;
  const modelName = typeof aiInput.model_name === "string" ? aiInput.model_name : "Locon Watch";
  const modelCode = typeof aiInput.model_code === "string" ? aiInput.model_code : "GJD.XX";

  const system = [
    "Jesteś asystentem dopasowującym obrazki do stron drukowanej instrukcji obsługi.",
    `Model docelowy: ${modelName} (${modelCode}).`,
    "",
    "Dostajesz LISTĘ STRON (z tytułami) i LISTĘ OBRAZKÓW (z krótkimi opisami).",
    "Twoja praca: dla każdego obrazka zdecyduj na której stronie najlepiej pasuje.",
    "Jedno-do-jednego: jeden obrazek → jedna strona. Możesz zostawić obrazek bez",
    "przypisania jeśli opis nie pasuje do żadnej strony.",
    "",
    "Reguły:",
    "- Porównuj OPIS obrazka z TYTUŁEM strony oraz typowym kontekstem.",
    "  'ekran logowania w aplikacji' pasuje do 'Krok N: Pobierz aplikację' / 'Konfiguracja konta'.",
    "  'front zegarka' pasuje do 'Budowa urządzenia' / 'Specyfikacja techniczna'.",
    "  'tabela SAR' pasuje do 'Informacja SAR' / 'Specyfikacja techniczna'.",
    "  'QR App Store' pasuje do 'Pobierz aplikację' / 'Kontakt'.",
    "- Obrazek z BRAK OPISU → confidence 'none' i suggested_page_id=null.",
    "- Wiele obrazków pasujących do tej samej strony — przypisz wszystkie (osobne wpisy),",
    "  AI poprawnie ułoży je na stronie w kolejnym kroku auto-populate.",
    "",
    "Format odpowiedzi — WYŁĄCZNIE surowy JSON. Bez fence ```. Bez prozy.",
    "Schemat:",
    "{",
    '  "mappings": [',
    "    {",
    '      "image_id": "<uuid>",',
    '      "suggested_page_id": "<uuid lub null>",',
    '      "confidence": "high|medium|low|none",',
    '      "reason": "krótkie uzasadnienie w jednym zdaniu"',
    "    }",
    "  ]",
    "}",
  ].join("\n");

  const userLines: string[] = [
    "LISTA STRON:",
  ];
  for (const p of pages) {
    userLines.push(`- id: "${p.id}"  #${p.page_number}  template:${p.template ?? "blank"}  tytuł: ${p.title ? `"${p.title}"` : "(brak)"}`);
  }
  userLines.push("");
  userLines.push("LISTA OBRAZKÓW:");
  for (const img of images) {
    userLines.push(`- id: "${img.id}"  nazwa: "${img.name}"  opis: ${img.description ? `"${img.description}"` : "(BRAK OPISU)"}`);
  }
  userLines.push("");
  userLines.push("Zwróć JSON z rekomendacjami dla każdego obrazka z listy.");

  try {
    const ai = await callClaude({
      system,
      user: userLines.join("\n"),
      model: EDIT_MODEL,
      maxTokens: 3000,
    });
    const parsed = parseJsonFromAi<{ mappings: Array<{ image_id: string; suggested_page_id: string | null; confidence: string; reason: string }> }>(ai.text);
    const pageById = new Map(pages.map((p) => [p.id, p]));

    const mappings: Mapping[] = images.map((img) => {
      const aiMapping = parsed.mappings?.find((m) => m.image_id === img.id);
      const suggestedPageId = aiMapping?.suggested_page_id ?? null;
      const page = suggestedPageId ? pageById.get(suggestedPageId) : null;
      const conf = aiMapping?.confidence;
      return {
        image_id: img.id,
        image_name: img.name,
        image_description: img.description,
        suggested_page_id: page ? page.id : null,
        suggested_page_number: page?.page_number ?? null,
        suggested_page_title: page?.title ?? page?.template ?? null,
        confidence:
          conf === "high" || conf === "medium" || conf === "low" || conf === "none"
            ? conf
            : "low",
        reason: aiMapping?.reason ?? "(brak uzasadnienia AI)",
      };
    });

    await sb.from("gen4_ai_history").insert({
      project_id: id,
      role: "assistant",
      content: `image-mapping preview: ${mappings.length} obrazków`,
      structured: {
        workflow_type: "image_mapping_preview",
        images_count: images.length,
        pages_count: pages.length,
      },
      model: ai.model,
      input_tokens: ai.inputTokens,
      output_tokens: ai.outputTokens,
      latency_ms: ai.latencyMs,
    });

    return NextResponse.json({ mappings });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI call failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
