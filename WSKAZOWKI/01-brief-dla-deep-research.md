# Brief dla Deep Research — Generator Instrukcji v4 (Locon / Bezpieczna Rodzina)

> **Cel tego dokumentu:** dostarczyć innemu modelowi AI (deep research) pełen kontekst aktualnego stanu systemu, aby mógł zasugerować jak go **dalej usprawnić, zautomatyzować i podnieść jakość outputu**.
>
> **Format odpowiedzi oczekiwany od research modela:** lista konkretnych, ułożonych w priorytecie ulepszeń — każde z (a) opisem problemu, (b) propozycją rozwiązania, (c) szacowanym wpływem, (d) szacowanym wysiłkiem implementacji.

---

## 1. Cel biznesowy

Firma **Locon Sp. z o.o.** (marka **Bezpieczna Rodzina**) produkuje i dystrybuuje urządzenia bezpieczeństwa rodzinnego (lokalizatory GPS, smartwatche dla dzieci, opaski dla seniorów, lokalizatory dla zwierząt — GJD.14, GJD.15, GJD.16, opaski senior Life/Plus/Premium, trackery pet Dog Path/Max/Mini). Dla każdego z tych urządzeń **musi powstawać kilka rodzajów dokumentacji drukowanej** (włącznie do opakowań QSG, oddzielne karty gwarancyjne, pełne instrukcje obsługi PDF) w **wielu językach** (PL, BG, HR, RO, MK, SQ, EN).

Dotychczas robione **ręcznie w Excelu/InDesign** przez product managera i tłumaczy. Czas powstania jednej kompletnej instrukcji wielojęzycznej: **kilka tygodni**. Wąskie gardła: spójność layoutu między językami, aktualizacja gdy zmieni się specyfikacja, ekstrakcja wartości technicznych z raportów SAR/instrukcji producenta (chińskich), zgodność prawna z RED 2014/53/EU, RoHS, ustawą o ochronie konsumentów, RODO, MDR (dla opasek z funkcjami zdrowotnymi).

**Generator Instrukcji v4** ma to zautomatyzować end-to-end: user definiuje *(rodzaj dokumentu × rodzaj urządzenia × model × języki)*, system generuje gotowy projekt z poprawnymi sekcjami prawnymi, AI wstawia treść, user edytuje wizualnie (kliknij i ciągnij na canvasie), tłumaczy automatycznie, eksportuje do PDF gotowego do druku (z bleed/crop marks).

**Użytkownicy:** 1-3 osoby z Locon (product manager, designer, koordynator tłumaczeń). Niski poziom techniczny — interfejs musi być no-code/low-code.

**Skala:** ~15-20 projektów rocznie × średnio 4 języki × ~14 stron/projekt = ~1000 stron/rok do wygenerowania.

---

## 2. Stack techniczny i ograniczenia infrastruktury

- **Frontend + Backend:** Next.js 16 App Router, TypeScript, Turbopack
- **UI:** React 19, Tailwind CSS 4, interactjs (drag/resize), pdfjs-dist (preview)
- **Baza danych:** Supabase Postgres (~13 tabel gen4_*)
- **Storage:** Supabase Storage (3 buckety: `gen4-images`, `gen4-reference-docs`, `gen4-exports`)
- **AI:** Anthropic SDK 0.94, Claude Haiku 4.5 / Sonnet 4.6 / Opus 4.7 (user-selectable)
  - Anthropic Files API beta (`files-api-2025-04-14`) — załączanie PDF/TXT do promptów
  - Prompt caching (`cache_control: ephemeral`) na system prompty
- **Hosting:** Vercel Hobby (proxowane przez hub `bezpieczna-rodzina-prototypy.vercel.app/generator-instrukcji/`)
- **Auth:** JWT (HS256) przekazywany z hub middleware przez header `x-locon-user-email`
- **PDF export:** pdf-lib + @pdf-lib/fontkit (custom fonts), własny renderer
- **Pliki źródłowe:** mammoth (DOCX), xlsx (XLSX), pdfjs (PDF rendering), tesseract.js (OCR fallback)
- **Email:** nodemailer (Gmail SMTP)
- **Płatność za AI:** ~$10 testowo, user płaci sam z konta Anthropic

**Krytyczne ograniczenia Vercel Hobby (mają wpływ na architekturę):**

- **60s function cap** (hard) — odpowiedzi AI muszą się zmieścić, inaczej 504. Stąd:
  - Generacja projektu rozbita na **skeleton** (1 wywołanie) + **per-page populate** (N wywołań — robione client-side w pętli)
  - Apply Design System rozbity na **per-page** (~14 wywołań w pętli)
  - Apply Style robione **per-target-page** w pętli
- **4.5 MB body cap** (multipart) — pliki referencyjne (SAR PDFs do 25MB) idą **direct upload** do Supabase Storage przez signed URL, omijając Vercel
- Limit 12 serverless functions per project — generator-instrukcji to **osobny Vercel project**, hub i drafty są osobnymi projektami

---

## 3. Model danych — 13 tabel gen4_*

| Tabela | Cel | Kluczowe pola |
| --- | --- | --- |
| `gen4_projects` | Projekt = jeden dokument w jednym języku bazowym | name, document_type, device_type, model_name, model_code, default_lang, design_system (jsonb), status (draft/generating/ready/approved), is_template, approved_by, approved_at, owner_email |
| `gen4_pages` | Strony projektu (1:N do projektu) | page_number, width_mm, height_mm, template, title, language |
| `gen4_elements` | Elementy strony (1:N do strony) — text/image/line/rect/qr/page_number/callout | x_mm, y_mm, w_mm, h_mm, z_index, rotation_deg, properties (jsonb) |
| `gen4_images` | Biblioteka obrazków projektu | file_path, description, preferred_page_id, source_lang |
| `gen4_design_systems` | Design systemy projektu (kolory/fonty/spacing) | dsl_json, name, source (manual / from_pdf / from_screenshot) |
| `gen4_reference_docs` | Pliki referencyjne (SAR/spec/manual) | kind, source_lang, name, file_path, mime_type, anthropic_file_id, extracted_summary |
| `gen4_translations` | Tłumaczenia per (element × język) | source_text, translated_text, lang, model |
| `gen4_translation_memory` | TM cross-project (klucz: md5 hash) | source_hash, source_text, translations (jsonb per lang), times_used |
| `gen4_ai_notes` | „Notatki AI" — lessons learned, podpowiedzi user-defined dla AI | content, scope (project/global), tags, used_in_workflows |
| `gen4_project_versions` | Snapshot projektu do restore | snapshot_jsonb, label, created_at |
| `gen4_post_edit_log` | Log edycji per user (audit) | action, details, user_email |
| `gen4_ai_history` | Legacy log AI (mniej szczegółów niż gen4_ai_calls) | role, content, structured (jsonb), input/output_tokens |
| `gen4_ai_calls` | **Nowy** — pełna historia wywołań AI z system_prompt + user_prompt + response_text | endpoint, context_type, user_instruction, model, tokens, duration, prompt_edited_by_user, error |

---

## 4. Co system już potrafi — pełna lista features

### 4.1 Tworzenie projektu

- **Wizard nowego projektu** (`/ai/new`) z 3 trybami:
  1. **Pełne AI** — wybierasz document_type × device_type × model × języki, AI generuje wszystko od zera (skeleton + populate per page)
  2. **Z szablonu** — klon istniejącego projektu oznaczonego jako `is_template`
  3. **Bez AI (preset)** — kościec wymaganych sekcji prawnych bez treści (do ręcznej edycji)
- **Słownik wymagań prawnych** (`lib/v4LegalTemplates.ts`): mapa (document_type × device_type) → lista wymaganych sekcji z `legal_basis` (np. RED 2014/53/EU dla deklaracji zgodności, RODO dla informacji o przetwarzaniu)
- **Multi-step expansion** — strona „Pierwsze uruchomienie" automatycznie rozbija się na N osobnych stron (każdy krok osobno)
- **Document types:** qsg_full, qsg_only, kg_short, kg_full, manual_full
- **Device types:** tracker_pet, watch_kid, band_senior
- **Per-page format** — każda strona może mieć inne wymiary (76×76mm dla QSG, A6/A5 dla pełnych instrukcji)

### 4.2 Edycja wizualna (canvas)

- **Drag & drop** elementów (interactjs)
- **Resize** uchwytami na rogach/krawędziach
- **Snap to 1mm grid** (toggle)
- **Smart guides** (pojawiają się gdy element wyrównuje się z innym)
- **Multi-select** (Shift+klik, gumka)
- **Linijki** (ruler na górze + lewej)
- **Zoom** 2-16x, Fit do widoku
- **Undo/redo** historia 10 zmian
- **Skróty klawiszowe:** Ctrl+Z (cofnij), Ctrl+D (duplikuj), Delete, Cmd+P (preview)
- **Fullscreen preview** strony (Esc zamyka)
- **Side-by-side language compare** — pokaż tę samą stronę w dwóch językach obok siebie
- **Element types:** text, image, line, rect, qr, page_number, callout
- **Per-element properties panel** — wszystkie pola edytowalne (x, y, w, h, color, font, opacity slider, fit_mode, content, format itd.)

### 4.3 AI Assistant (na poziomie strony)

- **Asystent po prawej stronie** edytora dla bieżącej strony
- Textarea „co chcesz zrobić ze stroną" + szybkie chipy:
  - „Zrób stronę bardziej profesjonalną i estetyczną"
  - „Zwiększ wszystkie nagłówki o 2pt"
  - „Dodaj na środku duży QR kod do aplikacji"
  - „Skróć opis kroku do 2-3 zdań"
  - „Zmień kolor akcentów na ciemniejszy szary"
- **3 tryby wywołania:**
  - 🔁 **Stream** — generuje na żywo (widać tekst pojawiający się stopniowo)
  - ✨ **Zastosuj przez AI** — jedno wywołanie, podmienia stronę
  - 📋 **Tylko prompt** — generuje prompt do skopiowania do claude.ai (fallback)
- **Model picker** — Haiku 4.5 / Sonnet 4.6 / Opus 4.7
- **👁️ Edytuj prompt przed wysłaniem** — fetchuje wygenerowany prompt, otwiera modal z edytowalnym system + user, „Wyślij teraz" wysyła Twoją wersję

### 4.4 AI per-element

- W panelu Właściwości po zaznaczeniu elementu: przycisk **„✨ Popraw ten element przez AI"**
- Textarea + model picker
- AI dostaje TYLKO ten element + pozostałe jako kontekst read-only
- Szybkie (~3-5s na Haiku, ~10-15s na Sonnet)

### 4.5 Design System

- Panel **Design System** (lista per projekt)
- Tworzenie z 3 źródeł:
  - Manualne wpisanie (JSON: colors, typography, spacing)
  - **Import z PDF wzorcowego** — AI analizuje PDF i wyciąga tokeny DS
  - **Import ze screenshotów** — AI analizuje obrazki
- **Apply DS do strony** — AI przepisuje stronę zgodnie z DS
- **Apply DS do całego projektu** — pętla per page (~14 wywołań, prompt caching obniża koszt o 90% od drugiego)
- **Apply Style → inne strony** — bierze bieżącą stronę jako wzorzec stylowania (kolory/fonty/układ), aplikuje na pozostałe ZACHOWUJĄC ich treść

### 4.6 Notatki AI (lessons learned)

- Panel **Notes** — user-defined wskazówki dla AI, np. „w sekcji bezpieczeństwa zawsze wspomnij NPS dla seniorów"
- Scope: project (tylko ten projekt) lub global (wszystkie)
- AI sugeruje nowe notatki na podstawie powtórzonych edycji (`/ai-notes/suggest`)
- Notatki trafiają do system prompt każdego wywołania AI w danym projekcie

### 4.7 Pliki referencyjne

- Upload PDF / DOCX / XLSX / TXT / MD / CSV / JSON (do 25MB)
- DOCX → konwersja przez mammoth → tekst
- XLSX → konwersja przez xlsx (każdy arkusz osobno) → CSV
- Sync z **Anthropic Files API beta** (jeden raz przy uploadzie, reuse w wielu wywołaniach)
- AI extract summary po uploadzie (~1-3 zdania)
- Pliki dołączane jako attachments w `auto-populate`, `ai-edit`, `apply-design`
- 5 kategorii: `sar_report`, `tech_spec`, `manufacturer_manual`, `declaration_ce`, `other`

### 4.8 Tłumaczenia

- **Auto-tłumaczenie** całego projektu na wszystkie języki projektu jednym przyciskiem
- **Translation memory** cross-project (jeśli ten sam string był tłumaczony w innym projekcie, reuse bez AI call)
- Klucz TM: md5(source_text) → translations per lang
- **Batch translate** — wszystkie języki naraz
- Per-string review (modyfikacja konkretnego tłumaczenia)
- **Side-by-side language compare** w edytorze

### 4.9 Walidacja layoutu

- Auto-walidacja po każdej zmianie (`/api/v4/pages/[id]/validate`)
- Wykrywa: out-of-bounds, naruszenie 3mm marginesu, text overflow (heurystyka), placeholdery DO UZUPEŁNIENIA, image bez image_id, zero dimensions, **overlap**, brak title, **image z opacity < 0.08** (prawie niewidoczny)
- Pole `ai_fixable` na każdym issue (true/false) — `false` dla placeholderów (AI nie powinien wymyślać wartości)
- **„Napraw przez AI"** — przyjmuje listę naprawialnych issues, wysyła do AI z `layout_only=true` (pomija reference docs dla szybkości)
- Walidacja całego projektu pre-export (`/lint`)

### 4.10 Eksport

- **PDF export** z opcjami:
  - Per-page format (każda strona może mieć inne wymiary)
  - **Crop marks** + **bleed 3mm** (do druku offsetowego)
  - **Fold marks** (dla materiałów składanych)
  - **Watermark DRAFT** (semi-transparent, na każdej stronie)
  - **„Approved by"** pieczątka z datą
- **JSON export** — pełen dump struktur do backupu / dalszej obróbki
- **Compliance check** przed eksportem — AI sprawdza zgodność prawną i flaguje brakujące sekcje

### 4.11 Wersje i restore

- Snapshot projektu (na żądanie albo auto przed dużymi operacjami jak Apply DS)
- Lista wersji z labelami i datami
- **Restore** — przywraca poprzedni stan (zachowuje obecny jako nową wersję)

### 4.12 Templates (szablony)

- Toggle `is_template` na projekcie
- Lista szablonów dostępna w wizardzie nowego projektu
- **Clone** — deep copy z zachowaniem struktury, NIE kopiuje reference_docs (file_id reuse) ani translations

### 4.13 Cost Dashboard

- Sumaryczne tokeny i koszt AI per projekt
- Per-endpoint breakdown
- Pokazuje udział cache hits (savings)

### 4.14 Debug / observability

- **Panel debug AI** (nowy) — pełna historia wywołań Claude:
  - System prompt + user prompt + raw response + error
  - Model, max_tokens, temperature, czas, tokens in/out, cache creation/read
  - Badge „prompt edytowany przez usera" gdy nadpisano
  - Filtry: per endpoint, per page, per element
- **Audit log** — kto co edytował kiedy
- **Edit log** — operacje strukturalne (apply DS, apply style, ai fix)

---

## 5. Główne przepływy użytkownika

### Flow 1: Nowy projekt z AI

```
1. Wybierz document_type + device_type + model + języki + (opcjonalnie) plik referencyjny
2. Backend buduje skeleton prompt z legal requirements
3. AI generuje listę stron (page_number, title, template, brief content description) — ~5-10s
4. Frontend w pętli wywołuje /auto-populate per page (Haiku, ~3-5s każda)
5. User wchodzi do edytora, dopracowuje ręcznie + AI assistant
6. Auto-translate na pozostałe języki
7. Apply DS (opcjonalnie)
8. Compliance check + lint
9. Export PDF z crop marks / bleed
```

### Flow 2: Edycja istniejącego projektu

```
1. Otwórz projekt
2. Klikaj elementy, edytuj w panelu Właściwości (ręcznie) lub przez AI per-element
3. Albo: Assistant AI po prawej dla całej strony
4. Albo: Apply Style → inne strony (jeśli jedna strona wygląda dobrze, zastosuj wygląd do reszty)
5. Re-translate jeśli zmieniło się PL
6. Re-export PDF
```

### Flow 3: Adaptacja na nowy język

```
1. Otwórz projekt PL
2. Dodaj język w settings
3. Auto-translate batch (przykład: 200 elementów tekstowych × 6 języków = 1200 tłumaczeń)
4. Translation memory pokrywa ~30-50% (zwroty „Ostrzeżenie", „Specyfikacja techniczna", model codes)
5. User ręcznie review translations w side-by-side compare
6. Apply DS może ponownie żeby spójność layoutu w nowych językach
7. Export per-lang PDF
```

---

## 6. Co już wiemy że jest pain pointem / mocnymi limitami

### 6.1 Z perspektywy AI quality

- **Halucynacje wartości technicznych** — AI próbuje wymyślić wartości SAR / numery norm gdy nie ma reference doc. Częściowo rozwiązane przez placeholdery `DO UZUPEŁNIENIA`, ale nadal się zdarza.
- **Mieszanie modeli** — AI miało skłonność do pisania „GJD.15 / GJD.16" w treści dla projektu który dotyczy tylko jednego modelu. Mitigated przez sekcję „JEDEN MODEL — RYGOR" w system prompcie, ale to brittle (regex check by się przydał).
- **Niespójność stylu między językami** — auto-translate zachowuje treść, ale nie style. Trzeba Apply DS po tłumaczeniu.
- **Nadgenerowanie placeholderów** — AI woli wstawić `DO UZUPEŁNIENIA` niż zaryzykować, nawet gdy ma dane w reference docs.
- **Złe interpretowanie polecenia „popraw kontrast"** — AI patrzy na dane (z_index, color), nie na rendering (overlay obrazków, opacity). Stąd nie zauważa „biały tekst na obrazku" jeśli pod obrazkiem jest ciemny rect.

### 6.2 Z perspektywy UX

- **Brak undo/redo dla operacji AI** — gdy AI popsuje stronę, user musi ręcznie poprawić (jest snapshot via versions, ale to ciężki manual flow).
- **Brak preview „co się zmieni" przed wykonaniem** — AI od razu pisze do bazy. Edit-prompt feature daje wgląd w prompt, ale nie w wynik.
- **Brak A/B comparison wyników AI** — endpoint ab-variants istnieje ale UI jest podstawowe.
- **Per-element AI fix nie ma „undo"** — gdy AI poprawi element niewłaściwie, user musi cofać ręcznie.
- **Brak guided workflow** — system zakłada że user wie co robić. Brak „kreator → krok 1, krok 2, krok 3" z tooltipami.

### 6.3 Z perspektywy technicznej

- **Vercel Hobby 60s cap** — wymusza chunking. Sonnet/Opus 4.7 są ryzykowne (mogą nie zdążyć).
- **Brak background jobs** — wszystko musi być synchroniczne lub robione w pętli client-side z postępem na UI.
- **JSON parse od AI bywa wadliwy** — mamy 5-tap fallback parser (strict → fence-strip → control-char-escape → bracket-extract → truncation-repair), ale to objaw. Lepiej byłoby użyć Anthropic **tool use** z JSON schema żeby Claude zwracał strukturalne dane.
- **Brak telemetrii produkcyjnej** — nie wiemy ile czasu user spędza na każdym kroku, gdzie najczęściej klika „undo" itd.
- **Brak testów** — TypeCheck przechodzi, ale nie ma unit/integration/E2E. Krytyczne dla bezpieczeństwa zmian.
- **Reference docs sync z Anthropic** — gdy plik się zmieni, trzeba ręcznie re-uploadować. Brak versioningu.

### 6.4 Z perspektywy procesu biznesowego

- **Compliance check jest superficial** — AI sprawdza czy są wymagane sekcje, ale nie weryfikuje treści pod kątem prawnym. Brak integracji z bazą norm prawnych.
- **Brak workflow zatwierdzeń** — pole `approved_by` istnieje, ale nie ma faktycznego procesu (approval gate, notyfikacje).
- **Brak roli „tłumacz"** — wszyscy mają wszystko. Brak ról / permissioning.
- **Brak diff'u między językami** — gdy PL się zmieni, trudno zobaczyć co konkretnie wymaga retłumaczenia.
- **Brak integracji z drukarnią** — eksport PDF kończy proces. Nikt nie wie czy druk się zaczął, kto zatwierdził, kiedy dostawa.

---

## 7. Endpointy API (51) — kompletna lista

```
# Projekty
POST   /api/v4/projects                        — lista
GET    /api/v4/projects/[id]                   — szczegóły
POST   /api/v4/projects/generate               — generowanie skeletonu z AI
POST   /api/v4/projects/[id]/clone             — klonuj projekt/template
POST   /api/v4/projects/[id]/approve           — zatwierdź (approved_by, approved_at)
POST   /api/v4/projects/[id]/toggle-template   — toggle is_template
POST   /api/v4/projects/[id]/import            — import JSON
GET    /api/v4/projects/[id]/edit-log          — historia edycji
GET    /api/v4/projects/[id]/ai-history        — historia AI (legacy)
GET    /api/v4/projects/[id]/ai-calls          — pełna historia wywołań AI (debug)

# Strony
GET    /api/v4/projects/[id]/pages
GET    /api/v4/pages/[pageId]                  — szczegóły strony z elementami
POST   /api/v4/pages/[pageId]/auto-populate    — AI generuje elementy dla strony
POST   /api/v4/pages/[pageId]/ai-edit          — AI edytuje całą stronę
POST   /api/v4/pages/[pageId]/ai-edit-stream   — j.w. ze streamingiem
POST   /api/v4/pages/[pageId]/ai-edit/preview-prompt  — zwraca prompt bez wywoływania AI
POST   /api/v4/pages/[pageId]/edit-prompt      — legacy: generuje prompt do skopiowania
POST   /api/v4/pages/[pageId]/replace-elements — manual paste of AI output
POST   /api/v4/pages/[pageId]/apply-design     — apply DS per page
POST   /api/v4/pages/[pageId]/apply-style      — apply page style do innej strony
POST   /api/v4/pages/[pageId]/explain          — AI wyjaśnia decyzję dla tej strony
POST   /api/v4/pages/[pageId]/validate         — walidacja layoutu
POST   /api/v4/pages/[pageId]/ab-variants      — generuj 2 warianty (różne temperature)

# Elementy
POST   /api/v4/pages/[pageId]/elements
PATCH  /api/v4/elements/[elementId]
DELETE /api/v4/elements/[elementId]
POST   /api/v4/pages/[pageId]/elements/[elementId]/ai-fix  — popraw 1 element

# Design Systems
GET    /api/v4/projects/[id]/design-systems
POST   /api/v4/projects/[id]/design-systems/[dsId]
POST   /api/v4/projects/[id]/apply-design-prompt  — generuj prompt do apply DS

# Obrazki
POST   /api/v4/projects/[id]/images
DELETE /api/v4/images/[imageId]
POST   /api/v4/projects/[id]/image-mapping/preview — AI sugeruje image→page mapping
POST   /api/v4/projects/[id]/image-mapping/apply

# Pliki referencyjne
POST   /api/v4/projects/[id]/reference-docs
POST   /api/v4/projects/[id]/reference-docs/upload-url  — signed URL dla direct upload
DELETE /api/v4/reference-docs/[docId]

# Notatki AI
GET/POST/DELETE  /api/v4/projects/[id]/ai-notes
POST   /api/v4/ai-notes/suggest                — AI sugeruje nowe notatki

# Tłumaczenia
GET/POST /api/v4/projects/[id]/translations
POST   /api/v4/projects/[id]/translate
POST   /api/v4/projects/[id]/translate-prompt

# Wersje
GET/POST /api/v4/projects/[id]/versions
POST   /api/v4/projects/[id]/versions/[verId]/restore

# Eksport
POST   /api/v4/projects/[id]/export-pdf
GET    /api/v4/projects/[id]/export-json
POST   /api/v4/projects/[id]/lint
POST   /api/v4/projects/[id]/compliance-check

# Inne
GET    /api/v4/templates                       — lista templates dostępnych
GET    /api/v4/models                          — lista dostępnych modeli AI
GET    /api/v4/status                          — mode (auto/manual)
GET    /api/v4/metrics                         — koszty / stats
```

---

## 8. Komponenty UI (kluczowe)

- `Gen4Editor` — główny canvas + toolbar + assistant AI (3200 linii)
- `Gen4DesignSystemPanel` — DS CRUD + apply
- `Gen4NotesPanel` — notatki AI
- `Gen4ReferenceDocsPanel` — pliki referencyjne
- `Gen4ImagePanel` — biblioteka obrazków
- `Gen4TranslationsPanel` — tłumaczenia + batch
- `Gen4ExportPanel` — opcje eksportu PDF
- `Gen4VersionsPanel` — wersje + restore
- `Gen4AuditPanel` — audit log
- `Gen4CostDashboard` — koszty AI
- `Gen4AiDebugPanel` — debug wywołań AI

---

## 9. Pytania dla research modela (CO MAMY ZROBIĆ DALEJ)

Proszę o analizę pod kątem konkretnych, ułożonych w priorytecie ulepszeń. Każde ulepszenie z:

- **(a)** opisem problemu który rozwiązuje
- **(b)** propozycją rozwiązania (architekturalnie + krok po kroku)
- **(c)** szacowanym wpływem (high/medium/low) na: jakość outputu, czas pracy usera, redukcję błędów
- **(d)** szacowanym wysiłkiem implementacji (S/M/L/XL)
- **(e)** zależnościami / wymaganiami zewnętrznymi

### Konkretne obszary do przeanalizowania:

1. **Jakość outputu AI** — jak osiągnąć żeby AI:
   - Nie halucynował wartości technicznych
   - Konsekwentnie używał jednego modelu/marki w treści
   - Rozumiał rendering wizualny (nie tylko strukturę danych)
   - Lepiej radził sobie z layoutem (typografia, hierarchia, biały kontrast)
   - Mógł generować content kierowany do różnych grup wiekowych (dzieci, seniorzy)

2. **Wydajność i koszt AI** — co możemy zrobić aby:
   - Zmniejszyć liczbę wywołań Claude (dziś każda strona = osobny call)
   - Wykorzystać prompt caching lepiej (które prompty mogą się dłużej cache'ować)
   - Wybrać optymalny model per zadanie automatycznie (Haiku dla geometry, Sonnet dla treści, Opus dla compliance)
   - Wykorzystać Anthropic batch API (50% taniej) dla operacji nie-realtime
   - Wykorzystać Anthropic tool use / structured outputs zamiast naszego JSON-parsera

3. **UX procesu tworzenia dokumentu** — jak zmniejszyć friction:
   - Better onboarding (pierwszy projekt) — brak tutorial dziś
   - Templates flow (więcej templates, lepsza klasyfikacja)
   - Guided wizard (krok-po-kroku zamiast „wszystko naraz")
   - Real-time preview podczas AI generation (mamy stream, ale nie ma porównania z poprzednią wersją)
   - Better diff/undo dla operacji AI

4. **Workflow tłumaczeń i wielojęzyczności** — co usprawnić:
   - Wykrywanie zmian PL które wymagają re-tłumaczenia (delta)
   - Glosariusz/style guide per język (terminologia produktowa Locon)
   - QA dla tłumaczeń (np. czy tłumaczenie mieści się w boxie, czy zachowuje numery porządkowe)
   - Wbudowany review workflow z tłumaczem (komentarze, approve per string)

5. **Zgodność prawna i compliance** — jak zwiększyć pewność:
   - Integracja z bazą norm (CE marking, RoHS, RED 2014/53/EU, RODO, MDR)
   - Auto-update szablonów gdy zmienią się przepisy
   - Walidacja semantyczna treści (nie tylko obecność sekcji, ale ich jakość)
   - Audytowalny ślad zmian per regulacja

6. **Proces zatwierdzeń i integracja z drukarnią** — co dodać:
   - Multi-step approval (designer → product manager → legal → final)
   - Email notifications na zmianę stanu
   - Eksport z metadanymi do drukarni (printer-ready PDF specs)
   - Tracking statusu druku/dostawy

7. **Skalowanie systemu** — jak przejść z 1-3 userów do 10+:
   - Role i permissioning (designer / translator / approver / admin)
   - Workflow per role (translator widzi tylko strings, designer widzi tylko layout)
   - Multi-tenant (różne marki / brandy w jednym systemie)

8. **Niezawodność i jakość kodu** — co dodać:
   - Test suite (unit + integration + E2E) — dziś zero
   - Migracja z Vercel Hobby na Pro/Enterprise (background jobs, dłuższe funkcje)
   - Monitoring (Sentry, OpenTelemetry)
   - CI/CD z type check + tests + smoke tests

9. **Konkretne braki w obecnym kodzie** — z perspektywy refactoringu:
   - `Gen4Editor.tsx` ma 3200 linii — co da się wydzielić
   - System prompty są inline w endpointach (`v4Edit.ts`, `v4ApplyDs.ts`) — wymagają sterowania wersjami i porównań
   - Brak typowanych odpowiedzi z AI (używamy `parseJsonFromAi<T>` z 5 fallbackami) — czy tool use rozwiązałby to elegancko
   - Tabela `gen4_ai_calls` rośnie szybko — czy nie potrzeba retention policy / partitioning

10. **Innowacyjne ulepszenia produktowe** — czego nie pomyśleliśmy:
    - AI vision dla weryfikacji wydrukowanego PDF vs. design
    - AI sugestie A/B testów (np. „spróbuj zmienić kolejność sekcji 3 i 4 — może lepiej działać")
    - Eksport do innych formatów (HTML interaktywny, ePub, app deep link)
    - AI sugestie dotyczące „głosu marki" (czy treść brzmi spójnie z innymi materiałami Locon)
    - Integracja z systemami zewnętrznymi (ERP, PIM, CRM Locon)

---

## 10. Co NIE jest w zakresie tego research

- Konkretne wybory bibliotek frontowych (zostajemy przy React/Next.js)
- Migracja na inną platformę chmurową (zostaje Vercel + Supabase)
- Zmiana modelu AI providera (zostajemy przy Anthropic Claude)

---

## 11. Format oczekiwanej odpowiedzi

Sugerowany szablon dla każdego ulepszenia:

```markdown
### [Priorytet #N] Tytuł ulepszenia

**Problem:** [1-2 zdania]
**Rozwiązanie:** [3-5 zdań, ewentualnie krok po kroku]
**Wpływ:**
  - Jakość outputu: high/medium/low
  - Czas usera: high/medium/low
  - Redukcja błędów: high/medium/low
**Wysiłek implementacji:** S (do 1 dnia) / M (2-3 dni) / L (1-2 tyg) / XL (>2 tyg)
**Zależności:** [biblioteki, API, decyzje biznesowe]
**Przykład:** [opcjonalnie — konkretny kod / mock UI]
```

Na końcu **lista TOP 5 ulepszeń** które dają największy ROI — z uzasadnieniem dlaczego właśnie te.

---

**Koniec briefu. Czekamy na deep research.**
