import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const LANG_KEYS = ["pl", "bg", "hr", "ro", "mk", "sq", "en"] as const;
type LangKey = (typeof LANG_KEYS)[number];
type TranslationContent = Partial<Record<LangKey, string>>;

interface TranslationRow {
  row_index: number;
  row_key: string | null;
  content: TranslationContent;
}

/** Returns all translation rows for a project. */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: project, error: pErr } = await sb
    .from("gen2_projects")
    .select("id")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (pErr || !project) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Paginate to avoid PostgREST 1000-row default cap (same gotcha as blocks).
  const PAGE_SIZE = 1000;
  const rows: TranslationRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: chunk, error } = await sb
      .from("gen2_translations")
      .select("row_index, row_key, content")
      .eq("project_id", id)
      .order("row_index", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!chunk || chunk.length === 0) break;
    rows.push(
      ...chunk.map((r) => ({
        row_index: r.row_index,
        row_key: r.row_key,
        content: (r.content ?? {}) as TranslationContent,
      })),
    );
    if (chunk.length < PAGE_SIZE) break;
  }

  return NextResponse.json({ rows });
}

/**
 * POST accepts a multipart/form-data upload with an `.xlsx` file.
 * Parses the first sheet and stores each row as a translation entry.
 *
 * Expected XLSX columns (case-insensitive header lookup): pl, bg, hr, ro, mk, sq, en.
 * Optional columns "id" or "key" become row_key.
 *
 * Replaces all existing translations for the project (full re-import on every upload).
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: project, error: pErr } = await sb
    .from("gen2_projects")
    .select("id")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (pErr || !project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const form = await request.formData();
  const file = form.get("xlsx");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing xlsx file" }, { status: 400 });
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "xlsx too large (max 10 MB)" }, { status: 413 });
  }

  let rows: TranslationRow[];
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    rows = parseXlsxToRows(buf);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "xlsx parse failed" },
      { status: 400 },
    );
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: "no rows found in xlsx" }, { status: 400 });
  }

  // Replace all.
  const { error: delErr } = await sb
    .from("gen2_translations")
    .delete()
    .eq("project_id", id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  const insertRows = rows.map((r) => ({
    project_id: id,
    row_index: r.row_index,
    row_key: r.row_key,
    content: r.content,
  }));

  const CHUNK = 500;
  for (let i = 0; i < insertRows.length; i += CHUNK) {
    const slice = insertRows.slice(i, i + CHUNK);
    const { error } = await sb.from("gen2_translations").insert(slice);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, rows: insertRows.length });
}

/** DELETE wipes all translations for the project. */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const sb = getSupabaseAdmin();
  const { data: project, error: pErr } = await sb
    .from("gen2_projects")
    .select("id")
    .eq("id", id)
    .eq("owner_email", auth.email)
    .single();
  if (pErr || !project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { error } = await sb.from("gen2_translations").delete().eq("project_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

function parseXlsxToRows(buf: Buffer): TranslationRow[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("empty workbook");
  const sheet = wb.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

  if (json.length === 0) return [];

  // Case-insensitive header lookup. Find the first row's keys, build a map
  // from lowercase header → actual header so we can read regardless of case.
  const headerMap = new Map<string, string>();
  for (const key of Object.keys(json[0])) {
    headerMap.set(key.trim().toLowerCase(), key);
  }
  const findCol = (...candidates: string[]): string | null => {
    for (const c of candidates) {
      const hit = headerMap.get(c.toLowerCase());
      if (hit) return hit;
    }
    return null;
  };

  const cols: Partial<Record<LangKey | "key", string>> = {};
  for (const lang of LANG_KEYS) {
    const c = findCol(lang);
    if (c) cols[lang] = c;
  }
  const keyCol = findCol("key", "id");
  if (keyCol) cols.key = keyCol;

  const rows: TranslationRow[] = [];
  json.forEach((raw, idx) => {
    const content: TranslationContent = {};
    let anyText = false;
    for (const lang of LANG_KEYS) {
      const colName = cols[lang];
      if (!colName) continue;
      const v = raw[colName];
      const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
      if (s.length > 0) {
        content[lang] = s;
        anyText = true;
      }
    }
    if (!anyText) return; // skip empty rows
    rows.push({
      row_index: idx,
      row_key: cols.key ? (String(raw[cols.key] ?? "").trim() || null) : null,
      content,
    });
  });

  return rows;
}
