import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, EDIT_MODEL } from "@/lib/anthropic";
import { parseJsonFromAi } from "@/lib/v4Generate";
import { logAiCall } from "@/lib/v4AiLog";

export const runtime = "nodejs";
export const maxDuration = 30;

interface Suggestion {
  scope: "global" | "document_type" | "device_type" | "project";
  scope_value: string | null;
  content: string;
  why: string;
  evidence_count: number;
}

/** AI analizuje wzorce w gen4_post_edit_log + ai_history dla użytkownika
 *  i sugeruje regułki do AI Notebook. Wzorce typu: "user zawsze poprawia
 *  X na Y po generacji" → "Dodaj globalną notatkę: nigdy X, zawsze Y". */
export async function POST(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY nie skonfigurowany" }, { status: 503 });
  }

  const sb = getSupabaseAdmin();

  // 1. Pobierz ostatnie 50 edycji manualnych user-a (oznaczone source=manual).
  const { data: edits } = await sb
    .from("gen4_post_edit_log")
    .select("project_id, page_id, source, description, before_state, after_state, created_at")
    .eq("owner_email", auth.email)
    .eq("source", "manual")
    .order("created_at", { ascending: false })
    .limit(50);

  if (!edits || edits.length < 3) {
    return NextResponse.json({
      suggestions: [],
      message: "Za mało danych — wymagane ≥3 manualne edycje (mamy " + (edits?.length ?? 0) + ").",
    });
  }

  // 2. Pobierz aktualne notatki użytkownika (żeby AI nie sugerował duplikatów).
  const { data: existingNotes } = await sb
    .from("gen4_ai_notes")
    .select("scope, scope_value, content")
    .eq("owner_email", auth.email)
    .eq("is_active", true);

  // 3. Zbierz context per projekt (document_type/device_type żeby AI wiedział o scope).
  const projectIds = Array.from(new Set(edits.map((e) => e.project_id)));
  const { data: projects } = await sb
    .from("gen4_projects")
    .select("id, document_type, device_type, ai_input")
    .in("id", projectIds);
  const projectMeta = new Map<string, { document_type: string | null; device_type: string | null }>();
  for (const p of projects ?? []) {
    projectMeta.set(p.id, {
      document_type: p.document_type as string | null,
      device_type: p.device_type as string | null,
    });
  }

  // 4. Buduj prompt — AI analizuje edycje i sugeruje regułki.
  const editsRendered = edits.slice(0, 30).map((e, i) => {
    const meta = projectMeta.get(e.project_id);
    const beforeStr = e.before_state ? JSON.stringify(e.before_state).slice(0, 200) : "(brak)";
    const afterStr = e.after_state ? JSON.stringify(e.after_state).slice(0, 200) : "(brak)";
    return `${i + 1}. [doc=${meta?.document_type ?? "?"} dev=${meta?.device_type ?? "?"}] ${e.description ?? "(brak opisu)"}
   PRZED: ${beforeStr}
   PO:    ${afterStr}`;
  }).join("\n\n");

  const existingRendered = (existingNotes ?? [])
    .map((n) => `- [${n.scope}${n.scope_value ? `:${n.scope_value}` : ""}] ${n.content}`)
    .join("\n") || "(brak)";

  const system = [
    "Jesteś analitykiem patterns w edycjach instrukcji obsługi. Otrzymujesz",
    "logi ostatnich 30 manualnych edycji użytkownika (które robił PO generacji AI",
    "— czyli rzeczy które AI zrobił źle albo niezgodnie z preferencją usera).",
    "",
    "Twoja praca: znaleźć POWTARZAJĄCE SIĘ wzorce (minimum 2 podobne edycje =",
    "wzorzec) i zaproponować regułki do AI Notebook, żeby kolejna generacja",
    "była lepsza.",
    "",
    "Reguły:",
    "- Nie sugeruj rzeczy które już są w istniejących notatkach (lista poniżej).",
    "- Wzorzec występujący w wielu projektach (różnych document_type/device_type)",
    "  → scope='global'. Występujący tylko w jednym typie dokumentu → scope='document_type'.",
    "  Występujący tylko w jednym urządzeniu → scope='device_type'.",
    "- Pisz krótkie, konkretne regułki po polsku (max 200 znaków).",
    "- Jeśli żaden silny wzorzec nie istnieje, zwróć pustą listę.",
    "",
    "ISTNIEJĄCE NOTATKI (nie powtarzaj):",
    existingRendered,
    "",
    "Format odpowiedzi — WYŁĄCZNIE surowy JSON, bez fence ```:",
    '{ "suggestions": [',
    '    {',
    '      "scope": "global|document_type|device_type",',
    '      "scope_value": "<np. qsg_full lub null dla global>",',
    '      "content": "krótka regułka",',
    '      "why": "wzorzec który zauważyłem",',
    '      "evidence_count": 3 // liczba edycji potwierdzających',
    '    }',
    '  ] }',
  ].join("\n");

  const user = `Logi edycji manualnych (${edits.length} ostatnich):\n\n${editsRendered}\n\nZnajdź wzorce i zaproponuj regułki.`;

  const startedAt = Date.now();
  try {
    const ai = await callClaude({
      system,
      user,
      model: EDIT_MODEL,
      maxTokens: 2000,
    });
    const parsed = parseJsonFromAi<{ suggestions: Suggestion[] }>(ai.text);

    // logAiCall z project_id=null (cross-project endpoint, analizuje wzorce
    // niezalezne od pojedynczego projektu). Wymaga migracji 0022.
    void logAiCall({
      project_id: null,
      endpoint: "ai-notes/suggest",
      context_type: "global",
      user_instruction: `suggest notes patterns from ${edits.length} manual edits`,
      system_prompt: system,
      user_prompt: user,
      model: ai.model,
      max_tokens: 2000,
      response_text: ai.text,
      tokens_in: ai.inputTokens,
      tokens_out: ai.outputTokens,
      duration_ms: Date.now() - startedAt,
      user_email: auth.email,
    });

    return NextResponse.json({
      suggestions: parsed.suggestions ?? [],
      analyzed_edits: edits.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI call failed";
    void logAiCall({
      project_id: null,
      endpoint: "ai-notes/suggest",
      context_type: "global",
      system_prompt: system,
      user_prompt: user,
      model: EDIT_MODEL,
      max_tokens: 2000,
      error: msg,
      duration_ms: Date.now() - startedAt,
      user_email: auth.email,
    });
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
