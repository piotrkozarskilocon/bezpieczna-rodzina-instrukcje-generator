import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { ownPage, parsePageEditResponse, replacePageElements } from "@/lib/v4Edit";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

/** Replaces all elements of a page with the provided JSON.
 *  Body: { json: string } — raw text from Claude.ai answer. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as { json?: string } | null;
  const raw = body?.json?.trim();
  if (!raw) return NextResponse.json({ error: "missing json" }, { status: 400 });

  let parsed;
  try {
    parsed = parsePageEditResponse(raw);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "parse failed" },
      { status: 400 },
    );
  }

  let count: number;
  try {
    count = await replacePageElements(pageId, parsed);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "replace failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, elements: count });
}
