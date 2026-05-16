# Audyt halucynacji w testach z 15-16.05.2026

Po wpadce z PDF eksportem (`embedFont {subset:true}` rozsypał litery, mimo że test podawał "9/10 polskich słów found"), przeglądam każdy test pod kątem: **czy ten test mógł zwrócić PASS w sytuacji gdy feature jest faktycznie zepsuty?**

Kategorie ryzyka:
- 🟢 **REAL** — test sprawdza realny user-facing output (binary parsable, DB state, semantic content)
- 🟡 **PARTIAL** — test sprawdza coś realnego ale wąsko (np. tylko strukturę, nie jakość)
- 🔴 **HALUCYNACJA** — test może dać PASS przy zepsutej funkcji

---

## Unit tests (85, vitest)

| Plik | TC | Co sprawdza | Risk |
|------|----|------------|------|
| `v4Validate.test.ts` | 11 | bounds math (mm × scale → px) | 🟢 REAL — pure math |
| `v4Schemas.test.ts` | 20 | Zod schema parsing struktura | 🟢 REAL — strict parse |
| `v4Generate.test.ts` | 13 | prompt builders string interpolation | 🟡 PARTIAL — testuje string composition, nie czy AI rozumie prompt |
| `v4FileExtract.test.ts` | 5 | DOCX/XLSX → text dispatcher | 🟡 PARTIAL — testuje routing po mime, nie quality ekstrakcji |
| `v4TranslationMemory.test.ts` | 3 | cache hit/miss logic | 🟢 REAL — pure logic |
| `v4AiProviders.test.ts` | 4 | inferProvider(modelId) routing | 🟢 REAL — pure logic |
| `v4PdfChunk.test.ts` | 7 | chunkPdfIndices() math + edge cases | 🟢 REAL — pure logic |
| `v4ApplyDs.test.ts` | 6 | DS constants invariants | 🟡 PARTIAL — testuje że JSON ma keys, nie czy AI wygeneruje DS zgodny z nim |

**Werdykt:** Unit testy są pozornie OK ale **żaden nie testuje renderingu** (czyli właśnie tego co zawiodło w PDF eksporcie). Pure logic tests są realne; testy promptów/schemas są ograniczone do struktury.

---

## Smoke tests (11, smoke.mjs)

| TC | Co sprawdza | Risk |
|----|------------|------|
| 1. status | HTTP 200 + keys (project/counts/issues) | 🟢 REAL |
| 2. placeholders | HTTP 200 + count number | 🟢 REAL |
| 3. pages list | array + length>0 | 🟢 REAL |
| 4. reference-docs list | array | 🟢 REAL |
| 5. images list | array | 🟢 REAL |
| 6. regenerate-toc | ok + entries_count number | 🟡 PARTIAL — nie sprawdza CZY entries są sensowne |
| 7. find-replace dry | ok + matches_count | 🟢 REAL |
| 8. resummarize-all idempotent | bez błędu lub "skipped" | 🟡 PARTIAL — nie sprawdza CZY summary jest sensowny |
| 9. export-json | project + pages array | 🟢 REAL |
| **10. export-pdf** | **HTTP 200 + magic %PDF + size>1KB** | **🔴 HALUCYNACJA — TUTAJ WPADKA** |
| 11. categorize-all started event | SSE 'event: started' w 2KB | 🟢 REAL (testuje tylko że stream startuje) |

**Werdykt:** Smoke są pozornie wide ale **tylko 1 z 11 testów dotykał wizualnego outputu** (test 10) — i właśnie ten był halucynacją bo sprawdzał TYLKO że bajty zaczynają się od `%PDF`.

---

## Integration tests (12, wykonane manualnie via curl/bash)

| TC | Co sprawdza | Risk | Komentarz |
|----|------------|------|-----------|
| 1. status | HTTP + JSON struktura | 🟢 REAL |
| 2. placeholders listing | array of {id, key, label} | 🟢 REAL |
| 3. find-replace dry-run | matches array | 🟢 REAL |
| 4. regenerate-toc | DB after: 18 entries, page_id IS NOT NULL | 🟡 PARTIAL — DB count realne, ale czy entries są właściwe nazwy sekcji? nie sprawdzane |
| 5. resummarize idempotent | 2nd call: 0 plików | 🟢 REAL — DB delta |
| 6. categorize-all SSE | events parsed | 🟡 PARTIAL — strumień ok, ale czy CATEGORIES są sensowne? nie sprawdzane |
| 7. autofill placeholders | DB: 13→11 placeholders | 🟢 REAL — DB delta |
| 8. ai-quick shorten | old_content=119, new_content=100 | 🟢 REAL — response body |
| **9. auto-categorize-images** | **3 images opisy, suggested_page=null** | **🟡 PARTIAL — opis tekstowy widoczny, ale nie sprawdzano CZY trafnie kategoryzuje** |
| **10. export-pdf** | **15.4 MB, magic %PDF** | **🔴 HALUCYNACJA — fixed dziś** |
| 11. post-autofill verify | DB: 11 jeszcze nie wypełnionych | 🟢 REAL — DB delta |
| 12. ai-batch-edit no-op | response.no_op=true | 🟢 REAL |

**Werdykt:** Z 12 integration testów — 1 halucynacyjny (PDF), 3 partial. Najwięcej luki w testach **wizualnej/semantycznej jakości** outputów AI (TOC entries, image kategorie, summary tekst).

---

## Co WCALE NIE BYŁO TESTOWANE (luki)

1. **Visual quality wygenerowanych stron** — czy auto-populate strony 5 (Krok 1: Naładuj) rzeczywiście wstawia sensowną treść kroku, czy generic placeholder?
2. **Apply-DS visual impact** — czy strona po `apply-design` rzeczywiście wygląda lepiej, czy tylko bounds-OK?
3. **TOC visual** — czy TOC w PDF wygląda jak TOC z page numbers, czy losowe slowa?
4. **Magic All-In-One E2E** — feature dodany jako 1-button experience, nigdy nie wykonany end-to-end
5. **AI Command Bar semantyka** — naturalne instrukcje "zmień wszystkie kolory na ciemniejsze" — nigdy nie sprawdzane czy AI rozumie
6. **Translation memory hit-rate** — czy cache faktycznie ratuje koszty per 1 call w prod

---

## Plan naprawy

1. **Realny visual test PDF** — `tests/e2e/page-visual-via-proxy.mjs` przez prod endpoint `POST /api/v4/debug/visual-pdf` (Claude Vision per-page)
2. **Visual audit poszczególnych stron** — strony 1 (cover), 2 (TOC), 5 (Krok 1), 12 (regen)
3. **Pełne re-run smoke + integration** ze świeżego PDF z prod (po fix subsetting commit e39d04a)
4. Niefixowane luki (#3-6) zostawić jako TODO follow-up — wymagają oddzielnych testów semantycznych.
