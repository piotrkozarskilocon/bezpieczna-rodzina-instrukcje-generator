/**
 * GET /api/v4/projects/[id]/placeholders — lista wszystkich placeholderow
 * 'DO UZUPELNIENIA' i image bez image_id w calym projekcie.
 *
 * Frontend pokazuje pasek 'Brakuje N wartosci' z click-to-jump per pozycja.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface PlaceholderItem {
  page_id: string;
  page_number: number;
  page_title: string | null;
  element_id: string;
  element_type: string;
  kind: "text_placeholder" | "image_missing" | "image_low_opacity";
  label: string;
  snippet: string;
}

const PLACEHOLDER_RE = /⚠️\s*DO\s+UZUPE[ŁL]NIENIA\s*[:：]?\s*(.+)/i;

export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: projectId } = await ctx.params;
  const sb = getSupabaseAdmin();

  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", projectId)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Wszystkie strony + elementy projektu jednym query.
  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, title")
    .eq("project_id", projectId)
    .order("page_number", { ascending: true });
  if (!pages || pages.length === 0) {
    return NextResponse.json({ items: [], count: 0 });
  }
  const pageIds = pages.map((p) => p.id);
  const pageMap = new Map(pages.map((p) => [p.id, p]));

  const { data: elements } = await sb
    .from("gen4_elements")
    .select("id, page_id, type, properties")
    .in("page_id", pageIds);

  const items: PlaceholderItem[] = [];
  for (const el of elements ?? []) {
    const page = pageMap.get(el.page_id);
    if (!page) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = el.properties as any;

    // Text placeholderów '⚠️ DO UZUPEŁNIENIA: <opis>'
    if (el.type === "text" || el.type === "callout") {
      const content: string = typeof props?.content === "string" ? props.content : "";
      const match = content.match(PLACEHOLDER_RE);
      if (match) {
        items.push({
          page_id: page.id,
          page_number: page.page_number,
          page_title: page.title,
          element_id: el.id,
          element_type: el.type,
          kind: "text_placeholder",
          label: match[1].trim().slice(0, 80),
          snippet: content.slice(0, 120),
        });
      }
    }

    // Image bez image_id i bez placeholder_description
    if (el.type === "image") {
      const imageId = props?.image_id;
      const desc = typeof props?.placeholder_description === "string" ? props.placeholder_description : null;
      if (!imageId) {
        items.push({
          page_id: page.id,
          page_number: page.page_number,
          page_title: page.title,
          element_id: el.id,
          element_type: "image",
          kind: "image_missing",
          label: desc ?? "Brakujący obrazek",
          snippet: desc ?? "(wgraj obrazek do biblioteki i przypisz)",
        });
      } else if (typeof props?.opacity === "number" && props.opacity > 0 && props.opacity < 0.08) {
        items.push({
          page_id: page.id,
          page_number: page.page_number,
          page_title: page.title,
          element_id: el.id,
          element_type: "image",
          kind: "image_low_opacity",
          label: `Niska opacity (${props.opacity})`,
          snippet: "obraz prawie niewidoczny, ustaw 0.10-0.20 dla watermarka",
        });
      }
    }
  }

  // Sortuj po page_number rosnaco
  items.sort((a, b) => a.page_number - b.page_number);

  return NextResponse.json({
    items,
    count: items.length,
    by_kind: {
      text_placeholder: items.filter((i) => i.kind === "text_placeholder").length,
      image_missing: items.filter((i) => i.kind === "image_missing").length,
      image_low_opacity: items.filter((i) => i.kind === "image_low_opacity").length,
    },
  });
}
