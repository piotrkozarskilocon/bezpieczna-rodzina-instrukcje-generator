#!/usr/bin/env node
/**
 * Visual test KONKRETNYCH stron — chunkuje PDF na pojedyncze strony i wysyla
 * kazda do Claude Vision z pytaniem czy wyglada poprawnie wg expected layout.
 *
 * Uzycie: node tests/e2e/page-visual.mjs <pdfPath> <pageNum1,pageNum2,...>
 */

import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import Anthropic from '@anthropic-ai/sdk';

const PDF_PATH = process.argv[2];
const PAGES_ARG = process.argv[3] ?? '1,2,5,12';
if (!PDF_PATH) { console.error('Usage: page-visual.mjs <pdf> <pages>'); process.exit(2); }
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(2); }

const pdfBytes = readFileSync(PDF_PATH);
const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
console.log(`PDF: ${doc.getPageCount()} stron, ${(pdfBytes.length / 1024 / 1024).toFixed(1)} MB`);

const pageNums = PAGES_ARG.split(',').map((n) => parseInt(n.trim(), 10));
const client = new Anthropic({ apiKey: ANTHROPIC });

const results = [];
for (const pageNum of pageNums) {
  if (pageNum < 1 || pageNum > doc.getPageCount()) {
    results.push({ pageNum, verdict: 'SKIP', reason: 'out of range' });
    continue;
  }
  // Wytnij pojedynczą stronę
  const single = await PDFDocument.create();
  const [copied] = await single.copyPages(doc, [pageNum - 1]);
  single.addPage(copied);
  const singleBytes = await single.save();
  const base64 = Buffer.from(singleBytes).toString('base64');

  process.stdout.write(`▶ Strona ${pageNum} (${(singleBytes.length / 1024).toFixed(0)} KB)... `);
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: `Strona QSG smartwatcha (76×76 mm, druk skala szarosci).

Krotki raport (max 5 zdan):
1. Co widzisz na tej stronie? (1 zdanie opis)
2. Czy litery sa SPOJNE w slowach?
3. Czy polskie diakrytyki widoczne?
4. Czy layout wyglada profesjonalnie / czy elementy nakladaja sie?
5. WERDYKT: OK / ZEPSUTY / DROBNE_PROBLEMY` },
      ],
    }],
  });
  const text = msg.content.map((b) => b.type === 'text' ? b.text : '').join('');
  const verdicts = text.match(/\b(ZEPSUTY|DROBNE_PROBLEMY|DROBNE PROBLEMY|OK)\b/gi) ?? [];
  const verdict = (verdicts.pop() ?? 'UNKNOWN').toUpperCase().replace(' ', '_');
  console.log(`${verdict === 'OK' ? '✓' : verdict.includes('ZEPSUTY') ? '✗' : '⚠'} ${verdict}`);
  results.push({ pageNum, verdict, description: text.slice(0, 500), tokens: msg.usage.input_tokens });
}

console.log('\n══════════════════════════════════════════════════════════════════════');
console.log('VISUAL AUDIT RESULTS');
console.log('══════════════════════════════════════════════════════════════════════');
for (const r of results) {
  console.log(`\nStrona ${r.pageNum}: ${r.verdict}`);
  console.log(r.description);
  console.log('─'.repeat(70));
}

const broken = results.filter((r) => r.verdict === 'ZEPSUTY').length;
const issues = results.filter((r) => r.verdict.includes('PROBLEMY')).length;
const ok = results.filter((r) => r.verdict === 'OK').length;
console.log(`\nSUMMARY: ${ok}/${results.length} OK · ${issues} drobne_problemy · ${broken} zepsute`);
process.exit(broken > 0 ? 1 : 0);
