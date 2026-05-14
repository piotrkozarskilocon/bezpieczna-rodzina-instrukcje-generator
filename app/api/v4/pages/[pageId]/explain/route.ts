import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { ownPage, loadPageWithElements } from "@/lib/v4Edit";
import { getRequiredSections, type DocumentType, type DeviceType } from "@/lib/v4LegalTemplates";
import { loadActiveNotes } from "@/lib/v4Notes";
import { logAiCall } from "@/lib/v4AiLog";

export const runtime = "nodejs";
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

/**
 * AI tłumaczy strukturę bieżącej strony — dlaczego zawiera te elementy,
 * skąd wzięły się konkretne sekcje (legal templates), które notatki AI
 * miały wpływ. Pomaga w audycie i edukacji nowych pracowników.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY nie skonfigurowany" },
      { status: 503 },
    );
  }

  const data = await loadPageWithElements(pageId);
  if (!data) return NextResponse.json({ error: "page not found" }, { status: 404 });
  const { page, elements } = data;

  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("ai_input, document_type, device_type")
    .eq("id", page.project_id)
    .single();
  const aiInput = (project?.ai_input ?? {}) as Record<string, unknown>;
  const docType = (project?.document_type ?? null) as DocumentType | null;
  const devType = (project?.device_type ?? null) as DeviceType | null;

  // Znajdź sekcję z legal templates (jak w auto-populate).
  let sectionInfo: { id: string; title: string; description: string; legal_basis?: string } | null = null;
  if (docType && devType) {
    const stepCount = typeof aiInput.step_count === "number" ? aiInput.step_count : 1;
    const sections = getRequiredSections(docType, devType, stepCount);
    const idx = page.page_number - 1;
    const titleLower = (page.title ?? "").toLowerCase();
    const match =
      sections.find((s) => s.title === page.title) ??
      sections.find((s) => titleLower.startsWith(s.title.toLowerCase())) ??
      sections[idx] ??
      null;
    if (match) {
      sectionInfo = {
        id: match.id,
        title: match.title,
        description: match.description,
        legal_basis: match.legal_basis,
      };
    }
  }

  const notes = await loadActiveNotes({
    owner_email: auth.email,
    document_type: docType ?? undefined,
    device_type: devType ?? undefined,
    project_id: page.project_id,
  });

  const system = [
    "Jesteś analitykiem instrukcji obsługi. Otrzymujesz strukturę POJEDYNCZEJ strony",
    "drukowanej instrukcji + kontekst (typ dokumentu, urządzenie, wymagania prawne, notatki AI)",
    "i Twoja praca to WYTŁUMACZYĆ użytkownikowi DLACZEGO strona wygląda tak jak wygląda.",
    "",
    "Format odpowiedzi: zwięzły markdown w języku polskim. Sekcje:",
    "  ## Cel tej strony",
    "  (1-2 zdania o roli strony w dokumencie)",
    "  ## Wymagania prawne",
    "  (jeśli sekcja ma podstawę prawną — wyjaśnij którego artykułu/dyrektywy dotyczy)",
    "  ## Elementy na stronie",
    "  (lista wszystkich elementów z krótkim wyjaśnieniem każdego — co reprezentuje, dlaczego ma taki rozmiar/pozycję)",
    "  ## Reguły AI które wpłynęły",
    "  (jeśli notatki dotyczyły tej strony — wymień te które mogły mieć wpływ)",
    "",
    "Bądź konkretny i edukacyjny — to ma być przydatne nawet dla osoby która pierwszy raz",
    "ogląda generator instrukcji. NIE wymyślaj danych których nie widzisz w strukturze.",
  ].join("\n");

  const userLines: string[] = [
    `## Kontekst projektu`,
    `Model: ${typeof aiInput.model_name === "string" ? aiInput.model_name : "?"} (${typeof aiInput.model_code === "string" ? aiInput.model_code : "?"})`,
    `Typ dokumentu: ${docType ?? "nieznany"}`,
    `Typ urządzenia: ${devType ?? "nieznany"}`,
    ``,
    `## Strona ${page.page_number}`,
    `Template: ${page.template ?? "blank"}`,
    `Tytuł: ${page.title ?? "(brak)"}`,
    `Wymiary: ${page.width_mm}×${page.height_mm} mm`,
    ``,
  ];

  if (sectionInfo) {
    userLines.push(`## Sekcja z legal templates (id: ${sectionInfo.id})`);
    userLines.push(`Opis: ${sectionInfo.description}`);
    if (sectionInfo.legal_basis) userLines.push(`Podstawa prawna: ${sectionInfo.legal_basis}`);
    userLines.push("");
  }

  userLines.push(`## Elementy na stronie (${elements.length})`);
  for (const el of elements) {
    const props = el.properties as Record<string, unknown>;
    const summary =
      el.type === "text" || el.type === "callout"
        ? `"${(props.content as string ?? "").slice(0, 100)}"`
        : el.type === "image"
          ? `image_id=${props.image_id ?? "null"}`
          : el.type === "qr"
            ? `url=${props.url ?? "(brak)"}`
            : el.type === "page_number"
              ? `format=${props.format ?? "{n}/{N}"}`
              : "";
    userLines.push(`- ${el.type} @ (${el.x_mm.toFixed(1)},${el.y_mm.toFixed(1)}) ${el.w_mm.toFixed(1)}×${el.h_mm.toFixed(1)}mm — ${summary}`);
  }

  if (notes.length > 0) {
    userLines.push("");
    userLines.push(`## Aktywne notatki AI dla tego kontekstu`);
    for (const n of notes) {
      userLines.push(`- [${n.scope}] ${n.content}`);
    }
  }

  userLines.push("");
  userLines.push("Wytłumacz tę stronę zgodnie z formatem opisanym w prompcie systemowym.");

  const explainUser = userLines.join("\n");
  const explainStartedAt = Date.now();
  try {
    const ai = await callClaude({
      system,
      user: explainUser,
      model: EDIT_MODEL,
      maxTokens: 2000,
    });
    void logAiCall({
      project_id: page.project_id,
      page_id: pageId,
      endpoint: "explain",
      context_type: "page",
      user_instruction: "explain page decisions",
      system_prompt: system,
      user_prompt: explainUser,
      model: ai.model,
      max_tokens: 2000,
      response_text: ai.text,
      tokens_in: ai.inputTokens,
      tokens_out: ai.outputTokens,
      duration_ms: Date.now() - explainStartedAt,
      user_email: auth.email,
    });
    return NextResponse.json({ explanation: ai.text, model: ai.model });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "AI call failed" },
      { status: 502 },
    );
  }
}
