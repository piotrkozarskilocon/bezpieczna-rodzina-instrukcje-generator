import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Cennik tokenów Anthropic — USD per 1M tokens (stan 2026-05).
// Aktualizuj tu gdy Anthropic zmieni pricing; reszta apki czyta automatycznie.
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-7": { input: 15, output: 75 },
  // wpisy bez wersji = fallback
  "haiku": { input: 1, output: 5 },
  "sonnet": { input: 3, output: 15 },
  "opus": { input: 15, output: 75 },
};

/** Koszt z uwzględnieniem cache:
 *   - uncached input: 1.0×
 *   - cache write:    1.25× (Anthropic narzut)
 *   - cache read:     0.1× (90% zniżki)
 *   - output:         1.0× model output price */
function costUsd(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheWrite: number = 0,
  cacheRead: number = 0,
): number {
  if (!model) return 0;
  const lookup = (m: string) => {
    if (PRICING[m]) return PRICING[m];
    for (const key of Object.keys(PRICING)) {
      if (m.toLowerCase().includes(key.toLowerCase())) return PRICING[key];
    }
    return null;
  };
  const p = lookup(model);
  if (!p) return 0;
  return (
    (inputTokens * p.input
      + cacheWrite * p.input * 1.25
      + cacheRead * p.input * 0.1
      + outputTokens * p.output)
    / 1_000_000
  );
}

interface HistoryRow {
  id: string;
  role: string;
  content: string;
  structured: Record<string, unknown> | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  created_at: string;
}

/**
 * Historia wywołań AI dla projektu + zsumowane metryki kosztowe.
 * Frontend wyświetla w panelu Gen4CostDashboard.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", id)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: history, error } = await sb
    .from("gen4_ai_history")
    .select("id, role, content, structured, model, input_tokens, output_tokens, latency_ms, created_at")
    .eq("project_id", id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (history ?? []) as HistoryRow[];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheWrite = 0;
  let totalCacheRead = 0;
  let totalCost = 0;
  const perWorkflow = new Map<string, { count: number; cost: number; input: number; output: number; cache_read: number }>();
  const enriched = rows.map((r) => {
    const inT = r.input_tokens ?? 0;
    const outT = r.output_tokens ?? 0;
    // Cache stats z structured (zapisujemy je przy każdym wywołaniu callClaude).
    const cw = typeof r.structured?.cache_creation_tokens === "number" ? r.structured.cache_creation_tokens : 0;
    const cr = typeof r.structured?.cache_read_tokens === "number" ? r.structured.cache_read_tokens : 0;
    const cost = costUsd(r.model, inT, outT, cw, cr);
    totalInput += inT;
    totalOutput += outT;
    totalCacheWrite += cw;
    totalCacheRead += cr;
    totalCost += cost;
    const wf = (r.structured?.workflow_type as string | undefined) ?? "other";
    const cur = perWorkflow.get(wf) ?? { count: 0, cost: 0, input: 0, output: 0, cache_read: 0 };
    cur.count += 1;
    cur.cost += cost;
    cur.input += inT;
    cur.output += outT;
    cur.cache_read += cr;
    perWorkflow.set(wf, cur);
    return { ...r, cost_usd: cost };
  });

  return NextResponse.json({
    history: enriched,
    totals: {
      calls: rows.length,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cache_write_tokens: totalCacheWrite,
      cache_read_tokens: totalCacheRead,
      cost_usd: totalCost,
    },
    by_workflow: Array.from(perWorkflow.entries()).map(([workflow, stats]) => ({
      workflow,
      ...stats,
    })),
  });
}
