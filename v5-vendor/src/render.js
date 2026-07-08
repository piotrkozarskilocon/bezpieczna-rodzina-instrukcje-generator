import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPage } from "./templates.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "dist");
const bookletsDir = path.join(projectRoot, "data", "booklets");
const assetsDir = path.join(projectRoot, "assets");

function buildTocItems(pages) {
  return pages
    .map((page, index) => ({
      pageNumber: index + 1,
      label:
        page.type === "cover"
          ? "Cover"
          : page.type === "toc"
            ? "Contents"
            : page.type === "step"
              ? `Step ${page.stepNumber} · ${page.title}`
              : page.title || page.label || page.type,
    }))
    .filter((item) => item.label !== "Contents");
}

function renderDocument(booklet) {
  const { meta, branding, pages } = booklet;
  const tocItems = booklet.toc?.items || buildTocItems(pages);

  const pageMarkup = pages
    .map((page, index) =>
      renderPage({
        meta,
        branding,
        page,
        pageNumber: index + 1,
        tocItems,
      }),
    )
    .join("\n");

  return `<!doctype html>
<html lang="${meta.language.toLowerCase()}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${meta.device} ${meta.language} booklet</title>
    <link rel="stylesheet" href="./print.css" />
    <style>
      :root {
        --page-width-mm: ${meta.pageSizeMm.width}mm;
        --page-height-mm: ${meta.pageSizeMm.height}mm;
      }
    </style>
  </head>
  <body>
    ${pageMarkup}
  </body>
</html>`;
}

async function resolveInputFiles() {
  const inputArg = process.argv[2];

  if (inputArg) {
    return [path.resolve(projectRoot, inputArg)];
  }

  const entries = await fs.readdir(bookletsDir);
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(bookletsDir, entry));
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.copyFile(
    path.join(projectRoot, "src", "styles", "print.css"),
    path.join(outputDir, "print.css"),
  );
  await fs.cp(assetsDir, path.join(outputDir, "assets"), { recursive: true });

  const inputFiles = await resolveInputFiles();

  for (const inputFile of inputFiles) {
    const raw = await fs.readFile(inputFile, "utf8");
    const booklet = JSON.parse(raw);
    const html = renderDocument(booklet);
    const outputFile = path.join(outputDir, `${booklet.meta.documentId}.html`);

    await fs.writeFile(outputFile, html, "utf8");
    console.log(`Rendered HTML: ${outputFile}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
