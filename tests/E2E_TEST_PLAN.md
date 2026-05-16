# Plan pogłębionych testów — Generator Instrukcji v4

Cel: kompletne pokrycie funkcjonalności od smoke po full regression. Pięć warstw, od szybkich (10 min) po pełne (3-4 h).

---

## Layer 1 — Smoke tests (~10 min, automated)

**Cel:** Sprawdzić że wszystkie endpointy odpowiadają HTTP 200 i zwracają sensowne dane.

**Wykonane (16.05.2026):** 12/12 testów przeszło, 1 minor bug znaleziony i naprawiony (`ai-edit` 0-patches no-op).

**Kategoria endpointów (16 nowych dziś + 5 istniejących):**

### Read-only
- [ ] `GET /api/v4/projects/[id]/status` — agregaty (counts/issues/cost/completeness)
- [ ] `GET /api/v4/projects/[id]/placeholders` — lista DO UZUPEŁNIENIA
- [ ] `GET /api/v4/projects/[id]/pages/` — lista stron
- [ ] `GET /api/v4/projects/[id]/reference-docs/` — lista plików
- [ ] `GET /api/v4/projects/[id]/images/` — lista obrazków
- [ ] `GET /api/v4/projects/[id]/translations/` — tłumaczenia
- [ ] `GET /api/v4/pages/[id]/elements/` — elementy strony
- [ ] `GET /api/v4/pages/[id]/validate` — walidacja layoutu
- [ ] `GET /api/v4/debug/attachments?projectId=X` — diagnostyka attachments
- [ ] `GET /api/v4/projects/[id]/export-pdf?lang=pl` — PDF binary
- [ ] `GET /api/v4/projects/[id]/export-json` — JSON eksport

### Mutating — pojedynczy element
- [ ] `POST /api/v4/elements/[id]/ai-quick` (6 actions: shorten/expand/fix-grammar/improve/simplify/translate)
- [ ] `PATCH /api/v4/elements/[id]` — properties update
- [ ] `DELETE /api/v4/elements/[id]`

### Mutating — pojedyncza strona
- [ ] `POST /api/v4/pages/[id]/auto-populate` — generate elements
- [ ] `POST /api/v4/pages/[id]/ai-edit` — instruction-based edit
- [ ] `POST /api/v4/pages/[id]/apply-design` — apply DS
- [ ] `POST /api/v4/pages/[id]/apply-style` — copy style from page
- [ ] `POST /api/v4/pages/[id]/validate` z fix=true — auto-fix issues
- [ ] `POST /api/v4/pages/[id]/duplicate` — duplikuj stronę
- [ ] `POST /api/v4/pages/[id]/replace-elements` — pełen replace

### Mutating — bulk (SSE)
- [ ] `POST /api/v4/projects/[id]/regenerate-toc` — deterministic TOC
- [ ] `POST /api/v4/projects/[id]/resummarize-all` (?force=1) — bulk Gemini
- [ ] `POST /api/v4/projects/[id]/regenerate-pages` (?from=N) — bulk auto-populate
- [ ] `POST /api/v4/projects/[id]/categorize-all` — bulk auto-categorize
- [ ] `POST /api/v4/projects/[id]/autofill-placeholders` — fill z extracted
- [ ] `POST /api/v4/projects/[id]/find-replace` (dry + apply)
- [ ] `POST /api/v4/projects/[id]/reorder-pages` — atomic
- [ ] `POST /api/v4/projects/[id]/auto-categorize-images` — Vision
- [ ] `POST /api/v4/projects/[id]/fix-all-issues` (?from=N) — bulk fix
- [ ] `POST /api/v4/projects/[id]/ai-batch-edit` — natural language instruction
- [ ] `POST /api/v4/projects/[id]/translate` — bulk translation
- [ ] `POST /api/v4/projects/[id]/clone` — clone project

### File operations
- [ ] `POST /api/v4/reference-docs/[id]/resummarize` — single Gemini
- [ ] `POST /api/v4/reference-docs/[id]/categorize` — single categorize
- [ ] `POST /api/v4/reference-docs/[id]/extract-structured` (SSE) — per-kind extract

**Test harness:** plain curl + bash. Każdy endpoint = 1 sprawdzenie HTTP code + 1-2 expected pole w JSON response.

---

## Layer 2 — Integration tests (~30 min, automated)

**Cel:** Sprawdzić cross-feature flow, gdzie wynik jednego endpointa konsumowany jest przez drugi.

### IT-1: Full lifecycle projektu (create→upload→process→edit→export)
1. POST `/projects/generate` z minimalnym input → projekt + szkielet
2. Upload 2 plików (PDF SAR + DOCX deklaracja) przez signed URL
3. Polling /reference-docs/ → sprawdź `anthropic_file_id` + `extracted_summary` po ~10s
4. POST `/categorize-all` → sprawdź że PDF dostał `kind=sar_report`
5. POST `/extract-structured` na SAR → sprawdź `extracted_structured.sar_head_max`
6. POST `/regenerate-pages?limit=3` → sprawdź że strony mają elementy
7. POST `/autofill-placeholders` → sprawdź spadek `text_placeholders`
8. POST `/regenerate-toc` → sprawdź 18 entries
9. GET `/export-pdf` → sprawdź size > 5KB, content-type, magic bytes

**Expected:** zero błędów, każdy krok produkuje deltę widoczną w `/status`.

### IT-2: Undo/Redo z AI edits
1. Create projekt z 1 stroną
2. Insert element ręcznie → snapshot
3. POST `/ai-edit` z instrukcją → AI changes
4. Undo (replace-elements ze snapshotem) → element zachowany
5. Redo (replace-elements z AI result) → AI changes wracają
6. Sprawdź `pushHistory` count w client state

### IT-3: Concurrency (parallel auto-populate)
1. Create projekt z 10 stronami
2. Parallel: 5 wywołań `/pages/[id]/auto-populate` na różne strony
3. Wait dla wszystkich response
4. Sprawdź że każda strona ma elementy (no race conditions w gen4_elements)

### IT-4: Multi-language flow
1. Create projekt w PL
2. POST `/translate` z lang=bg → sprawdź `gen4_translations` ma entries dla wszystkich text elements
3. GET `/translations?lang=bg` → coverage 100%
4. GET `/export-pdf?lang=bg` → PDF z bułgarską treścią
5. POST `/translate` lang=hr → cache TM (translation memory) używa BG jako reference

### IT-5: Idempotency wszystkich bulk endpoints
1. Run /resummarize-all → wszystkie fresh
2. Re-run /resummarize-all → "Brak plików do resummarize"
3. Run /categorize-all → wszystkie skategoryzowane
4. Re-run /categorize-all → skipuje
5. Run z ?force=1 → wymusza re-run

### IT-6: Magic All-In-One chain
1. Create projekt z 5 plikami (mixed PDF/DOCX/XLSX)
2. Klik Magic All-In-One (6 endpointów w pętli)
3. Po ~3-5 min: sprawdź że
   - 100% files have summaries
   - 90%+ files have correct kind
   - >50% placeholders filled
   - 0 layout errors
   - TOC reflects current pages

**Test harness:** Node script (lub Vitest test z `vi.fetch` mock-free przeciw prod URL).

---

## Layer 3 — E2E Browser (Playwright / Vercel Agent Browser, ~1h)

**Cel:** Symulować realnego użytkownika klikającego w UI.

### B-1: Wizard flow
1. Navigate `/ai/new`
2. Fill: name, modelCode, modelName, documentType=qsg_full, deviceType=watch_kid
3. Drag & drop 3 PDFy w drop zone → expect thumbnails
4. Click "Stwórz projekt (AI)" → wait for progress steps
5. Redirect to `/ai/projects/[id]` → expect 20+ stron w sidebarze

### B-2: Editor interactions
1. Open existing project
2. Click element → expect selection (blue border)
3. Drag element → expect smart guides
4. Right-click → expect context menu z 7 opcjami
5. Ctrl+C, Ctrl+V → expect duplicate +2mm offset
6. Ctrl+Shift+Z → expect redo (po wcześniejszym Ctrl+Z)
7. Ctrl+F → expect Find/Replace modal
8. Ctrl+A → expect multi-select banner z 5+ buttons (Align/Distribute/...)

### B-3: AI Command Bar
1. Click "Presety" dropdown → wybierz "Pogrub nagłówki"
2. Input wypełnia się tekstem instrukcji
3. Click "▶ Wykonaj"
4. Wait dla progress
5. Sprawdź że tytuły stron rzeczywiście pogrubione (font-weight w properties)

### B-4: Page reorder drag&drop
1. Sidebar pages list: drag page 5 nad page 3
2. Drop → expect API call /reorder-pages
3. List re-render z nowym order
4. TOC odświeżony (lub wymaga manualnego klick "🔄 Spis treści")

### B-5: Image clipboard paste
1. Take screenshot system-wide
2. Focus na editor canvas (NOT input/textarea)
3. Ctrl+V → expect upload do gen4_images
4. Open "Biblioteka obrazków" tab → expect new image z timestamp filename

### B-6: Multi-language preview side-by-side
1. Editor toolbar select "🌍 Porównaj… + BG"
2. Canvas split na 2 kolumny
3. Right pane pokazuje stronę przetłumaczoną na BG
4. Edit text w left (PL) → right pane pokazuje stary BG (nie auto-translate)
5. Trigger `/translate` dla strony → BG się odświeża

**Test harness:** Playwright Test (already in monorepo? sprawdź `e2e/` dir) + headless Chromium z proxy_secret w cookies.

---

## Layer 4 — Stress + Edge cases (~1h, automated)

**Cel:** Złamać system intencjonalnie.

### E-1: Bardzo duże pliki PDF
- Upload 19MB PDF (limit Gemini 20MB) → expect summary OK, extract OK
- Upload 25MB PDF (over limit) → expect "file too large" error message
- Upload 1153-page PDF (Appendix WCDMA Blocking) → expect chunking + Claude text fallback

### E-2: Zepsute pliki
- Upload pseudo-PDF (random bytes z `.pdf` ext) → expect graceful error
- Upload encrypted PDF (password-protected) → expect tolerant loader fallback
- Upload DOCX bez headerów → expect prepareFileForAi error

### E-3: Concurrency
- 10 parallel `/auto-populate` na różne strony tego samego projektu
- 5 parallel uploadów do `/reference-docs/upload-url/`
- Race: 2 użytkowników edytujących ten sam element w tym samym czasie (last-write-wins)

### E-4: Stress liczbowy
- Projekt z 50 stronami × 30 elementów = 1500 elementów
- Bulk `/regenerate-pages` → expect chunking pattern (next_offset) działa
- Time-to-completion < 10 min total (multiple chunks)
- Memory footprint OK (no Vercel OOM)

### E-5: Network failures
- Disable Gemini API key → expect 503 z message
- Simulate Anthropic 429 → expect retry chain działa (3 attempts, fallback model)
- Vercel function timeout (300s) → expect SSE pre-completion warning

### E-6: Schema edge cases
- Element z `properties.content` zawierającym specjalne znaki Unicode (emoji, chińskie)
- Element x_mm=0, y_mm=0 (na krawędzi)
- Page z 100 elementami (overflow validation)
- DS jsonb z modelName="GOAT" → sprawdź sanitizeDsForPrompt

**Test harness:** k6 / Locust dla concurrency. Specjalne pliki test fixtures w `tests/fixtures/`.

---

## Layer 5 — Manual UX/UI Quality (~1h, wymaga user)

**Cel:** Subiektywna ocena czy AI generuje **dobrej jakości** treść.

### Q-1: AI output quality
- Wygeneruj QSG dla GJD.17 (nowy model) od zera
- **Subiektywna ocena:**
  - Czy nagłówki sensowne? (10 stron × 1 nagłówek = 10 ocen)
  - Czy treść body jest gramatyczna i polska? (10 stron × ~50 słów = check)
  - Czy diakrytyki zachowane? (grep `ą|ę|ł|ó|ś|ź|ż` w content)
  - Czy ostrzeżenia sensowne dla device_type=watch_kid?
  - Czy SAR values są EXACT z raportu (0.414 W/kg) lub placeholderem (nie zmyślone)?

### Q-2: Visual quality
- Otwórz każdą stronę w preview (Cmd+P)
- Sprawdź czy elementy się nie nakładają
- Sprawdź czy obrazki są ostre w eksporcie PDF (grayscale conversion)
- Sprawdź czy fonty są czytelne przy zoom 6× (real druk to ~3× zoom max)

### Q-3: Print test
- Export PDF dla projektu
- Wydrukuj 1 stronę na lokalnej drukarce (76×76 mm = 3×3 inch)
- Sprawdź:
  - Czy margins 3mm respektowane (nic nie obcięte przez drukarkę)
  - Czy linie są ciągłe (nie pikselowane)
  - Czy obrazki w skali szarości (nie kolor)

### Q-4: Multilingual quality
- Wygeneruj QSG po PL, BG, HR
- Native speaker review (jeśli dostępny) lub Google Translate back-check
- Sprawdź czy GJD.16 / specific numbers zostały zachowane (nie przetłumaczone)

---

## Test data fixtures

```
tests/fixtures/
├── projects/
│   ├── minimal.json          # 1-strona projekt
│   ├── full-gjd16.json       # 20-stronowy QSG z extracted_structured
│   └── stress-50pages.json   # 50 stron stress test
├── pdfs/
│   ├── sar-typical.pdf       # 50-page SAR (~5MB)
│   ├── sar-huge.pdf          # 500-page SAR (~15MB)
│   ├── docx-converted.txt    # po prepareFileForAi
│   └── corrupted.pdf         # losowe bajty
├── images/
│   ├── watch-front.png       # smartwatch frontal
│   ├── watch-back.png        # styki ładowania
│   └── screenshot-app.jpg    # interface aplikacji
└── design-systems/
    ├── locon-default.json    # marka Locon
    └── empty.json            # bez tokenów
```

---

## Coverage matrix

Aktualne pokrycie testów (Vitest unit tests w `lib/`):

| File | LOC | Test Coverage |
|---|---|---|
| `lib/v4Validate.ts` | 238 | ✓ 4 testów (validatePage all branches) |
| `lib/v4Schemas.ts` | 280 | ✓ 7 testów (PatchOp, SAR, TechSpec, Decl, Manual, Generic, Callouts) |
| `lib/v4Generate.ts` | 380 | ✓ 5 testów (renderImages, loadProject, buildSystem) |
| `lib/v4FileExtract.ts` | 110 | ✓ 5 testów (PDF/DOCX/XLSX prepare) |
| `lib/v4TranslationMemory.ts` | 90 | ✓ 3 testów (lookup, save, increment) |
| `lib/v4AiProviders.ts` | 65 | ✓ 4 testów (dispatcher, fallback) |
| **Razem** | ~1200 | **28 unit testów** |

**Brakuje (pokrycie ~30% lines):**
- `lib/anthropic.ts` (Anthropic client + attachments) — KRYTYCZNE
- `lib/v4Edit.ts` (page edit operations) — WYSOKIE
- `lib/v4ApplyDs.ts` (apply design system) — WYSOKIE
- `lib/v4Translate.ts` (translation prompt builder) — ŚREDNIE
- `lib/v4Gemini.ts` (Gemini client + retry) — ŚREDNIE
- `lib/v4PdfChunk.ts` (PDF chunking + tolerant loader) — KRYTYCZNE
- `lib/v4Images.ts`, `lib/v4ReferenceDocs.ts`, `lib/v4Notes.ts`, `lib/v4AiLog.ts` — niskie

---

## Plan implementacji testów (priorytety)

### Sprint 1 (1-2 dni) — automated smoke + integration
1. `tests/e2e/smoke.test.ts` — Vitest skript wywołujący wszystkie endpointy przez fetch
2. `tests/e2e/integration.test.ts` — Lifecycle IT-1 + IT-5 (full flow + idempotency)
3. CI workflow: dodać `npm run test:e2e` na każdy push (po unit tests)
4. Cleanup: po każdym test runs, usuń `gen4_projects.name LIKE 'TEST-%'`

### Sprint 2 (2-3 dni) — coverage podniesienie do 60%
1. Unit testy `lib/v4PdfChunk.ts` (tolerant loader + chunkPdf + extractPdfText)
2. Unit testy `lib/anthropic.ts` (buildAttachmentBlocks z mocked Supabase + Anthropic SDK)
3. Unit testy `lib/v4Edit.ts` (loadPageWithElements, ownPage, replacePageElements)
4. Unit testy `lib/v4ApplyDs.ts` (commonRules z mock dimensions, sanitizeDsForPrompt)

### Sprint 3 (3-4 dni) — Playwright E2E
1. Install Playwright (`npm install -D @playwright/test`)
2. Setup baseURL = production alias + cookie injection
3. Tests B-1 do B-6 jako .spec.ts files
4. CI: nightly run Playwright (osobny workflow)

### Sprint 4 (1-2 dni) — Stress + Edge
1. k6 script (`tests/stress/concurrency.js`)
2. Edge case fixtures w `tests/fixtures/`
3. Manual fuzz testing 1h

### Sprint 5 (1 dzień) — Manual UX/UI checklist
1. Markdown checklist z 30+ point każdy
2. Native speaker review form (Google Form?)
3. Print test protocol

---

## Acceptance criteria

Projekt jest "production-ready" gdy:
- [ ] Smoke tests: 100% PASS (zero 4xx/5xx errors)
- [ ] Integration tests: 100% PASS
- [ ] Unit test coverage: >= 60% lines (aktualne ~30%)
- [ ] E2E browser tests: >= 90% PASS (10% acceptable flaky)
- [ ] Stress test: 50-page project completion <10 min total
- [ ] Manual quality review: 80%+ pozytywnych ocen native speakers
- [ ] CI green for 7 dni z rzędu

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Vercel 300s timeout dla bulk | Chunking pattern + next_offset (już zaimplementowane) |
| Anthropic 5MB request limit | Zero attachments per-page (już zaimplementowane) |
| Gemini quota exhaustion | Retry chain + Claude fallback (już zaimplementowane) |
| PDF compressed xref | pdf-parse v1 + raw regex fallback (już zaimplementowane) |
| Concurrent edits | Last-write-wins; jeśli problem → row versioning w gen4_elements |
| Test data accumulation | Cleanup script per test run |
| AI cost explosion | Cost monitor w status (już zaimplementowane), alerts > $X |

---

**Sporządzono:** 2026-05-16 (auto-generated po smoke E2E)
**Stan implementacji:** Layer 1 done (smoke 12/12 PASS); Layers 2-5 TBD.
