import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { countPdfPages, chunkPdf, MAX_PAGES_PER_CHUNK, extractPdfText } from "./v4PdfChunk";

async function buildPdf(numPages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < numPages; i++) {
    const page = doc.addPage([595, 842]); // A4 portrait
    page.drawText(`Page ${i + 1}`, { x: 50, y: 700, size: 14 });
  }
  return Buffer.from(await doc.save());
}

describe("v4PdfChunk", () => {
  it("countPdfPages: zwraca poprawny page count dla 5-stronicowego PDF", async () => {
    const buf = await buildPdf(5);
    const count = await countPdfPages(buf);
    expect(count).toBe(5);
  });

  it("countPdfPages: zwraca poprawny page count dla 1-stronicowego PDF", async () => {
    const buf = await buildPdf(1);
    const count = await countPdfPages(buf);
    expect(count).toBe(1);
  });

  it("MAX_PAGES_PER_CHUNK = 400", () => {
    expect(MAX_PAGES_PER_CHUNK).toBe(400);
  });

  it("chunkPdf: zwraca [oryginal] gdy total <= maxPagesPerChunk", async () => {
    const buf = await buildPdf(10);
    const chunks = await chunkPdf(buf, 400);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startPage).toBe(1);
    expect(chunks[0].endPage).toBe(10);
    expect(chunks[0].bytes).toBe(buf); // ten sam buffer (no copy)
  });

  it("chunkPdf: dzieli 5-stron PDF na chunki po 2 strony", async () => {
    const buf = await buildPdf(5);
    const chunks = await chunkPdf(buf, 2);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ startPage: 1, endPage: 2 });
    expect(chunks[1]).toMatchObject({ startPage: 3, endPage: 4 });
    expect(chunks[2]).toMatchObject({ startPage: 5, endPage: 5 });
    // Każdy chunk to nowy PDF buffer
    for (const c of chunks) {
      expect(c.bytes.length).toBeGreaterThan(100);
      // Pierwsze 4 bajty muszą być %PDF
      expect(c.bytes.subarray(0, 4).toString()).toBe("%PDF");
    }
  });

  it("chunkPdf: chunked PDF jest valid (countPdfPages na chunkach)", async () => {
    const buf = await buildPdf(7);
    const chunks = await chunkPdf(buf, 3);
    expect(chunks).toHaveLength(3); // 3+3+1
    const c0 = await countPdfPages(chunks[0].bytes);
    const c1 = await countPdfPages(chunks[1].bytes);
    const c2 = await countPdfPages(chunks[2].bytes);
    expect(c0).toBe(3);
    expect(c1).toBe(3);
    expect(c2).toBe(1);
  });

  it("countPdfPages: fallback na raw bytes — rzuca error gdy nie PDF", async () => {
    const garbage = Buffer.from("not a pdf, random bytes");
    await expect(countPdfPages(garbage)).rejects.toThrow();
  });

  it.skip("extractPdfText: zwraca text + numpages dla prostego PDF (pdf-parse v1 nie obsluguje PDFs z pdf-lib — wymaga real PDF fixture)", async () => {
    const buf = await buildPdf(2);
    const result = await extractPdfText(buf);
    expect(result.numpages).toBe(2);
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
  });
});
