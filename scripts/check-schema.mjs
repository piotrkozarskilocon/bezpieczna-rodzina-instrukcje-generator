// Jednorazowy skrypt — sprawdza czy wszystkie kolumny / tabele wymagane przez
// migracje 0001..0009 są obecne w produkcyjnym Supabase.
// Uruchomienie: node scripts/check-schema.mjs

// Wczytaj .env.local przez --env-file (node 20+).
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w .env.local");
  process.exit(1);
}

// Lista (tabela, kolumna) — co MUSI istnieć po wszystkich migracjach.
// Skupiamy się na v4 (aktualna ścieżka). v2/v3 sprawdzamy jednym kanonicznym
// kluczem każdej tabeli żeby tylko potwierdzić że są na miejscu.
const expectations = [
  // 0001 v1
  ["generator_projects", "id"],
  // 0003 v2
  ["gen2_projects", "id"],
  // 0004 v3
  ["gen3_glossary", "source_term"],
  ["gen3_glossary", "do_not_translate"],
  // 0005 — v4 base
  ["gen4_projects", "id"],
  ["gen4_projects", "owner_email"],
  ["gen4_projects", "ai_input"],
  ["gen4_projects", "ai_log"],
  ["gen4_projects", "default_lang"],
  ["gen4_pages", "id"],
  ["gen4_pages", "project_id"],
  ["gen4_pages", "page_number"],
  ["gen4_pages", "template"],
  ["gen4_pages", "width_mm"],
  ["gen4_pages", "height_mm"],
  ["gen4_pages", "notes"],
  ["gen4_elements", "id"],
  ["gen4_elements", "page_id"],
  ["gen4_elements", "type"],
  ["gen4_elements", "x_mm"],
  ["gen4_elements", "y_mm"],
  ["gen4_elements", "z_index"],
  ["gen4_elements", "rotation_deg"],
  ["gen4_elements", "properties"],
  ["gen4_elements", "origin"],
  ["gen4_translations", "id"],
  ["gen4_translations", "element_id"],
  ["gen4_translations", "language"],
  ["gen4_translations", "text"],
  ["gen4_translations", "is_pinned"],
  ["gen4_images", "id"],
  ["gen4_images", "project_id"],
  ["gen4_ai_history", "id"],
  ["gen4_ai_history", "role"],
  // 0006 — design system (legacy column)
  ["gen4_projects", "design_system"],
  // 0007 — multi-DS
  ["gen4_design_systems", "id"],
  ["gen4_design_systems", "project_id"],
  ["gen4_design_systems", "name"],
  ["gen4_design_systems", "content"],
  ["gen4_design_systems", "is_default"],
  // 0008 — title
  ["gen4_pages", "title"],
  // 0009 — document/device type
  ["gen4_projects", "document_type"],
  ["gen4_projects", "device_type"],
  ["gen4_projects", "legal_template_version"],
  // 0010 — images description + preferred_page
  ["gen4_images", "description"],
  ["gen4_images", "preferred_page_id"],
  ["gen4_images", "mime_type"],
  // 0011 — AI notes
  ["gen4_ai_notes", "id"],
  ["gen4_ai_notes", "owner_email"],
  ["gen4_ai_notes", "scope"],
  ["gen4_ai_notes", "scope_value"],
  ["gen4_ai_notes", "content"],
  ["gen4_ai_notes", "is_active"],
  ["gen4_ai_notes", "used_count"],
  // 0012 — reference docs
  ["gen4_reference_docs", "id"],
  ["gen4_reference_docs", "project_id"],
  ["gen4_reference_docs", "kind"],
  ["gen4_reference_docs", "name"],
  ["gen4_reference_docs", "file_path"],
  ["gen4_reference_docs", "anthropic_file_id"],
  ["gen4_reference_docs", "extracted_summary"],
  // 0013 — translation memory
  ["gen4_translation_memory", "id"],
  ["gen4_translation_memory", "owner_email"],
  ["gen4_translation_memory", "target_lang"],
  ["gen4_translation_memory", "source_text"],
  ["gen4_translation_memory", "target_text"],
  ["gen4_translation_memory", "source_hash"],
  ["gen4_translation_memory", "used_count"],
  // 0014 — project versions
  ["gen4_project_versions", "id"],
  ["gen4_project_versions", "project_id"],
  ["gen4_project_versions", "version_number"],
  ["gen4_project_versions", "description"],
  ["gen4_project_versions", "snapshot"],
  // 0015 — post-edit log
  ["gen4_post_edit_log", "id"],
  ["gen4_post_edit_log", "project_id"],
  ["gen4_post_edit_log", "owner_email"],
  ["gen4_post_edit_log", "source"],
  ["gen4_post_edit_log", "description"],
];

async function checkColumn(table, column) {
  // PostgREST: select konkretnej kolumny + limit=0. Jeśli kolumny lub tabeli brak,
  // dostaniemy 400/404 z opisem błędu.
  const url = `${URL}/rest/v1/${table}?select=${column}&limit=0`;
  const res = await fetch(url, {
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: "count=exact",
    },
  });
  if (res.ok) return { ok: true };
  const text = await res.text();
  return { ok: false, status: res.status, msg: text.slice(0, 240) };
}

const missing = [];
const presentTables = new Set();
const missingTables = new Set();

for (const [table, column] of expectations) {
  const r = await checkColumn(table, column);
  if (r.ok) {
    presentTables.add(table);
    process.stdout.write(".");
  } else {
    process.stdout.write("X");
    missing.push({ table, column, ...r });
    if (r.msg.includes("Could not find the table") || r.status === 404) {
      missingTables.add(table);
    }
  }
}
console.log("");

if (missing.length === 0) {
  console.log(`✓ Wszystkie ${expectations.length} kolumn (${presentTables.size} tabel) na miejscu.`);
  process.exit(0);
}

console.log("\nBRAKUJĄCE KOLUMNY / TABELE:\n");
const grouped = new Map();
for (const m of missing) {
  if (!grouped.has(m.table)) grouped.set(m.table, []);
  grouped.get(m.table).push(m);
}
for (const [table, items] of grouped) {
  if (missingTables.has(table)) {
    console.log(`✗ TABELA BRAKUJE: ${table}`);
  } else {
    console.log(`~ tabela ${table} istnieje, ale brakuje kolumn:`);
    for (const it of items) {
      console.log(`    - ${it.column}    (HTTP ${it.status}: ${it.msg.slice(0, 120)})`);
    }
  }
}
process.exit(1);
