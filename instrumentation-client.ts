/**
 * Sentry init dla klienta (browser). Next.js 15+ uzywa instrumentation-client.ts
 * zamiast starego sentry.client.config.ts.
 *
 * Bez DSN: SDK no-op, zero ruchu sieciowego.
 */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    // Session Replay — replay sesji TYLKO na error (oszczednie, free tier).
    // Pelne sesje (sampleRate > 0) szybko wyczerpia limity.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      Sentry.replayIntegration({
        maskAllText: false, // niech user widzi co kliknieto (to nie aplikacja publiczna)
        blockAllMedia: false,
      }),
    ],
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "local",
  });
}

// Sentry oczekuje export dla router transitions (Next 15+ App Router).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
