import { promises as fs } from "node:fs";
import path from "node:path";
import type { Booklet } from "./compose";

// Vendorowany, zweryfikowany w druku system szablonów bookletów (KG_HANDOFF).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — moduł JS bez typów
import { renderPage } from "../../v5-vendor/src/templates.js";

const VENDOR_ROOT = path.join(process.cwd(), "v5-vendor");

/** Booklet JSON → pełny dokument HTML (odpowiednik v5-vendor/src/render.js). */
export function bookletToHtml(booklet: Booklet): string {
  const { meta, branding, pages } = booklet;
  const tocItems = booklet.toc?.items ?? [];
  const pageMarkup = pages
    .map((page, index) =>
      renderPage({ meta, branding, page, pageNumber: index + 1, tocItems })
    )
    .join("\n");
  return `<!doctype html>
<html lang="${meta.language.toLowerCase()}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${meta.device} ${meta.language} booklet</title>
    <link rel="stylesheet" href="./print.css" />
    <style>
      :root {
        --page-width-mm: ${meta.pageSizeMm.width}mm;
        --page-height-mm: ${meta.pageSizeMm.height}mm;
      }
    </style>
  </head>
  <body>
    ${pageMarkup}
  </body>
</html>`;
}

/** Zapisuje HTML + print.css + assets do katalogu wyjściowego. */
export async function writeHtmlBundle(booklet: Booklet, outDir: string): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(
    path.join(VENDOR_ROOT, "src", "styles", "print.css"),
    path.join(outDir, "print.css")
  );
  await fs.cp(path.join(VENDOR_ROOT, "assets"), path.join(outDir, "assets"), {
    recursive: true,
    force: true,
  });
  const htmlPath = path.join(outDir, `${booklet.meta.documentId}.html`);
  await fs.writeFile(htmlPath, bookletToHtml(booklet), "utf8");
  return htmlPath;
}

export interface PageOverflow {
  pageIndex: number;
  label: string;
  overflowPx: number;
}

export interface RenderPdfResult {
  pdfPath: string;
  pageCount: number;
  overflows: PageOverflow[];
}

/** HTML → PDF przez Chromium (Playwright lokalnie; na Vercelu podmienialne na
 *  puppeteer-core + @sparticuz/chromium — ten sam protokół CDP). Przy okazji
 *  mierzy w DOM przepełnienia stron — deterministyczny sygnał dla QA. */
export async function renderPdf(
  htmlPath: string,
  booklet: Booklet,
  pdfPath: string
): Promise<RenderPdfResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { chromium } = require("playwright") as typeof import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
    const overflows = (await page.evaluate(() => {
      const out: Array<{ pageIndex: number; label: string; overflowPx: number }> = [];
      document.querySelectorAll<HTMLElement>(".page").forEach((el, i) => {
        const overflow = Math.max(
          el.scrollHeight - el.clientHeight,
          el.scrollWidth - el.clientWidth
        );
        if (overflow > 1) {
          out.push({
            pageIndex: i,
            label: el.querySelector(".page-label")?.textContent?.trim() ?? `page ${i + 1}`,
            overflowPx: overflow,
          });
        }
      });
      return out;
    })) as PageOverflow[];

    await page.pdf({
      path: pdfPath,
      width: `${booklet.meta.pageSizeMm.width}mm`,
      height: `${booklet.meta.pageSizeMm.height}mm`,
      printBackground: true,
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
      preferCSSPageSize: true,
    });
    await page.close();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PDFDocument } = require("pdf-lib") as typeof import("pdf-lib");
    const pdfBytes = await fs.readFile(pdfPath);
    const doc = await PDFDocument.load(pdfBytes);
    return { pdfPath, pageCount: doc.getPageCount(), overflows };
  } finally {
    await browser.close();
  }
}

/** Render stron HTML do PNG — do wizualnej inspekcji jakości. */
export async function renderPagePngs(
  htmlPath: string,
  outDir: string,
  pageIndexes: number[]
): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { chromium } = require("playwright") as typeof import("playwright");
  const browser = await chromium.launch({ headless: true });
  const paths: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
    await fs.mkdir(outDir, { recursive: true });
    for (const idx of pageIndexes) {
      const el = page.locator(`.page >> nth=${idx}`);
      const file = path.join(outDir, `page-${String(idx + 1).padStart(2, "0")}.png`);
      await el.screenshot({ path: file });
      paths.push(file);
    }
  } finally {
    await browser.close();
  }
  return paths;
}
