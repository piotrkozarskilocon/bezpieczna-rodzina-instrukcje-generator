import { createClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client using service role key.
 *
 * Never import this from client components — the service role key bypasses
 * RLS and would be a critical leak if shipped to the browser. RLS is OFF on
 * generator_* tables; access control is enforced in API routes via JWT email.
 */
export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export const BUCKETS = {
  PDFS: "generator-pdfs",
  IMAGES: "generator-images",
} as const;

export const BUCKETS_V2 = {
  PDFS: "gen2-pdfs",
} as const;

export const TABLES_V2 = {
  projects: "gen2_projects",
  pages: "gen2_pages",
  blocks: "gen2_blocks",
  translations: "gen2_translations",
} as const;

export const BUCKETS_V3 = {
  IMAGES: "gen3-images", // also stores reference PDFs
} as const;

export const TABLES_V3 = {
  projects: "gen3_projects",
  pages: "gen3_pages",
  elements: "gen3_elements",
  images: "gen3_images",
  translations: "gen3_translations",
  glossary: "gen3_glossary",
} as const;

export const BUCKETS_V4 = {
  IMAGES: "gen4-images",
} as const;

export const TABLES_V4 = {
  projects: "gen4_projects",
  pages: "gen4_pages",
  elements: "gen4_elements",
  images: "gen4_images",
  translations: "gen4_translations",
  glossary: "gen3_glossary", // shared global glossary
  aiHistory: "gen4_ai_history",
} as const;
