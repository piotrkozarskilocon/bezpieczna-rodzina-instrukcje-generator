/**
 * Bulk AI fix layout issues w calym projekcie. Petla per strona, wywoluje
 * lint/fix logiki AI per strona. SSE z progress + chunking.
 *
 * Wywoluje pages/[id]/validate/fix (lub linter z AI fix) — tu wywolujemy
 * bezposrednio /api/v4/pages/[pageId]/validate POST (AI fix mode).
 */

import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

  const { id: projectId } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project } = await sb.from("gen4_projects").select("owner_email").eq("id", projectId).single();
  if (!project || project.owner_email !== auth.email) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  const reqUrl = new URL(request.url);
  const fromPage = parseInt(reqUrl.searchParams.get("from") ?? "0", 10) || 0;
  const limitPerInvoke = Math.min(parseInt(reqUrl.searchParams.get("limit") ?? "20", 10) || 20, 30);

  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, title")
    .eq("project_id", projectId)
    .order("page_number", { ascending: true });
  const allPages = pages ?? [];
  const remaining = allPages.filter((p) => p.page_number >= fromPage);
  const targets = remaining.slice(0, limitPerInvoke);
  const nextOffset = remaining.length > limitPerInvoke ? remaining[limitPerInvoke].page_number : null;

  if (targets.length === 0) {
    return new Response(JSON.stringify({ error: "Brak stron do fix" }), { status: 400 });
  }

  // Url to self via GENERATOR_BASE_URL (stabilny alias).
  const baseUrl = process.env.GENERATOR_BASE_URL?.replace(/\/$/, "") ??
    (() => { const u = new URL(request.url); return `${u.protocol}//${u.host}`; })();
  const apiBase = `${baseUrl}/generator-instrukcji/api/v4`;
  const proxySecret = process.env.INTERNAL_PROXY_SECRET ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-locon-proxy-secret": proxySecret,
    "x-locon-user-email": auth.email,
  };

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const sse = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("started", { total: targets.length, total_eligible: allPages.length, from: fromPage, next_offset: nextOffset });

      const heartbeat = setInterval(() => {
        try { send("ping", { elapsed_ms: Date.now() - startedAt }); } catch { /* */ }
      }, 10000);

      let okCount = 0;
      let errCount = 0;
      let skippedCount = 0;
      let totalIssuesFixed = 0;

      for (let i = 0; i < targets.length; i++) {
        const page = targets[i];
        send("progress", {
          current: i + 1, total: targets.length,
          page_number: page.page_number, title: page.title, status: "starting",
        });

        try {
          // Call POST /api/v4/pages/[id]/validate z fix=true zeby AI naprawila issues.
          // Validate endpoint zwraca rowniez `issues` lista po naprawie.
          const r = await fetch(`${apiBase}/pages/${page.id}/validate`, {
            method: "POST",
            headers,
            body: JSON.stringify({ fix: true }),
          });
          if (!r.ok) {
            const txt = await r.text().catch(() => "");
            throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
          }
          const data = (await r.json()) as { fixed?: number; issues?: unknown[]; no_fixable?: boolean };
          const fixed = data.fixed ?? 0;
          if (data.no_fixable || fixed === 0) {
            skippedCount++;
            send("progress", {
              current: i + 1, total: targets.length,
              page_number: page.page_number, title: page.title, status: "skipped",
              reason: "brak fixable issues",
            });
          } else {
            okCount++;
            totalIssuesFixed += fixed;
            send("progress", {
              current: i + 1, total: targets.length,
              page_number: page.page_number, title: page.title, status: "done",
              fixed,
            });
          }
        } catch (err) {
          errCount++;
          const msg = err instanceof Error ? err.message : String(err);
          send("progress", {
            current: i + 1, total: targets.length,
            page_number: page.page_number, title: page.title, status: "error",
            error: msg.slice(0, 200),
          });
        }
      }

      clearInterval(heartbeat);
      send("done", {
        total: targets.length,
        ok: okCount, err: errCount, skipped: skippedCount,
        total_issues_fixed: totalIssuesFixed,
        next_offset: nextOffset,
        has_more: nextOffset !== null,
        duration_ms: Date.now() - startedAt,
      });
      controller.close();
    },
  });

  return new Response(sse, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
