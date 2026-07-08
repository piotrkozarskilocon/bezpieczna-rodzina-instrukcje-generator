import { promises as fs } from "node:fs";
import { PDFDocument, ParseSpeeds } from "pdf-lib";
import { callClaude, PREMIUM_MODEL } from "../anthropic";
import { prepareFileForAi, normalizeMime } from "../v4FileExtract";
import { extractPdfText } from "../v4PdfChunk";
import { DeviceKBSchema, type DeviceKB } from "./types";

/** Anthropic PDF (inline base64): limit ~100 stron i ~30 MB requestu.
 *  Duże raporty tniemy: istotne treści są na początku (tabele wyników, dane
 *  urządzenia) i na końcu (chińskie manuale trzymają moce nadawania
 *  i ostrzeżenia na ostatnich stronach). */
const HEAD_PAGES = 60;
const TAIL_PAGES = 12;
const MAX_WHOLE_PAGES = 90;
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

/** pdf-lib z eskalującymi tolerancjami — chińskie narzędzia labowe produkują
 *  PDF-y z niestandardowymi strukturami (wzór: v4PdfChunk.loadPdfTolerant). */
async function loadPdfTolerant(buf: Buffer): Promise<PDFDocument> {
  const attempts: Array<Parameters<typeof PDFDocument.load>[1]> = [
    { ignoreEncryption: true },
    { ignoreEncryption: true, throwOnInvalidObject: false },
    { ignoreEncryption: true, throwOnInvalidObject: false, parseSpeed: ParseSpeeds.Fastest },
    {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      parseSpeed: ParseSpeeds.Fastest,
      updateMetadata: false,
      capNumbers: true,
    },
  ];
  let lastErr: unknown = null;
  for (const opts of attempts) {
    try {
      return await PDFDocument.load(buf, opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("pdf-lib: nie udało się załadować");
}

async function slicePdf(buf: Buffer): Promise<{ out: Buffer; note: string } | null> {
  const src = await loadPdfTolerant(buf);
  const total = src.getPageCount();
  if (total <= MAX_WHOLE_PAGES && buf.length <= MAX_INLINE_BYTES) return null;
  const out = await PDFDocument.create();
  const head = Array.from({ length: Math.min(HEAD_PAGES, total) }, (_, i) => i);
  const tail = Array.from({ length: TAIL_PAGES }, (_, i) => total - TAIL_PAGES + i);
  const idx = [...new Set([...head, ...tail])].filter((i) => i >= 0 && i < total).sort((a, b) => a - b);
  const pages = await out.copyPages(src, idx);
  pages.forEach((p) => out.addPage(p));
  return {
    out: Buffer.from(await out.save()),
    note: `Dokument ma ${total} stron; załączono strony 1–${Math.min(HEAD_PAGES, total)} oraz ${
      total - TAIL_PAGES + 1
    }–${total}.`,
  };
}

export interface ClaudeExtractInput {
  name: string;
  localPath: string;
  mimeType: string;
  system: string;
  user: string;
}

export interface ClaudeExtractResult {
  fragment: DeviceKB;
  inputTokens: number;
  outputTokens: number;
}

/** Ekstrakcja przez Claude: PDF jako inline base64 document block (z przycięciem
 *  >90 stron), DOCX/XLSX/tekst jako tekst w prompcie. Structured output przez
 *  tool_use. Fallback dla nieparsowalnych PDF-ów: pdf-parse → tekst. */
export async function extractWithClaude(input: ClaudeExtractInput): Promise<ClaudeExtractResult> {
  const mime = normalizeMime(input.mimeType, input.name) ?? input.mimeType;
  const bytes = await fs.readFile(input.localPath);

  let inlineDocuments: Array<{ name: string; mediaType: string; dataBase64: string }> | undefined;
  let user = input.user;

  if (mime === "application/pdf") {
    try {
      const sliced = await slicePdf(bytes);
      const toSend = sliced?.out ?? bytes;
      if (sliced) user += `\n\nUWAGA: ${sliced.note}`;
      if (toSend.length > MAX_INLINE_BYTES) throw new Error("PDF za duży po przycięciu");
      inlineDocuments = [
        { name: input.name, mediaType: "application/pdf", dataBase64: toSend.toString("base64") },
      ];
    } catch {
      // PDF nie do naprawienia strukturalnie — ratujemy samą warstwę tekstową.
      const { text, numpages } = await extractPdfText(bytes);
      user +=
        `\n\nUWAGA: PDF nieparsowalny — poniżej sama warstwa tekstowa (${numpages} stron, ` +
        `bez tabel/obrazów):\n${text.slice(0, 350_000)}`;
    }
  } else if (mime.startsWith("image/")) {
    inlineDocuments = [{ name: input.name, mediaType: mime, dataBase64: bytes.toString("base64") }];
  } else {
    const prepared = await prepareFileForAi(bytes, input.name, mime);
    user += `\n\nZAWARTOŚĆ DOKUMENTU (skonwertowana na tekst):\n${prepared.bytes
      .toString("utf8")
      .slice(0, 350_000)}`;
  }

  const res = await callClaude<DeviceKB>({
    model: PREMIUM_MODEL,
    maxTokens: 32000,
    system: input.system,
    user,
    inlineDocuments,
    outputSchema: {
      name: "kb_fragment",
      description: "Fragment bazy wiedzy o urządzeniu wyekstrahowany z dokumentu",
      schema: DeviceKBSchema,
    },
  });
  if (!res.parsed) throw new Error(`Claude: brak sparsowanego fragmentu dla ${input.name}`);
  return {
    fragment: res.parsed,
    inputTokens: res.inputTokens ?? 0,
    outputTokens: res.outputTokens ?? 0,
  };
}
