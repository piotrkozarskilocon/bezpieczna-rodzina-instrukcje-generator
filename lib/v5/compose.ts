import { z } from "zod";
import { callClaude, PREMIUM_MODEL } from "../anthropic";
import type { DeviceKB } from "./types";

/** Marker luki w treści — QA gate blokuje dokument, dopóki markery istnieją. */
export const GAP_MARKER = "«BRAK:";

/** Booklet walidujemy miękko: strukturę stron sprawdza renderer i QA;
 *  schemat wymusza tylko rdzeń kontraktu templates.js. */
export const BookletSchema = z.object({
  meta: z.object({
    documentId: z.string(),
    language: z.string(),
    languageLabel: z.string(),
    device: z.string(),
    title: z.string(),
    subtitle: z.string().optional(),
    pageSizeMm: z.object({ width: z.number(), height: z.number() }),
    revision: z.string().optional(),
  }),
  branding: z.object({ company: z.string() }).passthrough(),
  toc: z
    .object({
      title: z.string(),
      items: z.array(z.object({ label: z.string(), pageNumber: z.number() })),
    })
    .optional(),
  pages: z.array(z.record(z.string(), z.unknown())).min(4),
});
export type Booklet = z.infer<typeof BookletSchema>;

export interface ComposeInput {
  kb: DeviceKB;
  /** Gotowy booklet innego urządzenia jako szablon strukturalny (np. master PL GJD.16). */
  masterTemplate: Booklet;
  device: { documentId: string; modelCode: string; tradeName: string };
  language?: string;
}

export interface ComposeResult {
  booklet: Booklet;
  gaps: string[];
  inputTokens: number;
  outputTokens: number;
}

const COMPOSE_SYSTEM = `Jesteś redaktorem technicznym Locon. Tworzysz treść drukowanej skróconej
instrukcji (QSG) + karty gwarancyjnej smartwatcha/trackera GPS dla dzieci, na podstawie:
(1) SZABLONU — gotowego, zweryfikowanego w druku bookletu JSON innego urządzenia,
(2) BAZY WIEDZY (KB) — faktów o NOWYM urządzeniu wyekstrahowanych ze źródeł, z atrybucją.

ZASADY:
1. Zachowujesz strukturę szablonu: te same typy stron, te same klucze konfiguracji, ta sama
   kolejność. Booklet wynikowy musi renderować się w tym samym systemie szablonów.
2. Podmieniasz WSZYSTKIE treści specyficzne dla urządzenia (nazwy, model, funkcje, kroki,
   parametry, pasma, moce, SAR, bateria, zawartość zestawu) na dane z KB. NIGDY nie zostawiasz
   danych starego urządzenia z szablonu.
3. Fakty czerpiesz WYŁĄCZNIE z KB. Jeżeli KB nie zawiera danej wartości, wstawiasz marker
   «BRAK: opis.czego.brakuje» i wymieniasz go w polu gaps.
4. Stały tekst prawny szablonu (gwarancja, WEEE, utylizacja, bezpieczeństwo, CE, RODO) zachowujesz
   dosłownie, podmieniając jedynie nazwę/model urządzenia i wartości parametrów.
5. Strony kroków/funkcji możesz zduplikować lub pominąć, jeśli liczba kroków nowego urządzenia
   tego wymaga — zachowując kształt konfiguracji strony. Stron prawnych nie usuwasz.
6. Objętość tekstu na stronie ma być ZBLIŻONA do szablonu (±20%) — strony są małe (druk 72×72 mm)
   i nadmiar się nie zmieści.
7. Język: polski, naturalny, zwięzły, forma bezpośrednia („naciśnij", „przytrzymaj"). Terminy
   techniczne (Wi-Fi, GPS, LTE, dBm, W/kg, IP67) łacinką.
8. Aktualizujesz toc.items i displayNumber stron po zmianach liczby stron.
9. Zwracasz JSON: {"booklet": <kompletny booklet>, "gaps": ["ścieżka/opis braku", ...]}.`;

const ComposeOutSchema = z.object({
  booklet: BookletSchema,
  gaps: z.array(z.string()).default([]),
});

export async function composeQsg(input: ComposeInput): Promise<ComposeResult> {
  const res = await callClaude<z.infer<typeof ComposeOutSchema>>({
    model: PREMIUM_MODEL,
    maxTokens: 60000,
    system: COMPOSE_SYSTEM,
    user:
      `NOWE URZĄDZENIE: model Locon ${input.device.modelCode}, nazwa handlowa "${input.device.tradeName}", ` +
      `documentId="${input.device.documentId}", język=${input.language ?? "PL"}.\n\n` +
      `SZABLON (booklet istniejącego urządzenia):\n${JSON.stringify(input.masterTemplate)}\n\n` +
      `BAZA WIEDZY NOWEGO URZĄDZENIA:\n${JSON.stringify(stripQuotes(input.kb))}`,
    outputSchema: {
      name: "composed_booklet",
      description: "Booklet QSG dla nowego urządzenia + lista luk",
      schema: ComposeOutSchema,
    },
  });
  if (!res.parsed) throw new Error("Compose: brak sparsowanego wyniku");
  const gapsFromMarkers = scanGapMarkers(res.parsed.booklet);
  return {
    booklet: res.parsed.booklet,
    gaps: [...new Set([...res.parsed.gaps, ...gapsFromMarkers])],
    inputTokens: res.inputTokens ?? 0,
    outputTokens: res.outputTokens ?? 0,
  };
}

/** KB do promptu bez pól quote (oszczędność tokenów — cytaty nie są potrzebne
 *  do pisania treści, provenance zostaje w source_doc/locator). */
function stripQuotes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripQuotes);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "quote") continue;
      out[k] = stripQuotes(v);
    }
    return out;
  }
  return node;
}

export function scanGapMarkers(booklet: Booklet): string[] {
  const gaps: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const re = /«BRAK:([^»]*)»/g;
      let m;
      while ((m = re.exec(v))) gaps.push(m[1].trim());
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(booklet);
  return gaps;
}
