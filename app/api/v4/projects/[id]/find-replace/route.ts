/**
 * Find/Replace na text/callout elementach w projekcie.
 * POST /api/v4/projects/[id]/find-replace
 * Body: { find, replace, case_sensitive?, regex?, scope: 'project'|'page', page_id? }
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
  const body = (await request.json().catch(() => null)) as {
    find?: string;
    replace?: string;
    case_sensitive?: boolean;
    regex?: boolean;
    scope?: "project" | "page";
    page_id?: string;
  } | null;

  if (!body?.find) return NextResponse.json({ error: "missing 'find'" }, { status: 400 });

  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", projectId)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Build matcher
  let pattern: RegExp;
  try {
    if (body.regex) {
      pattern = new RegExp(body.find, body.case_sensitive ? "g" : "gi");
    } else {
      const escaped = body.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pattern = new RegExp(escaped, body.case_sensitive ? "g" : "gi");
    }
  } catch {
    return NextResponse.json({ error: "invalid regex pattern" }, { status: 400 });
  }

  // Zbierz strony i ich elementy
  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number")
    .eq("project_id", projectId);
  if (!pages) return NextResponse.json({ error: "no pages" }, { status: 400 });
  const pageIds = body.scope === "page" && body.page_id
    ? [body.page_id]
    : pages.map((p) => p.id);

  const { data: elements } = await sb
    .from("gen4_elements")
    .select("id, page_id, type, properties")
    .in("page_id", pageIds);

  interface Replacement {
    element_id: string;
    page_id: string;
    old_content: string;
    new_content: string;
    match_count: number;
  }
  const replacements: Replacement[] = [];
  for (const el of elements ?? []) {
    if (el.type !== "text" && el.type !== "callout") continue;
    const props = el.properties as { content?: string };
    const content = props?.content;
    if (typeof content !== "string") continue;
    if (!pattern.test(content)) continue;
    // Reset lastIndex bo /g flag
    pattern.lastIndex = 0;
    const matches = content.match(pattern);
    if (!matches) continue;
    const newContent = content.replace(pattern, body.replace ?? "");
    replacements.push({
      element_id: el.id,
      page_id: el.page_id,
      old_content: content,
      new_content: newContent,
      match_count: matches.length,
    });
  }

  // Dry-run mode: nie aktualizuj jezeli replace nie jest podany.
  const dryRun = body.replace === undefined;
  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      matches_count: replacements.reduce((sum, r) => sum + r.match_count, 0),
      elements_count: replacements.length,
      preview: replacements.slice(0, 5).map((r) => ({
        element_id: r.element_id,
        page_id: r.page_id,
        snippet: r.old_content.slice(0, 100),
      })),
    });
  }

  // Apply replacements
  let appliedCount = 0;
  for (const r of replacements) {
    const { data: el } = await sb
      .from("gen4_elements")
      .select("properties")
      .eq("id", r.element_id)
      .single();
    if (!el) continue;
    const newProps = { ...(el.properties as Record<string, unknown>), content: r.new_content };
    const { error } = await sb
      .from("gen4_elements")
      .update({ properties: newProps })
      .eq("id", r.element_id);
    if (!error) appliedCount++;
  }

  return NextResponse.json({
    ok: true,
    replaced_in_elements: appliedCount,
    total_matches: replacements.reduce((sum, r) => sum + r.match_count, 0),
    affected_pages: new Set(replacements.map((r) => r.page_id)).size,
  });
}
