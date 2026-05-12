import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Duplikuje projekt — wszystkie strony, elementy, design systems, notatki
 * (scope=project), reference docs (anthropic_file_id reuse — nie uploadujemy
 * ponownie do Anthropic). Translacje NIE są kopiowane — nowy projekt
 * startuje od bazowego języka, tłumaczenia można odpalić ponownie z translation
 * memory (większość trafień).
 *
 * Body: { name: string, model_code?: string, model_name?: string }
 *   - name (wymagane) — nazwa nowego projektu
 *   - model_code/model_name (opcjonalne) — gdy podane, ai_input dostaje
 *     nowe wartości (np. dla wariantu GJD.16 zamiast GJD.15)
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: sourceId } = await ctx.params;
  const body = (await request.json().catch(() => null)) as {
    name?: string;
    model_code?: string;
    model_name?: string;
  } | null;
  if (!body?.name?.trim()) {
    return NextResponse.json({ error: "missing name" }, { status: 400 });
  }
  const newName = body.name.trim().slice(0, 200);

  const sb = getSupabaseAdmin();

  // Source projekt
  const { data: source } = await sb
    .from("gen4_projects")
    .select("*")
    .eq("id", sourceId)
    .eq("owner_email", auth.email)
    .single();
  if (!source) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Zaktualizuj ai_input jeśli podano nowy model
  const newAiInput = { ...(source.ai_input as Record<string, unknown>) };
  if (body.model_code) newAiInput.model_code = body.model_code.trim();
  if (body.model_name) newAiInput.model_name = body.model_name.trim();

  // 1. Insert nowego projektu
  const { data: newProject, error: insertErr } = await sb
    .from("gen4_projects")
    .insert({
      owner_email: auth.email,
      name: newName,
      default_lang: source.default_lang,
      status: "ready",
      ai_input: newAiInput,
      design_system: source.design_system,
      document_type: source.document_type,
      device_type: source.device_type,
      legal_template_version: source.legal_template_version,
    })
    .select("id")
    .single();
  if (insertErr || !newProject) {
    return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
  }
  const newId = newProject.id;

  // 2. Pages — kopiuj 1:1, zachowaj page_number
  const { data: sourcePages } = await sb
    .from("gen4_pages")
    .select("id, page_number, width_mm, height_mm, template, title, notes")
    .eq("project_id", sourceId)
    .order("page_number", { ascending: true });
  const pageIdMap = new Map<string, string>();
  if (sourcePages && sourcePages.length > 0) {
    const pageRows = sourcePages.map((p) => ({
      project_id: newId,
      page_number: p.page_number,
      width_mm: p.width_mm,
      height_mm: p.height_mm,
      template: p.template,
      title: p.title,
      notes: p.notes,
    }));
    const { data: insertedPages } = await sb
      .from("gen4_pages")
      .insert(pageRows)
      .select("id, page_number");
    if (insertedPages) {
      // mapa source.id → new.id po page_number
      const sourceByNumber = new Map(sourcePages.map((p) => [p.page_number, p.id]));
      for (const np of insertedPages) {
        const srcId = sourceByNumber.get(np.page_number);
        if (srcId) pageIdMap.set(srcId, np.id);
      }
    }
  }

  // 3. Elements — kopiuj per strona z nowym page_id
  if (pageIdMap.size > 0) {
    const { data: sourceElements } = await sb
      .from("gen4_elements")
      .select("page_id, type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties, origin")
      .in("page_id", Array.from(pageIdMap.keys()));
    if (sourceElements && sourceElements.length > 0) {
      const elementRows = sourceElements.map((e) => ({
        page_id: pageIdMap.get(e.page_id)!,
        type: e.type,
        x_mm: e.x_mm,
        y_mm: e.y_mm,
        w_mm: e.w_mm,
        h_mm: e.h_mm,
        z_index: e.z_index,
        rotation_deg: e.rotation_deg,
        properties: e.properties,
        origin: e.origin,
      }));
      const CHUNK = 500;
      for (let i = 0; i < elementRows.length; i += CHUNK) {
        await sb.from("gen4_elements").insert(elementRows.slice(i, i + CHUNK));
      }
    }
  }

  // 4. Design systems — kopiuj wszystkie
  const { data: sourceDs } = await sb
    .from("gen4_design_systems")
    .select("name, content, is_default")
    .eq("project_id", sourceId);
  if (sourceDs && sourceDs.length > 0) {
    await sb.from("gen4_design_systems").insert(
      sourceDs.map((d) => ({
        project_id: newId,
        name: d.name,
        content: d.content,
        is_default: d.is_default,
      })),
    );
  }

  // 5. Project-scoped notes — kopiuj (skoro user uważał je za ważne dla tego
  // typu pracy, prawdopodobnie chce zachować je też w klonie).
  const { data: sourceNotes } = await sb
    .from("gen4_ai_notes")
    .select("scope, scope_value, content, why")
    .eq("owner_email", auth.email)
    .eq("scope", "project")
    .eq("scope_value", sourceId)
    .eq("is_active", true);
  if (sourceNotes && sourceNotes.length > 0) {
    await sb.from("gen4_ai_notes").insert(
      sourceNotes.map((n) => ({
        owner_email: auth.email,
        scope: "project",
        scope_value: newId,
        content: n.content,
        why: n.why,
        is_active: true,
      })),
    );
  }

  // 6. Reference docs — kopiujemy metadata (anthropic_file_id reuse —
  // Anthropic Files API trzyma plik 90 dni od ostatniego użycia, więc OK).
  // Storage file_path: kopiujemy faktyczny plik do nowego prefiksu (NIE reuse
  // path bo źródłowy projekt mógłby zostać usunięty i CASCADE usunie też plik).
  const { data: sourceDocs } = await sb
    .from("gen4_reference_docs")
    .select("kind, source_lang, name, file_path, size_bytes, mime_type, anthropic_file_id, extracted_summary, uploaded_by")
    .eq("project_id", sourceId);
  for (const doc of sourceDocs ?? []) {
    try {
      // Skopiuj plik w storage (źródłowa ścieżka → nowa).
      const newPath = `${newId}/${Date.now()}-${doc.name.replace(/[^\w.\-]+/g, "_").slice(0, 80)}`;
      const { data: blob } = await sb.storage.from("gen4-reference-docs").download(doc.file_path);
      if (!blob) continue;
      const buf = new Uint8Array(await blob.arrayBuffer());
      await sb.storage
        .from("gen4-reference-docs")
        .upload(newPath, buf, { contentType: doc.mime_type ?? "application/pdf", upsert: false });
      await sb.from("gen4_reference_docs").insert({
        project_id: newId,
        kind: doc.kind,
        source_lang: doc.source_lang,
        name: doc.name,
        file_path: newPath,
        size_bytes: doc.size_bytes,
        mime_type: doc.mime_type,
        anthropic_file_id: doc.anthropic_file_id, // reuse
        extracted_summary: doc.extracted_summary,
        uploaded_by: doc.uploaded_by,
      });
    } catch {
      /* per-doc fail nie blokuje całego clone — user może dorzucić ręcznie */
    }
  }

  return NextResponse.json({
    id: newId,
    pages_copied: pageIdMap.size,
    elements_copied: sourcePages?.length ?? 0,
  });
}
