/**
 * Deterministycznie regeneruje elementy strony Spis tresci (template='toc')
 * na podstawie aktualnej listy stron projektu.
 *
 * Bez AI — czytamy gen4_pages, filtrujemy nie-cover/nie-toc, sortujemy po
 * page_number, generujemy layout title + linia + N entry tekstow.
 *
 * Frontend wywoluje to po dodaniu/usunieciu strony albo zmianie tytulu.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { replacePageElements } from "@/lib/v4Edit";

export const runtime = "nodejs";
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface PageRow {
  id: string;
  page_number: number;
  template: string | null;
  title: string | null;
  width_mm: number;
  height_mm: number;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
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

  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, template, title, width_mm, height_mm")
    .eq("project_id", projectId)
    .order("page_number", { ascending: true });
  const allPages = (pages ?? []) as PageRow[];

  const tocPage = allPages.find((p) => p.template === "toc");
  if (!tocPage) {
    return NextResponse.json(
      { error: "Brak strony toc w projekcie (template='toc'). Dodaj ja recznie albo wygeneruj projekt od nowa." },
      { status: 400 },
    );
  }

  // Entries = wszystkie strony poza cover i toc (sortowane po page_number).
  const entries = allPages
    .filter((p) => p.template !== "cover" && p.template !== "toc")
    .filter((p) => p.title && p.title.trim().length > 0);

  if (entries.length === 0) {
    return NextResponse.json(
      { error: "Brak stron z tytulami do umieszczenia w spisie tresci." },
      { status: 400 },
    );
  }

  // Layout TOC: skalowanie do wymiarow strony (typowo 76x76 mm).
  const pw = tocPage.width_mm;
  const ph = tocPage.height_mm;
  const margin = 3;
  const fontScale = Math.min(pw, ph) / 76;
  const titleFont = Math.round(14 * fontScale);
  const entryFont = Math.max(4, Math.round(6 * fontScale));
  const entryLineHeight = entryFont * 0.55; // mm; ~1.5 line-height converted

  const titleY = margin + 2; // 5 mm dla 76x76
  const titleH = Math.round(titleFont * 0.4) + 1; // ~6 mm dla 14pt
  const dividerY = titleY + titleH + 1;
  const firstEntryY = dividerY + 2;

  // Sprawdz czy entries miesci sie w wysokosci. Jezeli nie — zmniejsz font.
  const availableH = ph - margin - firstEntryY;
  let actualEntryFont = entryFont;
  let actualLineHeight = entryLineHeight;
  while (entries.length * actualLineHeight > availableH && actualEntryFont > 3) {
    actualEntryFont -= 1;
    actualLineHeight = actualEntryFont * 0.55;
  }

  // Szerokosc kolumn: title po lewej (75% szerokosci), pageNum po prawej (15%).
  const contentW = pw - 2 * margin;
  const titleColW = Math.round(contentW * 0.82);
  const pageNumColW = contentW - titleColW;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elements: any[] = [
    // 1. Tytul "Spis treści"
    {
      type: "text",
      x_mm: margin,
      y_mm: titleY,
      w_mm: pw - 2 * margin,
      h_mm: titleH + 2,
      z_index: 1,
      rotation_deg: 0,
      properties: {
        content: "Spis treści",
        font_size_pt: titleFont,
        color: "#0f172a",
        align: "left",
      },
    },
    // 2. Linia separator
    {
      type: "line",
      x_mm: margin,
      y_mm: dividerY,
      w_mm: pw - 2 * margin,
      h_mm: 0.3,
      z_index: 1,
      rotation_deg: 0,
      properties: {
        stroke_width: 0.3,
        color: "#94a3b8",
      },
    },
  ];

  // 3. Entries (numerowane, title po lewej, numer strony po prawej)
  entries.forEach((p, idx) => {
    const y = firstEntryY + idx * actualLineHeight;
    elements.push({
      type: "text",
      x_mm: margin,
      y_mm: y,
      w_mm: titleColW,
      h_mm: actualLineHeight,
      z_index: 1,
      rotation_deg: 0,
      properties: {
        content: `${idx + 1}. ${p.title}`,
        font_size_pt: actualEntryFont,
        color: "#0f172a",
        align: "left",
      },
    });
    elements.push({
      type: "text",
      x_mm: margin + titleColW,
      y_mm: y,
      w_mm: pageNumColW,
      h_mm: actualLineHeight,
      z_index: 1,
      rotation_deg: 0,
      properties: {
        content: String(p.page_number),
        font_size_pt: actualEntryFont,
        color: "#475569",
        align: "right",
      },
    });
  });

  // Zapis (delete + insert wszystkich elementow TOC)
  const count = await replacePageElements(tocPage.id, { elements });

  return NextResponse.json({
    ok: true,
    toc_page_id: tocPage.id,
    toc_page_number: tocPage.page_number,
    entries_count: entries.length,
    elements_count: count,
    entry_font_pt: actualEntryFont,
  });
}
