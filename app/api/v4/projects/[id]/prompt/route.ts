import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  buildSystemPrompt,
  buildUserPrompt,
  loadGlossaryDoNotTranslate,
  loadProjectDesignSystem,
  type GenerationInput,
} from "@/lib/v4Generate";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Returns the system + user prompt for this project's generation. The prompt
 * is rebuilt deterministically from the saved ai_input + global glossary, so
 * it always reflects the latest glossary changes (no stale snapshot).
 *
 * Used by the manual workflow:
 *   - User clicks "Skopiuj prompt" in the editor → frontend GETs this →
 *     concatenates system + user with a separator → writes to clipboard.
 *   - User pastes that into a fresh Claude.ai conversation, gets JSON back,
 *     pastes into /import endpoint.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project, error } = await sb
    .from("gen4_projects")
    .select("id, ai_input")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (error || !project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const input = project.ai_input as GenerationInput | null;
  if (!input || !input.model_code) {
    return NextResponse.json({ error: "project has no ai_input — was it created via the wizard?" }, { status: 400 });
  }

  const doNotTranslate = await loadGlossaryDoNotTranslate();
  const designSystem = await loadProjectDesignSystem(id);
  const scope =
    input.document_type && input.device_type
      ? { document_type: input.document_type, device_type: input.device_type }
      : null;
  const system = buildSystemPrompt(doNotTranslate, designSystem, scope);
  const user = buildUserPrompt(input);

  return NextResponse.json({
    system,
    user,
    // Convenience: pre-joined text for "copy to clipboard" UX. Includes
    // a clear header so the user can paste directly into Claude.ai.
    combined: [
      "# SYSTEM (kontekst dla Claude)",
      "",
      system,
      "",
      "# UŻYTKOWNIK (zadanie)",
      "",
      user,
    ].join("\n"),
  });
}
