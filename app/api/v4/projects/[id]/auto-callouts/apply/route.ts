/**
 * Auto-callouts APPLY — bierze preview callouts (z /auto-callouts endpoint)
 * + target_page_id, konwertuje bbox normalized [0-1000] → mm w obrebie
 * image_box na stronie, tworzy gen4_elements:
 *   - 1× image element (z image_id z gen4_images)
 *   - N× text label (label_pl) umieszczony po najblizszej stronie image_box
 *   - N× line z label do bbox center
 *
 * Body:
 *   {
 *     image_id: string,
 *     target_page_id: string,
 *     callouts: Callout[],         // moga byc edytowane przez usera
 *     image_box?: {                // opcjonalne, default centered 60x60
 *       x_mm: number,
 *       y_mm: number,
 *       w_mm: number,
 *       h_mm: number,
 *     }
 *   }
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { CalloutSchema, type Callout } from "@/lib/v4Schemas";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ApplyBodySchema = z.object({
  image_id: z.string(),
  target_page_id: z.string(),
  callouts: z.array(CalloutSchema),
  image_box: z
    .object({
      x_mm: z.number(),
      y_mm: z.number(),
      w_mm: z.number(),
      h_mm: z.number(),
    })
    .optional(),
});

/** Konwertuje bbox normalized [0-1000] → mm w obrebie image_box.
 *  Zakladamy fit_mode = "cover" lub ze image_box ma proporcje zgodne ze
 *  zdjeciem. W innym wypadku (contain) bedzie odchylenie ale uzytkownik
 *  moze recznie poprawic. */
function bboxToMm(c: Callout, imageBox: { x_mm: number; y_mm: number; w_mm: number; h_mm: number }) {
  const xn = (v: number) => imageBox.x_mm + (v / 1000) * imageBox.w_mm;
  const yn = (v: number) => imageBox.y_mm + (v / 1000) * imageBox.h_mm;
  return {
    x_mm: xn(c.bbox_xmin),
    y_mm: yn(c.bbox_ymin),
    w_mm: xn(c.bbox_xmax) - xn(c.bbox_xmin),
    h_mm: yn(c.bbox_ymax) - yn(c.bbox_ymin),
    cx_mm: (xn(c.bbox_xmin) + xn(c.bbox_xmax)) / 2,
    cy_mm: (yn(c.bbox_ymin) + yn(c.bbox_ymax)) / 2,
  };
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: projectId } = await ctx.params;
  const body = await request.json().catch(() => null);
  const parsed = ApplyBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", details: parsed.error.issues }, { status: 400 });
  }
  const { image_id, target_page_id, callouts, image_box } = parsed.data;

  const sb = getSupabaseAdmin();

  // Auth check
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", projectId)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Walidacja target page nalezy do projektu
  const { data: page } = await sb
    .from("gen4_pages")
    .select("id, project_id, width_mm, height_mm")
    .eq("id", target_page_id)
    .single();
  if (!page || page.project_id !== projectId) {
    return NextResponse.json({ error: "page not found in project" }, { status: 404 });
  }

  // Validate image
  const { data: image } = await sb
    .from("gen4_images")
    .select("id")
    .eq("id", image_id)
    .eq("project_id", projectId)
    .single();
  if (!image) {
    return NextResponse.json({ error: "image not found in project" }, { status: 404 });
  }

  // Default image_box: centered, 60x60% strony.
  const pageW = page.width_mm ?? 76;
  const pageH = page.height_mm ?? 76;
  const defaultW = Math.min(pageW * 0.7, 60);
  const defaultH = Math.min(pageH * 0.7, 60);
  const imageBox =
    image_box ?? {
      x_mm: (pageW - defaultW) / 2,
      y_mm: (pageH - defaultH) / 2,
      w_mm: defaultW,
      h_mm: defaultH,
    };

  // Layout labels — po najblizszej zewnetrznej stronie image_box
  const imageCenter = {
    x: imageBox.x_mm + imageBox.w_mm / 2,
    y: imageBox.y_mm + imageBox.h_mm / 2,
  };
  const LABEL_W = 22; // typowa szerokosc labela "Przycisk SOS"
  const LABEL_H = 3;  // wysokosc tekstu
  const LABEL_GAP = 4; // odstep od krawedzi image_box

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newElements: any[] = [];

  // 1. Image element (z_index 0 — pod calloutami)
  newElements.push({
    page_id: target_page_id,
    type: "image",
    x_mm: imageBox.x_mm,
    y_mm: imageBox.y_mm,
    w_mm: imageBox.w_mm,
    h_mm: imageBox.h_mm,
    z_index: 0,
    rotation_deg: 0,
    properties: { image_id, fit_mode: "contain", opacity: 1 },
  });

  // 2. Per callout — label + line
  // Layout LEFT-vs-RIGHT split + pionowy stride
  const leftCallouts: Array<{ callout: Callout; cx: number; cy: number }> = [];
  const rightCallouts: Array<{ callout: Callout; cx: number; cy: number }> = [];
  for (const c of callouts) {
    const mm = bboxToMm(c, imageBox);
    if (mm.cx_mm < imageCenter.x) {
      leftCallouts.push({ callout: c, cx: mm.cx_mm, cy: mm.cy_mm });
    } else {
      rightCallouts.push({ callout: c, cx: mm.cx_mm, cy: mm.cy_mm });
    }
  }
  // sortuj per strona po Y (top → bottom)
  leftCallouts.sort((a, b) => a.cy - b.cy);
  rightCallouts.sort((a, b) => a.cy - b.cy);

  const placeLabels = (
    arr: typeof leftCallouts,
    side: "left" | "right",
    zStart: number,
  ) => {
    if (arr.length === 0) return zStart;
    // Vertical stride — rozloz labele rownomiernie wzdluz image_box height
    const strideY = arr.length > 1 ? (imageBox.h_mm - LABEL_H) / (arr.length - 1) : 0;
    let z = zStart;
    for (let i = 0; i < arr.length; i++) {
      const { callout, cx, cy } = arr[i];
      const labelY = imageBox.y_mm + i * strideY;
      const labelX =
        side === "left"
          ? Math.max(2, imageBox.x_mm - LABEL_GAP - LABEL_W)
          : Math.min(pageW - LABEL_W - 2, imageBox.x_mm + imageBox.w_mm + LABEL_GAP);
      // Linia od krawedzi labela do bbox center
      const lineStartX = side === "left" ? labelX + LABEL_W : labelX;
      const lineStartY = labelY + LABEL_H / 2;
      const lineMinX = Math.min(lineStartX, cx);
      const lineMinY = Math.min(lineStartY, cy);
      const lineMaxX = Math.max(lineStartX, cx);
      const lineMaxY = Math.max(lineStartY, cy);
      newElements.push({
        page_id: target_page_id,
        type: "line",
        x_mm: lineMinX,
        y_mm: lineMinY,
        w_mm: Math.max(0.1, lineMaxX - lineMinX),
        h_mm: Math.max(0.1, lineMaxY - lineMinY),
        z_index: z++,
        rotation_deg: 0,
        properties: {
          stroke_width: 0.3,
          color: "#475569",
          // line endpoints jako % wewnatrz boxa (od top-left)
          // dla labela LEFT: start=top-right (100, 50), end=top-left (0, 50) → ale to zalezy od konfiguracji renderera
          // simplest: linia diagonalna od (0,0) do (100,100) prc — renderer rysuje
          x1_pct: side === "left" ? 0 : 100,
          y1_pct: lineStartY > cy ? 100 : 0,
          x2_pct: side === "left" ? 100 : 0,
          y2_pct: lineStartY > cy ? 0 : 100,
        },
      });
      newElements.push({
        page_id: target_page_id,
        type: "text",
        x_mm: labelX,
        y_mm: labelY,
        w_mm: LABEL_W,
        h_mm: LABEL_H + 1,
        z_index: z++,
        rotation_deg: 0,
        properties: {
          content: callout.label_pl,
          font_size_pt: 6,
          color: "#0F172A",
          align: side === "left" ? "right" : "left",
          font_weight: "semibold",
        },
      });
    }
    return z;
  };

  const zAfterLeft = placeLabels(leftCallouts, "left", 1);
  placeLabels(rightCallouts, "right", zAfterLeft);

  // Insert do gen4_elements (bulk)
  const { data: inserted, error } = await sb
    .from("gen4_elements")
    .insert(newElements)
    .select("id");
  if (error) {
    return NextResponse.json({ error: `insert failed: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    elements_created: inserted?.length ?? 0,
    image_box: imageBox,
    callouts_placed: callouts.length,
  });
}
