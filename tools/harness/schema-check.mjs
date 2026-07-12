import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const schemaPath = join(root, "docs", "schema.sql");

if (!existsSync(schemaPath)) {
  throw new Error("Missing docs/schema.sql");
}

const schema = readFileSync(schemaPath, "utf8");
const requiredTables = [
  "users",
  "web_sessions",
  "consent_records",
  "contact_collections",
  "contact_collection_members",
  "contact_member_tags",
  "contact_collection_policies",
  "contact_collection_consents",
  "conversation_spaces",
  "space_memberships",
  "hub_spokes",
  "invitations",
  "invitation_approval_requirements",
  "invitation_approvals",
  "messages",
  "message_audiences",
  "message_deliveries",
  "media_upload_sessions",
  "media_upload_parts",
  "media_assets",
  "media_variants",
  "message_attachments",
  "media_grants",
  "media_albums",
  "media_album_items",
  "media_processing_events",
  "stickers",
  "message_reactions",
  "events",
  "event_attendees",
  "event_reminders",
  "event_reminder_receipts",
  "call_sessions",
  "broadcast_channels",
  "avatar_profiles",
  "ai_model_configs",
  "ai_jobs",
  "voice_transcripts",
  "voice_profiles",
  "tts_assets",
  "remote_support_sessions",
  "remote_support_consents",
  "remote_support_events",
  "audit_logs",
  "idempotency_keys",
  "outbox_events"
];

for (const table of requiredTables) {
  if (!new RegExp(`create\\s+table\\s+${table}\\s*\\(`, "i").test(schema)) {
    throw new Error(`Required V2 table is missing: ${table}`);
  }
}

const tableNames = Array.from(schema.matchAll(/create\s+table\s+([a-z0-9_]+)\s*\(/gi), (match) => match[1]);
const duplicateTables = tableNames.filter((table, index) => tableNames.indexOf(table) !== index);

if (duplicateTables.length > 0) {
  throw new Error(`Duplicate table declarations: ${Array.from(new Set(duplicateTables)).join(", ")}`);
}

const requiredFragments = [
  "type in ('direct', 'open_group', 'hub', 'broadcast_channel', 'meeting_backstage')",
  "delivery_mode",
  "hub_announcement",
  "thread_key",
  "private_archive",
  "captured_at",
  "captured_local_at",
  "place_name",
  "expected_sha256_hex",
  "media_grants_viewer_idx",
  "voice_profile",
  "remote_control",
  "outbox_events_unpublished_idx",
  "token_hash bytea",
  "session_auth_version",
  "token_digest bytea",
  "bootstrap_claim_allowed",
  "contact_collection_consents_effective_idx",
  "recurrence_ends_at",
  "event_attendees_viewer_window_idx",
  "occurrence_start_at"
];

for (const fragment of requiredFragments) {
  if (!schema.includes(fragment)) {
    throw new Error(`Required schema contract is missing: ${fragment}`);
  }
}

if (/create\s+table\s+message_reads\s*\(/i.test(schema)) {
  throw new Error("Legacy message_reads table must not coexist with message_deliveries in V2.");
}

const governanceFiles = [
  "AGENTS.md",
  ".agents/skills/hahatalk-feature-stage/SKILL.md",
  ".agents/skills/hahatalk-feature-stage/agents/openai.yaml",
  ".codex/config.toml",
  ".codex/hooks.json",
  ".codex/agents/architecture-researcher.toml",
  ".codex/agents/privacy-reviewer.toml",
  ".codex/agents/feature-worker.toml",
  "apps/api/migrations/001_auth_foundation.sql",
  "apps/api/migrations/002_invitation_consent_guest_approval.sql",
  "apps/api/migrations/003_persisted_conversation_core.sql",
  "apps/api/migrations/004_contacts_family_managed_groups.sql",
  "apps/api/migrations/005_media_document_desk.sql",
  "apps/api/migrations/006_schedule_rsvp_reminders.sql"
];

for (const file of governanceFiles) {
  if (!existsSync(join(root, file))) {
    throw new Error(`Required governance file is missing: ${file}`);
  }
}

const hooks = JSON.parse(readFileSync(join(root, ".codex", "hooks.json"), "utf8"));
for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
  if (!Array.isArray(hooks.hooks?.[event]) || hooks.hooks[event].length === 0) {
    throw new Error(`Codex hook event is missing: ${event}`);
  }
}

console.log(`Schema check passed: ${requiredTables.length} V2 tables and project governance files are present.`);
