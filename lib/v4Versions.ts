/**
 * Version history dla projektu — snapshoty stanu (pages + elements + design
 * systems + project-scoped notes) przed każdą destruktywną operacją.
 *
 * Pozwala cofnąć projekt do dowolnej wersji bez utraty całej historii (w
 * przeciwieństwie do "undo" w editorze które ma tylko 10 ostatnich stanów
 * per strona).
 */

import { getSupabaseAdmin } from "@/lib/supabase";

export interface ProjectSnapshot {
  pages: Array<{
    page_number: number;
    width_mm: number;
    height_mm: number;
    template: string | null;
    title: string | null;
    notes: string | null;
    elements: Array<{
      type: string;
      x_mm: number;
      y_mm: number;
      w_mm: number;
      h_mm: number;
      z_index: number;
      rotation_deg: number;
      properties: Record<string, unknown>;
      origin: string;
    }>;
  }>;
  design_systems: Array<{
    name: string;
    content: Record<string, unknown>;
    is_default: boolean;
  }>;
}

/** Tworzy snapshot bieżącego stanu projektu w gen4_project_versions.
 *  description — krótki opis akcji ('przed apply-DS Stop Hejt', 'przed batch
 *  auto-populate'). Wywoływane fire-and-forget — błąd nie blokuje operacji. */
export async function createVersion(
  projectId: string,
  description: string,
  createdBy: string,
): Promise<void> {
  const sb = getSupabaseAdmin();
  try {
    const { data: pages } = await sb
      .from("gen4_pages")
      .select("id, page_number, width_mm, height_mm, template, title, notes")
      .eq("project_id", projectId)
      .order("page_number", { ascending: true });
    const { data: elements } = pages && pages.length > 0
      ? await sb
          .from("gen4_elements")
          .select("page_id, type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties, origin")
          .in("page_id", pages.map((p) => p.id))
      : { data: [] };
    const { data: designSystems } = await sb
      .from("gen4_design_systems")
      .select("name, content, is_default")
      .eq("project_id", projectId);

    const elementsByPage = new Map<string, Array<Record<string, unknown>>>();
    for (const e of elements ?? []) {
      const arr = elementsByPage.get(e.page_id) ?? [];
      arr.push({
        type: e.type,
        x_mm: e.x_mm,
        y_mm: e.y_mm,
        w_mm: e.w_mm,
        h_mm: e.h_mm,
        z_index: e.z_index,
        rotation_deg: e.rotation_deg,
        properties: e.properties,
        origin: e.origin,
      });
      elementsByPage.set(e.page_id, arr);
    }

    const snapshot: ProjectSnapshot = {
      pages: (pages ?? []).map((p) => ({
        page_number: p.page_number,
        width_mm: p.width_mm,
        height_mm: p.height_mm,
        template: p.template,
        title: p.title,
        notes: p.notes,
        elements: (elementsByPage.get(p.id) ?? []) as ProjectSnapshot["pages"][number]["elements"],
      })),
      design_systems: (designSystems ?? []) as ProjectSnapshot["design_systems"],
    };

    // Następny version_number = MAX + 1
    const { data: existing } = await sb
      .from("gen4_project_versions")
      .select("version_number")
      .eq("project_id", projectId)
      .order("version_number", { ascending: false })
      .limit(1);
    const nextVersion = (existing?.[0]?.version_number ?? 0) + 1;

    await sb.from("gen4_project_versions").insert({
      project_id: projectId,
      version_number: nextVersion,
      description: description.slice(0, 300),
      snapshot,
      created_by: createdBy,
    });
  } catch (err) {
    console.warn("[v4 versions] createVersion failed (non-critical):", err);
  }
}

/** Restore projektu z konkretnej wersji. Wymiana pages+elements+design_systems
 *  atomic (delete all → insert from snapshot). Reference docs i translations
 *  zostają — nie są w snapshot. */
export async function restoreVersion(projectId: string, versionId: string): Promise<{ pages: number; elements: number; design_systems: number }> {
  const sb = getSupabaseAdmin();
  const { data: version } = await sb
    .from("gen4_project_versions")
    .select("snapshot")
    .eq("id", versionId)
    .eq("project_id", projectId)
    .single();
  if (!version) throw new Error("version not found");
  const snap = version.snapshot as ProjectSnapshot;

  // Wipe current
  await sb.from("gen4_pages").delete().eq("project_id", projectId);
  await sb.from("gen4_design_systems").delete().eq("project_id", projectId);

  // Insert pages + grab new ids
  let elementsCount = 0;
  if (snap.pages?.length > 0) {
    const pageRows = snap.pages.map((p) => ({
      project_id: projectId,
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
    const pageIdByNumber = new Map<number, string>();
    for (const ip of insertedPages ?? []) pageIdByNumber.set(ip.page_number, ip.id);

    const elementRows: Array<Record<string, unknown>> = [];
    for (const p of snap.pages) {
      const pageId = pageIdByNumber.get(p.page_number);
      if (!pageId) continue;
      for (const e of p.elements) {
        elementRows.push({
          page_id: pageId,
          type: e.type,
          x_mm: e.x_mm,
          y_mm: e.y_mm,
          w_mm: e.w_mm,
          h_mm: e.h_mm,
          z_index: e.z_index,
          rotation_deg: e.rotation_deg,
          properties: e.properties,
          origin: e.origin,
        });
      }
    }
    if (elementRows.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < elementRows.length; i += CHUNK) {
        await sb.from("gen4_elements").insert(elementRows.slice(i, i + CHUNK));
      }
      elementsCount = elementRows.length;
    }
  }

  let dsCount = 0;
  if (snap.design_systems?.length > 0) {
    await sb.from("gen4_design_systems").insert(
      snap.design_systems.map((d) => ({
        project_id: projectId,
        name: d.name,
        content: d.content,
        is_default: d.is_default,
      })),
    );
    dsCount = snap.design_systems.length;
  }

  return { pages: snap.pages?.length ?? 0, elements: elementsCount, design_systems: dsCount };
}
