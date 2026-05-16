#!/usr/bin/env node
/**
 * REAL visual test PDF — pdfjs-dist text-items analysis + Claude Vision check.
 *
 * NIE polegaj na pdf-parse extractor (rekonstruuje tekst nawet z chaotycznych
 * positions — false positive jak w smoke test z 16.05). Sprawdz LAYOUT:
 *   1. Heurystyki pdfjs-dist: % single-char items, % empty placeholders
 *   2. Claude Vision opis 5 pierwszych stron (jezeli ANTHROPIC_API_KEY w env)
 *
 * Wymaga:
 *   INTERNAL_PROXY_SECRET (do pobrania PDF z prod)
 *   ANTHROPIC_API_KEY (opcjonalnie, dla visual check)
 *   TEST_PROJECT_ID (default ddb872d7-...)
 *
 * Exit 0 = all pass, 1 = visual defects detected.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

const BASE = process.env.GENERATOR_BASE_URL ?? 'https://bezpieczna-rodzina-instrukcje-gener.vercel.app';
const PROXY = process.env.INTERNAL_PROXY_SECRET;
const EMAIL = process.env.TEST_USER_EMAIL ?? 'piotr.kozarski@locon.pl';
const PROJECT_ID = process.env.TEST_PROJECT_ID ?? 'ddb872d7-8d8c-4f46-acda-949117da91c9';
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;

if (!PROXY) { console.error('Missing INTERNAL_PROXY_SECRET'); process.exit(2); }

// ── 1. Pobierz PDF z prod ─────────────────────────────────────────────
const url = `${BASE}/generator-instrukcji/api/v4/projects/${PROJECT_ID}/export-pdf?lang=pl`;
console.log(`▶ Pobieram PDF z ${url}`);
const t0 = Date.now();
const res = await fetch(url, {
  headers: { 'x-locon-proxy-secret': PROXY, 'x-locon-user-email': EMAIL },
  redirect: 'follow',
});
if (!res.ok) { console.error(`PDF fetch failed: HTTP ${res.status}`); process.exit(1); }
const pdfBytes = Buffer.from(await res.arrayBuffer());
const fetchMs = Date.now() - t0;
console.log(`  ${(pdfBytes.length / 1024 / 1024).toFixed(1)} MB w ${fetchMs}ms`);

const tmpPath = 'C:/Users/PiotrK/AppData/Local/Temp/smoke-visual.pdf';
if (!existsSync('C:/Users/PiotrK/AppData/Local/Temp')) mkdirSync('C:/Users/PiotrK/AppData/Local/Temp', { recursive: true });
writeFileSync(tmpPath, pdfBytes);

// ── 2. pdfjs-dist text-items analysis ─────────────────────────────────
console.log(`\n▶ pdfjs-dist text-items analysis (3 stron):`);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes), verbosity: 0, disableWorker: true }).promise;

let suspicious = 0;
for (let pageNum = 1; pageNum <= Math.min(3, doc.numPages); pageNum++) {
  const page = await doc.getPage(pageNum);
  const tc = await page.getTextContent();
  const items = tc.items;
  if (items.length === 0) continue;
  const singleChar = items.filter((i) => (i.str ?? '').length === 1).length;
  const shortItems = items.filter((i) => (i.str ?? '').trim().length <= 3).length;
  const pctShort = Math.round(100 * shortItems / items.length);
  const flag = pctShort > 70 ? ' ⚠️ SUSPICIOUS' : '';
  if (pctShort > 70) suspicious++;
  console.log(`  page ${pageNum}: ${items.length} items, single-char=${singleChar}, short(<=3)=${pctShort}%${flag}`);
}

if (suspicious > 0) {
  console.log(`\n⚠️ ${suspicious} stron ma >70% short items — mozliwe ze tekst rozsypany`);
}

// ── 3. Claude Vision visual check (5 stron) ───────────────────────────
if (!ANTHROPIC) {
  console.log('\nℹ️  ANTHROPIC_API_KEY nie ustawiony — Claude Vision check pominiety.');
  process.exit(suspicious > 0 ? 1 : 0);
}

console.log(`\n▶ Claude Vision check (5 stron)...`);
const fullDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
const out = await PDFDocument.create();
const indices = [];
for (let i = 0; i < Math.min(5, fullDoc.getPageCount()); i++) indices.push(i);
const copied = await out.copyPages(fullDoc, indices);
for (const p of copied) out.addPage(p);
const chunk = await out.save();
const chunkBase64 = Buffer.from(chunk).toString('base64');

const { default: Anthropic } = await import('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: ANTHROPIC });
const msg = await client.messages.create({
  model: 'claude-haiku-4-5-20251001', // tańsza wersja dla smoke
  max_tokens: 800,
  messages: [{
    role: 'user',
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: chunkBase64 } },
      { type: 'text', text: `5 stron PDF Quick Start Guide. Krotki raport:
1. Czy litery są SPOJNE w slowach, czy ROZSYPANE pojedynczo (visual)?
2. Czy polskie diakrytyki sa widoczne (ą, ę, ł, ó, ś, ź, ż, ć, ń)?
3. Czy są błędne ligatury 'fi' w nietypowych miejscach?
4. JEDNORAZOWY WERDYKT na koniec: OK / ZEPSUTY / CZĘŚCIOWO.` },
    ],
  }],
});

const text = msg.content.map((b) => b.type === 'text' ? b.text : '').join('');
console.log(`\n${text}`);

// Verdict regex tolerancyjny — Claude moze pisac "OK", "WERDYKT: OK", "✅ OK",
// "Werdykt koncowy: OK", etc. Szukamy ostatniego z tych slow w odpowiedzi.
const lastVerdict = (text.match(/\b(ZEPSUTY|CZĘŚCIOWO|CZESCIOWO|OK)\b/gi) ?? []).pop();
const verdict = lastVerdict ? lastVerdict.toUpperCase() : 'UNKNOWN';
console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(`VERDICT: ${verdict} · pdfjs-suspicious=${suspicious} · tokens ${msg.usage.input_tokens}in/${msg.usage.output_tokens}out`);
console.log(`══════════════════════════════════════════════════════════════════════`);

process.exit(verdict === 'OK' && suspicious === 0 ? 0 : 1);
