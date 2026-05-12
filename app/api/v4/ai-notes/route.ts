import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

const VALID_SCOPES = new Set(["global", "document_type", "device_type", "project"]);

/** GET — lista wszystkich notatek użytkownika (aktywnych + nieaktywnych) dla
 *  UI. Filtr scope/scope_value przez query params (opcjonalny). */
export async function GET(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = getSupabaseAdmin();
  let q = sb
    .from("gen4_ai_notes")
    .select("id, scope, scope_value, content, why, is_active, used_count, created_at, updated_at")
    .eq("owner_email", auth.email)
    .order("scope", { ascending: true })
    .order("used_count", { ascending: false });

  const scope = request.nextUrl.searchParams.get("scope");
  if (scope && VALID_SCOPES.has(scope)) q = q.eq("scope", scope);
  const scopeValue = request.nextUrl.searchParams.get("scope_value");
  if (scopeValue) q = q.eq("scope_value", scopeValue);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ notes: data ?? [] });
}

/** POST — nowa notatka. Body: { scope, scope_value?, content, why? } */
export async function POST(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { scope?: string; scope_value?: string | null; content?: string; why?: string }
    | null;
  if (!body || !body.scope || !VALID_SCOPES.has(body.scope)) {
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  }
  if (!body.content?.trim()) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  // scope_value wymagany dla document_type / device_type / project
  if (body.scope !== "global" && !body.scope_value?.trim()) {
    return NextResponse.json(
      { error: `scope_value wymagany dla scope=${body.scope}` },
      { status: 400 },
    );
  }

  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("gen4_ai_notes")
    .insert({
      owner_email: auth.email,
      scope: body.scope,
      scope_value: body.scope === "global" ? null : (body.scope_value?.trim() ?? null),
      content: body.content.trim().slice(0, 1500),
      why: body.why?.trim().slice(0, 500) || null,
      is_active: true,
    })
    .select("id, scope, scope_value, content, why, is_active, used_count, created_at, updated_at")
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });
  }
  return NextResponse.json({ note: data });
}
