/**
 * Auth helpers shared by API routes and proxy.
 *
 * The hub site issues an HS256 JWT with `{ type: 'session', email, exp }` and
 * sets it as a cookie `session_token`. When the hub proxies a request to this
 * project (`proxyToOrigin`), Vercel Edge strips the Cookie header — so the hub
 * also injects `x-locon-proxy-secret` (shared secret) and `x-locon-user-email`
 * (from the verified JWT payload). API routes here trust those headers and
 * skip the cookie path entirely. Direct (non-proxied) requests fall back to
 * verifying the cookie.
 */

import { jwtVerify } from "jose";
import type { NextRequest } from "next/server";

const PROXY_SECRET_HEADER = "x-locon-proxy-secret";
const USER_EMAIL_HEADER = "x-locon-user-email";

export interface AuthResult {
  email: string;
  source: "proxy" | "cookie";
}

export async function authenticate(request: NextRequest): Promise<AuthResult | null> {
  // Path 1: hub proxy with shared secret + email forwarded in headers.
  const expectedSecret = process.env.INTERNAL_PROXY_SECRET;
  const proxySecret = request.headers.get(PROXY_SECRET_HEADER);
  if (expectedSecret && proxySecret === expectedSecret) {
    const email = request.headers.get(USER_EMAIL_HEADER);
    if (email && isAllowedDomain(email)) {
      return { email, source: "proxy" };
    }
  }

  // Path 2: direct access — verify the cookie ourselves.
  const cookieToken = request.cookies.get("session_token")?.value;
  if (!cookieToken) return null;
  const email = await verifySessionJWT(cookieToken);
  if (!email) return null;
  return { email, source: "cookie" };
}

async function verifySessionJWT(token: string): Promise<string | null> {
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (payload.type !== "session") return null;
    const email = typeof payload.email === "string" ? payload.email : null;
    if (!email || !isAllowedDomain(email)) return null;
    return email;
  } catch {
    return null;
  }
}

function isAllowedDomain(email: string): boolean {
  const allowedDomain = process.env.AUTH_DOMAIN ?? "locon.pl";
  return email.endsWith(`@${allowedDomain}`);
}
