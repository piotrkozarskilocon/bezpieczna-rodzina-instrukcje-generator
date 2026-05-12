/**
 * Zapis kazdego wywolania AI do gen4_ai_calls — sluzy do panelu debug,
 * gdzie user moze zobaczyc dokladnie co generator wysylal do Claude i co
 * wrocilo. Fire-and-forget: bledy zapisu sa logowane ale nie blokuja
 * odpowiedzi do usera.
 */

import { getSupabaseAdmin } from "@/lib/supabase";

export interface AiCallLogEntry {
  project_id: string;
  page_id?: string | null;
  element_id?: string | null;
  endpoint: string;
  context_type: "page" | "element" | "project" | "global";
  user_instruction?: string | null;
  system_prompt?: string | null;
  user_prompt?: string | null;
  prompt_edited_by_user?: boolean;
  model?: string | null;
  max_tokens?: number | null;
  temperature?: number | null;
  response_text?: string | null;
  error?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cache_creation_tokens?: number | null;
  cache_read_tokens?: number | null;
  duration_ms?: number | null;
  user_email?: string | null;
}

/** Tnij dlugie pola zeby tabela nie urosla bez limitu (system prompt
 *  bywa 5-20k znakow; response text moze byc bardzo dlugi). */
const MAX_PROMPT_LEN = 50_000;
const MAX_RESPONSE_LEN = 100_000;

function truncate(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[...truncated, original length: ${s.length}]`;
}

export async function logAiCall(entry: AiCallLogEntry): Promise<void> {
  try {
    const sb = getSupabaseAdmin();
    await sb.from("gen4_ai_calls").insert({
      project_id: entry.project_id,
      page_id: entry.page_id ?? null,
      element_id: entry.element_id ?? null,
      endpoint: entry.endpoint,
      context_type: entry.context_type,
      user_instruction: truncate(entry.user_instruction, 10_000),
      system_prompt: truncate(entry.system_prompt, MAX_PROMPT_LEN),
      user_prompt: truncate(entry.user_prompt, MAX_PROMPT_LEN),
      prompt_edited_by_user: entry.prompt_edited_by_user ?? false,
      model: entry.model ?? null,
      max_tokens: entry.max_tokens ?? null,
      temperature: entry.temperature ?? null,
      response_text: truncate(entry.response_text, MAX_RESPONSE_LEN),
      error: truncate(entry.error, 5_000),
      tokens_in: entry.tokens_in ?? null,
      tokens_out: entry.tokens_out ?? null,
      cache_creation_tokens: entry.cache_creation_tokens ?? null,
      cache_read_tokens: entry.cache_read_tokens ?? null,
      duration_ms: entry.duration_ms ?? null,
      user_email: entry.user_email ?? null,
    });
  } catch (err) {
    console.warn("[ai-log] failed to record call:", err instanceof Error ? err.message : err);
  }
}
