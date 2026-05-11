/**
 * Słownik wymagań prawnych dla dokumentacji urządzeń Locon (v1).
 *
 * Mapa (document_type × device_type) → lista wymaganych sekcji + ich opis +
 * podstawa prawna. Na podstawie tej listy AI buduje wstępny szkielet stron
 * dokumentu — w sekcjach których nie potrafi wypełnić bez danych źródłowych
 * (SAR, deklaracja zgodności CE, NIP gwaranta, wartości techniczne) wstawia
 * widoczne placeholdery `⚠️ DO UZUPEŁNIENIA: ...`. Faza 2 generatora
 * pobiera te placeholdery z plików referencyjnych (raport SAR, instrukcja
 * producenta, specyfikacja techniczna).
 *
 * Wersjonowanie: zmiana strukturalna => bump legal_template_version w
 * gen4_projects, żeby przy regeneracji starszych projektów było wiadomo,
 * że szkielet się zmienił.
 */

export const DOCUMENT_TYPES = [
  "qsg_full",     // QSG + skrócona instrukcja (najczęstszy combo)
  "qsg_only",    // sam Quick Start Guide
  "kg_short",    // skrócona karta gwarancyjna (sama tabela na pieczątkę + minimum)
  "kg_full",     // pełna karta gwarancyjna (warunki + procedura reklamacji + RODO)
  "manual_full", // pełna instrukcja obsługi (cała funkcjonalność + załączniki prawne)
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DEVICE_TYPES = [
  "tracker_pet",  // tracker zwierzęcy (lokalizator GPS na obrożę)
  "watch_kid",    // zegarek dziecięcy (smartwatch z GPS+GSM)
  "band_senior",  // opaska seniorska (smartband z GPS+GSM, często z funkcjami zdrowotnymi)
] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  qsg_full: "QSG + skrócona instrukcja obsługi",
  qsg_only: "Sam Quick Start Guide",
  kg_short: "Skrócona karta gwarancyjna",
  kg_full: "Pełna karta gwarancyjna",
  manual_full: "Pełna instrukcja obsługi",
};

export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  tracker_pet: "Tracker zwierzęcy (obroża GPS)",
  watch_kid: "Zegarek dziecięcy (smartwatch GPS+GSM)",
  band_senior: "Opaska seniorska (smartband GPS+GSM)",
};

export interface SectionRequirement {
  /** Stabilny identyfikator — nie zmienia się między wersjami szablonu, służy do diff'u przy regeneracji. */
  id: string;
  /** Tytuł strony / sekcji (trafi do gen4_pages.title). */
  title: string;
  /** Template strony (musi być jedną z wartości z VALID_TEMPLATES w v4Generate.ts). */
  template: "cover" | "toc" | "step" | "warranty_terms" | "warranty_stamp" | "contact" | "blank";
  /** Krótki opis tego co ma się znaleźć na stronie — trafia do prompta. */
  description: string;
  /** Podstawa prawna (informacyjna, dla audytu). */
  legal_basis?: string;
  /** Pola które AI ma wypełnić jako placeholder, jeśli brak danych referencyjnych. */
  placeholders?: string[];
  /** Sekcja multi-krokowa — rozbija się na N osobnych stron przy generowaniu
   *  szkieletu. Każdy krok otrzymuje swój placeholder obrazka (screen z aplikacji
   *  / zdjęcie urządzenia). N pochodzi z input.step_count. */
  multi_step?: boolean;
  /** Czy strona MUSI mieć dedykowany obrazek (placeholder + AI matchuje image_id
   *  z biblioteki). Ustawiane też automatycznie dla wszystkich expanded stron
   *  multi_step. */
  needs_image?: boolean;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Bazowe sekcje (cover + spis treści) — występują w każdym dokumencie.
 * ───────────────────────────────────────────────────────────────────────── */

const SECTION_COVER: SectionRequirement = {
  id: "cover",
  title: "Okładka",
  template: "cover",
  description:
    "Logo Bezpieczna Rodzina, nazwa modelu + kod, krótki podtytuł (np. 'Quick Start Guide' " +
    "lub 'Karta gwarancyjna'), oznaczenie wersji dokumentu (np. v1.0 / 2026).",
};

const SECTION_TOC: SectionRequirement = {
  id: "toc",
  title: "Spis treści",
  template: "toc",
  description:
    "Numerowana lista wszystkich pozostałych stron z tytułami i numerami stron. " +
    "Spis treści NIE wymienia samej okładki ani siebie.",
};

/* ─────────────────────────────────────────────────────────────────────────
 * Sekcje QSG (quick start guide).
 * ───────────────────────────────────────────────────────────────────────── */

const QSG_BOX_CONTENTS: SectionRequirement = {
  id: "box_contents",
  title: "Zawartość opakowania",
  template: "step",
  description:
    "Lista elementów w pudełku z ikonami: urządzenie, ładowarka/kabel, instrukcja, " +
    "(opcjonalnie pasek/obroża). Zwięzła lista wypunktowana.",
  placeholders: ["lista akcesoriów dołączonych do urządzenia"],
};

const QSG_DEVICE_OVERVIEW: SectionRequirement = {
  id: "device_overview",
  title: "Budowa urządzenia",
  template: "step",
  description:
    "Schemat urządzenia z opisanymi elementami: przyciski, port ładowania, slot SIM " +
    "(jeśli dotyczy), czujniki, dioda statusu. Placeholder na grafikę poglądową.",
  placeholders: ["grafika z numeracją elementów", "lista przycisków i ich funkcji"],
  needs_image: true,
};

const QSG_FIRST_USE: SectionRequirement = {
  id: "first_use",
  title: "Pierwsze uruchomienie",
  template: "step",
  description:
    "Sekcja wprowadzająca proces uruchomienia. Typowe kroki to: ładowanie do pełna, " +
    "instalacja karty SIM (jeśli urządzenie obsługuje), włączenie urządzenia, pobranie " +
    "aplikacji Bezpieczna Rodzina, parowanie urządzenia z kontem.",
  multi_step: true,  // rozbija się na N osobnych stron (krok per strona)
  needs_image: true,
};

const QSG_BASIC_USE: SectionRequirement = {
  id: "basic_use",
  title: "Podstawowe użycie",
  template: "step",
  description:
    "Włącz/wyłącz urządzenie, podstawowe gesty/przyciski, alarm SOS (jeśli funkcja jest), " +
    "ładowanie baterii, kontrola statusu w aplikacji.",
};

const QSG_SAFETY_BASIC: SectionRequirement = {
  id: "safety_basic",
  title: "Bezpieczeństwo",
  template: "step",
  description:
    "Skrócone ostrzeżenia: nie demontuj, używaj tylko oryginalnych ładowarek, unikaj " +
    "ekstremalnych temperatur, woda (z odniesieniem do IP rating jeśli dotyczy), " +
    "utylizacja baterii zgodnie z WEEE.",
  legal_basis: "Dyrektywa RED 2014/53/UE art. 10 ust. 8, Dyrektywa WEEE 2012/19/UE",
  placeholders: ["IP rating urządzenia", "zakres temperatur pracy"],
};

const QSG_SYMBOLS: SectionRequirement = {
  id: "symbols",
  title: "Symbole i oznaczenia",
  template: "step",
  description:
    "Tabela symboli: CE, WEEE (przekreślony kosz), oznaczenia europejskie (RoHS), " +
    "klasa ochrony IP, zakres temperatur. Każdy symbol z krótkim opisem znaczenia.",
  legal_basis: "Dyrektywa RED 2014/53/UE załącznik V",
};

const QSG_MANUFACTURER_DATA: SectionRequirement = {
  id: "manufacturer_data",
  title: "Producent / Importer",
  template: "step",
  description:
    "Pełne dane firmy: 'Locon Sp. z o.o., adres siedziby, NIP/VAT EU PL8521013334, " +
    "kontakt do BOK, adres www'. Wymagane przepisami RED (art. 10) i przepisami " +
    "konsumenckimi (UoPK art. 12).",
  legal_basis: "RED 2014/53/UE art. 10, UoPK art. 12 ust. 1 pkt 2",
};

const QSG_DOC_SHORT: SectionRequirement = {
  id: "doc_short",
  title: "Deklaracja zgodności (skrót)",
  template: "step",
  description:
    "Krótkie oświadczenie: 'Locon Sp. z o.o. niniejszym oświadcza, że urządzenie [model] " +
    "spełnia wymagania dyrektywy RED 2014/53/UE. Pełna treść deklaracji zgodności UE " +
    "dostępna pod adresem: bezpiecznarodzina.pl/ce/[model]'.",
  legal_basis: "RED 2014/53/UE art. 10 ust. 9",
};

const QSG_CONTACT: SectionRequirement = {
  id: "contact",
  title: "Kontakt",
  template: "contact",
  description:
    "E-mail BOK, telefon BOK, godziny pracy BOK, adres www, QR z linkiem do pełnej " +
    "instrukcji online (bezpiecznarodzina.pl/instrukcje/[kod-modelu]).",
};

/* ─────────────────────────────────────────────────────────────────────────
 * Sekcje rozszerzające QSG do skróconej instrukcji obsługi.
 * ───────────────────────────────────────────────────────────────────────── */

const SHORT_TECH_SPEC: SectionRequirement = {
  id: "tech_spec_short",
  title: "Specyfikacja techniczna",
  template: "step",
  description:
    "Tabela parametrów: model, GSM/LTE band, GPS (chipset/precyzja), Wi-Fi (jeśli), " +
    "Bluetooth (wersja), bateria (mAh), wymiary, waga, zakres temperatur, IP rating, " +
    "częstotliwości pracy radia (MHz), maksymalna moc (dBm).",
  legal_basis: "RED 2014/53/UE art. 10 ust. 8 lit. a-c (zakres pasm i moc)",
  placeholders: [
    "GSM/LTE bandy",
    "częstotliwości pracy (MHz)",
    "maksymalna moc nadajnika (dBm/mW)",
    "pojemność baterii (mAh)",
    "wymiary i waga",
    "IP rating",
  ],
};

const SHORT_SAR_INFO: SectionRequirement = {
  id: "sar_info",
  title: "Informacja SAR",
  template: "step",
  description:
    "Wartości SAR (head/body) z raportu pomiarowego. Norma badania (np. EN 50360, " +
    "EN 50566). Krótki opis: 'SAR wyraża maksymalną ilość energii radiowej pochłanianej " +
    "przez ciało…'. Limit prawny w UE: 2,0 W/kg uśredniony na 10 g tkanki.",
  legal_basis: "Zalecenie 1999/519/WE, EN 50360, EN 50566",
  placeholders: [
    "wartość SAR head (W/kg)",
    "wartość SAR body (W/kg)",
    "norma pomiaru",
    "data raportu SAR",
  ],
};

const SHORT_COMPATIBILITY: SectionRequirement = {
  id: "compatibility",
  title: "Kompatybilność",
  template: "step",
  description:
    "Tabela kompatybilności: minimalna wersja Android (np. 7.0+), minimalna wersja iOS " +
    "(np. 13.0+), aplikacja 'Bezpieczna Rodzina' z linkami do sklepów (Google Play, App Store).",
};

const SHORT_FAQ: SectionRequirement = {
  id: "faq_short",
  title: "Najczęstsze problemy",
  template: "step",
  description:
    "5–8 najczęstszych problemów: 'Urządzenie się nie ładuje', 'Brak GPS', 'Nie mogę " +
    "się sparować', 'Aplikacja pokazuje 'offline''. Każdy problem z jedno-dwuzdaniowym " +
    "rozwiązaniem.",
};

const SHORT_WARRANTY_STAMP: SectionRequirement = {
  id: "warranty_stamp",
  title: "Karta gwarancyjna",
  template: "warranty_stamp",
  description:
    "Tabela na pieczątkę: model, IMEI/SN (puste pole), data sprzedaży (puste pole), " +
    "podpis sprzedawcy + miejsce na pieczątkę sklepu. Krótka info o okresie gwarancji.",
  legal_basis: "KC art. 577 § 1, UoPK art. 13",
  placeholders: ["okres gwarancji w miesiącach", "dane gwaranta"],
};

/* ─────────────────────────────────────────────────────────────────────────
 * Sekcje karty gwarancyjnej.
 * ───────────────────────────────────────────────────────────────────────── */

const KG_GUARANTOR_DATA: SectionRequirement = {
  id: "guarantor_data",
  title: "Dane gwaranta",
  template: "step",
  description:
    "Pełne dane gwaranta: 'Locon Sp. z o.o., adres siedziby (Łódź / Warszawa), NIP, " +
    "REGON, KRS, numer VAT EU, kontakt: e-mail i telefon do działu reklamacji'.",
  legal_basis: "KC art. 577 § 2, UoPK art. 13 ust. 1 pkt 1",
};

const KG_PERIOD: SectionRequirement = {
  id: "warranty_period",
  title: "Okres gwarancji",
  template: "step",
  description:
    "Okres gwarancji w miesiącach (zwykle 24 dla konsumentów, 12 dla przedsiębiorców), " +
    "licząc od daty zakupu. Definicja momentu rozpoczęcia gwarancji.",
  legal_basis: "KC art. 577¹ § 4, UoPK art. 13",
  placeholders: ["okres gwarancji konsumenckiej", "okres gwarancji B2B"],
};

const KG_SCOPE: SectionRequirement = {
  id: "warranty_scope",
  title: "Zakres gwarancji",
  template: "warranty_terms",
  description:
    "Co obejmuje gwarancja: wady fabryczne (materiałowe i wykonania), działanie " +
    "elektroniki, działanie radia GPS/GSM. Co NIE obejmuje: uszkodzenia mechaniczne, " +
    "zalanie poza IP rating, ingerencja użytkownika, naturalne zużycie baterii.",
  legal_basis: "KC art. 577² § 1",
};

const KG_CONSUMER_RIGHTS: SectionRequirement = {
  id: "consumer_rights",
  title: "Uprawnienia konsumenta",
  template: "warranty_terms",
  description:
    "Obligatoryjny zapis: 'Gwarancja nie wyłącza, nie ogranicza ani nie zawiesza " +
    "uprawnień konsumenta wynikających z przepisów o rękojmi za wady (KC art. 556¹–576⁴) " +
    "oraz uprawnień wynikających z UoPK rozdz. 5'.",
  legal_basis: "KC art. 579, UoPK art. 13 ust. 4",
};

const KG_CLAIM_PROCEDURE: SectionRequirement = {
  id: "claim_procedure",
  title: "Procedura reklamacji",
  template: "warranty_terms",
  description:
    "Krok po kroku: 1) zgłoszenie reklamacji (e-mail / formularz online), 2) wymagane " +
    "dane (IMEI, dowód zakupu, opis usterki), 3) wysyłka urządzenia na adres serwisu " +
    "(koszt po stronie gwaranta dla zgłoszeń uznanych), 4) czas rozpatrzenia (14 dni " +
    "kalendarzowych — UoPK), 5) sposób zwrotu/wymiany.",
  legal_basis: "KC art. 580, UoPK art. 7a",
  placeholders: ["adres serwisu / formularz reklamacyjny", "e-mail do reklamacji"],
};

const KG_GDPR: SectionRequirement = {
  id: "gdpr",
  title: "Przetwarzanie danych (RODO)",
  template: "warranty_terms",
  description:
    "Klauzula informacyjna RODO przy zgłoszeniu reklamacji: administrator danych " +
    "(Locon Sp. z o.o.), cel przetwarzania (rozpatrzenie reklamacji), podstawa prawna " +
    "(art. 6 ust. 1 lit. b/c RODO), okres przechowywania, prawa osoby (dostęp, sprostowanie, " +
    "usunięcie, sprzeciw), kontakt do IOD, prawo skargi do PUODO.",
  legal_basis: "RODO art. 13",
};

/* ─────────────────────────────────────────────────────────────────────────
 * Sekcje pełnej instrukcji obsługi (manual_full).
 * ───────────────────────────────────────────────────────────────────────── */

const MANUAL_APP_GUIDE: SectionRequirement = {
  id: "app_guide",
  title: "Aplikacja Bezpieczna Rodzina",
  template: "step",
  description:
    "Pełen przewodnik po aplikacji: instalacja, rejestracja konta, parowanie " +
    "urządzenia, mapa i lokalizacja, strefy bezpieczne (geofencing), historia " +
    "lokalizacji, alarmy, połączenia (jeśli model obsługuje).",
};

const MANUAL_ADVANCED_CONFIG: SectionRequirement = {
  id: "advanced_config",
  title: "Konfiguracja zaawansowana",
  template: "step",
  description:
    "Tryby pracy (oszczędzanie baterii / standardowy / dokładny GPS), częstotliwość " +
    "lokalizacji, ustawienia komunikatów SOS, listy zaufanych numerów (jeśli funkcja).",
};

const MANUAL_DOC_FULL: SectionRequirement = {
  id: "doc_full",
  title: "Deklaracja zgodności UE (pełna)",
  template: "step",
  description:
    "Pełna treść deklaracji zgodności CE: nazwa producenta, opis urządzenia, dyrektywy " +
    "(RED 2014/53/UE, RoHS 2011/65/UE), normy zharmonizowane (EN 301 511, EN 301 489-x, " +
    "EN 62311, EN 62368-1), miejsce/data wystawienia, podpis osoby upoważnionej.",
  legal_basis: "RED 2014/53/UE art. 18",
  placeholders: [
    "lista zastosowanych norm zharmonizowanych",
    "data i miejsce wystawienia deklaracji",
    "imię/nazwisko osoby upoważnionej",
  ],
};

const MANUAL_TROUBLESHOOTING_FULL: SectionRequirement = {
  id: "troubleshooting_full",
  title: "Rozwiązywanie problemów",
  template: "step",
  description:
    "Pełna lista typowych problemów (15–25 pozycji) pogrupowana w sekcje: ładowanie, " +
    "łączność (GPS/GSM), parowanie z aplikacją, alarmy. Każdy problem z dłuższym " +
    "rozwiązaniem.",
};

/* ─────────────────────────────────────────────────────────────────────────
 * Sekcje per typ urządzenia.
 * ───────────────────────────────────────────────────────────────────────── */

const DEVICE_NOTE_KID: SectionRequirement = {
  id: "device_note_kid",
  title: "Ochrona danych dziecka",
  template: "step",
  description:
    "Informacja dla rodzica/opiekuna: zgoda rodzica na przetwarzanie danych dziecka " +
    "poniżej 16 r.ż. (RODO art. 8), cel zbierania lokalizacji, prawo dostępu i usunięcia, " +
    "wskazówki bezpiecznego korzystania (kod blokady, lista zaufanych numerów).",
  legal_basis: "RODO art. 8 ust. 1, ustawa o ochronie danych z 10.05.2018",
};

const DEVICE_NOTE_SENIOR: SectionRequirement = {
  id: "device_note_senior",
  title: "Funkcje zdrowotne — zastrzeżenia",
  template: "step",
  description:
    "OBLIGATORYJNE zastrzeżenie jeśli urządzenie ma czujniki zdrowotne (puls, SpO2, " +
    "ciśnienie): 'Urządzenie nie jest wyrobem medycznym w rozumieniu MDR 2017/745. " +
    "Pomiary mają charakter orientacyjny i nie służą do diagnozowania, leczenia ani " +
    "monitorowania chorób. Nie zastępują konsultacji lekarskiej'. Bez tego zapisu " +
    "wprowadzanie produktu na rynek jest naruszeniem MDR.",
  legal_basis: "MDR 2017/745 art. 7 (zakaz wprowadzania w błąd)",
};

const DEVICE_NOTE_PET: SectionRequirement = {
  id: "device_note_pet",
  title: "Bezpieczeństwo zwierzęcia",
  template: "step",
  description:
    "Wskazówki montażu na obroży: dopasowanie obroży, kontrola czy nie naciska, długość " +
    "noszenia, postępowanie po zamoczeniu (IP rating). Ostrzeżenie: nie pozwalać " +
    "zwierzęciu gryźć urządzenia (bateria Li-ion).",
};

/* ─────────────────────────────────────────────────────────────────────────
 * Mapa: (document_type, device_type) → kolejność wymaganych sekcji.
 *
 * Dla czytelności składamy listę z 3 segmentów: bazowe sekcje (cover+toc),
 * sekcje wynikające z document_type, oraz sekcje device-specific.
 * ───────────────────────────────────────────────────────────────────────── */

function sectionsForDocumentType(doc: DocumentType): SectionRequirement[] {
  switch (doc) {
    case "qsg_only":
      return [
        QSG_BOX_CONTENTS,
        QSG_DEVICE_OVERVIEW,
        QSG_FIRST_USE,
        QSG_BASIC_USE,
        QSG_SAFETY_BASIC,
        QSG_SYMBOLS,
        QSG_MANUFACTURER_DATA,
        QSG_DOC_SHORT,
        QSG_CONTACT,
      ];
    case "qsg_full":
      return [
        QSG_BOX_CONTENTS,
        QSG_DEVICE_OVERVIEW,
        QSG_FIRST_USE,
        QSG_BASIC_USE,
        SHORT_COMPATIBILITY,
        QSG_SAFETY_BASIC,
        SHORT_TECH_SPEC,
        SHORT_SAR_INFO,
        QSG_SYMBOLS,
        SHORT_FAQ,
        QSG_MANUFACTURER_DATA,
        QSG_DOC_SHORT,
        SHORT_WARRANTY_STAMP,
        QSG_CONTACT,
      ];
    case "kg_short":
      return [
        SHORT_WARRANTY_STAMP,
        KG_GUARANTOR_DATA,
        KG_PERIOD,
        KG_CLAIM_PROCEDURE,
      ];
    case "kg_full":
      return [
        SHORT_WARRANTY_STAMP,
        KG_GUARANTOR_DATA,
        KG_PERIOD,
        KG_SCOPE,
        KG_CONSUMER_RIGHTS,
        KG_CLAIM_PROCEDURE,
        KG_GDPR,
        QSG_CONTACT,
      ];
    case "manual_full":
      return [
        QSG_BOX_CONTENTS,
        QSG_DEVICE_OVERVIEW,
        QSG_FIRST_USE,
        QSG_BASIC_USE,
        MANUAL_APP_GUIDE,
        MANUAL_ADVANCED_CONFIG,
        SHORT_COMPATIBILITY,
        QSG_SAFETY_BASIC,
        SHORT_TECH_SPEC,
        SHORT_SAR_INFO,
        QSG_SYMBOLS,
        MANUAL_TROUBLESHOOTING_FULL,
        QSG_MANUFACTURER_DATA,
        MANUAL_DOC_FULL,
        SHORT_WARRANTY_STAMP,
        KG_GUARANTOR_DATA,
        KG_PERIOD,
        KG_SCOPE,
        KG_CONSUMER_RIGHTS,
        KG_CLAIM_PROCEDURE,
        KG_GDPR,
        QSG_CONTACT,
      ];
  }
}

function deviceSpecificSection(dev: DeviceType): SectionRequirement | null {
  switch (dev) {
    case "watch_kid": return DEVICE_NOTE_KID;
    case "band_senior": return DEVICE_NOTE_SENIOR;
    case "tracker_pet": return DEVICE_NOTE_PET;
  }
}

/** Rozbija sekcję multi_step na N osobnych pozycji (krok per strona).
 *  Każda strona dostaje: tytuł "Krok N: ...", needs_image=true (każdy krok
 *  ma własny screen/zdjęcie), placeholder na obrazek. AI sam wymyśla
 *  konkretne tytuły kroków na bazie opisu sekcji-rodzica. */
function expandMultiStep(section: SectionRequirement, stepCount: number): SectionRequirement[] {
  if (!section.multi_step || stepCount <= 1) return [section];
  return Array.from({ length: stepCount }, (_, i) => ({
    id: `${section.id}_step_${i + 1}`,
    title: `Krok ${i + 1}`,
    template: "step" as const,
    description:
      `Krok ${i + 1} z ${stepCount} sekcji "${section.title}". Wymyśl konkretny ` +
      `tytuł (np. "Krok ${i + 1}: Naładuj zegarek", "Krok ${i + 1}: Włóż kartę SIM", ` +
      `"Krok ${i + 1}: Sparuj z aplikacją"). Strona powinna zawierać: numer + nazwę kroku ` +
      `jako nagłówek, krótki opis czynności (1-3 zdania), oraz miejsce na obrazek ` +
      `(screen aplikacji lub zdjęcie urządzenia w trakcie tego kroku). ` +
      `Kontekst całej sekcji: ${section.description}`,
    placeholders: ["screen aplikacji / zdjęcie urządzenia dla tego kroku"],
    needs_image: true,
  }));
}

/**
 * Zwraca pełną listę wymaganych sekcji w kolejności w jakiej powinny pojawić się
 * w dokumencie. Sekcja device-specific wstawiana jest tuż przed sekcjami prawnymi
 * (przed manufacturer_data) — jest częścią opisu produktu, nie załącznikiem.
 *
 * stepCount — gdy podany i większy od 1, sekcje multi_step rozbijają się na
 * N osobnych stron (krok per strona). Pochodzi z gen4_projects.ai_input.step_count.
 */
export function getRequiredSections(
  documentType: DocumentType,
  deviceType: DeviceType,
  stepCount: number = 1,
): SectionRequirement[] {
  const out: SectionRequirement[] = [SECTION_COVER, SECTION_TOC];
  const rawDoc = sectionsForDocumentType(documentType);
  const doc = rawDoc.flatMap((s) => expandMultiStep(s, stepCount));
  const devSection = deviceSpecificSection(deviceType);

  if (devSection) {
    // Wstaw przed pierwszą sekcją "prawnoadministracyjną" (manufacturer_data,
    // doc_short, guarantor_data) — czyli mówiąc po polsku: na końcu części
    // produktowej, zanim zaczyna się część regulacyjna.
    const cutoffIds = new Set(["manufacturer_data", "doc_short", "guarantor_data", "warranty_stamp"]);
    const cutoffIdx = doc.findIndex((s) => cutoffIds.has(s.id));
    if (cutoffIdx === -1) {
      out.push(...doc, devSection);
    } else {
      out.push(...doc.slice(0, cutoffIdx), devSection, ...doc.slice(cutoffIdx));
    }
  } else {
    out.push(...doc);
  }
  return out;
}

/**
 * Renderuje listę wymaganych sekcji w formie czytelnej dla AI (markdown-like).
 * Trafia do system prompt — informuje Claude jakie strony MUSI wygenerować
 * i co dokładnie ma się na nich znaleźć.
 */
export function renderRequirementsForPrompt(
  documentType: DocumentType,
  deviceType: DeviceType,
  stepCount: number = 1,
): string {
  const sections = getRequiredSections(documentType, deviceType, stepCount);
  const lines: string[] = [
    `WYMAGANE SEKCJE DOKUMENTU (typ: ${DOCUMENT_TYPE_LABELS[documentType]}; urządzenie: ${DEVICE_TYPE_LABELS[deviceType]}):`,
    `Wygeneruj DOKŁADNIE ${sections.length} stron w tej kolejności i z tymi tytułami.`,
    "Każda strona musi spełniać poniższy opis. Jeśli nie znasz konkretnych danych",
    "(np. wartości SAR, NIP, IMEI, lista akcesoriów, częstotliwości pracy radia) —",
    "WSTAW WIDOCZNY PLACEHOLDER w treści w postaci:",
    '   ⚠️ DO UZUPEŁNIENIA: <opis brakującej informacji>',
    "Nie wymyślaj wartości technicznych ani prawnych. Lepiej widoczna luka niż",
    "wymyślona liczba — użytkownik zasili dokument plikami referencyjnymi (raport SAR,",
    "instrukcja producenta, specyfikacja techniczna) w kolejnym kroku.",
    "",
  ];
  sections.forEach((s, idx) => {
    lines.push(`${idx + 1}. ${s.title}  [template: ${s.template}, id: ${s.id}]`);
    lines.push(`   ${s.description}`);
    if (s.legal_basis) lines.push(`   Podstawa prawna: ${s.legal_basis}`);
    if (s.placeholders && s.placeholders.length > 0) {
      lines.push(`   Wstaw placeholdery dla: ${s.placeholders.join(", ")}`);
    }
    if (s.needs_image) {
      lines.push(`   ⚙️ ZAWSZE pozostaw miejsce na obrazek (image element, ~30-50 mm szer.)`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

export function isValidDocumentType(x: unknown): x is DocumentType {
  return typeof x === "string" && (DOCUMENT_TYPES as readonly string[]).includes(x);
}

export function isValidDeviceType(x: unknown): x is DeviceType {
  return typeof x === "string" && (DEVICE_TYPES as readonly string[]).includes(x);
}
