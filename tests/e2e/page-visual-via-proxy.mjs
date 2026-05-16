#!/usr/bin/env node
/**
 * Visual audit per-page przez PROD endpoint /api/v4/debug/visual-pdf.
 * Workaround dla wygasłych lokalnych ANTHROPIC_API_KEY — prod ma working klucz.
 *
 * Wymaga env:
 *   INTERNAL_PROXY_SECRET (z .env.local)
 *   GENERATOR_BASE_URL (default: prod stable alias)
 *
 * Uzycie: node tests/e2e/page-visual-via-proxy.mjs <pdfPath> <pageNum1,pageNum2,...>
 */

import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";

const PDF_PATH = process.argv[2];
const PAGES_ARG = process.argv[3] ?? "1,2,5,12";
if (!PDF_PATH) {
  console.error("Usage: page-visual-via-proxy.mjs <pdf> <pages>");
  process.exit(2);
}

const BASE = process.env.GENERATOR_BASE_URL ?? "https://bezpieczna-rodzina-instrukcje-gener.vercel.app";
const PROXY = process.env.INTERNAL_PROXY_SECRET;
const EMAIL = process.env.TEST_USER_EMAIL ?? "piotr.kozarski@locon.pl";
if (!PROXY) { console.error("Missing INTERNAL_PROXY_SECRET"); process.exit(2); }

const headers = {
  "x-locon-proxy-secret": PROXY,
  "x-locon-user-email": EMAIL,
  "Content-Type": "application/json",
};
const URL = `${BASE}/generator-instrukcji/api/v4/debug/visual-pdf`;

const pdfBytes = readFileSync(PDF_PATH);
const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
console.log(`PDF: ${doc.getPageCount()} stron, ${(pdfBytes.length / 1024 / 1024).toFixed(1)} MB`);

const pageNums = PAGES_ARG.split(",").map((n) => parseInt(n.trim(), 10));
const results = [];

for (const pageNum of pageNums) {
  if (pageNum < 1 || pageNum > doc.getPageCount()) {
    results.push({ pageNum, verdict: "SKIP", reason: "out of range" });
    continue;
  }
  const single = await PDFDocument.create();
  const [copied] = await single.copyPages(doc, [pageNum - 1]);
  single.addPage(copied);
  const singleBytes = await single.save();
  const base64 = Buffer.from(singleBytes).toString("base64");

  process.stdout.write(`▶ Strona ${pageNum} (${(singleBytes.length / 1024).toFixed(0)} KB)... `);
  const start = Date.now();
  const res = await fetch(URL, {
    method: "POST",
    headers,
    redirect: "follow",
    body: JSON.stringify({
      pdf_base64: base64,
      prompt: `Strona QSG smartwatcha (76x76 mm, druk skala szarosci).

Krotki raport (max 6 zdan):
1. Co widzisz na tej stronie? (1 zdanie opis)
2. Czy litery sa SPOJNE w slowach, czy ROZSYPANE pojedynczo?
3. Czy polskie diakrytyki widoczne (a, e, l, o, s, z, c, n)?
4. Czy layout wyglada profesjonalnie / czy elementy nakladaja sie?
5. Czy widzisz puste placeholdery typu [device.brand] {model.name}?
6. WERDYKT: OK / ZEPSUTY / DROBNE_PROBLEMY`,
    }),
  });
  const json = await res.json();
  const ms = Date.now() - start;
  if (!res.ok || !json.ok) {
    console.log(`✗ FAIL — ${json.error ?? res.status}`);
    results.push({ pageNum, verdict: "ERROR", description: json.error ?? "", ms });
    continue;
  }
  const text = json.text ?? "";
  const verdicts = text.match(/\b(ZEPSUTY|DROBNE_PROBLEMY|DROBNE PROBLEMY|OK)\b/gi) ?? [];
  const verdict = (verdicts.pop() ?? "UNKNOWN").toUpperCase().replace(" ", "_");
  console.log(`${verdict === "OK" ? "✓" : verdict.includes("ZEPSUTY") ? "✗" : "⚠"} ${verdict} (${ms}ms)`);
  results.push({ pageNum, verdict, description: text.slice(0, 700), ms, tokens_in: json.tokens_in });
}

console.log("\n══════════════════════════════════════════════════════════════════════");
console.log("VISUAL AUDIT RESULTS");
console.log("══════════════════════════════════════════════════════════════════════");
for (const r of results) {
  console.log(`\nStrona ${r.pageNum}: ${r.verdict}`);
  if (r.description) console.log(r.description);
  console.log("─".repeat(70));
}

const broken = results.filter((r) => r.verdict === "ZEPSUTY").length;
const issues = results.filter((r) => r.verdict.includes("PROBLEMY")).length;
const ok = results.filter((r) => r.verdict === "OK").length;
console.log(`\nSUMMARY: ${ok}/${results.length} OK · ${issues} drobne_problemy · ${broken} zepsute`);
process.exit(broken > 0 ? 1 : 0);
