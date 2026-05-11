import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { buildApplyDsToProjectPrompt } from "@/lib/v4ApplyDs";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Builds a "rewrite the entire project applying this design system" prompt.
 *  Body: { ds_id, instruction? }. The user pastes the resulting Claude
 *  response into the existing /import endpoint to apply it. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("id")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { ds_id?: string; instruction?: string };
  if (!body.ds_id) return NextResponse.json({ error: "missing ds_id" }, { status: 400 });

  const prompt = await buildApplyDsToProjectPrompt(id, body.ds_id, body.instruction);
  if (!prompt) return NextResponse.json({ error: "design system or project not found" }, { status: 404 });

  return NextResponse.json(prompt);
}
