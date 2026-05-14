import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { parseJsonFromAi } from "@/lib/v4Generate";
import {
  getRequiredSections,
  type DocumentType,
  type DeviceType,
} from "@/lib/v4LegalTemplates";
import { logAiCall } from "@/lib/v4AiLog";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface ComplianceIssue {
  severity: "critical" | "warning" | "info";
  section_id?: string;
  page_number?: number;
  message: string;
  legal_basis?: string;
}

/** Pre-flight AI compliance check — drugi pass Claude analizuje pełen
 *  projekt pod kątem zgodności z legal templates i wskazuje uchybienia. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email, document_type, device_type, ai_input")
    .eq("id", id)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY nie skonfigurowany" }, { status: 503 });
  }

  const docType = project.document_type as DocumentType | null;
  const devType = project.device_type as DeviceType | null;
  if (!docType || !devType) {
    return NextResponse.json({ error: "projekt nie ma typu dokumentu/urządzenia" }, { status: 400 });
  }

  // Załaduj wszystkie strony + ich text/callout treści (do analizy compliance).
  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, template, title")
    .eq("project_id", id)
    .order("page_number", { ascending: true });
  if (!pages || pages.length === 0) {
    return NextResponse.json({ issues: [{ severity: "critical", message: "Projekt nie ma stron" }] });
  }

  const { data: elements } = await sb
    .from("gen4_elements")
    .select("page_id, type, properties")
    .in("page_id", pages.map((p) => p.id))
    .in("type", ["text", "callout"]);

  const textsByPage = new Map<string, string[]>();
  for (const e of elements ?? []) {
    const arr = textsByPage.get(e.page_id) ?? [];
    const content = (e.properties as Record<string, unknown>)?.content;
    if (typeof content === "string" && content.trim()) arr.push(content.trim());
    textsByPage.set(e.page_id, arr);
  }

  const stepCount = typeof (project.ai_input as Record<string, unknown>)?.step_count === "number"
    ? (project.ai_input as Record<string, number>).step_count
    : 1;
  const requiredSections = getRequiredSections(docType, devType, stepCount);
  const requiredRendered = requiredSections.map((s) => `- ${s.title}${s.legal_basis ? ` (${s.legal_basis})` : ""}`).join("\n");

  const pagesRendered = pages.map((p) => {
    const texts = textsByPage.get(p.id) ?? [];
    return `STRONA ${p.page_number} [template:${p.template ?? "blank"}] "${p.title ?? "(brak)"}"\n${texts.map((t) => `  ${t.slice(0, 200)}`).join("\n") || "  (brak tekstu)"}`;
  }).join("\n\n");

  const system = [
    "Jesteś prawnym audytorem instrukcji obsługi dla urządzeń marki Locon.",
    "Otrzymujesz pełen tekst projektowanego dokumentu oraz listę wymaganych sekcji",
    "z legal templates. Twoja praca: znaleźć POMYŁKI, BRAKI i NIEZGODNOŚCI ze",
    "wymaganiami prawnymi (RED, UoPK, KC, RODO, MDR).",
    "",
    "Sprawdzaj:",
    "- czy wszystkie wymagane sekcje są obecne",
    "- czy klauzule RODO/MDR/CE mają wymagane treści",
    "- czy są jakieś placeholdery DO UZUPEŁNIENIA które wymagają wartości",
    "- czy język jest spójny (nie mieszać modeli, dat, jednostek)",
    "- czy nie ma 'wymyślonych' numerów (SAR, IMEI, NIP)",
    "",
    "Severity:",
    "- 'critical' = brak obowiązkowej sekcji prawnej, lub wymyślona wartość gdzie wymagana jest realna",
    "- 'warning'  = niekompletna sekcja, brak placeholdera dla brakujących danych",
    "- 'info'     = sugestia stylistyczna / ulepszenie",
    "",
    "Format odpowiedzi — WYŁĄCZNIE surowy JSON bez fence:",
    '{ "issues": [',
    '  { "severity": "critical|warning|info",',
    '    "section_id": "first_use|warranty_terms|...",',
    '    "page_number": 5,',
    '    "message": "konkretny opis uchybienia",',
    '    "legal_basis": "opcjonalnie podstawa prawna" }',
    "  ] }",
    "Jeśli brak uchybień, zwróć pustą tablicę.",
  ].join("\n");

  const user = [
    "WYMAGANE SEKCJE z legal templates:",
    requiredRendered,
    "",
    "PEŁNA TREŚĆ PROJEKTU:",
    pagesRendered,
    "",
    "Przeanalizuj i zwróć listę uchybień.",
  ].join("\n");

  const complianceStartedAt = Date.now();
  try {
    const ai = await callClaude({
      system,
      user,
      model: EDIT_MODEL,
      maxTokens: 4000,
    });
    const parsed = parseJsonFromAi<{ issues: ComplianceIssue[] }>(ai.text);

    void logAiCall({
      project_id: id,
      endpoint: "compliance-check",
      context_type: "project",
      user_instruction: "compliance check",
      system_prompt: system,
      user_prompt: user,
      model: ai.model,
      max_tokens: 4000,
      response_text: ai.text,
      tokens_in: ai.inputTokens,
      tokens_out: ai.outputTokens,
      duration_ms: Date.now() - complianceStartedAt,
      user_email: auth.email,
    });

    // Telemetria
    await sb.from("gen4_ai_history").insert({
      project_id: id,
      role: "assistant",
      content: `compliance check: ${parsed.issues?.length ?? 0} uchybień`,
      structured: {
        workflow_type: "compliance_check",
        issues_count: parsed.issues?.length ?? 0,
      },
      model: ai.model,
      input_tokens: ai.inputTokens,
      output_tokens: ai.outputTokens,
      latency_ms: ai.latencyMs,
    });

    return NextResponse.json({ issues: parsed.issues ?? [] });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "compliance check failed" },
      { status: 502 },
    );
  }
}
