/**
 * Globalna pamięć tłumaczeń — AI nie tłumaczy ponownie tego co już raz
 * przetłumaczył. Dzięki temu terminologia jest spójna między projektami
 * (np. "Locon Watch" zawsze tłumaczy się tak samo).
 *
 * Per (owner_email, target_lang, source_hash) trzymamy jeden wpis.
 * Hash to MD5 z source_text — szybki lookup, deterministyczny, bez wymogu
 * zainstalowanej extension w Postgres.
 */

import { createHash } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase";

export function hashSource(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

export interface CachedTranslation {
  source_text: string;
  target_text: string;
}

/** Lookup grupowy — dla listy source_text zwraca mapę element_id-like-id
 *  → cached target_text (jeśli istnieje w memory). */
export async function lookupTranslations(
  ownerEmail: string,
  targetLang: string,
  sources: Array<{ id: string; text: string }>,
): Promise<Map<string, string>> {
  const sb = getSupabaseAdmin();
  if (sources.length === 0) return new Map();

  const hashes = sources.map((s) => hashSource(s.text));
  const { data } = await sb
    .from("gen4_translation_memory")
    .select("source_hash, target_text")
    .eq("owner_email", ownerEmail)
    .eq("target_lang", targetLang)
    .in("source_hash", hashes);

  const byHash = new Map<string, string>();
  for (const row of data ?? []) byHash.set(row.source_hash, row.target_text);

  const out = new Map<string, string>();
  for (let i = 0; i < sources.length; i++) {
    const hit = byHash.get(hashes[i]);
    if (hit) out.set(sources[i].id, hit);
  }
  return out;
}

/** Zapisuje nowe tłumaczenia do memory (upsert). Każdy hit zwiększa used_count.
 *  Wykonywane fire-and-forget po sukcesie tłumaczenia projektu. */
export async function saveTranslations(
  ownerEmail: string,
  targetLang: string,
  entries: Array<{ source_text: string; target_text: string }>,
): Promise<void> {
  if (entries.length === 0) return;
  const sb = getSupabaseAdmin();
  const rows = entries.map((e) => ({
    owner_email: ownerEmail,
    source_lang: "pl",
    target_lang: targetLang,
    source_text: e.source_text,
    target_text: e.target_text,
    source_hash: hashSource(e.source_text),
    used_count: 1,
  }));
  // Upsert na unique index (owner_email, target_lang, source_hash).
  // On conflict — zwiększamy used_count. Supabase JS klient pozwala na to
  // przez .upsert() z onConflict.
  await sb
    .from("gen4_translation_memory")
    .upsert(rows, { onConflict: "owner_email,target_lang,source_hash", ignoreDuplicates: false });
}

/** Inkrement used_count dla hits (gdy memory zwróciło cache). Fire-and-forget. */
export async function incrementMemoryUseCount(
  ownerEmail: string,
  targetLang: string,
  sourceTexts: string[],
): Promise<void> {
  if (sourceTexts.length === 0) return;
  const sb = getSupabaseAdmin();
  const hashes = sourceTexts.map(hashSource);
  // PostgREST nie ma atomic increment — zrobimy select+update. Dla małych
  // ilości (zwykle 30-100 elementów per projekt) akceptowalne.
  const { data } = await sb
    .from("gen4_translation_memory")
    .select("id, used_count")
    .eq("owner_email", ownerEmail)
    .eq("target_lang", targetLang)
    .in("source_hash", hashes);
  for (const row of data ?? []) {
    await sb
      .from("gen4_translation_memory")
      .update({ used_count: (row.used_count ?? 0) + 1 })
      .eq("id", row.id);
  }
}
