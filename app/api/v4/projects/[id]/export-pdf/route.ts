import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { exportProjectToPdf, loadProjectForExport } from "@/lib/v4Export";

export const runtime = "nodejs";
// PDF generation can take a few seconds for larger projects.
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const SUPPORTED_LANGS = new Set(["pl", "bg", "hr", "ro", "mk", "sq", "en"]);

/**
 * Generates a vector PDF for the project in the requested language.
 * GET /api/v4/projects/[id]/export-pdf?lang=pl
 *
 * Returns the PDF binary with a Content-Disposition that suggests a sensible
 * filename so the browser's "Save as" dialog gets the project name + lang.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project, error } = await sb
    .from("gen4_projects")
    .select("id, owner_email, name")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (error || !project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const lang = (request.nextUrl.searchParams.get("lang") ?? "pl").toLowerCase();
  if (!SUPPORTED_LANGS.has(lang)) {
    return NextResponse.json({ error: `unsupported lang (${lang})` }, { status: 400 });
  }
  // Watermark DRAFT — opcjonalny query param `?draft=1`.
  const watermarkDraft = request.nextUrl.searchParams.get("draft") === "1";
  // Bleed + crop marks dla druku profesjonalnego — opcjonalne `?bleed=3&crop=1`.
  const bleedParam = request.nextUrl.searchParams.get("bleed");
  const bleedMm = bleedParam ? Math.min(10, Math.max(0, parseFloat(bleedParam))) : 0;
  const cropMarks = request.nextUrl.searchParams.get("crop") === "1";

  let bytes: Uint8Array;
  try {
    const data = await loadProjectForExport(id, lang);
    bytes = await exportProjectToPdf(data, lang, { watermarkDraft, bleedMm, cropMarks });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "export failed" },
      { status: 500 },
    );
  }

  // Slugify project name for the filename — strip non-ASCII, replace whitespace.
  const slug = project.name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "instrukcja";
  const filename = `${slug}_${lang.toUpperCase()}.pdf`;

  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
