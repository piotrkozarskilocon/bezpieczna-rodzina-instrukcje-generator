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

import { PDFDocument, ParseSpeeds } from "pdf-lib";

export const MAX_PAGES_PER_CHUNK = 400;

/** Probuje zaladowac PDF z eskalujacymi tolerancjami parsera. Niektore PDFy
 *  (np. zapisane przez chinskie narzedzia testowe RF) maja niestandardowe
 *  struktury i strict pdf-lib rzuca "Expected instance of e, but got
 *  instance of undefined". */
async function loadPdfTolerant(buf: Buffer): Promise<PDFDocument> {
  const attempts: Array<Parameters<typeof PDFDocument.load>[1]> = [
    { ignoreEncryption: true },
    { ignoreEncryption: true, throwOnInvalidObject: false },
    { ignoreEncryption: true, throwOnInvalidObject: false, parseSpeed: ParseSpeeds.Fastest },
    { ignoreEncryption: true, throwOnInvalidObject: false, parseSpeed: ParseSpeeds.Fastest, updateMetadata: false, capNumbers: true },
  ];
  let lastErr: unknown = null;
  for (const opts of attempts) {
    try {
      return await PDFDocument.load(buf, opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("pdf-lib: nie udalo sie zaladowac");
}

export interface PdfChunk {
  /** 1-indexed page range, inclusive */
  startPage: number;
  endPage: number;
  bytes: Buffer;
}

/** Zwraca liczbe stron PDF bez pelnego ladowania (do decyzji czy chunkowac).
 *  Fallback: regex po '/Count NNN' w raw PDF gdy pdf-lib nie chce zaladowac. */
export async function countPdfPages(buf: Buffer): Promise<number> {
  try {
    const pdf = await loadPdfTolerant(buf);
    return pdf.getPageCount();
  } catch {
    // Heurystyka raw: szukaj '/Type /Pages\n/Count NNN' w pliku.
    // PDF spec: gdy '/Type /Pages' to root Pages obiekt, '/Count' to liczba stron.
    const text = buf.toString("latin1");
    const matches = Array.from(text.matchAll(/\/Type\s*\/Pages[^]*?\/Count\s+(\d+)/g));
    if (matches.length === 0) {
      throw new Error("pdf-lib load failed, raw '/Count' tez nie znaleziono");
    }
    // Bierzemy MAX z dopasowan — top-level Pages tree zwykle ma najwiekszy Count.
    return Math.max(...matches.map((m) => parseInt(m[1], 10) || 0));
  }
}

/** Dzieli PDF na chunki po max `maxPagesPerChunk` stron.
 *  Jezeli total <= maxPagesPerChunk, zwraca [oryginal] bez kopiowania. */
export async function chunkPdf(
  buf: Buffer,
  maxPagesPerChunk: number = MAX_PAGES_PER_CHUNK,
): Promise<PdfChunk[]> {
  const source = await loadPdfTolerant(buf);
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
