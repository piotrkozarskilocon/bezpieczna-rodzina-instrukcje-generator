import fss from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
for (const f of [".env.local", ".env.vercel-prod"]) {
  const p = path.join(ROOT, f);
  if (!fss.existsSync(p)) continue;
  for (const line of fss.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=["']?(.*?)["']?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function main() {
  const { getAnthropicClient } = await import("../../lib/anthropic");
  const { toFile } = await import("@anthropic-ai/sdk/core/uploads");
  const client = getAnthropicClient();
  const buf = fss.readFileSync(
    path.join(ROOT, "v5-work/gjd16/sources/deklaracja_zgodnosci_ue_smartwatch gjd.16_signed_ssp.pdf")
  );
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const up: any = await (client as any).beta.files.upload({
      file: await toFile(new Blob([new Uint8Array(buf)], { type: "application/pdf" }), "deklaracja.pdf"),
    });
    console.log("UPLOAD OK", up.id);
  } catch (e) {
    console.log("UPLOAD FAIL", String(e).slice(0, 400));
  }
}
main();
