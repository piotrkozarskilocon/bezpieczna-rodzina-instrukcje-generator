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

import { PDFDocument, degrees, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
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
  imageBytes: Map<string, { bytes: Uint8Array; mime: string }>; // image_id → fetched data
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

  // Preload images: zbieramy wszystkie image_id z elementów typu 'image',
  // pobieramy bytes z bucket (storage admin client — bez signed URL bo to
  // server-side). pdf-lib obsługuje natywnie PNG i JPG. WebP/GIF idą jako
  // placeholder z ramką (nie wspierane przez pdf-lib).
  const imageBytes = new Map<string, { bytes: Uint8Array; mime: string }>();
  const imageIdsFromElements: string[] = [];
  for (const el of elements ?? []) {
    if (el.type !== "image") continue;
    const props = el.properties as Record<string, unknown> | null;
    const id = typeof props?.image_id === "string" ? props.image_id : null;
    if (id && !imageBytes.has(id)) imageIdsFromElements.push(id);
  }
  if (imageIdsFromElements.length > 0) {
    const { data: images } = await sb
      .from("gen4_images")
      .select("id, path, mime_type")
      .in("id", imageIdsFromElements);
    for (const img of images ?? []) {
      try {
        const { data: blob, error } = await sb.storage
          .from("gen4-images")
          .download(img.path);
        if (error || !blob) continue;
        const buf = new Uint8Array(await blob.arrayBuffer());
        imageBytes.set(img.id, {
          bytes: buf,
          mime: img.mime_type ?? blob.type ?? "image/png",
        });
      } catch (err) {
        console.warn(`[v4 export] failed to download image ${img.id}:`, err);
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
    imageBytes,
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
  /** Wysokość obszaru treści (bez bleed) — używana w konwersji Y-from-top → bottom. */
  pageHeightPt: number;
  fontRegular: PDFFont;
  fontBold: PDFFont;
  pageNumber: number;
  totalPages: number;
  lang: string;
  imageBytes: Map<string, { bytes: Uint8Array; mime: string }>;
  /** Offset rysowania od dolnej-lewej krawędzi fizycznej strony PDF.
   *  Gdy bleed=0 → 0/0. Gdy bleed=3mm → bleedPt/bleedPt. */
  offsetXPt: number;
  offsetYPt: number;
}

/** Render one element. Returns nothing — direct draw on the page. */
async function drawElement(
  el: ElementRow,
  ctx: DrawContext,
  resolveText: (el: ElementRow) => string,
): Promise<void> {
  const props = el.properties ?? {};
  // Globalne offsety z bleed/crop marks dodajemy do każdej współrzędnej x/y.
  const xPt = el.x_mm * PT_PER_MM + ctx.offsetXPt;
  const wPt = el.w_mm * PT_PER_MM;
  const hPt = el.h_mm * PT_PER_MM;
  const yPdfBottom = mmYTopToPdfBottom(el.y_mm, el.h_mm, ctx.pageHeightPt) + ctx.offsetYPt;

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
    let cursorY = ctx.pageHeightPt - el.y_mm * PT_PER_MM - sizePt + ctx.offsetYPt; // baseline of first line, with bleed offset
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
    // Linia rysowana między dwoma punktami procentowymi wewnątrz bounding boxa
    // (faza 2c — pozwala na pion/skos/poziom). Fallback dla starych linii bez
    // x1_pct/y1_pct: pozioma na środku bounding boxa.
    const p = props as Record<string, unknown>;
    const x1Pct = typeof p.x1_pct === "number" ? p.x1_pct : 0;
    const y1Pct = typeof p.y1_pct === "number" ? p.y1_pct : 50;
    const x2Pct = typeof p.x2_pct === "number" ? p.x2_pct : 100;
    const y2Pct = typeof p.y2_pct === "number" ? p.y2_pct : 50;
    // Konwersja procentów na px w bounding boxie, z mm w punktach PDF.
    const x1Pt = xPt + (x1Pct / 100) * wPt;
    const y1Pt = ctx.pageHeightPt - (el.y_mm + (y1Pct / 100) * el.h_mm) * PT_PER_MM + ctx.offsetYPt;
    const x2Pt = xPt + (x2Pct / 100) * wPt;
    const y2Pt = ctx.pageHeightPt - (el.y_mm + (y2Pct / 100) * el.h_mm) * PT_PER_MM + ctx.offsetYPt;
    ctx.page.drawLine({
      start: { x: x1Pt, y: y1Pt },
      end: { x: x2Pt, y: y2Pt },
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
    const imageId = typeof (props as Record<string, unknown>).image_id === "string"
      ? ((props as Record<string, string>).image_id as string)
      : null;
    const imgData = imageId ? ctx.imageBytes.get(imageId) : null;
    const fitMode = typeof (props as Record<string, unknown>).fit_mode === "string"
      ? ((props as Record<string, string>).fit_mode as string)
      : "contain";

    // Brak image_id lub nie udało się pobrać → placeholder z ramką (jak dotąd).
    if (!imgData) {
      ctx.page.drawRectangle({
        x: xPt,
        y: yPdfBottom,
        width: wPt,
        height: hPt,
        borderWidth: 0.3,
        borderColor: rgb(0.7, 0.7, 0.7),
      });
      // Krótki opis placeholderu jeśli AI go wpisał — żeby na druku
      // było widać czego brakuje.
      const placeholderDesc = (props as Record<string, unknown>).placeholder_description;
      if (typeof placeholderDesc === "string" && placeholderDesc.trim()) {
        const labelSize = 4.5;
        ctx.page.drawText(`📷 ${placeholderDesc}`, {
          x: xPt + 1,
          y: yPdfBottom + hPt / 2 - labelSize / 2,
          size: labelSize,
          font: ctx.fontRegular,
          color: rgb(0.5, 0.5, 0.5),
        });
      }
      return;
    }

    try {
      // pdf-lib obsługuje PNG i JPG natywnie. WebP/GIF → konwersja niewspierana,
      // próba embedJpg może paść — wtedy fallback do placeholderu.
      const mime = imgData.mime.toLowerCase();

      // grayscale: true → pre-process bytes przez sharp (desaturation).
      // pdf-lib nie ma natywnego grayscale filtera, robimy to przed embed.
      let processedBytes = imgData.bytes;
      const grayscaleRaw = (props as Record<string, unknown>).grayscale;
      const isGrayscale = grayscaleRaw === true || grayscaleRaw === "true" || grayscaleRaw === 1 || grayscaleRaw === "1";
      if (isGrayscale && (mime.includes("png") || mime.includes("jpeg") || mime.includes("jpg"))) {
        try {
          // Dynamic import — sharp jest ciezki (~30MB native bindings), nie chcemy
          // go ladowac przy kazdym imporcie v4Export.ts. Tylko gdy faktycznie
          // potrzebny do grayscale processing.
          const sharp = (await import("sharp")).default;
          processedBytes = await sharp(Buffer.from(imgData.bytes)).grayscale().toBuffer();
        } catch (sharpErr) {
          console.warn(`[v4Export] sharp grayscale failed, fallback do oryginalu:`, sharpErr);
          // Nie blokujemy exportu — gdy sharp padnie, lecimy z kolorowym obrazem.
        }
      }

      let img;
      if (mime.includes("png")) {
        img = await ctx.page.doc.embedPng(processedBytes);
      } else if (mime.includes("jpeg") || mime.includes("jpg")) {
        img = await ctx.page.doc.embedJpg(processedBytes);
      } else {
        // Niewspierany format → placeholder + tekst z mime
        ctx.page.drawRectangle({
          x: xPt, y: yPdfBottom, width: wPt, height: hPt,
          borderWidth: 0.3, borderColor: rgb(0.7, 0.7, 0.7),
        });
        ctx.page.drawText(`(format ${mime} niewspierany w PDF — przeglądnij obrazek do PNG/JPG)`, {
          x: xPt + 1, y: yPdfBottom + 1, size: 3.5,
          font: ctx.fontRegular, color: rgb(0.7, 0.4, 0.4),
        });
        return;
      }

      // fit_mode contain — dopasuj zachowując proporcje, wycentruj.
      // fit_mode cover — wypełnij box, możliwe przycięcie (pdf-lib nie ma
      // natywnego cropping, więc fallback do contain).
      const imgRatio = img.width / img.height;
      const boxRatio = wPt / hPt;
      let drawW = wPt;
      let drawH = hPt;
      let drawX = xPt;
      let drawY = yPdfBottom;
      if (fitMode === "contain" || fitMode === "cover") {
        if (imgRatio > boxRatio) {
          drawW = wPt;
          drawH = wPt / imgRatio;
          drawY = yPdfBottom + (hPt - drawH) / 2;
        } else {
          drawH = hPt;
          drawW = hPt * imgRatio;
          drawX = xPt + (wPt - drawW) / 2;
        }
      }
      // Opacity dla watermarkow — pdf-lib obsluguje natywnie przez parametr
      // opacity w drawImage. Wczesniej typeof === "number" upadalo do 1 gdy AI
      // zapisalo opacity jako string ("0.15") — watermark wychodzil na PDF
      // nieprzezroczystym. Number() coerce + jawny fallback dla null/undefined/""
      // (zeby nie wpadly w Number(null)=0 → niewidoczny).
      const rawOpacity = (props as Record<string, unknown>).opacity;
      const opacityNum =
        rawOpacity === undefined || rawOpacity === null || rawOpacity === ""
          ? 1
          : Number(rawOpacity);
      const opacity = Number.isFinite(opacityNum) ? Math.max(0, Math.min(1, opacityNum)) : 1;
      ctx.page.drawImage(img, {
        x: drawX,
        y: drawY,
        width: drawW,
        height: drawH,
        ...(opacity < 1 ? { opacity } : {}),
      });
    } catch (err) {
      console.warn(`[v4 export] embed image ${imageId} failed:`, err);
      ctx.page.drawRectangle({
        x: xPt, y: yPdfBottom, width: wPt, height: hPt,
        borderWidth: 0.3, borderColor: rgb(0.7, 0.7, 0.7),
      });
    }
    return;
  }
}

export interface ExportOptions {
  /** Gdy true, każda strona dostaje semi-transparent watermark 'DRAFT'
   *  przekątnie — chroni przed wysłaniem niezatwierdzonego dokumentu do drukarni. */
  watermarkDraft?: boolean;
  /** Stopka 'Zatwierdzono: [imię] [data]' na każdej stronie — gdy projekt
   *  ma approved_by + approved_at, eksport może je dodać do PDF. */
  approvedBy?: string;
  approvedAt?: string;
  /** Bleed dla druku profesjonalnego (mm). Typowo 3mm. Gdy > 0, strona PDF
   *  jest powiększona o 2*bleed, treść przesunięta o bleed do środka. */
  bleedMm?: number;
  /** Crop marks (znaczniki obcinania) w narożnikach — działa razem z bleed. */
  cropMarks?: boolean;
  /** Fold marks (znaczniki składania) — dla stron rozkładanych (szer >= 2× wys
   *  lub wys >= 2× szer) rysuje cienką kreskę w środku osi krótszego boku. */
  foldMarks?: boolean;
}

/** Builds the PDF and returns its bytes (Uint8Array, ready for response).
 *  Embeds Inter Regular + Bold from /public/fonts so glyphs match the editor. */
export async function exportProjectToPdf(
  data: ProjectExportData,
  lang: string,
  options?: ExportOptions,
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
    // subset: false — pelne embedding fontu. Z subset=true pdf-lib/fontkit
    // psul Unicode→glyph mapping dla polskich diakrytykow: litery renderowaly
    // sie jako pojedyncze rozsypane glyphs zamiast spojnych slow + 'fi'
    // ligatury zamiast wlasciwych znakow. Tradeoff: PDF ~1MB wiekszy (font
    // ~300KB × 2 wagi embedded w pelni), ale rendering jest POPRAWNY.
    fontRegular = await pdfDoc.embedFont(regularBytes);
    fontBold = await pdfDoc.embedFont(boldBytes);
  } catch (err) {
    console.warn("[v4 export] Inter not found, falling back to Helvetica:", err);
    fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  }

  pdfDoc.setTitle(`${data.name} (${lang.toUpperCase()})`);
  pdfDoc.setAuthor("Locon Sp. z o.o.");
  pdfDoc.setProducer("Generator Instrukcji v4");

  const totalPages = data.pages.length;
  // Bleed dla druku profesjonalnego. Gdy bleedMm > 0, strona PDF jest fizycznie
  // większa, treść przesunięta do środka — drukarnia obcina bleedMm z każdej
  // strony żeby uzyskać docelowy format.
  const bleedMm = Math.max(0, options?.bleedMm ?? 0);
  const bleedPt = bleedMm * PT_PER_MM;
  for (const p of data.pages) {
    const innerWidthPt = p.width_mm * PT_PER_MM;
    const innerHeightPt = p.height_mm * PT_PER_MM;
    // Strona PDF: docelowy format + 2*bleed na każdą oś.
    const widthPt = innerWidthPt + 2 * bleedPt;
    const heightPt = innerHeightPt + 2 * bleedPt;
    const page = pdfDoc.addPage([widthPt, heightPt]);

    const ctx: DrawContext = {
      page,
      // pageHeightPt = wysokość OBSZARU TREŚCI (bez bleed). drawElement używa
      // jej do konwersji Y-top→Y-bottom dla współrzędnych w mm, a osobny offset
      // (offsetYPt = bleedPt) przesuwa to wszystko do środka fizycznej strony.
      pageHeightPt: innerHeightPt,
      fontRegular,
      fontBold,
      pageNumber: p.page_number,
      totalPages,
      lang,
      imageBytes: data.imageBytes,
      offsetXPt: bleedPt,
      offsetYPt: bleedPt,
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

    // Watermark DRAFT po wszystkich elementach (na wierzchu). Tekst przekątnie
    // 45° w bladoszarym kolorze, żeby był widoczny ale nie blokował druku
    // korekt podczas review.
    // Stopka 'Zatwierdzono' — w lewym dolnym rogu strony (poza marginesem
    // treści, w bleed area lub blisko krawędzi). Bardzo mały font.
    if (options?.approvedBy) {
      const stamp = `Zatwierdzono: ${options.approvedBy}${options.approvedAt ? ` • ${new Date(options.approvedAt).toLocaleDateString("pl-PL")}` : ""}`;
      page.drawText(stamp, {
        x: bleedPt + 1,
        y: bleedPt + 1.2,
        size: 3.5,
        font: fontRegular,
        color: rgb(0.4, 0.4, 0.4),
      });
    }

    if (options?.watermarkDraft) {
      const text = "DRAFT";
      const wmSize = Math.min(widthPt, heightPt) * 0.25;
      const textW = fontBold.widthOfTextAtSize(text, wmSize);
      page.drawText(text, {
        x: (widthPt - textW * Math.cos(Math.PI / 4)) / 2,
        y: heightPt / 2 - wmSize / 2,
        size: wmSize,
        font: fontBold,
        color: rgb(0.85, 0.4, 0.4),
        opacity: 0.18,
        rotate: degrees(45),
      });
    }

    // Fold marks — dla stron rozkładanych (np. 152×76) cienka pionowa lub
    // pozioma kreska w środku osi krótszego wymiaru. Wystaje 1-2mm na bleed.
    if (options?.foldMarks) {
      const innerW = innerWidthPt;
      const innerH = innerHeightPt;
      const isWideFold = innerW >= 1.8 * innerH; // pozioma składa (np. 152×76)
      const isTallFold = innerH >= 1.8 * innerW;
      if (isWideFold) {
        // Pionowa kreska w środku osi X
        const midX = bleedPt + innerW / 2;
        const overshoot = Math.min(bleedPt * 0.5, 3);
        page.drawLine({
          start: { x: midX, y: bleedPt - overshoot },
          end: { x: midX, y: bleedPt + innerH + overshoot },
          thickness: 0.2,
          color: rgb(0.5, 0.5, 0.5),
          dashArray: [2, 2],
        });
      } else if (isTallFold) {
        // Pozioma kreska w środku osi Y
        const midY = bleedPt + innerH / 2;
        const overshoot = Math.min(bleedPt * 0.5, 3);
        page.drawLine({
          start: { x: bleedPt - overshoot, y: midY },
          end: { x: bleedPt + innerW + overshoot, y: midY },
          thickness: 0.2,
          color: rgb(0.5, 0.5, 0.5),
          dashArray: [2, 2],
        });
      }
    }

    // Crop marks — cienkie czarne linie w narożnikach pokazujące gdzie
    // drukarnia ma obcinać. Wymaga bleed > 0 (musi być miejsce na rysowanie).
    if (options?.cropMarks && bleedPt > 0) {
      const markLen = Math.min(bleedPt * 0.8, 4); // długość kreski w pt, max ~1.4 mm
      const gap = bleedPt * 0.2; // odstęp między rogiem treści a kreską
      const sw = 0.3; // stroke width w pt
      const cornerColor = rgb(0, 0, 0);
      // Narożniki w układzie fizycznej strony (0..widthPt, 0..heightPt):
      const innerL = bleedPt;
      const innerR = bleedPt + innerWidthPt;
      const innerB = bleedPt;
      const innerT = bleedPt + innerHeightPt;
      // 4 narożniki × 2 linie (pionowa + pozioma).
      const corners: Array<{ x: number; y: number; sx: number; sy: number }> = [
        { x: innerL, y: innerB, sx: -1, sy: -1 }, // lewy dolny
        { x: innerR, y: innerB, sx: 1, sy: -1 }, // prawy dolny
        { x: innerL, y: innerT, sx: -1, sy: 1 }, // lewy górny
        { x: innerR, y: innerT, sx: 1, sy: 1 }, // prawy górny
      ];
      for (const c of corners) {
        // Pozioma kreska wystająca w bleed (od x±gap do x±(gap+markLen)).
        page.drawLine({
          start: { x: c.x + c.sx * gap, y: c.y },
          end: { x: c.x + c.sx * (gap + markLen), y: c.y },
          thickness: sw,
          color: cornerColor,
        });
        // Pionowa kreska wystająca w bleed.
        page.drawLine({
          start: { x: c.x, y: c.y + c.sy * gap },
          end: { x: c.x, y: c.y + c.sy * (gap + markLen) },
          thickness: sw,
          color: cornerColor,
        });
      }
    }
  }

  const bytes = await pdfDoc.save();
  return bytes;
}
