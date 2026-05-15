/**
 * Bulk regeneracja elementow stron (poza cover/toc) — pętla auto-populate
 * per strona. SSE stream z progress per strona.
 *
 * Uzywane gdy user napprawil prompt/DS i chce zregenerowac calosc QSG, ale
 * nie chce klikac per strona w UI. Cover (template='cover') i TOC pomijamy
 * — TOC ma osobny deterministyczny endpoint regenerate-toc.
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
  if (!auth) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const { id: projectId } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", projectId)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  // Query params: ?from=N (start od page_number >= N), ?limit=M (max stron per invoke).
  // Vercel 300s max → ~12s per strona → max ~25 stron per invoke. Default 15 dla safety.
  const reqUrl = new URL(request.url);
  const fromPage = parseInt(reqUrl.searchParams.get("from") ?? "0", 10) || 0;
  const limitPerInvoke = Math.min(
    parseInt(reqUrl.searchParams.get("limit") ?? "15", 10) || 15,
    25,
  );

  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, template, title")
    .eq("project_id", projectId)
    .order("page_number", { ascending: true });
  const allPages = pages ?? [];
  // Pomijamy cover (nie ma elementow do regeneracji w sensie tresci)
  // i toc (deterministyczny — osobny endpoint regenerate-toc).
  const eligible = allPages.filter((p) => p.template !== "cover" && p.template !== "toc");
  const remaining = eligible.filter((p) => p.page_number >= fromPage);
  const targetPages = remaining.slice(0, limitPerInvoke);
  // next_offset = page_number pierwszej nie-przetworzonej strony, lub null gdy koniec.
  const nextOffset = remaining.length > limitPerInvoke ? remaining[limitPerInvoke].page_number : null;

  if (targetPages.length === 0) {
    return new Response(JSON.stringify({ error: "Brak stron do regeneracji" }), { status: 400 });
  }

  // Url to ourselves zeby wywolac auto-populate per stronę. VERCEL_URL zwraca
  // deployment-specific URL ktory ma "deployment protection" → 401. Uzywamy
  // stabilnego aliasu (GENERATOR_BASE_URL env) lub fallback do request.url host.
  const baseUrl = (() => {
    if (process.env.GENERATOR_BASE_URL) return process.env.GENERATOR_BASE_URL.replace(/\/$/, "");
    const u = new URL(request.url);
    return `${u.protocol}//${u.host}`;
  })();
  // basePath '/generator-instrukcji' — dla direct call do siebie potrzebne.
  // Ale endpointy beta/auto-populate zyja pod tym basePath, wiec dorzucamy.
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
      send("started", {
        total: targetPages.length,
        total_eligible: eligible.length,
        from: fromPage,
        next_offset: nextOffset,
        project_id: projectId,
      });

      const heartbeat = setInterval(() => {
        try { send("ping", { elapsed_ms: Date.now() - startedAt }); } catch { /* closed */ }
      }, 10000);

      let okCount = 0;
      let errCount = 0;
      const errors: Array<{ page_number: number; title: string | null; error: string }> = [];

      for (let i = 0; i < targetPages.length; i++) {
        const page = targetPages[i];
        send("progress", {
          current: i + 1,
          total: targetPages.length,
          page_number: page.page_number,
          title: page.title,
          status: "starting",
        });

        try {
          const apRes = await fetch(`${apiBase}/pages/${page.id}/auto-populate`, {
            method: "POST",
            headers,
          });
          if (!apRes.ok) {
            const txt = await apRes.text().catch(() => "");
            throw new Error(`HTTP ${apRes.status}: ${txt.slice(0, 200)}`);
          }
          const data = (await apRes.json()) as { ok?: boolean; elements?: number; error?: string };
          if (!data.ok) {
            throw new Error(data.error ?? "auto-populate returned not ok");
          }
          okCount++;
          send("progress", {
            current: i + 1,
            total: targetPages.length,
            page_number: page.page_number,
            title: page.title,
            status: "done",
            elements: data.elements,
          });
        } catch (err) {
          errCount++;
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ page_number: page.page_number, title: page.title, error: msg.slice(0, 300) });
          send("progress", {
            current: i + 1,
            total: targetPages.length,
            page_number: page.page_number,
            title: page.title,
            status: "error",
            error: msg.slice(0, 300),
          });
        }
      }

      clearInterval(heartbeat);
      send("done", {
        total: targetPages.length,
        ok: okCount,
        err: errCount,
        errors,
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
