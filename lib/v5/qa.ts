import type { Booklet } from "./compose";
import { GAP_MARKER, scanGapMarkers } from "./compose";
import type { DeviceKB } from "./types";
import type { PageOverflow } from "./render";

export interface QaCheck {
  id: string;
  requirement: string;
  legal_basis?: string;
  ok: boolean;
  detail: string;
  severity: "blocker" | "warning";
}

export interface QaReport {
  ready: boolean;
  checks: QaCheck[];
}

function bookletText(b: Booklet): string {
  return JSON.stringify(b).toLowerCase();
}

function hasPageCfg(b: Booklet, cfgKey: string): boolean {
  return b.pages.some((p) => cfgKey in p);
}

export interface QaInput {
  booklet: Booklet;
  kb: DeviceKB;
  overflows: PageOverflow[];
  /** Nazwy/kody urządzenia z SZABLONU — nie mogą przetrwać w nowym dokumencie. */
  forbiddenTemplateNames?: string[];
}

/** Brama kompletności QSG — checklista regulacyjna z deep researchu
 *  (RED 2014/53/EU, GPSR 2023/988, Battery Reg 2023/1542, WEEE, IEC/IEEE 82079-1)
 *  + kontrole generatywne (luki, CJK, pozostałości szablonu, overflow). */
export function runQsgGate(input: QaInput): QaReport {
  const { booklet, kb, overflows } = input;
  const text = bookletText(booklet);
  const checks: QaCheck[] = [];
  const add = (
    id: string,
    requirement: string,
    ok: boolean,
    detail: string,
    legal?: string,
    severity: "blocker" | "warning" = "blocker"
  ) => checks.push({ id, requirement, ok, detail, legal_basis: legal, severity });

  // — Checklista regulacyjna (QSG-01…09) —
  const manuName = kb.identity.manufacturer?.value?.name?.toLowerCase();
  add(
    "QSG-01",
    "Dane producenta i importera z adresami",
    text.includes("producent") && (manuName ? text.includes(manuName.split(" ")[0]) : true),
    manuName ? `producent w KB: ${manuName}` : "brak producenta w KB — wymaga uzupełnienia",
    "RED art. 10(7) i 12(3); GPSR art. 9(5)"
  );
  const model = kb.identity.model_code?.value;
  add(
    "QSG-02",
    "Oznaczenie typu/modelu produktu",
    !!model && text.includes(model.toLowerCase()),
    model ? `model ${model} obecny w treści` : "brak model_code w KB",
    "RED art. 10(6); GPSR art. 9(5)"
  );
  add(
    "QSG-03",
    "Pasma częstotliwości i maks. moc nadawania",
    hasPageCfg(booklet, "frequencyPage") && hasPageCfg(booklet, "powerTablePage") && kb.radio.bands.length > 0,
    `pasma w KB: ${kb.radio.bands.length}; strony frequency/power: ${hasPageCfg(booklet, "frequencyPage")}/${hasPageCfg(booklet, "powerTablePage")}`,
    "RED art. 10(8)"
  );
  add(
    "QSG-04",
    "Deklaracja zamierzonego użycia i ograniczeń",
    /przeznaczon|służy do|zaprojektowan/.test(text),
    "szukano deklaracji przeznaczenia w treści",
    "RED art. 10(8) i 10(10); GPSR art. 9(7)"
  );
  add(
    "QSG-05",
    "Uproszczona deklaracja zgodności UE + URL pełnej DoC",
    /deklaracj\w+ zgodności/.test(text) && /2014\/53\/ue|2014\/53\/eu/.test(text) && /https?:\/\//.test(text),
    "wymagana formuła z Annex VII i adres URL",
    "RED art. 10(9) i Annex VII"
  );
  add(
    "QSG-06",
    "Krytyczne ostrzeżenia bezpieczeństwa w druku",
    hasPageCfg(booklet, "warningsPage") && hasPageCfg(booklet, "safetyPage"),
    "strony OSTRZEŻENIA i BEZPIECZEŃSTWO UŻYTKOWANIA",
    "GPSR art. 9(7); IEC/IEEE 82079-1"
  );
  add(
    "QSG-07",
    "Język polski dla rynku PL",
    booklet.meta.language.toUpperCase() === "PL",
    `meta.language=${booklet.meta.language}`,
    "RED art. 10(8); Ustawa o języku polskim art. 7"
  );
  add(
    "QSG-08",
    "Parametry bezpiecznego ładowania (5V, nadzór dorosłych)",
    /5\s*v/.test(text) && /ładowani/.test(text),
    "szukano 5V + sekcji ładowania",
    "GPSR; EN 62368-1"
  );
  add(
    "QSG-09",
    "URL + QR do pełnej instrukcji online",
    booklet.pages.some((p) => p.variant === "qr" || "contactPage" in p || "appDownloadPage" in p) &&
      /https?:\/\/|qr/.test(text),
    "strona QR/kontakt z linkiem",
    "GPSR — ramy instrukcji cyfrowych"
  );
  // — SAR i WEEE (obowiązkowe także w QSG wg praktyki Locon) —
  add(
    "MAN-05",
    "Wartości SAR z progami",
    hasPageCfg(booklet, "sarPage") && kb.sar.results.length > 0,
    `wyniki SAR w KB: ${kb.sar.results.length}`,
    "RED art. 3(1)(a); EN 50566"
  );
  add(
    "MAN-07",
    "Symbol WEEE + instrukcja utylizacji",
    hasPageCfg(booklet, "weeePage") && hasPageCfg(booklet, "disposalPage"),
    "strony WEEE i UTYLIZACJA",
    "WEEE 2012/19/UE; Battery Reg 2023/1542"
  );
  add(
    "MAN-06",
    "Informacja o baterii niewymiennej przez użytkownika",
    /bateri/.test(text),
    kb.hardware.battery?.value?.removable === false
      ? "KB potwierdza baterię niewymienną"
      : "brak potwierdzenia (removable) w KB — zweryfikuj treść",
    "Battery Reg (EU) 2023/1542 art. 74",
    kb.hardware.battery?.value?.removable === false ? "blocker" : "warning"
  );

  // — Kontrole generatywne —
  // Luki dzielimy wg wagi: dane wymagane prawnie (RED/GPSR/SAR/bateria-bezpieczeństwo)
  // blokują publikację; luki kosmetyczne (kolor, czas pracy) tylko ostrzegają.
  const LEGAL_GAP = /manufacturer|importer|sar\.|radio\.|max_power|regulatory|safety|doc_url|removable/i;
  const gaps = scanGapMarkers(booklet);
  const legalGaps = gaps.filter((g) => LEGAL_GAP.test(g));
  const optionalGaps = gaps.filter((g) => !LEGAL_GAP.test(g));
  add(
    "GEN-01",
    `Brak luk ${GAP_MARKER}…» w danych wymaganych prawnie`,
    legalGaps.length === 0,
    legalGaps.length ? `luki prawne: ${legalGaps.join("; ")}` : "czysto"
  );
  add(
    "GEN-01b",
    "Brak luk w danych opcjonalnych",
    optionalGaps.length === 0,
    optionalGaps.length ? `luki opcjonalne: ${optionalGaps.join("; ")}` : "czysto",
    undefined,
    "warning"
  );
  const cjk = (JSON.stringify(booklet).match(/[一-鿿]/g) ?? []).length;
  add("GEN-02", "Brak nieprzetłumaczonych znaków CJK", cjk === 0, cjk ? `znaków CJK: ${cjk}` : "czysto");
  const leftovers = (input.forbiddenTemplateNames ?? []).filter((n) => {
    const own = [
      kb.identity.model_code?.value,
      kb.identity.trade_name?.value,
      kb.identity.manufacturer_model?.value,
      kb.identity.manufacturer?.value?.name,
    ]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());
    return !own.some((o) => o.includes(n.toLowerCase())) && text.includes(n.toLowerCase());
  });
  add(
    "GEN-03",
    "Brak pozostałości nazw urządzenia z szablonu",
    leftovers.length === 0,
    leftovers.length ? `znaleziono: ${leftovers.join(", ")}` : "czysto"
  );
  add(
    "GEN-04",
    "Brak przepełnień stron (pomiar DOM)",
    overflows.length === 0,
    overflows.length
      ? overflows.map((o) => `${o.label} (+${o.overflowPx}px)`).join("; ")
      : "wszystkie strony mieszczą treść"
  );

  const ready = checks.every((c) => c.ok || c.severity === "warning");
  return { ready, checks };
}
