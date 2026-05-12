import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { ownPage, buildPageEditPrompt } from "@/lib/v4Edit";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

/**
 * Zwraca dokladnie ten prompt ktory poszedlby do Claude przy POST /ai-edit,
 * BEZ wywolywania AI. Sluzy do podgladu "co generator zbuduje" — user moze
 * skopiowac/edytowac przed wlasciwym wywolaniem.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as { instruction?: string } | null;
  const instruction = body?.instruction?.trim();
  if (!instruction) {
    return NextResponse.json({ error: "missing instruction" }, { status: 400 });
  }
  const built = await buildPageEditPrompt(pageId, instruction);
  if (!built) return NextResponse.json({ error: "page not found" }, { status: 404 });
  return NextResponse.json({
    system: built.system,
    user: built.user,
    element_count: built.elementCount,
  });
}
