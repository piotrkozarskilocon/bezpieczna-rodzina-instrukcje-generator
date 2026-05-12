import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { ownPage, loadPageWithElements } from "@/lib/v4Edit";
import { validatePage, summarizeIssues } from "@/lib/v4Validate";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ pageId: string }>;
}

/** GET — sprawdza layout strony i zwraca listę problemów (errors/warnings/infos).
 *  Nic nie zapisuje, używane przez UI editor + Gen4ExportPanel (lint pre-export). */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { pageId } = await ctx.params;
  if (!(await ownPage(pageId, auth.email))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const data = await loadPageWithElements(pageId);
  if (!data) return NextResponse.json({ error: "page not found" }, { status: 404 });
  const { page, elements } = data;

  const issues = validatePage({
    id: page.id,
    page_number: page.page_number,
    width_mm: page.width_mm,
    height_mm: page.height_mm,
    template: page.template,
    title: page.title,
    elements,
  });

  return NextResponse.json({
    issues,
    summary: summarizeIssues(issues),
  });
}
