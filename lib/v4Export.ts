/**
 * v4 vector PDF export.
 *
 * Builds a PDF document straight from the gen4_pages + gen4_elements rows
 * (and optional gen4_translations for the chosen language). Uses pdf-lib —
 * vector output, embedded Inter font, native multi-page. No raster of the
 * preview canvas — the editor's display is just visual feedback.
 *
 * Coordinate systems: in the DB / editor we use mm with Y growing downward
 * (matches CSS). pdf-lib uses points with Y growing upward from the
 * bottom-left of the page. We convert in `mmYTopToPdf`.
 */

import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
// fontkit must be registered via PDFDocument.registerFontkit before embedding TTFs.
import fontkit from "@pdf-lib/fontkit";
import QRCode from "qrcode";
import { promises as fs } from "fs";
import path from "path";
import { getSupabaseAdmin } from "@/lib/supabase";

const MM_PER_PT = 25.4 / 72;
const PT_PER_MM = 72 / 25.4;

interface ElementRow {
  id: string;
  type: string;
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
  z_index: number;
  rotation_deg: number;
  properties: Record<string, unknown>;
}

interface PageRow {
  id: string;
  page_number: number;
  width_mm: number;
  height_mm: number;
  template: string | null;
  elements: ElementRow[];
}

interface ProjectExportData {
  id: string;
  name: string;
  default_lang: string;
  pages: PageRow[];
  translations: Map<string, string>; // element_id → translated text
}

/** Loads everything needed to render a PDF for one language.
 *  When lang === default_lang or no translations exist, the map is empty. */
export async function loadProjectForExport(
  projectId: string,
  lang: string,
): Promise<ProjectExportData> {
  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("id, name, default_lang")
    .eq("id", projectId)
    .single();
  if (!project) throw new Error("project not found");

  const { data: pages } = await sb
    .from("gen4_pages")
    .select("id, page_number, width_mm, height_mm, template")
    .eq("project_id", projectId)
    .order("page_number", { ascending: true });
  if (!pages) throw new Error("no pages");

  const pageIds = pages.map((p) => p.id);
  const { data: elements } = await sb
    .from("gen4_elements")
    .select("id, page_id, type, x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties")
    .in("page_id", pageIds)
    .order("z_index", { ascending: true });

  const elementsByPage = new Map<string, ElementRow[]>();
  for (const el of elements ?? []) {
    const arr = elementsByPage.get(el.page_id) ?? [];
    arr.push(el as ElementRow);
    elementsByPage.set(el.page_id, arr);
  }

  // Translations only matter when target lang is different from source.
  const translations = new Map<string, string>();
  if (lang !== project.default_lang) {
    const elementIds = (elements ?? []).map((e) => e.id);
    if (elementIds.length > 0) {
      // Paginate to avoid the 1000-row PostgREST cap.
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb
          .from("gen4_translations")
          .select("element_id, text")
          .eq("project_id", projectId)
          .eq("language", lang)
          .in("element_id", elementIds)
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        for (const row of data) translations.set(row.element_id, row.text);
        if (data.length < PAGE) break;
      }
    }
  }

  return {
    id: project.id,
    name: project.name,
    default_lang: project.default_lang,
    pages: pages.map((p) => ({
      ...p,
      elements: elementsByPage.get(p.id) ?? [],
    })),
    translations,
  };
}

/** Convert "#0f172a" or "rgb(15, 23, 42)" to pdf-lib's rgb(0..1). Falls back
 *  to black on parse failure — better than throwing mid-render. */
function parseColor(value: unknown): ReturnType<typeof rgb> {
  if (typeof value !== "string") return rgb(0, 0, 0);
  const v = value.trim().toLowerCase();
  if (v.startsWith("#")) {
    const hex = v.slice(1);
    const expanded = hex.length === 3
      ? hex.split("").map((c) => c + c).join("")
      : hex;
    if (expanded.length !== 6) return rgb(0, 0, 0);
    const r = parseInt(expanded.slice(0, 2), 16);
    const g = parseInt(expanded.slice(2, 4), 16);
    const b = parseInt(expanded.slice(4, 6), 16);
    return rgb(r / 255, g / 255, b / 255);
  }
  const m = v.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return rgb(parseInt(m[1]) / 255, parseInt(m[2]) / 255, parseInt(m[3]) / 255);
  return rgb(0, 0, 0);
}

/** Y conversion: editor uses Y from top, pdf-lib uses Y from bottom.
 *  Returns the bottom-left Y (in points) of a box that starts at y_mm from
 *  the top with height h_mm. */
function mmYTopToPdfBottom(yMmTop: number, hMm: number, pageHeightPt: number): number {
  return pageHeightPt - (yMmTop + hMm) * PT_PER_MM;
}

/** Splits text into lines that fit within `maxWidthPt` at given font size,
 *  preserving any explicit \n line breaks. Words longer than the box are
 *  put on their own line uncut (better visual feedback than mid-word breaks). */
function wrapText(text: string, font: PDFFont, sizePt: number, maxWidthPt: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = "";
    for (const w of words) {
      const candidate = current ? `${current} ${w}` : w;
      const width = font.widthOfTextAtSize(candidate, sizePt);
      if (width <= maxWidthPt || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = w;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

interface DrawContext {
  page: PDFPage;
  pageHeightPt: number;
  fontRegular: PDFFont;
  fontBold: PDFFont;
  pageNumber: number;
  totalPages: number;
  lang: string;
}

/** Render one element. Returns nothing — direct draw on the page. */
async function drawElement(
  el: ElementRow,
  ctx: DrawContext,
  resolveText: (el: ElementRow) => string,
): Promise<void> {
  const props = el.properties ?? {};
  const xPt = el.x_mm * PT_PER_MM;
  const wPt = el.w_mm * PT_PER_MM;
  const hPt = el.h_mm * PT_PER_MM;
  const yPdfBottom = mmYTopToPdfBottom(el.y_mm, el.h_mm, ctx.pageHeightPt);

  if (el.type === "text" || el.type === "callout") {
    const sizePt = typeof (props as Record<string, unknown>).font_size_pt === "number"
      ? ((props as Record<string, number>).font_size_pt as number)
      : 9;
    const weight = (props as Record<string, string>).weight ?? "regular";
    const font = weight === "bold" ? ctx.fontBold : ctx.fontRegular;
    const color = parseColor((props as Record<string, unknown>).color);
    const align = ((props as Record<string, string>).align ?? "left") as "left" | "center" | "right" | "justify";
    const text = resolveText(el);
    if (!text) return;

    const lines = wrapText(text, font, sizePt, wPt);
    const lineHeightPt = sizePt * 1.2;
    let cursorY = ctx.pageHeightPt - el.y_mm * PT_PER_MM - sizePt; // baseline of first line
    for (const line of lines) {
      // Don't draw past the bottom edge of the box.
      if (cursorY < yPdfBottom - 0.5) break;
      const lineWidth = font.widthOfTextAtSize(line, sizePt);
      let drawX = xPt;
      if (align === "center") drawX = xPt + (wPt - lineWidth) / 2;
      else if (align === "right") drawX = xPt + (wPt - lineWidth);
      ctx.page.drawText(line, { x: drawX, y: cursorY, size: sizePt, font, color });
      cursorY -= lineHeightPt;
    }
    return;
  }

  if (el.type === "rect") {
    const stroke = parseColor((props as Record<string, unknown>).color);
    const strokeWidthMm = typeof (props as Record<string, unknown>).stroke_width === "number"
      ? ((props as Record<string, number>).stroke_width as number)
      : 0.3;
    const fillRaw = (props as Record<string, unknown>).fill;
    const hasFill = typeof fillRaw === "string" && fillRaw !== "transparent" && fillRaw !== "none";
    ctx.page.drawRectangle({
      x: xPt,
      y: yPdfBottom,
      width: wPt,
      height: hPt,
      borderWidth: strokeWidthMm * PT_PER_MM,
      borderColor: stroke,
      ...(hasFill ? { color: parseColor(fillRaw) } : {}),
    });
    return;
  }

  if (el.type === "line") {
    const stroke = parseColor((props as Record<string, unknown>).color);
    const strokeWidthMm = typeof (props as Record<string, unknown>).stroke_width === "number"
      ? ((props as Record<string, number>).stroke_width as number)
      : 0.5;
    // h_mm typically 0 → horizontal line at top edge of box. Otherwise diagonal.
    const yTop = ctx.pageHeightPt - el.y_mm * PT_PER_MM;
    const yBottom = ctx.pageHeightPt - (el.y_mm + el.h_mm) * PT_PER_MM;
    ctx.page.drawLine({
      start: { x: xPt, y: yTop },
      end: { x: xPt + wPt, y: yBottom },
      thickness: strokeWidthMm * PT_PER_MM,
      color: stroke,
    });
    return;
  }

  if (el.type === "qr") {
    const url = (props as Record<string, unknown>).url;
    if (typeof url !== "string" || !url.trim()) return;
    // Render QR as PNG buffer at high enough resolution for print quality.
    const pngBuffer = await QRCode.toBuffer(url, {
      errorCorrectionLevel: "Q",
      margin: 0,
      scale: 16, // 16 px per module → very crisp at small print sizes
    });
    const png = await ctx.page.doc.embedPng(pngBuffer);
    ctx.page.drawImage(png, { x: xPt, y: yPdfBottom, width: wPt, height: hPt });
    return;
  }

  if (el.type === "page_number") {
    const sizePt = typeof (props as Record<string, unknown>).font_size_pt === "number"
      ? ((props as Record<string, number>).font_size_pt as number)
      : 5;
    const format = typeof (props as Record<string, unknown>).format === "string"
      ? ((props as Record<string, string>).format as string)
      : "{LANG} {n}/{N}";
    const color = parseColor((props as Record<string, unknown>).color ?? "#475569");
    const rendered = format
      .replace(/\{n\}/g, String(ctx.pageNumber))
      .replace(/\{N\}/g, String(ctx.totalPages))
      .replace(/\{lang\}/g, ctx.lang.toLowerCase())
      .replace(/\{LANG\}/g, ctx.lang.toUpperCase());
    const lineWidth = ctx.fontRegular.widthOfTextAtSize(rendered, sizePt);
    const drawX = xPt + (wPt - lineWidth) / 2; // center within box
    const drawY = yPdfBottom + (hPt - sizePt) / 2 + sizePt * 0.2; // approx vertical center
    ctx.page.drawText(rendered, { x: drawX, y: drawY, size: sizePt, font: ctx.fontRegular, color });
    return;
  }

  if (el.type === "image") {
    // Image library not yet wired into v4 — render a neutral placeholder so
    // the spot is visible but doesn't break the document.
    ctx.page.drawRectangle({
      x: xPt,
      y: yPdfBottom,
      width: wPt,
      height: hPt,
      borderWidth: 0.3,
      borderColor: rgb(0.7, 0.7, 0.7),
    });
    return;
  }
}

/** Builds the PDF and returns its bytes (Uint8Array, ready for response).
 *  Embeds Inter Regular + Bold from /public/fonts so glyphs match the editor. */
export async function exportProjectToPdf(
  data: ProjectExportData,
  lang: string,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // Try to load Inter from public/fonts. If it fails for any reason (file
  // missing in deployment), fall back to Helvetica so we always produce a PDF.
  let fontRegular: PDFFont;
  let fontBold: PDFFont;
  try {
    const regularPath = path.join(process.cwd(), "public", "fonts", "Inter-Regular.ttf");
    const boldPath = path.join(process.cwd(), "public", "fonts", "Inter-Bold.ttf");
    const [regularBytes, boldBytes] = await Promise.all([
      fs.readFile(regularPath),
      fs.readFile(boldPath),
    ]);
    fontRegular = await pdfDoc.embedFont(regularBytes, { subset: true });
    fontBold = await pdfDoc.embedFont(boldBytes, { subset: true });
  } catch (err) {
    console.warn("[v4 export] Inter not found, falling back to Helvetica:", err);
    fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  }

  pdfDoc.setTitle(`${data.name} (${lang.toUpperCase()})`);
  pdfDoc.setAuthor("Locon Sp. z o.o.");
  pdfDoc.setProducer("Generator Instrukcji v4");

  const totalPages = data.pages.length;
  for (const p of data.pages) {
    const widthPt = p.width_mm * PT_PER_MM;
    const heightPt = p.height_mm * PT_PER_MM;
    const page = pdfDoc.addPage([widthPt, heightPt]);
    const ctx: DrawContext = {
      page,
      pageHeightPt: heightPt,
      fontRegular,
      fontBold,
      pageNumber: p.page_number,
      totalPages,
      lang,
    };
    // Sort by z_index ascending so later-drawn elements layer on top.
    const sorted = [...p.elements].sort((a, b) => a.z_index - b.z_index);
    for (const el of sorted) {
      try {
        await drawElement(el, ctx, (e) => {
          // For text/callout: prefer translation when present, else original PL content.
          const props = e.properties as Record<string, unknown>;
          const original = typeof props.content === "string" ? props.content : "";
          if (e.type !== "text" && e.type !== "callout") return original;
          const translated = data.translations.get(e.id);
          return translated && translated.trim() ? translated : original;
        });
      } catch (err) {
        console.warn(`[v4 export] failed to draw element ${el.id} (${el.type}):`, err);
      }
    }
  }

  const bytes = await pdfDoc.save();
  return bytes;
}
