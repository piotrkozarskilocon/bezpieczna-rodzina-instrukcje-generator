import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

// Cennik per 1M tokens (zgodne z ai-history endpoint).
const PRICING = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
};

interface SectionMetric {
  section_hint: string; // dopasowane z opisu fix-hint lub workflow
  manual_fixes: number;
  ai_calls: number;
  fix_ratio: number; // manual / ai (im wyższe, tym częściej AI generuje źle)
}

/** Metryki user-a: średni koszt projektu (dla predykcji), top sekcje
 *  problematyczne (gdzie najczęściej user poprawia po AI). */
export async function GET(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = getSupabaseAdmin();

  // 1. Średni koszt per projekt (ostatnie 30 dni)
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: projects } = await sb
    .from("gen4_projects")
    .select("id")
    .eq("owner_email", auth.email)
    .gte("created_at", sinceIso);
  const projectIds = (projects ?? []).map((p) => p.id);

  let avgCostPerProject = 0;
  let avgCostPerLang = 0;
  if (projectIds.length > 0) {
    const { data: history } = await sb
      .from("gen4_ai_history")
      .select("project_id, model, input_tokens, output_tokens, structured")
      .in("project_id", projectIds);

    const costByProject = new Map<string, number>();
    let translationCost = 0;
    let translationCount = 0;
    for (const h of history ?? []) {
      const isHaiku = (h.model ?? "").toLowerCase().includes("haiku");
      const p = isHaiku ? PRICING.haiku : PRICING.sonnet;
      const cost = ((h.input_tokens ?? 0) * p.input + (h.output_tokens ?? 0) * p.output) / 1_000_000;
      costByProject.set(h.project_id, (costByProject.get(h.project_id) ?? 0) + cost);
      if ((h.structured as Record<string, unknown> | null)?.workflow_type === "translation") {
        translationCost += cost;
        translationCount += 1;
      }
    }
    if (costByProject.size > 0) {
      const sum = Array.from(costByProject.values()).reduce((a, b) => a + b, 0);
      avgCostPerProject = sum / costByProject.size;
    }
    if (translationCount > 0) avgCostPerLang = translationCost / translationCount;
  }

  // 2. Per-section quality (najczęściej fixowane workflow / sekcje)
  const { data: edits } = await sb
    .from("gen4_post_edit_log")
    .select("project_id, page_id, source, description")
    .eq("owner_email", auth.email)
    .eq("source", "manual")
    .order("created_at", { ascending: false })
    .limit(500);

  const fixCountByPattern = new Map<string, number>();
  for (const e of edits ?? []) {
    // Heurystyka: pierwszy "wyraz po dwukropku" lub całe description
    const desc = (e.description ?? "").toLowerCase();
    const key = desc.split(":")[0]?.trim() || "(inne)";
    fixCountByPattern.set(key, (fixCountByPattern.get(key) ?? 0) + 1);
  }

  // 3. AI calls per workflow
  const { data: aiCalls } = await sb
    .from("gen4_ai_history")
    .select("structured")
    .in("project_id", projectIds.length > 0 ? projectIds : ["00000000-0000-0000-0000-000000000000"]);
  const aiByWorkflow = new Map<string, number>();
  for (const a of aiCalls ?? []) {
    const wf = (a.structured as Record<string, unknown> | null)?.workflow_type as string | undefined;
    if (!wf) continue;
    aiByWorkflow.set(wf, (aiByWorkflow.get(wf) ?? 0) + 1);
  }

  const topFixPatterns: SectionMetric[] = Array.from(fixCountByPattern.entries())
    .map(([section_hint, count]) => ({
      section_hint,
      manual_fixes: count,
      ai_calls: 0,
      fix_ratio: 0,
    }))
    .sort((a, b) => b.manual_fixes - a.manual_fixes)
    .slice(0, 10);

  return NextResponse.json({
    period_days: 30,
    projects_count: projectIds.length,
    avg_cost_per_project_usd: avgCostPerProject,
    avg_cost_per_translation_usd: avgCostPerLang,
    ai_calls_by_workflow: Object.fromEntries(aiByWorkflow),
    top_manual_fix_patterns: topFixPatterns,
  });
}

/** POST — cost prediction dla batch. Body: { projects: number, langs?: number } */
export async function POST(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { projects?: number; langs?: number };
  const projectsCount = Math.max(1, Math.min(100, body.projects ?? 1));
  const langsCount = Math.max(0, Math.min(6, body.langs ?? 0));

  const sb = getSupabaseAdmin();
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Lookup avg cost per workflow z historycznych danych
  const { data: userProjects } = await sb
    .from("gen4_projects")
    .select("id")
    .eq("owner_email", auth.email)
    .gte("created_at", sinceIso);
  const userProjectIds = (userProjects ?? []).map((p) => p.id);
  let avgPerProject = 0.15; // fallback (typowy projekt Haiku 4.5 ~$0.15)
  let avgPerLang = 0.05;

  if (userProjectIds.length > 0) {
    const { data: realHistory } = await sb
      .from("gen4_ai_history")
      .select("project_id, model, input_tokens, output_tokens, structured")
      .in("project_id", userProjectIds);
    const projCost = new Map<string, number>();
    let translTotal = 0;
    let translCount = 0;
    for (const h of realHistory ?? []) {
      const isHaiku = (h.model ?? "").toLowerCase().includes("haiku");
      const p = isHaiku ? PRICING.haiku : PRICING.sonnet;
      const cost = ((h.input_tokens ?? 0) * p.input + (h.output_tokens ?? 0) * p.output) / 1_000_000;
      projCost.set(h.project_id, (projCost.get(h.project_id) ?? 0) + cost);
      if ((h.structured as Record<string, unknown> | null)?.workflow_type === "translation") {
        translTotal += cost;
        translCount += 1;
      }
    }
    if (projCost.size > 0) {
      avgPerProject = Array.from(projCost.values()).reduce((a, b) => a + b, 0) / projCost.size;
    }
    if (translCount > 0) avgPerLang = translTotal / translCount;
  }

  const baseCost = avgPerProject * projectsCount;
  const langCost = avgPerLang * langsCount * projectsCount;
  return NextResponse.json({
    estimated_cost_usd: baseCost + langCost,
    breakdown: {
      base_generation: { projects: projectsCount, avg_per_project: avgPerProject, total: baseCost },
      translations: { langs: langsCount, projects: projectsCount, avg_per_lang: avgPerLang, total: langCost },
    },
    historical_sample_size: userProjectIds.length,
    note: userProjectIds.length === 0
      ? "Brak danych historycznych — szacunek na bazie typowych projektów ($0.15/proj, $0.05/lang)."
      : `Szacunek na bazie ${userProjectIds.length} projektów z ostatnich 30 dni.`,
  });
}
