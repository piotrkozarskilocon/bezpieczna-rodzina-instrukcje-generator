import path from "node:path";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const bookletsDir = path.join(projectRoot, "data", "booklets");

async function loadPlaywright() {
  const require = createRequire(import.meta.url);

  try {
    return require("playwright");
  } catch {
    const bundlePlaywright =
      "/Users/lauramusial/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
    return require(bundlePlaywright);
  }
}

async function main() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });

  try {
    const inputArg = process.argv[2];
    const bookletPaths = inputArg
      ? [path.resolve(projectRoot, inputArg)]
      : (await fs.readdir(bookletsDir))
          .filter((entry) => entry.endsWith(".json"))
          .sort((left, right) => left.localeCompare(right))
          .map((entry) => path.join(bookletsDir, entry));

    for (const bookletPath of bookletPaths) {
      const booklet = JSON.parse(await fs.readFile(bookletPath, "utf8"));
      const htmlPath = path.join(projectRoot, "dist", `${booklet.meta.documentId}.html`);
      const pdfPath = path.join(projectRoot, "dist", `${booklet.meta.documentId}.pdf`);
      const page = await browser.newPage();

      await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
      await page.pdf({
        path: pdfPath,
        width: `${booklet.meta.pageSizeMm.width}mm`,
        height: `${booklet.meta.pageSizeMm.height}mm`,
        printBackground: true,
        margin: {
          top: "0mm",
          right: "0mm",
          bottom: "0mm",
          left: "0mm",
        },
        preferCSSPageSize: true,
      });

      await page.close();
      console.log(`Exported PDF: ${pdfPath}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
