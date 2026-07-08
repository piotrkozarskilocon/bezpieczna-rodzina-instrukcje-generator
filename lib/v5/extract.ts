import { promises as fs } from "node:fs";
import { z } from "zod";
import { DeviceKBSchema, KIND_DEPTH, type DeviceKB, type SourceKind } from "./types";
import { callGeminiWithFiles, uploadToGemini, V5_GEMINI_PRO } from "./gemini";
import { prepareFileForAi, normalizeMime } from "../v4FileExtract";

/** Na czym skupić ekstrakcję danego rodzaju źródła (koszt vs wartość). */
const KIND_FOCUS: Partial<Record<SourceKind, string>> = {
  manufacturer_manual:
    "WSZYSTKO istotne dla użytkownika końcowego: funkcje i jak z nich korzystać (how_to_pl), " +
    "obsługa przycisków/portów, ładowanie, parowanie z aplikacją (app_flow.pairing_steps), " +
    "ostrzeżenia bezpieczeństwa (safety, zwykle na końcu — w tym maks. moc nadawania i teksty " +
    "ostrzegawcze), parametry techniczne, zawartość opakowania.",
  feature_guide:
    "Funkcje urządzenia (features): nazwa, opis, kroki użycia. Także wymagania aplikacji.",
  tech_spec:
    "Parametry sprzętowe (hardware.*), pasma radiowe z mocami jeśli podane (radio.bands), " +
    "pozycjonowanie (GPS/LBS/WiFi), SIM, bateria, IP rating, wymiary, waga, wyświetlacz, " +
    "sensory, zawartość opakowania, model producenta i kod Locon.",
  sar_report:
    "TYLKO: zmierzone wartości SAR (sar.results — pozycja pomiaru, pasmo, wartość W/kg, limit), " +
    "zastosowana norma (sar.standard), laboratorium (sar.lab), model badanego urządzenia " +
    "(identity.manufacturer_model). Ignoruj setki stron wykresów.",
  rf_test_report:
    "TYLKO: pasma częstotliwości i zmierzone maksymalne moce nadawania (radio.bands: tech, " +
    "freq_mhz, max_power). Model urządzenia. Ignoruj szczegóły procedur testowych.",
  emc_test_report: "TYLKO: normy EMC wg których badano i wynik (regulatory.standards). Model urządzenia.",
  safety_test_report:
    "TYLKO: normy bezpieczeństwa (np. EN 62368-1), wynik, parametry ładowania jeśli podane " +
    "(hardware.battery.charging), ostrzeżenia (safety).",
  declaration_ce:
    "Pełne dane deklaracji zgodności: producent z adresem (identity.manufacturer), typ/model, " +
    "wykaz norm (regulatory.standards), jednostka notyfikowana (regulatory.red_nb), " +
    "sygnatariusz (regulatory.doc_signatory), URL pełnej deklaracji jeśli podany (regulatory.doc_url).",
  nb_certificate: "TYLKO: jednostka notyfikowana, numer certyfikatu, zakres (regulatory.red_nb).",
  rohs_reach: "TYLKO: potwierdzenie zgodności RoHS/REACH, numery raportów (regulatory.rohs, regulatory.reach).",
  risk_assessment: "TYLKO: zidentyfikowane ryzyka wymagające ostrzeżeń użytkownika (safety).",
  product_photos:
    "Wygląd urządzenia: rozmieszczenie przycisków/portów (hardware.buttons_ports_pl), " +
    "elementy zestawu jeśli widoczne (package_contents).",
  app_screens:
    "Kroki flow w aplikacji (app_flow.pairing_steps) — co użytkownik robi ekran po ekranie. " +
    "Nazwa aplikacji (app_flow.app_name).",
  app_video:
    "Kroki flow w aplikacji (app_flow.pairing_steps) — sekwencja działań użytkownika z nagrania. " +
    "Nazwa aplikacji.",
  other: "Wszystko, co pasuje do schematu i może przydać się w instrukcji użytkownika.",
};

const KB_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(DeviceKBSchema));

function buildSystem(): string {
  return (
    "Jesteś ekspertem ds. dokumentacji technicznej urządzeń elektronicznych (smartwatche/trackery GPS " +
    "dla rodzin). Ekstrahujesz fakty ze źródłowych dokumentów producenta i raportów badań do " +
    "ustrukturyzowanej bazy wiedzy o urządzeniu.\n\n" +
    "ŻELAZNE ZASADY:\n" +
    "1. Ekstrahujesz WYŁĄCZNIE fakty obecne w dokumencie. Niczego nie zmyślasz, nie uzupełniasz z wiedzy ogólnej.\n" +
    "2. Każdy fakt ma provenance: sources=[{source_doc, locator (strona/arkusz), quote (krótki cytat " +
    "oryginału, w oryginalnym języku), confidence}].\n" +
    "3. Treści przeznaczone dla użytkownika (opisy, kroki, ostrzeżenia) piszesz od razu PO POLSKU — " +
    "tłumaczysz z chińskiego/angielskiego naturalnym, poprawnym językiem. Cytaty w quote zostają w oryginale.\n" +
    "4. Terminy techniczne (Wi-Fi, GPS, LTE, Band, dBm, W/kg, IP67, nano-SIM) zostają w formie łacińskiej.\n" +
    "5. Pola, których dokument nie pokrywa, POMIJASZ (nie wstawiasz pustych stringów ani null).\n" +
    "6. Zwracasz WYŁĄCZNIE JSON zgodny ze schematem, bez komentarzy."
  );
}

function buildUser(name: string, kind: SourceKind, extraContext?: string): string {
  const focus = KIND_FOCUS[kind] ?? KIND_FOCUS.other!;
  return (
    `Dokument: "${name}" (rodzaj: ${kind}).\n\nZAKRES EKSTRAKCJI: ${focus}\n\n` +
    (extraContext ? `KONTEKST: ${extraContext}\n\n` : "") +
    `Zwróć fragment bazy wiedzy jako JSON zgodny z tym schematem (wypełniaj tylko to, co jest w dokumencie):\n` +
    `${KB_JSON_SCHEMA}\n\n` +
    `W polu sources[].source_doc używaj dokładnie nazwy: "${name}".`
  );
}

export interface ExtractInput {
  name: string;
  localPath: string;
  mimeType: string;
  kind: SourceKind;
  /** np. "urządzenie: Lagenio K9 = Locon GJD.16" — pomaga przypisać model */
  deviceContext?: string;
}

export interface ExtractOutput {
  fragment: DeviceKB | null;
  skipped: boolean;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Ekstrakcja jednego pliku źródłowego → fragment DeviceKB z atrybucją.
 *  Routing: Gemini (gdy GEMINI_API_KEY) — PDF/obraz/wideo przez Files API;
 *  w przeciwnym razie Claude — PDF jako attachment z przycinaniem >90 stron.
 *  DOCX/XLSX zawsze konwertowane na tekst (mammoth/xlsx). */
export async function extractSourceFile(input: ExtractInput): Promise<ExtractOutput> {
  if (KIND_DEPTH[input.kind] === "skip") return { fragment: null, skipped: true };

  if (!process.env.GEMINI_API_KEY) {
    const mime = normalizeMime(input.mimeType, input.name) ?? input.mimeType;
    if (mime.startsWith("video/")) {
      return { fragment: null, skipped: true }; // wideo wymaga Gemini
    }
    const { extractWithClaude } = await import("./claudeExtract");
    const res = await extractWithClaude({
      name: input.name,
      localPath: input.localPath,
      mimeType: input.mimeType,
      system: buildSystem(),
      user: buildUser(input.name, input.kind, input.deviceContext),
    });
    return {
      fragment: res.fragment,
      skipped: false,
      model: "claude",
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    };
  }

  const mime = normalizeMime(input.mimeType, input.name) ?? input.mimeType;
  const isConvertible =
    mime.includes("wordprocessingml") || mime.includes("spreadsheetml");
  const isUploadable =
    mime === "application/pdf" || mime.startsWith("image/") || mime.startsWith("video/");

  let files: Awaited<ReturnType<typeof uploadToGemini>>[] = [];
  let inlineText = "";

  if (isConvertible) {
    const bytes = await fs.readFile(input.localPath);
    const prepared = await prepareFileForAi(bytes, input.name, mime);
    inlineText = `\n\nZAWARTOŚĆ DOKUMENTU (skonwertowana na tekst):\n${prepared.bytes.toString("utf8").slice(0, 400_000)}`;
  } else if (isUploadable) {
    files = [await uploadToGemini(input.localPath, mime, input.name)];
  } else {
    const bytes = await fs.readFile(input.localPath);
    inlineText = `\n\nZAWARTOŚĆ DOKUMENTU:\n${bytes.toString("utf8").slice(0, 400_000)}`;
  }

  const res = await callGeminiWithFiles({
    model: V5_GEMINI_PRO,
    system: buildSystem(),
    user: buildUser(input.name, input.kind, input.deviceContext) + inlineText,
    files,
    schema: DeviceKBSchema,
  });

  return {
    fragment: res.parsed ?? null,
    skipped: false,
    model: V5_GEMINI_PRO,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  };
}
