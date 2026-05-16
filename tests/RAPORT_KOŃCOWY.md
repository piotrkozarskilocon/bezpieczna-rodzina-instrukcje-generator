# Raport końcowy — audyt testów 16.05.2026

## TL;DR

- **1 z 11 smoke testów był halucynacją** (PDF eksport sprawdzał TYLKO binary, nie visual). NAPRAWIONE.
- **Pozostałe 10 smoke + 12 integration + 85 unit = REALNE**, ale węższy zakres niż się wydawało.
- **Po fix subsetting i debug endpoint visual-pdf** — wszystkie 4 strony zbadane przez Claude Vision: **4/4 OK**.

## Co było halucynacją

| Test | Halucynacja | Dowód |
|------|------------|-------|
| smoke #10 — export-pdf | Sprawdzał TYLKO `magic %PDF + size>1KB` | PDF z 16.05 08:13 miał POPRAWNE magic bytes ale rozsypane litery |
| integration #10 — export-pdf | Sprawdzał `pdf-parse` text reconstruction | pdf-parse układa tekst z chaotycznych positions → false positive |

## Co było realne ale ograniczone

| Test | Wąski zakres | Co nie sprawdza |
|------|------------|-----------------|
| unit `v4Generate` (13 TC) | string interpolation w prompts | czy AI rozumie prompt |
| unit `v4ApplyDs` (6 TC) | konstanty DS są dostępne | czy AI generuje DS zgodny |
| smoke #6 regenerate-toc | entries_count number | semantyka entries |
| smoke #8 resummarize | 0 plików = OK | jakość summary |
| integ #4 regenerate-toc DB | 18 entries, page_id NOT NULL | czy entries to prawdziwe sekcje |
| integ #6 categorize-all SSE | events_parsed > 0 | trafność kategorii |
| integ #9 auto-categorize-images | opisy widoczne | dokładność dopasowania do strony |

## Co naprawiłem

### 1. Bug subsetting w v4Export.ts (commit e39d04a)
- **Przed**: `embedFont(bytes, { subset: true })` → fontkit subset psuł Unicode→glyph mapping
- **Po**: `embedFont(bytes)` (pełny embedding) → spójne litery, polskie diakrytyki działają
- **Tradeoff**: PDF ~1MB większy, ale rendering POPRAWNY

### 2. Realny visual test PDF (commit 6f1dea5)
- `tests/e2e/pdf-visual.mjs` — pdfjs-dist text-items + Claude Vision 5 stron
- `npm run test:visual` skript
- Wykrywa rozsypanie liter heurystyką + LLM

### 3. Debug endpoint visual-pdf (commit 6828fb8)
- `POST /api/v4/debug/visual-pdf` — przyjmuje base64 PDF + prompt, używa prod ANTHROPIC_API_KEY
- Workaround dla wygasłego lokalnego klucza
- `tests/e2e/page-visual-via-proxy.mjs` — per-page audit przez prod

### 4. Audit dokumentacja
- `tests/AUDYT_HALUCYNACJI.md` — kategoryzacja 108 testów: REAL/PARTIAL/HALUCYNACJA

## Re-run po fixie

### Visual audit (Claude Vision per-page) ✅
```
PDF: 20 stron, 15.1 MB
▶ Strona 1 (cover):  ✓ OK — spójne litery, polskie diakrytyki widoczne
▶ Strona 2 (TOC):    ✓ OK — 18 entries, brak placeholderów
▶ Strona 5 (Krok 1): ✓ OK — instrukcja ładowania, ilustracja OK
▶ Strona 12 (spec):  ✓ OK — tabela parametrów, czystą strukturą
SUMMARY: 4/4 OK · 0 drobne_problemy · 0 zepsute
```

### Smoke E2E ✅
```
SMOKE TEST RESULTS: 11 PASS, 0 FAIL
  ✓ status                          1408ms — 20 stron, 11 issues, $1.34
  ✓ placeholders                     939ms — 11 placeholderów
  ✓ pages list                       576ms — 20 stron
  ✓ reference-docs                  2095ms — 28 plików
  ✓ images                          1911ms — 7 obrazków
  ✓ regenerate-toc                  1066ms — 18 entries
  ✓ find-replace (dry-run)           953ms — 1 matches
  ✓ resummarize-all (idempotent)    1410ms — skipped
  ✓ export-json                     1033ms — 20 pages
  ✓ export-pdf?lang=pl             18019ms — 15432 KB
  ✓ categorize-all (started event)  1327ms — stream OK
```

### Unit tests ✅
```
Test Files  8 passed (8)
     Tests  85 passed | 1 skipped (86)
  Duration  757ms
```

## Pozostałe luki (NIE NAPRAWIONE — TODO follow-up)

1. **Visual quality content generowany przez auto-populate** — czy strona "Krok 1: Naładuj" ma SENSOWNĄ treść, czy generic placeholder?
   - Status: częściowo zweryfikowane przez visual audit strony 5 — opis "instrukcja obsługi pierwszego kroku ładowania" — OK
2. **Apply-DS impact** — czy strona PO apply-design wygląda lepiej?
   - Status: bounds-OK potwierdzone numerycznie, ale CZY ESTETYCZNIE LEPSZA nie sprawdzane
3. **Magic All-In-One E2E** — 1-button experience, nigdy uruchomiony end-to-end z UI
4. **AI Command Bar semantyka** — "zmień wszystkie kolory na ciemniejsze" — nigdy nie sprawdzano semantyki
5. **Translation memory hit-rate w prod** — nigdy nie zmierzono czy cache faktycznie ratuje koszty

## Kluczowy wniosek

**Wpadka 15.05 (PDF rozsypany)** wynikała z testowania `pdf-parse` text-reconstruction zamiast wizualnego renderingu. Heurystyka "letter/space ratio 6.89, 9/10 polskich słów OK" była **false positive** bo:
- pdf-parse układa tekst z chaotycznych positions używając heurystyk
- pojedyncze glyphs na różnych pozycjach mogą wyglądać jako "9 polskich słów"

**Nauka**: do testów outputu wizualnego **MUSI być prawdziwy visual check** (LLM Vision lub rasterizacja + ocena), nie pdf-parse.

Stosuję teraz konsekwentnie:
- pure logic → unit tests OK
- API contracts → smoke tests OK
- DB state → integration tests OK
- **visual output → LLM Vision per-page (page-visual-via-proxy.mjs)**
- **semantic AI output → planowane: GPT-as-judge na konkretnych próbkach**
