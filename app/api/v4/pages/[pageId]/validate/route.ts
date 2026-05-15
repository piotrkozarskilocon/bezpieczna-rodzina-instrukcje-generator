import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { ownPage, loadPageWithElements } from "@/lib/v4Edit";
import { validatePage, summarizeIssues } from "@/lib/v4Validate";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

/** GET — sprawdza layout strony i zwraca listę problemów (errors/warnings/infos).
 *  Nic nie zapisuje, używane przez UI editor + Gen4ExportPanel (lint pre-export). */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const data = await loadPageWithElements(pageId);
  if (!data) return NextResponse.json({ error: "page not found" }, { status: 404 });
  const { page, elements } = data;

  const issues = validatePage({
    id: page.id,
    page_number: page.page_number,
    width_mm: page.width_mm,
    height_mm: page.height_mm,
    template: page.template,
    title: page.title,
    elements,
  });

  return NextResponse.json({
    issues,
    summary: summarizeIssues(issues),
  });
}

/** POST — uruchamia AI fix dla wszystkich fixable issues na stronie.
 *  Body: { fix: true } — zwraca { fixed, before_count, after_count } */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 503 });
  }

  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const data = await loadPageWithElements(pageId);
  if (!data) return NextResponse.json({ error: "page not found" }, { status: 404 });
  const { page, elements } = data;

  const beforeIssues = validatePage({
    id: page.id,
    page_number: page.page_number,
    width_mm: page.width_mm,
    height_mm: page.height_mm,
    template: page.template,
    title: page.title,
    elements,
  });
  const actionable = beforeIssues.filter((i) => i.ai_fixable !== false && i.fix_hint);

  if (actionable.length === 0) {
    return NextResponse.json({
      ok: true,
      no_fixable: true,
      before_count: beforeIssues.length,
      after_count: beforeIssues.length,
      fixed: 0,
    });
  }

  // Buduj instrukcje, wywoluj ai-edit przez Vercel API self-call (zeby uzyskac
  // ten sam ai-edit code path bez duplikacji).
  const instruction = [
    "Popraw nastepujace problemy z layoutem strony:",
    ...actionable.map((i, idx) => `${idx + 1}. ${i.message}. ${i.fix_hint ?? ""}`),
    "",
    "Zachowaj tresc elementow — popraw tylko ich pozycje/rozmiary tak, by miescily sie",
    "na stronie z 3mm marginesem i zeby teksty sie nie ucinaly.",
  ].join("\n");

  const baseUrl = process.env.GENERATOR_BASE_URL?.replace(/\/$/, "") ??
    (() => { const u = new URL(request.url); return `${u.protocol}//${u.host}`; })();
  const proxySecret = process.env.INTERNAL_PROXY_SECRET ?? "";
  const aiRes = await fetch(`${baseUrl}/generator-instrukcji/api/v4/pages/${pageId}/ai-edit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-locon-proxy-secret": proxySecret,
      "x-locon-user-email": auth.email,
    },
    body: JSON.stringify({ instruction, layout_only: true }),
  });
  if (!aiRes.ok) {
    const txt = await aiRes.text().catch(() => "");
    return NextResponse.json({ error: `ai-edit failed: ${txt.slice(0, 300)}` }, { status: 502 });
  }

  // Recompute issues after fix.
  // Re-fetch elements bo ai-edit replace robi delete+insert.
  const sb = getSupabaseAdmin();
  const { data: freshElements } = await sb
    .from("gen4_elements")
    .select("id, type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties")
    .eq("page_id", pageId)
    .order("z_index", { ascending: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const afterIssues = validatePage({
    id: page.id,
    page_number: page.page_number,
    width_mm: page.width_mm,
    height_mm: page.height_mm,
    template: page.template,
    title: page.title,
    elements: (freshElements ?? []) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  return NextResponse.json({
    ok: true,
    before_count: beforeIssues.length,
    after_count: afterIssues.length,
    fixed: Math.max(0, beforeIssues.length - afterIssues.length),
    actionable_before: actionable.length,
  });
}
