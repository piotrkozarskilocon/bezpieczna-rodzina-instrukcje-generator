import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  parseTranslationResponse,
  SUPPORTED_LANGS,
  type TargetLang,
} from "@/lib/v4Translate";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Lists translations for a project. Optional ?lang= filter; without it
 *  returns all languages so the UI can show coverage stats per lang. */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project, error: pErr } = await sb
    .from("gen4_projects")
    .select("id")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (pErr || !project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const langFilter = request.nextUrl.searchParams.get("lang");
  let query = sb
    .from("gen4_translations")
    .select("id, element_id, language, text, is_pinned, source, last_synced_at")
    .eq("project_id", id);
  if (langFilter) query = query.eq("language", langFilter);

  // Paginate (PostgREST default 1000 cap).
  const PAGE = 1000;
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  return NextResponse.json({ translations: rows });
}

/** Imports a translation set for one language. Body: { lang, json }.
 *  json is the raw text the user pasted from Claude.ai — accepts both
 *  { translations: {...} } and flat { id: text } shapes. Each entry is
 *  upserted into gen4_translations (project_id, element_id, language). */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project, error: pErr } = await sb
    .from("gen4_projects")
    .select("id")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (pErr || !project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as
    | { lang?: string; json?: string }
    | null;
  const lang = body?.lang as TargetLang | undefined;
  if (!lang || !SUPPORTED_LANGS.includes(lang)) {
    return NextResponse.json({ error: "missing/invalid lang" }, { status: 400 });
  }
  if (!body?.json?.trim()) {
    return NextResponse.json({ error: "missing json" }, { status: 400 });
  }

  let mappings: Map<string, string>;
  try {
    mappings = parseTranslationResponse(body.json);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "parse failed" },
      { status: 400 },
    );
  }

  // Verify which element_ids actually exist in this project — we don't want
  // to insert orphan rows if Claude hallucinated IDs.
  const elementIds = Array.from(mappings.keys());
  const { data: validElements } = await sb
    .from("gen4_elements")
    .select("id, gen4_pages!inner(project_id)")
    .in("id", elementIds);
  const validIds = new Set(
    (validElements ?? [])
      .filter((e: { gen4_pages: { project_id: string } | { project_id: string }[] }) => {
        const pages = e.gen4_pages;
        const pid = Array.isArray(pages) ? pages[0]?.project_id : pages?.project_id;
        return pid === id;
      })
      .map((e: { id: string }) => e.id),
  );

  const rows = Array.from(mappings.entries())
    .filter(([elId]) => validIds.has(elId))
    .map(([elId, text]) => ({
      project_id: id,
      element_id: elId,
      language: lang,
      text,
      source: "import",
    }));

  if (rows.length === 0) {
    return NextResponse.json({
      error: "no valid element_id found in JSON (does it match the project?)",
      received: mappings.size,
    }, { status: 400 });
  }

  // Upsert by (element_id, language) — overwrites previous translation but
  // keeps is_pinned=true rows untouched (handled separately when we need it).
  const { error: upErr } = await sb
    .from("gen4_translations")
    .upsert(rows, { onConflict: "element_id,language" });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    imported: rows.length,
    skipped: mappings.size - rows.length,
  });
}
