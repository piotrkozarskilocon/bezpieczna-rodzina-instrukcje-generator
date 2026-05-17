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
import { findOverlapGroups, resolveTextOverlaps, type OverlapElement } from "@/lib/v4OverlapResolver";
import { clampToBounds, hasOutOfBoundsElements } from "@/lib/v4BoundsClamp";

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

  let totalPatches = 0;
  let totalClampPatches = 0;
  let pagesWithOverlaps = 0;
  let pagesWithOutOfBounds = 0;
  const perPage: Array<{ page_number: number; groups_before: number; clamp_patches: number; patches: number; groups_after: number }> = [];

  for (const page of pages) {
    const { data: elements } = await sb
      .from("gen4_elements")
      .select("id, type, x_mm, y_mm, w_mm, h_mm, z_index")
      .eq("page_id", page.id);

    const els: OverlapElement[] = (elements ?? []).map((e) => ({
      id: e.id,
      type: e.type,
      x_mm: e.x_mm,
      y_mm: e.y_mm,
      w_mm: e.w_mm,
      h_mm: e.h_mm,
      z_index: e.z_index,
    }));

    // STEP 1: clamp to bounds — twardy nakaz: nic poza marginesem.
    let clampApplied = 0;
    if (hasOutOfBoundsElements(els, page.width_mm, page.height_mm, 3)) {
      pagesWithOutOfBounds++;
      const clampPatches = clampToBounds(els, page.width_mm, page.height_mm, 3);
      for (const p of clampPatches) {
        const update: Record<string, number> = {};
        if (p.x_mm !== undefined) update.x_mm = p.x_mm;
        if (p.y_mm !== undefined) update.y_mm = p.y_mm;
        if (p.w_mm !== undefined) update.w_mm = p.w_mm;
        if (p.h_mm !== undefined) update.h_mm = p.h_mm;
        if (Object.keys(update).length === 0) continue;
        const { error } = await sb.from("gen4_elements").update(update).eq("id", p.id);
        if (!error) clampApplied++;
      }
      totalClampPatches += clampApplied;
    }

    // STEP 2: refresh i sprawdz overlap po clamp
    const { data: elPostClamp } = await sb
      .from("gen4_elements")
      .select("id, type, x_mm, y_mm, w_mm, h_mm, z_index")
      .eq("page_id", page.id);
    const elsPostClamp: OverlapElement[] = (elPostClamp ?? []).map((e) => ({
      id: e.id, type: e.type, x_mm: e.x_mm, y_mm: e.y_mm,
      w_mm: e.w_mm, h_mm: e.h_mm, z_index: e.z_index,
    }));

    const groupsBefore = findOverlapGroups(elsPostClamp);
    if (groupsBefore.length === 0) {
      perPage.push({ page_number: page.page_number, groups_before: 0, clamp_patches: clampApplied, patches: 0, groups_after: 0 });
      continue;
    }

    pagesWithOverlaps++;

    // ITERATIVE: niektóre strony mają złożone overlap (4+ elementów z różnymi
    // bounds), 1 przebieg nie wystarcza — po przesunięciu jednego elementu
    // pojawia się nowy overlap z innym. Iterujemy do 5 przebiegów lub stable.
    let applied = 0;
    let currentEls = elsPostClamp;
    for (let iter = 0; iter < 5; iter++) {
      const groups = findOverlapGroups(currentEls);
      if (groups.length === 0) break;
      const patches = resolveTextOverlaps(currentEls, page.height_mm, 3, 1.0);
      if (patches.length === 0) break;
      for (const p of patches) {
        const update: Record<string, number> = {};
        if (p.y_mm !== undefined) update.y_mm = p.y_mm;
        if (p.h_mm !== undefined) update.h_mm = p.h_mm;
        if (Object.keys(update).length === 0) continue;
        const { error } = await sb.from("gen4_elements").update(update).eq("id", p.id);
        if (!error) applied++;
      }
      // Refresh z DB do następnej iteracji
      const { data: fresh } = await sb
        .from("gen4_elements")
        .select("id, type, x_mm, y_mm, w_mm, h_mm, z_index")
        .eq("page_id", page.id);
      currentEls = (fresh ?? []).map((e) => ({
        id: e.id, type: e.type, x_mm: e.x_mm, y_mm: e.y_mm,
        w_mm: e.w_mm, h_mm: e.h_mm, z_index: e.z_index,
      }));
    }

    totalPatches += applied;

    const groupsAfter = findOverlapGroups(currentEls);
    perPage.push({ page_number: page.page_number, groups_before: groupsBefore.length, clamp_patches: clampApplied, patches: applied, groups_after: groupsAfter.length });
  }

  return NextResponse.json({
    ok: true,
    pages_total: pages.length,
    pages_with_overlaps: pagesWithOverlaps,
    pages_with_out_of_bounds: pagesWithOutOfBounds,
    clamp_patches_total: totalClampPatches,
    patches_applied_total: totalPatches,
    per_page: perPage,
  });
}
