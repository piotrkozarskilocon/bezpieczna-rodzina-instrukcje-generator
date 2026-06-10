/**
 * Bulk deterministyczny dedupe overlap dla wszystkich stron projektu.
 * Iteruje per strona, wywołuje resolveTextOverlaps lokalnie (bez self-call
 * HTTP — szybciej). Działa w 1-3 sekundy dla 20 stron.
 *
 * POST /api/v4/projects/[id]/dedupe-overlap-all
 *   resp: { ok, pages_total, pages_with_overlaps, patches_applied_total }
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { findOverlapGroups, type OverlapElement } from "@/lib/v4OverlapResolver";
import { finalizePageLayout, type LayoutElement } from "@/lib/v4FinalizeLayout";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: projectId } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", projectId)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, width_mm, height_mm")
    .eq("project_id", projectId)
    .order("page_number", { ascending: true });

  if (!pages || pages.length === 0) {
    return NextResponse.json({ error: "no pages" }, { status: 404 });
  }

  let totalChanged = 0;
  let totalNeedsSplit = 0;
  let pagesWithOverlaps = 0;
  const perPage: Array<{ page_number: number; groups_before: number; groups_after: number; changed: number; needs_split: number }> = [];

  const toOverlap = (els: LayoutElement[]): OverlapElement[] =>
    els.map((e) => ({ id: e.id, type: e.type, x_mm: e.x_mm, y_mm: e.y_mm, w_mm: e.w_mm, h_mm: e.h_mm, z_index: e.z_index ?? 0 }));

  for (const page of pages) {
    // Jeden select per strona (z properties + z_index). Finalizacja w pamięci,
    // zapis TYLKO zmienionych — usuwa stary N+1 (selecty + update-per-element
    // w 5 iteracjach × 20 stron = setki round-tripów, ryzyko 300s).
    const { data: rows } = await sb
      .from("gen4_elements")
      .select("id, type, x_mm, y_mm, w_mm, h_mm, z_index, properties")
      .eq("page_id", page.id);

    const input: LayoutElement[] = (rows ?? []).map((e) => ({
      id: e.id, type: e.type, x_mm: e.x_mm, y_mm: e.y_mm, w_mm: e.w_mm, h_mm: e.h_mm,
      z_index: e.z_index, properties: (e.properties ?? {}) as LayoutElement["properties"],
    }));

    const groupsBefore = findOverlapGroups(toOverlap(input)).length;
    if (groupsBefore > 0) pagesWithOverlaps++;

    const result = finalizePageLayout(input, page.width_mm, page.height_mm);
    const changed = new Set(result.changedIds);
    let applied = 0;
    for (const e of result.elements) {
      if (!changed.has(e.id)) continue;
      const { error } = await sb
        .from("gen4_elements")
        .update({ x_mm: e.x_mm, y_mm: e.y_mm, w_mm: e.w_mm, h_mm: e.h_mm, properties: e.properties })
        .eq("id", e.id);
      if (!error) applied++;
    }
    totalChanged += applied;
    totalNeedsSplit += result.needsSplit.length;

    const groupsAfter = findOverlapGroups(toOverlap(result.elements)).length;
    perPage.push({
      page_number: page.page_number,
      groups_before: groupsBefore,
      groups_after: groupsAfter,
      changed: applied,
      needs_split: result.needsSplit.length,
    });
  }

  return NextResponse.json({
    ok: true,
    pages_total: pages.length,
    pages_with_overlaps: pagesWithOverlaps,
    // alias zachowany dla kompatybilności z UI (Gen4Editor czyta to pole).
    patches_applied_total: totalChanged,
    changed_total: totalChanged,
    needs_split_total: totalNeedsSplit,
    per_page: perPage,
  });
}
