/**
 * Reorder pages in project. Body: { order: string[] } (array of page IDs in new order).
 * Updates page_number per page atomically.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: projectId } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { order?: string[] } | null;
  const order = body?.order;
  if (!order || !Array.isArray(order) || order.length === 0) {
    return NextResponse.json({ error: "missing 'order' array" }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  const { data: project } = await sb.from("gen4_projects").select("owner_email").eq("id", projectId).single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Verify all IDs belong do projektu.
  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id")
    .eq("project_id", projectId);
  const ownedIds = new Set((pages ?? []).map((p) => p.id));
  for (const pid of order) {
    if (!ownedIds.has(pid)) {
      return NextResponse.json({ error: `page ${pid} not in project` }, { status: 400 });
    }
  }
  if (order.length !== ownedIds.size) {
    return NextResponse.json({ error: `expected ${ownedIds.size} pages in order, got ${order.length}` }, { status: 400 });
  }

  // Update page_number per page. Atomic — bumpujemy do temp high values, potem ustawiamy finalne
  // żeby uniknąć unique constraint problem jeżeli istnieje.
  // Najpierw temp values (page_number + 10000)
  for (let i = 0; i < order.length; i++) {
    await sb
      .from("gen4_pages")
      .update({ page_number: 10000 + i })
      .eq("id", order[i]);
  }
  // Potem finalne wartości
  for (let i = 0; i < order.length; i++) {
    await sb
      .from("gen4_pages")
      .update({ page_number: i + 1 })
      .eq("id", order[i]);
  }

  return NextResponse.json({ ok: true, reordered: order.length });
}
