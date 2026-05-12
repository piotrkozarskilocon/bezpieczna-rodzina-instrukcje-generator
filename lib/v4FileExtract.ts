/**
 * Ekstrakcja tekstu z plików referencyjnych do uploadu do Anthropic Files API.
 *
 * Anthropic Files API beta akceptuje bezpośrednio: PDF, text/plain, markdown,
 * CSV, JSON, obrazki. NIE akceptuje DOCX ani XLSX — te musimy skonwertować
 * po stronie serwera.
 *
 * Strategia:
 *   - PDF                       → przekazujemy bez konwersji (AI czyta natywnie)
 *   - TXT / MD / CSV / JSON     → przekazujemy bez konwersji (już są tekstem)
 *   - DOCX                      → mammoth → plain text → .txt
 *   - XLSX                      → xlsx → CSV per sheet, łączone → .csv
 *   - inne                      → null (nie wgrywamy do AI)
 */

import mammoth from "mammoth";
import * as XLSX from "xlsx";

export interface PreparedFile {
  /** Bajty do wgrania do Anthropic Files API. Może być oryginałem (PDF,
   *  TXT, MD itd.) lub wygenerowanym tekstem (DOCX → TXT, XLSX → CSV). */
  bytes: Buffer;
  /** Nazwa pliku przekazywana do Anthropic. Może zmienić rozszerzenie gdy
   *  konwertujemy (np. raport.docx → raport.docx.txt). */
  filename: string;
  /** MIME pliku po konwersji (nie oryginału). */
  mimeType: string;
  /** Czy plik został skonwertowany (true) czy przesłany 1:1 (false). */
  converted: boolean;
}

const PDF = "application/pdf";
const TXT = "text/plain";
const MD = "text/markdown";
const CSV = "text/csv";
const JSON_MIME = "application/json";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** MIME types akceptowane przez upload — zaakceptujemy więcej, ale tylko
 *  niektóre da się synchronizować z AI. Inne lądują w storage bez Anthropic
 *  sync (user może je później pobrać/podejrzeć). */
export const ACCEPTED_MIME_TYPES = new Set([PDF, TXT, MD, CSV, JSON_MIME, DOCX, XLSX_MIME]);

export const ACCEPT_ATTRIBUTE = [
  ".pdf",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".docx",
  ".xlsx",
  PDF,
  TXT,
  MD,
  CSV,
  JSON_MIME,
  DOCX,
  XLSX_MIME,
].join(",");

/** Heurystyka — czasem przeglądarka nie ustawia MIME (zwłaszcza dla .md, .txt
 *  bez rejestracji). Spadamy na rozszerzenie pliku. */
export function guessMimeFromFilename(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop();
  switch (ext) {
    case "pdf": return PDF;
    case "txt": return TXT;
    case "md": return MD;
    case "csv": return CSV;
    case "json": return JSON_MIME;
    case "docx": return DOCX;
    case "xlsx": return XLSX_MIME;
    default: return null;
  }
}

/** Normalizuje MIME — gdy z przeglądarki przyszło "" albo coś dziwnego,
 *  zgadujemy po rozszerzeniu. */
export function normalizeMime(rawMime: string | null | undefined, filename: string): string | null {
  if (rawMime && ACCEPTED_MIME_TYPES.has(rawMime)) return rawMime;
  return guessMimeFromFilename(filename);
}

/** Przygotuj plik do uploadu do Anthropic Files API. Konwertuje DOCX/XLSX,
 *  resztę przepuszcza bez zmian. Rzuca błąd dla nieobsługiwanych typów. */
export async function prepareFileForAi(
  buf: Buffer,
  filename: string,
  mimeType: string,
): Promise<PreparedFile> {
  switch (mimeType) {
    case PDF:
    case TXT:
    case MD:
    case CSV:
    case JSON_MIME:
      // Bez konwersji.
      return { bytes: buf, filename, mimeType, converted: false };

    case DOCX: {
      const { value: text } = await mammoth.extractRawText({ buffer: buf });
      if (!text.trim()) {
        throw new Error("DOCX wygląda na pusty po ekstrakcji tekstu");
      }
      // Anthropic dostaje plain text. Zachowujemy oryginalną nazwę bazową +
      // .txt żeby było widać że to konwersja.
      const baseName = filename.replace(/\.docx$/i, "");
      return {
        bytes: Buffer.from(text, "utf-8"),
        filename: `${baseName}.docx.txt`,
        mimeType: TXT,
        converted: true,
      };
    }

    case XLSX_MIME: {
      // Każdy arkusz konwertujemy na CSV i łączymy z separatorem nagłówka,
      // żeby AI widział strukturę spreadsheeta (tabele cech technicznych,
      // listy parametrów modeli, BOM-y, listy SAR per częstotliwość).
      const wb = XLSX.read(buf, { type: "buffer" });
      const chunks: string[] = [];
      for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
        if (!csv.trim()) continue;
        chunks.push(`### Arkusz: ${sheetName}\n${csv}`);
      }
      if (chunks.length === 0) {
        throw new Error("XLSX nie zawiera danych w żadnym arkuszu");
      }
      const text = chunks.join("\n\n");
      const baseName = filename.replace(/\.xlsx$/i, "");
      return {
        bytes: Buffer.from(text, "utf-8"),
        filename: `${baseName}.xlsx.csv`,
        mimeType: CSV,
        converted: true,
      };
    }

    default:
      throw new Error(`nieobsługiwany typ pliku: ${mimeType}`);
  }
}
