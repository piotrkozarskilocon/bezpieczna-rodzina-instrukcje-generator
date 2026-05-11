/**
 * Auth proxy for "Generator Instrukcji" — separate Vercel project
 * proxied behind hub site (bezpieczna-rodzina-prototypy.vercel.app).
 *
 * Verifies the same JWT cookie issued by the hub login flow. If the cookie
 * is missing or invalid, redirects the user back to the hub login page.
 *
 * Defense-in-depth: hub proxy also verifies before forwarding, but we
 * re-verify here so the project is safe even when accessed directly.
 *
 * NOTE: Next.js 16 renamed `middleware` to `proxy` — see proxy.md docs.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const HUB_LOGIN_URL = "https://bezpieczna-rodzina-prototypy.vercel.app/login";
const PROXY_SECRET_HEADER = "x-locon-proxy-secret";

export const config = {
  matcher: [
    /*
     * Protect all paths EXCEPT:
     * - /api/* (API routes; can opt-in to auth per-route)
     * - /_next/* (Vercel internals)
     * - /favicon.ico, static files
     */
    "/((?!api|_next/static|_next/image|favicon\\.ico).*)",
  ],
};

export default async function proxy(request: NextRequest): Promise<Response | undefined> {
  // When the hub proxies a request server-side, Vercel Edge `fetch()` strips
  // the Cookie header, which would cause a redirect loop here. The hub sets
  // a shared-secret header before forwarding (see hub middleware.js
  // `proxyToOrigin`); trust that signal — hub already verified the JWT.
  // Standard `x-forwarded-*` headers can't be used because Vercel rewrites
  // them at the edge, so we use a custom header name + shared secret.
  const proxySecret = request.headers.get(PROXY_SECRET_HEADER);
  const expectedSecret = process.env.INTERNAL_PROXY_SECRET;
  if (expectedSecret && proxySecret === expectedSecret) {
    return undefined;
  }

  const sessionToken = request.cookies.get("session_token")?.value;

  if (!sessionToken) {
    return NextResponse.redirect(HUB_LOGIN_URL);
  }

  const isValid = await verifySessionJWT(sessionToken);

  if (!isValid) {
    const res = NextResponse.redirect(HUB_LOGIN_URL);
    res.cookies.set("session_token", "", { maxAge: 0, path: "/" });
    return res;
  }

  return undefined;
}

async function verifySessionJWT(token: string): Promise<boolean> {
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return false;

    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const [headerB64, payloadB64, signatureB64] = parts;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const signatureInput = encoder.encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlDecode(signatureB64);

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) as ArrayBuffer,
      signatureInput.buffer.slice(signatureInput.byteOffset, signatureInput.byteOffset + signatureInput.byteLength) as ArrayBuffer,
    );
    if (!valid) return false;

    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
    const payload: { type?: string; exp?: number; email?: string } = JSON.parse(payloadJson);

    if (payload.type !== "session") return false;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return false;

    // Domain restriction (defense in depth — hub already enforces this on login)
    const allowedDomain = process.env.AUTH_DOMAIN ?? "locon.pl";
    if (payload.email && !payload.email.endsWith(`@${allowedDomain}`)) return false;

    return true;
  } catch {
    return false;
  }
}

function base64UrlDecode(str: string): Uint8Array {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
