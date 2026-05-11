import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { buildPageEditPrompt, ownPage } from "@/lib/v4Edit";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

/** Builds an edit prompt for a single page. Body: { instruction: string }. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as { instruction?: string };
  const instruction = body.instruction?.trim();
  if (!instruction) {
    return NextResponse.json({ error: "missing instruction" }, { status: 400 });
  }

  const prompt = await buildPageEditPrompt(pageId, instruction);
  if (!prompt) return NextResponse.json({ error: "page not found" }, { status: 404 });

  return NextResponse.json(prompt);
}
