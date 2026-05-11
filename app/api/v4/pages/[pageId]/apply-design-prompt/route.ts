import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { ownPage } from "@/lib/v4Edit";
import { buildApplyDsToPagePrompt } from "@/lib/v4ApplyDs";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as { ds_id?: string; instruction?: string };
  if (!body.ds_id) return NextResponse.json({ error: "missing ds_id" }, { status: 400 });

  const prompt = await buildApplyDsToPagePrompt(pageId, body.ds_id, body.instruction);
  if (!prompt) return NextResponse.json({ error: "page or design system not found" }, { status: 404 });

  return NextResponse.json(prompt);
}
