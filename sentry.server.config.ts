/**
 * Sentry init dla node.js runtime (API routes, server components, server actions).
 * Bez DSN: SDK no-op, zero ruchu sieciowego.
 */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // 10% requestow zbieranych w performance tracing. Mniej dla low-traffic projektu.
    tracesSampleRate: 0.1,
    // Filtruj noise — health checks, OPTIONS preflighty itd.
    ignoreErrors: [
      // Anthropic SDK throws AbortError gdy klient zerwie stream
      "AbortError",
      // Vercel function timeout — known issue, telemetria nic nie dodaje
      "FUNCTION_INVOCATION_TIMEOUT",
    ],
    // beforeSend hook moze filtrowac dalej. Tu prosta wersja — przepuscamy wszystko
    // poza errorami o znanej etiologii.
    environment: process.env.VERCEL_ENV ?? "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
  });
}
