/**
 * AI batch edit — user wpisuje 1 instrukcje, AI per strona stosuje ja przez ai-edit.
 * Np. "Tlumacz wszystkie ostrzezenia na BG", "Pogrub wszystkie naglowki", "Skroc kazda strone o polowe".
 *
 * SSE z progress + chunking (?from=N).
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
  const body = (await request.json().catch(() => null)) as { instruction?: string; scope?: "all" | "non_cover" } | null;
  const instruction = body?.instruction?.trim();
  if (!instruction) return new Response(JSON.stringify({ error: "missing instruction" }), { status: 400 });

  const sb = getSupabaseAdmin();
  const { data: project } = await sb.from("gen4_projects").select("owner_email").eq("id", projectId).single();
  if (!project || project.owner_email !== auth.email) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  const reqUrl = new URL(request.url);
  const fromPage = parseInt(reqUrl.searchParams.get("from") ?? "0", 10) || 0;
  const limitPerInvoke = Math.min(parseInt(reqUrl.searchParams.get("limit") ?? "15", 10) || 15, 25);

  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, template, title")
    .eq("project_id", projectId)
    .order("page_number", { ascending: true });
  const allPages = pages ?? [];
  const eligible = body?.scope === "all"
    ? allPages
    : allPages.filter((p) => p.template !== "cover" && p.template !== "toc");
  const remaining = eligible.filter((p) => p.page_number >= fromPage);
  const targets = remaining.slice(0, limitPerInvoke);
  const nextOffset = remaining.length > limitPerInvoke ? remaining[limitPerInvoke].page_number : null;

  if (targets.length === 0) {
    return new Response(JSON.stringify({ error: "Brak stron pasujacych do scope" }), { status: 400 });
  }

  const baseUrl = process.env.GENERATOR_BASE_URL?.replace(/\/$/, "") ??
    (() => { const u = new URL(request.url); return `${u.protocol}//${u.host}`; })();
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
      send("started", {
        total: targets.length, total_eligible: eligible.length,
        from: fromPage, next_offset: nextOffset,
        instruction,
      });

      const heartbeat = setInterval(() => {
        try { send("ping", { elapsed_ms: Date.now() - startedAt }); } catch { /* */ }
      }, 10000);

      let okCount = 0;
      let errCount = 0;

      for (let i = 0; i < targets.length; i++) {
        const page = targets[i];
        send("progress", {
          current: i + 1, total: targets.length,
          page_number: page.page_number, title: page.title, status: "starting",
        });

        try {
          const r = await fetch(`${baseUrl}/generator-instrukcji/api/v4/pages/${page.id}/ai-edit`, {
            method: "POST",
            headers,
            body: JSON.stringify({ instruction }),
          });
          if (!r.ok) {
            const txt = await r.text().catch(() => "");
            throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
          }
          const j = (await r.json()) as { elements?: number };
          okCount++;
          send("progress", {
            current: i + 1, total: targets.length,
            page_number: page.page_number, title: page.title, status: "done",
            elements: j.elements,
          });
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
        total: targets.length, ok: okCount, err: errCount,
        next_offset: nextOffset, has_more: nextOffset !== null,
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
