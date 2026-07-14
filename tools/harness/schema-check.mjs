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
  "call_participants",
  "call_events",
  "call_recordings",
  "call_recording_participants",
  "broadcast_channels",
  "channel_subscriptions",
  "broadcast_sessions",
  "broadcast_messages",
  "broadcast_reactions",
  "broadcast_moderation_actions",
  "broadcast_replays",
  "broadcast_private_handoffs",
  "broadcast_events",
  "avatar_profiles",
  "ai_model_configs",
  "ai_workers",
  "ai_jobs",
  "ai_job_attempts",
  "ai_job_dispatches",
  "ai_summary_inputs",
  "voice_transcripts",
  "voice_profile_consents",
  "voice_profiles",
  "tts_assets",
  "remote_support_sessions",
  "remote_support_consents",
  "remote_support_agent_credentials",
  "remote_support_commands",
  "remote_support_events",
  "mobile_sessions",
  "mobile_refresh_tokens",
  "mobile_devices",
  "mobile_push_jobs",
  "mobile_push_attempts",
  "rate_limit_buckets",
  "audit_export_jobs",
  "retention_policies",
  "legal_holds",
  "data_lifecycle_jobs",
  "release_candidates",
  "release_gate_results",
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
  "occurrence_start_at",
  "provider_room_name",
  "call_participants_user_status_idx",
  "token_version",
  "session_kind",
  "scheduled_meeting",
  "lobby_opens_at",
  "call_sessions_event_occurrence_meeting_idx",
  "call_participants_meeting_moderation_idx",
  "screen_share_status",
  "call_participants_one_screen_share_idx",
  "call_recordings_one_pending_or_active_idx",
  "call_recordings_provider_recovery_idx",
  "consent_snapshot_json",
  "room_composite",
  "session_kind in ('ad_hoc', 'scheduled_meeting', 'broadcast')",
  "broadcast_sessions_one_live_channel_idx",
  "broadcast_messages_moderation_queue_idx",
  "fencing_token",
  "redis_stream",
  "database_poll",
  "voice_profile_enrollment",
  "review_status text not null check (review_status in ('ai_draft', 'sending', 'reviewed', 'rejected'))",
  "source in ('file_upload', 'screen_capture', 'ai_generated')",
  "minimum_version in ('3.5', '3.6')",
  "credential_kind in ('activation', 'agent')",
  "command_kind in ('pointer_move', 'pointer_button', 'wheel', 'key')",
  "client_command_id",
  "control_epoch",
  "mobile_sessions_active_installation_idx",
  "push_token_ciphertext bytea not null",
  "event_type in ('conversation.message', 'calendar.reminder', 'call.invite', 'meeting.lobby', 'broadcast.started')",
  "mobile_push_jobs_claim_idx",
  "audit_export_jobs_org_isolation",
  "retention_policies_org_isolation",
  "legal_holds_org_isolation",
  "data_lifecycle_jobs_org_isolation",
  "release_candidates_org_isolation",
  "release_gate_results_org_isolation",
  "pending_external",
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
  "apps/api/migrations/006_schedule_rsvp_reminders.sql",
  "apps/api/migrations/007_livekit_call_core.sql",
  "apps/api/migrations/008_scheduled_meeting_lobby.sql",
  "apps/api/migrations/009_screen_share_device_background.sql",
  "apps/api/migrations/010_recording_consent_egress.sql",
  "apps/api/migrations/011_personal_broadcast.sql",
  "apps/api/migrations/012_ai_voice_workbench.sql",
  "apps/api/migrations/013_consented_remote_support.sql",
  "apps/api/migrations/014_mobile_companion.sql",
  "apps/api/migrations/015_release_hardening.sql",
  "apps/api/migrations/016_release_hardening_lifecycle_concurrency.sql",
  "docs/stage-8-ai-voice-workbench.md",
  "docs/stage-9-consented-remote-support.md",
  "docs/stage-10-mobile-companion.md",
  "docs/stage-11-hardening-release.md",
  "docs/stage-6f-trusted-media-infrastructure.md",
  "infra/media/README.md",
  "infra/media/compose.smoke.yaml",
  "infra/media/deployment.production.example.json",
  "infra/media/deployment.smoke.json",
  "infra/media/provision-minio.sh",
  "tools/infra/media-deployment-lib.mjs",
  "tools/infra/render-media-deployment.mjs",
  "tools/harness/media-egress-smoke.mjs",
  "tools/harness/media-infrastructure-config.mjs",
  "tools/harness/consented-remote-support.mjs",
  "tools/harness/mobile-companion.mjs",
  "tools/harness/mobile-bundle-check.mjs",
  "tools/harness/release-hardening.mjs",
  "tools/harness/release-load-reconnect.mjs",
  "tools/harness/release-artifact-check.mjs",
  "tools/release/create-release-manifest.mjs",
  "tools/release/create-sbom.mjs",
  ".github/workflows/release-candidate.yml",
  "apps/mobile/app.config.ts",
  "apps/mobile/src/lib/offline-queue.ts",
  "tools/harness/windows-remote-agent-process-smoke.cjs",
  "tools/harness/windows-remote-support-renderer-smoke.mjs"
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
