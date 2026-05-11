import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callClaude, INITIAL_MODEL } from "@/lib/anthropic";
import {
  type GenerationInput,
  buildSkeletonSystemPrompt,
  buildSkeletonUserPrompt,
  validateSkeletonGenerated,
  bulkInsertSkeletonPages,
  parseJsonFromAi,
} from "@/lib/v4Generate";
import {
  isValidDocumentType,
  isValidDeviceType,
} from "@/lib/v4LegalTemplates";

export const runtime = "nodejs";
// Vercel Hobby = hard cap 60s; Pro = 300s. Zostawiamy 60 by działało na Hobby
// i jednocześnie nie blokowało dłużej niż faktyczny limit platformy.
export const maxDuration = 60;

/**
 * Creates a draft v4 project. Behaviour depends on env:
 *   - ANTHROPIC_API_KEY set → tries to generate via Claude API immediately.
 *     On success, project status='ready' and pages/elements populated.
 *   - ANTHROPIC_API_KEY missing → returns the project in 'draft' status with
 *     no pages/elements; user is expected to copy the prompt to clipboard,
 *     run it manually in Claude.ai, and paste the JSON back via the
 *     /import endpoint.
 *
 * Either way the project row is created up-front, so the user immediately
 * sees it in their list (and we have a place to attach the AI input).
 */
export async function POST(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { name?: string; input?: Partial<GenerationInput> }
    | null;
  if (!body || !body.name?.trim() || !body.input) {
    return NextResponse.json({ error: "missing name or input" }, { status: 400 });
  }
  if (!isValidDocumentType(body.input.document_type)) {
    return NextResponse.json(
      { error: "missing or invalid document_type — wybierz typ dokumentu w wizardzie" },
      { status: 400 },
    );
  }
  if (!isValidDeviceType(body.input.device_type)) {
    return NextResponse.json(
      { error: "missing or invalid device_type — wybierz typ urządzenia w wizardzie" },
      { status: 400 },
    );
  }
  const input: GenerationInput = {
    name: body.name.trim(),
    model_code: body.input.model_code?.trim() || "GJD.XX",
    model_name: body.input.model_name?.trim() || "Locon Watch",
    features: Array.isArray(body.input.features) ? body.input.features : [],
    step_count: typeof body.input.step_count === "number"
      ? Math.min(8, Math.max(1, body.input.step_count))
      : 4,
    warranty_mode: (body.input.warranty_mode as GenerationInput["warranty_mode"]) ?? "full",
    page_size_mm: body.input.page_size_mm ?? { width: 76, height: 76 },
    document_type: body.input.document_type,
    device_type: body.input.device_type,
  };

  const sb = getSupabaseAdmin();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const initialStatus = apiKey ? "generating" : "draft";

  const { data: project, error: insertErr } = await sb
    .from("gen4_projects")
    .insert({
      owner_email: auth.email,
      name: input.name,
      status: initialStatus,
      ai_input: input,
      document_type: input.document_type,
      device_type: input.device_type,
    })
    .select("id, design_system")
    .single();
  if (insertErr || !project) {
    return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
  }

  // ─── Manual mode: no API key → user will paste-import the JSON later. ──
  if (!apiKey) {
    return NextResponse.json({
      id: project.id,
      mode: "manual",
      reason: "ANTHROPIC_API_KEY not configured — use prompt export workflow",
    });
  }

  // ─── Auto mode (chunked): generuj TYLKO szkielet stron. Elements dorabiamy ─
  // osobnymi krótkimi wywołaniami per strona (frontend wywołuje /auto-populate
  // w pętli z UI progress bar). Tutaj robimy małe szybkie wywołanie ~5-15s,
  // które zawsze zmieści się w 60s Hobby cap.
  let aiLog: Record<string, unknown>;
  try {
    const ai = await callClaude({
      system: buildSkeletonSystemPrompt({
        document_type: input.document_type,
        device_type: input.device_type,
        step_count: input.step_count,
      }),
      user: buildSkeletonUserPrompt(input),
      model: INITIAL_MODEL,
      maxTokens: 6000, // szkielet ~14-20 stron (multi-step = krok per strona)
    });
    aiLog = {
      step: "skeleton_generation",
      model: ai.model,
      input_tokens: ai.inputTokens,
      output_tokens: ai.outputTokens,
      latency_ms: ai.latencyMs,
      timestamp: new Date().toISOString(),
    };
    const pages = validateSkeletonGenerated(parseJsonFromAi(ai.text));
    const counts = await bulkInsertSkeletonPages(project.id, pages);
    await sb
      .from("gen4_projects")
      .update({ status: "ready", ai_log: [aiLog] })
      .eq("id", project.id);
    // Zwracamy też listę stron (id+page_number+title+template) by frontend mógł
    // wywołać /auto-populate dla każdej strony bez dodatkowego GET.
    const { data: insertedPages } = await sb
      .from("gen4_pages")
      .select("id, page_number, template, title")
      .eq("project_id", project.id)
      .order("page_number", { ascending: true });
    return NextResponse.json({
      id: project.id,
      mode: "auto",
      skeleton: true,
      pages: counts.pages,
      page_list: insertedPages ?? [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI call failed";
    await sb
      .from("gen4_projects")
      .update({
        status: "error",
        ai_log: [{ step: "skeleton_generation", error: msg, timestamp: new Date().toISOString() }],
      })
      .eq("id", project.id);
    return NextResponse.json({ id: project.id, error: msg }, { status: 502 });
  }
}
