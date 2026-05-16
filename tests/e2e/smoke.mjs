#!/usr/bin/env node
/**
 * E2E Smoke tests przeciw prod aliasowi.
 * Wymaga env:
 *   GENERATOR_BASE_URL (default: https://bezpieczna-rodzina-instrukcje-gener.vercel.app)
 *   INTERNAL_PROXY_SECRET
 *   TEST_USER_EMAIL (default: piotr.kozarski@locon.pl)
 *   TEST_PROJECT_ID (default: ddb872d7-8d8c-4f46-acda-949117da91c9 — GJD.16 QSG&KG AI v2)
 *
 * Uruchom: node tests/e2e/smoke.mjs
 * Exit 0 = all pass, 1 = any fail.
 */

const BASE = process.env.GENERATOR_BASE_URL ?? "https://bezpieczna-rodzina-instrukcje-gener.vercel.app";
const PROXY = process.env.INTERNAL_PROXY_SECRET;
const EMAIL = process.env.TEST_USER_EMAIL ?? "piotr.kozarski@locon.pl";
const PROJECT_ID = process.env.TEST_PROJECT_ID ?? "ddb872d7-8d8c-4f46-acda-949117da91c9";

if (!PROXY) {
  console.error("❌ Missing INTERNAL_PROXY_SECRET env var");
  process.exit(2);
}

const API = `${BASE}/generator-instrukcji/api/v4`;
const headers = {
  "x-locon-proxy-secret": PROXY,
  "x-locon-user-email": EMAIL,
  "Content-Type": "application/json",
};

let passed = 0;
let failed = 0;
const results = [];

async function check(name, fn) {
  process.stdout.write(`▶ ${name}... `);
  const start = Date.now();
  try {
    const result = await fn();
    const duration = Date.now() - start;
    if (result === false) throw new Error("returned false");
    passed++;
    results.push({ name, status: "PASS", duration, info: typeof result === "string" ? result : "" });
    console.log(`✓ PASS (${duration}ms) ${typeof result === "string" ? `— ${result}` : ""}`);
  } catch (err) {
    const duration = Date.now() - start;
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, status: "FAIL", duration, info: msg });
    console.log(`✗ FAIL (${duration}ms) — ${msg}`);
  }
}

async function getJson(path) {
  const res = await fetch(`${API}${path}`, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJson(path, body = {}) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "follow",
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { return { _raw: txt.slice(0, 500) }; }
}

async function postSse(path, body = {}, maxMs = 60000) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "follow",
    signal: AbortSignal.timeout(maxMs),
  });
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const p of parts) {
      const eventMatch = p.match(/^event:\s*(\w+)/m);
      const dataMatch = p.match(/^data:\s*(.+)$/m);
      if (eventMatch && dataMatch) {
        try { events.push({ event: eventMatch[1], data: JSON.parse(dataMatch[1]) }); } catch { /* skip */ }
      }
    }
  }
  return events;
}

// ────────────────────────────────────────────────────────────────────────────
// TEST SUITE
// ────────────────────────────────────────────────────────────────────────────

await check("GET /projects/[id]/status", async () => {
  const j = await getJson(`/projects/${PROJECT_ID}/status`);
  if (!j.project || !j.counts || !j.issues) throw new Error("missing keys");
  return `${j.counts.pages_total} stron, ${j.issues.total} issues, $${j.cost?.est_cost_usd_max ?? "?"}`;
});

await check("GET /projects/[id]/placeholders", async () => {
  const j = await getJson(`/projects/${PROJECT_ID}/placeholders`);
  if (typeof j.count !== "number") throw new Error("missing count");
  return `${j.count} placeholderów`;
});

await check("GET /projects/[id]/pages/", async () => {
  const j = await getJson(`/projects/${PROJECT_ID}/pages/`);
  if (!Array.isArray(j.pages) || j.pages.length === 0) throw new Error("no pages");
  return `${j.pages.length} stron`;
});

await check("GET /projects/[id]/reference-docs/", async () => {
  const j = await getJson(`/projects/${PROJECT_ID}/reference-docs/`);
  if (!Array.isArray(j.docs)) throw new Error("no docs array");
  return `${j.docs.length} plików`;
});

await check("GET /projects/[id]/images/", async () => {
  const j = await getJson(`/projects/${PROJECT_ID}/images/`);
  if (!Array.isArray(j.images)) throw new Error("no images array");
  return `${j.images.length} obrazków`;
});

await check("POST /projects/[id]/regenerate-toc", async () => {
  const j = await postJson(`/projects/${PROJECT_ID}/regenerate-toc`);
  if (!j.ok || typeof j.entries_count !== "number") throw new Error("invalid response");
  return `${j.entries_count} entries`;
});

await check("POST /projects/[id]/find-replace (dry-run)", async () => {
  const j = await postJson(`/projects/${PROJECT_ID}/find-replace`, {
    find: "test",
    scope: "project",
  });
  if (!j.ok) throw new Error("not ok");
  return `${j.matches_count ?? 0} matches`;
});

await check("POST /projects/[id]/resummarize-all (idempotent)", async () => {
  try {
    await postJson(`/projects/${PROJECT_ID}/resummarize-all`);
    return "ran";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Brak plikow do resummarize")) return "skipped (idempotent)";
    throw err;
  }
});

await check("GET /projects/[id]/export-json", async () => {
  const j = await getJson(`/projects/${PROJECT_ID}/export-json`);
  if (!j.project || !Array.isArray(j.pages)) throw new Error("missing structure");
  return `project + ${j.pages.length} pages w JSON`;
});

await check("GET /projects/[id]/export-pdf?lang=pl", async () => {
  const res = await fetch(`${API}/projects/${PROJECT_ID}/export-pdf?lang=pl`, {
    headers, redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("pdf")) throw new Error(`bad content-type: ${ct}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 1000) throw new Error(`PDF too small: ${buf.byteLength}`);
  // Magic %PDF
  const head = new Uint8Array(buf.slice(0, 4));
  if (head[0] !== 0x25 || head[1] !== 0x50 || head[2] !== 0x44 || head[3] !== 0x46) {
    throw new Error("not a PDF");
  }
  return `${Math.round(buf.byteLength / 1024)} KB`;
});

// categorize-all: long-running (10-180s), nie nadaje się do smoke. Sprawdź
// tylko ze endpoint odpowiada 'started' event w <15s.
await check("POST /projects/[id]/categorize-all (sprawdz started event)", async () => {
  const ac = new AbortController();
  const res = await fetch(`${API}/projects/${PROJECT_ID}/categorize-all`, {
    method: "POST", headers, body: "{}", redirect: "follow",
    signal: ac.signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  // Czytaj pierwsze 2KB strumienia, oczekuj 'event: started'
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const timeout = setTimeout(() => ac.abort(), 15000);
  while (buf.length < 2000) {
    const r = await reader.read();
    if (r.done) break;
    buf += decoder.decode(r.value, { stream: true });
    if (buf.includes("event: started")) break;
  }
  clearTimeout(timeout);
  ac.abort(); // koniec, nie czytamy całego stream
  if (!buf.includes("event: started")) throw new Error("no 'started' event in first 2KB");
  return "stream OK";
});

// ────────────────────────────────────────────────────────────────────────────
// RESULTS
// ────────────────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(70));
console.log(`SMOKE TEST RESULTS: ${passed} PASS, ${failed} FAIL`);
console.log("═".repeat(70));
for (const r of results) {
  const icon = r.status === "PASS" ? "✓" : "✗";
  console.log(`  ${icon} ${r.name.padEnd(60)} ${r.duration}ms ${r.info}`);
}
console.log("═".repeat(70));

process.exit(failed > 0 ? 1 : 0);
