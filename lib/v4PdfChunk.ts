/**
 * Helper do dzielenia duzych PDF-ow na mniejsze chunki ktore mieszcza sie
 * w limitach AI providerow:
 *   - Gemini 2.5 Flash: max 1000 stron i ~1M tokenow input
 *   - Anthropic Claude:  max 100 stron PDF
 *
 * Bezpieczna wielkosc chunka = 400 stron (zostawia margines tokenow).
 * Konwencja: kazdy chunk zachowuje oryginalne strony N..M, byle nie przekracza
 * MAX_PAGES_PER_CHUNK. Caller wywoluje AI per chunk, agreguje summaries
 * z prefixem 'Strony N-M:'.
 */

import { PDFDocument } from "pdf-lib";

export const MAX_PAGES_PER_CHUNK = 400;

export interface PdfChunk {
  /** 1-indexed page range, inclusive */
  startPage: number;
  endPage: number;
  bytes: Buffer;
}

/** Zwraca liczbe stron PDF bez pelnego ladowania (do decyzji czy chunkowac). */
export async function countPdfPages(buf: Buffer): Promise<number> {
  const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
  return pdf.getPageCount();
}

/** Dzieli PDF na chunki po max `maxPagesPerChunk` stron.
 *  Jezeli total <= maxPagesPerChunk, zwraca [oryginal] bez kopiowania. */
export async function chunkPdf(
  buf: Buffer,
  maxPagesPerChunk: number = MAX_PAGES_PER_CHUNK,
): Promise<PdfChunk[]> {
  const source = await PDFDocument.load(buf, { ignoreEncryption: true });
  const totalPages = source.getPageCount();

  if (totalPages <= maxPagesPerChunk) {
    return [{ startPage: 1, endPage: totalPages, bytes: buf }];
  }

  const chunks: PdfChunk[] = [];
  for (let start = 0; start < totalPages; start += maxPagesPerChunk) {
    const end = Math.min(start + maxPagesPerChunk, totalPages);
    const out = await PDFDocument.create();
    // Page indices 0-based array.
    const indices: number[] = [];
    for (let i = start; i < end; i++) indices.push(i);
    const copiedPages = await out.copyPages(source, indices);
    for (const p of copiedPages) out.addPage(p);
    const bytes = Buffer.from(await out.save());
    chunks.push({
      startPage: start + 1,
      endPage: end,
      bytes,
    });
  }
  return chunks;
}
