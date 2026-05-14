/**
 * Auto-callouts — Gemini 2.5 Pro Vision identyfikuje hardware interface points
 * na zdjeciu produktu i zwraca bounding boxy + labele. Bez apply — tylko
 * preview, frontend pokazuje markers + label, user moze edytowac przed
 * konwersja na page elements (osobny endpoint apply).
 *
 * Body:
 *   {
 *     image_id: string,        // z gen4_images
 *     language?: "pl"|"en"|... // default "pl"
 *   }
 *
 * Faza 3 z deep research planu. ROI XL dla QSG (Quick Start Guide).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callGemini, GEMINI_PRO } from "@/lib/v4Gemini";
import { CalloutsResponseSchema, type CalloutsResponse } from "@/lib/v4Schemas";
import { logAiCall } from "@/lib/v4AiLog";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const BUCKET = "gen4-images";

const SYSTEM_PROMPT = `Jestes ekspertem w technicznej dokumentacji produktow elektronicznych — smartwatchy, trackerow GPS, opasek seniora, lokalizatorow dla zwierzat. Otrzymujesz zdjecie urzadzenia i Twoja praca to ZIDENTYFIKOWAC wszystkie WIDOCZNE hardware interface points:

1. Przyciski fizyczne (power, SOS, navigation, side keys)
2. Porty (USB-C, micro-USB, charging contacts, audio jack)
3. Czujniki widoczne (camera, optical heart rate, fingerprint, IR)
4. Wskazniki swietlne (LED status, indicators)
5. Elementy ekranu (display, touchscreen area)
6. Konektory mechaniczne (strap pins, charging dock contacts)

Dla KAZDEGO punktu zwroc bounding box w formacie [0-1000] normalized + krotki polski label (1-3 slowa) + opcjonalnie angielski label.

ZASADY:
- Bounding box jest w skali 0-1000 niezaleznie od rozmiaru zdjecia. (0,0)=top-left, (1000,1000)=bottom-right.
- bbox_ymin < bbox_ymax, bbox_xmin < bbox_xmax (sprawdz przed zwracaniem).
- Bounding boxy maja byc CIASNE — wokol samej cechy, nie calego urzadzenia.
- NIE zaznaczaj rzeczy ktore nie sa "interface points" — tlo, palce, opakowanie.
- NIE wymyslaj punktow ktorych nie widac na zdjeciu.
- Label krotki — "Przycisk SOS" nie "Czerwony przycisk awaryjny SOS po prawej stronie".
- Opis (description) — opcjonalne 1-2 zdania zeby pomoc copywriterowi gdy uzyje calloutu w tresci instrukcji.

Zwracaj WYLACZNIE strukturalny JSON wg schemy submit_callouts. Bez prozy.`;

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 503 });
  }

  const { id: projectId } = await ctx.params;
  const body = (await request.json().catch(() => null)) as
    | { image_id?: string; language?: string }
    | null;
  const imageId = body?.image_id;
  if (!imageId) {
    return NextResponse.json({ error: "missing image_id" }, { status: 400 });
  }
  const language = body?.language ?? "pl";

  const sb = getSupabaseAdmin();

  // Auth + load image
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", projectId)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: image } = await sb
    .from("gen4_images")
    .select("id, name, path, mime_type, description")
    .eq("id", imageId)
    .eq("project_id", projectId)
    .single();
  if (!image) {
    return NextResponse.json({ error: "image not found in this project" }, { status: 404 });
  }

  // Download bytes z Supabase Storage
  const { data: download, error: dlErr } = await sb.storage.from(BUCKET).download(image.path);
  if (dlErr || !download) {
    return NextResponse.json({ error: `download failed: ${dlErr?.message ?? "unknown"}` }, { status: 500 });
  }
  const buf = Buffer.from(await download.arrayBuffer());
  const base64 = buf.toString("base64");
  const mimeType = image.mime_type || "image/png";

  if (buf.length > 20 * 1024 * 1024) {
    return NextResponse.json(
      { error: `image too large for inline (${(buf.length / 1024 / 1024).toFixed(1)}MB > 20MB)` },
      { status: 413 },
    );
  }

  const userPrompt = `Zdjecie produktu: ${image.name}${image.description ? `\nOpis usera: ${image.description}` : ""}\n\nJezyk callout-ow: ${language.toUpperCase()}\n\nZidentyfikuj wszystkie widoczne hardware interface points + zwroc strukturalny JSON.`;

  const startedAt = Date.now();
  let ai;
  try {
    ai = await callGemini<CalloutsResponse>({
      system: SYSTEM_PROMPT,
      user: userPrompt,
      model: GEMINI_PRO,
      maxTokens: 3000,
      outputSchema: {
        name: "submit_callouts",
        description: "Lista hardware interface points z bounding boxes",
        schema: CalloutsResponseSchema,
      },
      inlineFiles: [{ mimeType, data: base64 }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Gemini call failed";
    void logAiCall({
      project_id: projectId,
      endpoint: "auto-callouts",
      context_type: "project",
      user_instruction: `auto-callouts for image ${image.name}`,
      system_prompt: SYSTEM_PROMPT,
      user_prompt: userPrompt,
      model: GEMINI_PRO,
      max_tokens: 3000,
      error: msg,
      duration_ms: Date.now() - startedAt,
      user_email: auth.email,
    });
    return NextResponse.json({ error: `Gemini call failed: ${msg}` }, { status: 502 });
  }

  void logAiCall({
    project_id: projectId,
    endpoint: "auto-callouts",
    context_type: "project",
    user_instruction: `auto-callouts for image ${image.name}`,
    system_prompt: SYSTEM_PROMPT,
    user_prompt: userPrompt,
    model: ai.model,
    max_tokens: 3000,
    response_text: ai.text,
    tokens_in: ai.inputTokens,
    tokens_out: ai.outputTokens,
    duration_ms: Date.now() - startedAt,
    user_email: auth.email,
  });

  if (!ai.parsed) {
    return NextResponse.json(
      { error: "Gemini did not return parsed callouts", raw: ai.text.slice(0, 500) },
      { status: 502 },
    );
  }

  // Sanity check — invariants bbox_ymin < bbox_ymax (Gemini czasem zwraca odwrotnie)
  const validCallouts = ai.parsed.callouts.filter((c) => {
    return (
      typeof c.bbox_ymin === "number" &&
      typeof c.bbox_ymax === "number" &&
      typeof c.bbox_xmin === "number" &&
      typeof c.bbox_xmax === "number" &&
      c.bbox_ymin >= 0 &&
      c.bbox_ymin < c.bbox_ymax &&
      c.bbox_ymax <= 1000 &&
      c.bbox_xmin >= 0 &&
      c.bbox_xmin < c.bbox_xmax &&
      c.bbox_xmax <= 1000 &&
      typeof c.label_pl === "string" &&
      c.label_pl.trim().length > 0
    );
  });

  return NextResponse.json({
    ok: true,
    image: { id: image.id, name: image.name },
    product_description: ai.parsed.product_description ?? null,
    callouts: validCallouts,
    invalid_count: ai.parsed.callouts.length - validCallouts.length,
    model: ai.model,
    tokens_in: ai.inputTokens,
    tokens_out: ai.outputTokens,
    duration_ms: Date.now() - startedAt,
  });
}
