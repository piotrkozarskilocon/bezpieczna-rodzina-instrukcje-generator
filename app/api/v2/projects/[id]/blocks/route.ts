import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface BlockPayload {
  type: string;
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
  z_index?: number;
  content?: Record<string, unknown>;
  lang_default?: string;
}

interface PagePayload {
  page_number: number;
  width_mm: number;
  height_mm: number;
  blocks: BlockPayload[];
}

/**
 * Returns all pages + blocks for a project so the client can rebuild the
 * editor state without re-running PDF.js / OCR.
 *
 * Shape:
 *   { pages: [{ page_number, width_mm, height_mm, blocks: [...] }] }
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();

  // Verify ownership.
  const { data: project, error: projectErr } = await sb
    .from("gen2_projects")
    .select("id")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();

  if (projectErr || !project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: pages, error: pagesErr } = await sb
    .from("gen2_pages")
    .select("id, page_number, width_mm, height_mm")
    .eq("project_id", id)
    .order("page_number", { ascending: true });

  if (pagesErr) {
    return NextResponse.json({ error: pagesErr.message }, { status: 500 });
  }

  if (!pages || pages.length === 0) {
    return NextResponse.json({ pages: [] });
  }

  const pageIds = pages.map((p) => p.id);

  // Supabase / PostgREST caps a single .select() at 1000 rows by default.
  // For projects with thousands of blocks we'd silently lose data without
  // paging — load in chunks until we get a short page.
  const PAGE_SIZE = 1000;
  const blocks: Array<{
    page_id: string;
    type: string;
    x_mm: number;
    y_mm: number;
    w_mm: number;
    h_mm: number;
    z_index: number;
    content: { pl?: string; _title?: string; _src?: string } | null;
    lang_default: string;
  }> = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: chunk, error: blocksErr } = await sb
      .from("gen2_blocks")
      .select("page_id, type, x_mm, y_mm, w_mm, h_mm, z_index, content, lang_default")
      .in("page_id", pageIds)
      .order("z_index", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (blocksErr) {
      return NextResponse.json({ error: blocksErr.message }, { status: 500 });
    }
    if (!chunk || chunk.length === 0) break;
    blocks.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
  }

  const byPage = new Map<string, BlockPayload[]>();
  for (const b of blocks) {
    const arr = byPage.get(b.page_id) ?? [];
    arr.push({
      type: b.type,
      x_mm: Number(b.x_mm),
      y_mm: Number(b.y_mm),
      w_mm: Number(b.w_mm),
      h_mm: Number(b.h_mm),
      z_index: b.z_index,
      content: b.content ?? undefined,
      lang_default: b.lang_default,
    });
    byPage.set(b.page_id, arr);
  }

  return NextResponse.json({
    pages: pages.map((p) => ({
      page_number: p.page_number,
      width_mm: Number(p.width_mm),
      height_mm: Number(p.height_mm),
      blocks: byPage.get(p.id) ?? [],
    })),
  });
}

/**
 * Replaces ALL pages + blocks for the project. This is the simplest model:
 * after a re-OCR pass we just resend the full current state. For 30+ pages
 * with ~hundreds of blocks each, the round-trip is still fast enough and we
 * avoid the complexity of incremental sync. If volume grows materially we
 * can split this into per-page upserts later.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { pages?: PagePayload[] } | null;
  if (!body || !Array.isArray(body.pages)) {
    return NextResponse.json({ error: "missing pages" }, { status: 400 });
  }

  const sb = getSupabaseAdmin();

  const { data: project, error: projectErr } = await sb
    .from("gen2_projects")
    .select("id")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();

  if (projectErr || !project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Wipe and rewrite. Cascade on generator_pages → generator_blocks handles blocks.
  const { error: delErr } = await sb
    .from("gen2_pages")
    .delete()
    .eq("project_id", id);
  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  if (body.pages.length === 0) {
    return NextResponse.json({ ok: true, pages: 0, blocks: 0 });
  }

  // Insert pages, get their generated ids back.
  const pagesInsert = body.pages.map((p) => ({
    project_id: id,
    page_number: p.page_number,
    width_mm: p.width_mm,
    height_mm: p.height_mm,
  }));
  const { data: insertedPages, error: pagesInsertErr } = await sb
    .from("gen2_pages")
    .insert(pagesInsert)
    .select("id, page_number");

  if (pagesInsertErr || !insertedPages) {
    return NextResponse.json({ error: pagesInsertErr?.message ?? "insert pages failed" }, { status: 500 });
  }

  const pageIdByNumber = new Map<number, string>();
  for (const p of insertedPages) {
    pageIdByNumber.set(p.page_number, p.id);
  }

  // Flatten blocks across pages into a single insert.
  const blocksInsert: Array<Record<string, unknown>> = [];
  for (const page of body.pages) {
    const pageId = pageIdByNumber.get(page.page_number);
    if (!pageId) continue;
    for (let i = 0; i < page.blocks.length; i++) {
      const b = page.blocks[i];
      blocksInsert.push({
        page_id: pageId,
        type: b.type ?? "text",
        x_mm: b.x_mm,
        y_mm: b.y_mm,
        w_mm: b.w_mm,
        h_mm: b.h_mm,
        z_index: b.z_index ?? i,
        content: b.content ?? {},
        lang_default: b.lang_default ?? "pl",
      });
    }
  }

  // Supabase has a 1000-row default insert limit; chunk just in case.
  const CHUNK = 500;
  for (let i = 0; i < blocksInsert.length; i += CHUNK) {
    const chunk = blocksInsert.slice(i, i + CHUNK);
    const { error: chunkErr } = await sb.from("gen2_blocks").insert(chunk);
    if (chunkErr) {
      return NextResponse.json({ error: chunkErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    pages: body.pages.length,
    blocks: blocksInsert.length,
  });
}
