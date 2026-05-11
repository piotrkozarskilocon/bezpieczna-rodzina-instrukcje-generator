import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  buildTranslationPrompt,
  SUPPORTED_LANGS,
  type TargetLang,
} from "@/lib/v4Translate";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Builds the translation prompt for a given target language. Returns
 *  { system, user, combined, itemCount } so the client can copy `combined`
 *  to the clipboard in one go. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project, error } = await sb
    .from("gen4_projects")
    .select("id")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (error || !project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { lang?: string };
  const lang = body.lang as TargetLang | undefined;
  if (!lang || !SUPPORTED_LANGS.includes(lang)) {
    return NextResponse.json({ error: `unsupported lang (use one of ${SUPPORTED_LANGS.join(", ")})` }, { status: 400 });
  }

  const prompt = await buildTranslationPrompt(id, lang);
  return NextResponse.json(prompt);
}
