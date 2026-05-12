import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createVersion, restoreVersion } from "@/lib/v4Versions";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string; verId: string }>;
}

/** Restore projektu z wybranej wersji.
 *  PRZED restore tworzymy automatyczny snapshot stanu bieżącego ("przed
 *  restore vN") — dzięki temu user może wrócić jeśli pomyłka. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, verId } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", id)
    .single();
  if (project?.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // 0. Snapshot bieżącego stanu (safety net).
  const { data: targetVersion } = await sb
    .from("gen4_project_versions")
    .select("version_number")
    .eq("id", verId)
    .single();
  await createVersion(
    id,
    `Snapshot przed restore do v${targetVersion?.version_number ?? "?"}`,
    auth.email,
  );

  try {
    const counts = await restoreVersion(id, verId);
    return NextResponse.json({ ok: true, ...counts });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "restore failed" },
      { status: 500 },
    );
  }
}
