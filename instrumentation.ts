/**
 * Next.js instrumentation hook — startuje Sentry SDK w odpowiednim runtime.
 *
 * Wywolywane raz przy starcie procesu (cold start serverless). NEXT_RUNTIME
 * env var rozroznia node.js vs edge — kazdy ma osobny init.
 */
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Wymagane przez Next.js 15+ dla server-side error capturing w App Router.
export const onRequestError = Sentry.captureRequestError;
