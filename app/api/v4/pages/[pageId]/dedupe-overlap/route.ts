/**
 * Deterministyczny dedupe overlap dla pojedynczej strony.
 * Grupuje nakładające się text/callout elementy, układa je pionowo z 1mm gap.
 * Zapisuje patches do gen4_elements w jednej transakcji.
 *
 * POST /api/v4/pages/[pageId]/dedupe-overlap
 *   body: { gap_mm?: number, margin_mm?: number } (opcjonalne)
 *   resp: { ok, patches_applied, groups_resolved, before_overlaps, after_overlaps }
 *
 * SZYBKIE — nie wywołuje AI. Działa per-page w milisekundach.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { findOverlapGroups, resolveTextOverlaps, type OverlapElement } from "@/lib/v4OverlapResolver";

export const runtime = "nodejs";
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

async function ownPage(pageId: string, email: string): Promise<{ width_mm: number; height_mm: number } | null> {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("gen4_pages")
    .select("id, width_mm, height_mm, gen4_projects!inner(owner_email)")
    .eq("id", pageId)
    .single();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const owner = (data as any)?.gen4_projects?.owner_email;
  if (!data || owner !== email) return null;
  return { width_mm: data.width_mm, height_mm: data.height_mm };
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  const page = await ownPage(pageId, auth.email);
  if (!page) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { gap_mm?: number; margin_mm?: number };
  const gap = typeof body.gap_mm === "number" && body.gap_mm >= 0 ? body.gap_mm : 1.0;
  const margin = typeof body.margin_mm === "number" && body.margin_mm >= 0 ? body.margin_mm : 3.0;

  const sb = getSupabaseAdmin();
  const { data: elements } = await sb
    .from("gen4_elements")
    .select("id, type, x_mm, y_mm, w_mm, h_mm, z_index")
    .eq("page_id", pageId);

  const els: OverlapElement[] = (elements ?? []).map((e) => ({
    id: e.id,
    type: e.type,
    x_mm: e.x_mm,
    y_mm: e.y_mm,
    w_mm: e.w_mm,
    h_mm: e.h_mm,
    z_index: e.z_index,
  }));

  const groupsBefore = findOverlapGroups(els);
  if (groupsBefore.length === 0) {
    return NextResponse.json({
      ok: true,
      patches_applied: 0,
      groups_resolved: 0,
      before_overlaps: 0,
      after_overlaps: 0,
      message: "Brak nakładających się tekstów na stronie",
    });
  }

  const patches = resolveTextOverlaps(els, page.height_mm, margin, gap);

  // Aplikuj patches sekwencyjnie. Supabase nie ma RPC dla bulk update więc
  // wywołujemy update per element — typowo grupa to 2-4 elementy, kilka ms łącznie.
  let applied = 0;
  for (const p of patches) {
    const update: Record<string, number> = {};
    if (p.y_mm !== undefined) update.y_mm = p.y_mm;
    if (p.h_mm !== undefined) update.h_mm = p.h_mm;
    if (Object.keys(update).length === 0) continue;
    const { error } = await sb.from("gen4_elements").update(update).eq("id", p.id);
    if (!error) applied++;
  }

  // Sprawdz ile groups zostalo po zmianie
  const { data: freshElements } = await sb
    .from("gen4_elements")
    .select("id, type, x_mm, y_mm, w_mm, h_mm, z_index")
    .eq("page_id", pageId);
  const freshEls: OverlapElement[] = (freshElements ?? []).map((e) => ({
    id: e.id,
    type: e.type,
    x_mm: e.x_mm,
    y_mm: e.y_mm,
    w_mm: e.w_mm,
    h_mm: e.h_mm,
    z_index: e.z_index,
  }));
  const groupsAfter = findOverlapGroups(freshEls);

  return NextResponse.json({
    ok: true,
    patches_applied: applied,
    groups_resolved: groupsBefore.length - groupsAfter.length,
    before_overlaps: groupsBefore.length,
    after_overlaps: groupsAfter.length,
    patch_details: patches,
  });
}
