import { ClassifyResultSchema, type ClassifyResult, type SourceKind } from "./types";
import { callGeminiWithFiles, uploadToGemini, V5_GEMINI_FLASH } from "./gemini";

/** Deterministyczne reguły po nazwie pliku — pokrywają typowe nazewnictwo
 *  dostawców (chińskie laby, Locon). Kolejność ma znaczenie: pierwsza wygrywa. */
const NAME_RULES: Array<{ re: RegExp; kind: SourceKind }> = [
  { re: /appendix|blocking|extreme|normal/i, kind: "rf_test_report" },
  { re: /sar/i, kind: "sar_report" },
  { re: /nb证书|red evaluation/i, kind: "nb_certificate" },
  { re: /emc/i, kind: "emc_test_report" },
  { re: /safety/i, kind: "safety_test_report" },
  { re: /rohs|reach/i, kind: "rohs_reach" },
  { re: /risk\s*assessment|风险/i, kind: "risk_assessment" },
  { re: /declaration|deklaracja|doc文件/i, kind: "declaration_ce" },
  { re: /nb证书|certificate|certyfikat|evaluation/i, kind: "nb_certificate" },
  { re: /protocol|protokół|通讯协议/i, kind: "protocol_spec" },
  { re: /eut\s*photo|photo|zdjęci/i, kind: "product_photos" },
  { re: /funkcj\w*\s*ai|ai\s*functions?|feature/i, kind: "feature_guide" },
  { re: /manual|instrukcja|说明书|user\s*guide/i, kind: "manufacturer_manual" },
  { re: /spec|ksp|quotation/i, kind: "tech_spec" },
  { re: /screen|zrzut/i, kind: "app_screens" },
  // chińskie raporty laboratoryjne RF podpisane pieczęcią (已签章): WIFI/2G/3G/4G/GPS
  { re: /已签章|wifi\s*2\.4|test\s*report/i, kind: "rf_test_report" },
];

const LANG_HINTS: Array<{ re: RegExp; lang: string }> = [
  { re: /[一-鿿]/, lang: "zh" },
  { re: /instrukcja|deklaracja|zdjęci/i, lang: "pl" },
];

function guessByName(name: string): { kind: SourceKind; language: string } | null {
  const rule = NAME_RULES.find((r) => r.re.test(name));
  if (!rule) return null;
  const lang = LANG_HINTS.find((h) => h.re.test(name))?.lang ?? "en";
  return { kind: rule.kind, language: lang };
}

function kindByMime(mime: string): SourceKind | null {
  if (mime.startsWith("image/")) return "product_photos";
  if (mime.startsWith("video/")) return "app_video";
  if (mime.includes("spreadsheetml")) return "tech_spec";
  return null;
}

/** Klasyfikacja pliku: najpierw reguły (nazwa/mime), fallback Gemini Flash
 *  z samym plikiem. `localPath` potrzebny tylko dla fallbacku AI. */
export async function classifySourceFile(input: {
  name: string;
  mimeType: string;
  localPath?: string;
}): Promise<ClassifyResult> {
  const byMimeKind = kindByMime(input.mimeType);
  const byName = guessByName(input.name);
  if (byName) {
    return {
      kind: byMimeKind === "product_photos" && byName.kind !== "app_screens" ? byMimeKind : byName.kind,
      language: byName.language,
      summary_pl: `Sklasyfikowano po nazwie pliku: ${byName.kind}`,
    };
  }
  if (byMimeKind) {
    return { kind: byMimeKind, language: "und", summary_pl: `Sklasyfikowano po MIME: ${byMimeKind}` };
  }
  if (!input.localPath || !process.env.GEMINI_API_KEY) {
    return {
      kind: "other",
      language: "und",
      summary_pl: "Brak reguły dopasowania (fallback AI niedostępny) — kind=other",
    };
  }
  const file = await uploadToGemini(input.localPath, input.mimeType, input.name);
  const res = await callGeminiWithFiles({
    model: V5_GEMINI_FLASH,
    system:
      "Klasyfikujesz dokumenty źródłowe dot. urządzeń GPS/smartwatchy (materiały od producenta, " +
      "raporty badań, dokumenty zgodności UE). Odpowiadasz wyłącznie JSON-em.",
    user:
      `Sklasyfikuj załączony plik "${input.name}". Zwróć JSON zgodny ze schematem:\n` +
      `{"kind": jedno z ${JSON.stringify(ClassifyResultSchema.shape.kind.options)}, ` +
      `"language": kod ISO 639-1 głównego języka, "device_hint": model urządzenia jeśli widoczny, ` +
      `"summary_pl": "1-2 zdania po polsku"}`,
    files: [file],
    schema: ClassifyResultSchema,
  });
  return res.parsed!;
}
