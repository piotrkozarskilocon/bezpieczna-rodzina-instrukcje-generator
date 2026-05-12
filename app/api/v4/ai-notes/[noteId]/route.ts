import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ noteId: string }>;
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { noteId } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as {
    content?: string;
    why?: string | null;
    is_active?: boolean;
    scope_value?: string | null;
  };

  const update: Record<string, unknown> = {};
  if (typeof body.content === "string" && body.content.trim()) {
    update.content = body.content.trim().slice(0, 1500);
  }
  if ("why" in body) {
    update.why = typeof body.why === "string" && body.why.trim()
      ? body.why.trim().slice(0, 500)
      : null;
  }
  if (typeof body.is_active === "boolean") {
    update.is_active = body.is_active;
  }
  if ("scope_value" in body) {
    update.scope_value =
      typeof body.scope_value === "string" && body.scope_value.trim()
        ? body.scope_value.trim()
        : null;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from("gen4_ai_notes")
    .update(update)
    .eq("id", noteId)
    .eq("owner_email", auth.email);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { noteId } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from("gen4_ai_notes")
    .delete()
    .eq("id", noteId)
    .eq("owner_email", auth.email);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
