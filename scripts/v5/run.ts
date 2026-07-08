/**
 * CLI pipeline'u v5 — etapy z artefaktami na dysku (wznawialne, inspekcjonowalne).
 *
 *   npx tsx scripts/v5/run.ts <workdir> fetch <gen4_project_id>
 *   npx tsx scripts/v5/run.ts <workdir> classify
 *   npx tsx scripts/v5/run.ts <workdir> extract [--only <substr>] [--concurrency N]
 *   npx tsx scripts/v5/run.ts <workdir> merge
 *   npx tsx scripts/v5/run.ts <workdir> compose --model GJD.16 --name "Locon Watch Slay AI" [--template <plik.json>]
 *   npx tsx scripts/v5/run.ts <workdir> render
 *   npx tsx scripts/v5/run.ts <workdir> qa
 *
 * Klucze AI/Supabase: .env.local lub .env.vercel-prod w rootcie repo.
 */
import { promises as fs } from "node:fs";
import fss from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { classifySourceFile } from "../../lib/v5/classify";
import { extractSourceFile } from "../../lib/v5/extract";
import { mergeFragments, refineKb } from "../../lib/v5/merge";
import { composeQsg, BookletSchema, type Booklet } from "../../lib/v5/compose";
import { writeHtmlBundle, renderPdf, renderPagePngs } from "../../lib/v5/render";
import { runQsgGate } from "../../lib/v5/qa";
import { DeviceKBSchema, type SourceKind, type ClassifyResult } from "../../lib/v5/types";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BUCKET = "gen4-reference-docs";

function loadEnv() {
  for (const f of [".env.local", ".env.vercel-prod"]) {
    const p = path.join(REPO_ROOT, f);
    if (!fss.existsSync(p)) continue;
    for (const line of fss.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=["']?(.*?)["']?$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}

interface ManifestEntry {
  name: string;
  file: string;
  mimeType: string;
  sizeBytes: number;
  classify?: ClassifyResult;
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8")) as T;
}
async function writeJson(p: string, v: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(v, null, 2), "utf8");
}
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function stageFetch(workdir: string, projectId: string) {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: docs, error } = await supabase
    .from("gen4_reference_docs")
    .select("name,file_path,mime_type,size_bytes")
    .eq("project_id", projectId);
  if (error) throw error;
  const manifest: ManifestEntry[] = [];
  const srcDir = path.join(workdir, "sources");
  await fs.mkdir(srcDir, { recursive: true });
  for (const doc of docs ?? []) {
    const safe = doc.name.replace(/[^\w.\-À-ɏ一-鿿 ]+/g, "_");
    const local = path.join(srcDir, safe);
    if (!fss.existsSync(local) || fss.statSync(local).size !== doc.size_bytes) {
      const { data, error: dlErr } = await supabase.storage.from(BUCKET).download(doc.file_path);
      if (dlErr) {
        console.error(`✗ download ${doc.name}: ${dlErr.message}`);
        continue;
      }
      await fs.writeFile(local, Buffer.from(await data.arrayBuffer()));
    }
    manifest.push({ name: doc.name, file: safe, mimeType: doc.mime_type, sizeBytes: doc.size_bytes });
    console.log(`✓ ${doc.name} (${Math.round(doc.size_bytes / 1024)} KB)`);
  }
  await writeJson(path.join(workdir, "manifest.json"), manifest);
  console.log(`\nPobrano ${manifest.length} plików → ${srcDir}`);
}

async function stageClassify(workdir: string) {
  const manifest = await readJson<ManifestEntry[]>(path.join(workdir, "manifest.json"));
  for (const entry of manifest) {
    entry.classify = await classifySourceFile({
      name: entry.name,
      mimeType: entry.mimeType,
      localPath: path.join(workdir, "sources", entry.file),
    });
    console.log(`${entry.classify.kind.padEnd(20)} ${entry.classify.language.padEnd(4)} ${entry.name}`);
  }
  await writeJson(path.join(workdir, "manifest.json"), manifest);
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift()!);
    })
  );
}

async function stageExtract(workdir: string) {
  const manifest = await readJson<ManifestEntry[]>(path.join(workdir, "manifest.json"));
  const only = arg("--only");
  const concurrency = Number(arg("--concurrency") ?? 3);
  const fragDir = path.join(workdir, "fragments");
  await fs.mkdir(fragDir, { recursive: true });
  const device = arg("--device-context") ?? "";
  const todo = manifest.filter((e) => (!only || e.name.includes(only)));
  await pool(todo, concurrency, async (entry) => {
    const outPath = path.join(fragDir, `${entry.file}.json`);
    if (fss.existsSync(outPath)) {
      console.log(`= ${entry.name} (już wyekstrahowany)`);
      return;
    }
    const kind = (entry.classify?.kind ?? "other") as SourceKind;
    const t0 = Date.now();
    try {
      const res = await extractSourceFile({
        name: entry.name,
        localPath: path.join(workdir, "sources", entry.file),
        mimeType: entry.mimeType,
        kind,
        deviceContext: device || undefined,
      });
      if (res.skipped) {
        console.log(`~ ${entry.name} (kind=${kind} — pominięty)`);
        return;
      }
      await writeJson(outPath, { kind, fragment: res.fragment });
      console.log(
        `✓ ${entry.name} [${kind}] ${Math.round((Date.now() - t0) / 1000)}s in=${res.inputTokens} out=${res.outputTokens}`
      );
    } catch (err) {
      console.error(`✗ ${entry.name}: ${String(err).slice(0, 300)}`);
    }
  });
}

async function stageMerge(workdir: string) {
  const fragDir = path.join(workdir, "fragments");
  const files = (await fs.readdir(fragDir)).filter((f) => f.endsWith(".json"));
  const fragments = [];
  for (const f of files) {
    const { kind, fragment } = await readJson<{ kind: SourceKind; fragment: unknown }>(
      path.join(fragDir, f)
    );
    if (fragment)
      fragments.push({
        kind,
        fragment: DeviceKBSchema.parse(fragment),
        sourceName: f.replace(/\.json$/, ""),
      });
  }
  console.log(`Scalanie ${fragments.length} fragmentów…`);
  const { kb, conflicts } = mergeFragments(fragments);
  await writeJson(path.join(workdir, "kb.raw.json"), kb);
  await writeJson(path.join(workdir, "kb.conflicts.json"), conflicts);
  console.log(`Konflikty: ${conflicts.length}. Rafinacja (Claude)…`);
  let refined = kb;
  try {
    refined = await refineKb(kb);
  } catch (err) {
    console.warn(`⚠ Rafinacja nieudana (${String(err).slice(0, 120)}) — używam KB bez rafinacji.`);
  }
  await writeJson(path.join(workdir, "kb.json"), refined);
  console.log(
    `KB gotowa: funkcje=${refined.features.length}, pasma=${refined.radio.bands.length}, ` +
      `SAR=${refined.sar.results.length}, ostrzeżenia=${refined.safety.length}, kroki=${refined.app_flow.pairing_steps.length}`
  );
}

async function stageCompose(workdir: string) {
  const kb = DeviceKBSchema.parse(await readJson(path.join(workdir, "kb.json")));
  const templatePath =
    arg("--template") ?? path.join(REPO_ROOT, "v5-vendor", "data", "booklets", "gjd16-01-pl.json");
  const masterTemplate = BookletSchema.parse(await readJson(templatePath));
  const modelCode = arg("--model") ?? kb.identity.model_code?.value ?? "NIEZNANY";
  const tradeName = arg("--name") ?? kb.identity.trade_name?.value ?? modelCode;
  const res = await composeQsg({
    kb,
    masterTemplate,
    device: {
      documentId: `${modelCode.toLowerCase().replace(/\W+/g, "")}-qsg-pl`,
      modelCode,
      tradeName,
    },
  });
  await writeJson(path.join(workdir, "booklet.json"), res.booklet);
  await writeJson(path.join(workdir, "compose.gaps.json"), res.gaps);
  console.log(
    `Booklet: ${res.booklet.pages.length} stron, luki=${res.gaps.length}, tokeny in=${res.inputTokens} out=${res.outputTokens}`
  );
  if (res.gaps.length) console.log("LUKI:", res.gaps.join(" | "));
}

async function stageRender(workdir: string) {
  const booklet = BookletSchema.parse(await readJson(path.join(workdir, "booklet.json"))) as Booklet;
  const outDir = path.join(workdir, "out");
  const htmlPath = await writeHtmlBundle(booklet, outDir);
  const pdf = await renderPdf(htmlPath, booklet, path.join(outDir, `${booklet.meta.documentId}.pdf`));
  await writeJson(path.join(workdir, "render.json"), pdf);
  console.log(`PDF: ${pdf.pdfPath} (${pdf.pageCount} stron), overflow: ${pdf.overflows.length}`);
  const sample = Array.from({ length: booklet.pages.length }, (_, i) => i);
  const pngs = await renderPagePngs(htmlPath, path.join(outDir, "png"), sample);
  console.log(`PNG: ${pngs.length} stron → ${path.join(outDir, "png")}`);
}

async function stageQa(workdir: string) {
  const booklet = BookletSchema.parse(await readJson(path.join(workdir, "booklet.json"))) as Booklet;
  const kb = DeviceKBSchema.parse(await readJson(path.join(workdir, "kb.json")));
  const render = await readJson<{ overflows: [] }>(path.join(workdir, "render.json"));
  const report = runQsgGate({
    booklet,
    kb,
    overflows: render.overflows,
    forbiddenTemplateNames: (arg("--forbidden") ?? "").split(",").filter(Boolean),
  });
  await writeJson(path.join(workdir, "qa.json"), report);
  for (const c of report.checks) {
    console.log(`${c.ok ? "✓" : c.severity === "warning" ? "⚠" : "✗"} ${c.id} ${c.requirement} — ${c.detail}`);
  }
  console.log(`\nWERDYKT: ${report.ready ? "READY ✅" : "BLOCKED ❌"}`);
  if (!report.ready) process.exitCode = 2;
}

async function main() {
  loadEnv();
  const [workdirArg, stage, ...rest] = process.argv.slice(2);
  if (!workdirArg || !stage) {
    console.error("użycie: run.ts <workdir> <fetch|classify|extract|merge|compose|render|qa> …");
    process.exit(1);
  }
  const workdir = path.resolve(workdirArg);
  await fs.mkdir(workdir, { recursive: true });
  switch (stage) {
    case "fetch":
      return stageFetch(workdir, rest[0]);
    case "classify":
      return stageClassify(workdir);
    case "extract":
      return stageExtract(workdir);
    case "merge":
      return stageMerge(workdir);
    case "compose":
      return stageCompose(workdir);
    case "render":
      return stageRender(workdir);
    case "qa":
      return stageQa(workdir);
    default:
      throw new Error(`nieznany etap: ${stage}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
