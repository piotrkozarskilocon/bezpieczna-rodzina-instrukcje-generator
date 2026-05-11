import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Status endpoint — frontend pyta o stan integracji żeby wyświetlić właściwą
 * informację o trybie (auto przez API vs manual przez claude.ai). Sam fakt
 * istnienia klucza nie jest sekretem — wszyscy zalogowani użytkownicy
 * wewnętrzni mogą tę informację zobaczyć. Wartość klucza nigdy nie opuszcza
 * serwera.
 */
export async function GET(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return NextResponse.json({
    has_anthropic_key: Boolean(process.env.ANTHROPIC_API_KEY),
    mode: process.env.ANTHROPIC_API_KEY ? "auto" : "manual",
  });
}
