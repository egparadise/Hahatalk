import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "pg";

const confirmation = "RESET_HAHATALK_TEST_DATA";
const assistantSpaceId = "00000000-0000-4000-8000-000000000204";
const ownerId = "00000000-0000-4000-8000-000000000101";

function argument(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function assertText(value, label, maximum) {
  const normalized = value?.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid.`);
  return normalized;
}

if (argument("confirm") !== confirmation) {
  throw new Error(`Refusing destructive reset. Pass --confirm=${confirmation}.`);
}

const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
const userData = path.join(appData, "HahaTalk");
const status = JSON.parse(await readFile(path.join(userData, "runtime-status.json"), "utf8"));
const credentials = JSON.parse(await readFile(path.join(userData, "postgres-credentials.json"), "utf8"));
if (status.databaseMode !== "embedded-postgresql" || !Number.isInteger(status.databasePort)) {
  throw new Error("A running packaged HahaTalk embedded database is required.");
}
if (new URL(status.apiUrl).hostname !== "127.0.0.1") throw new Error("HahaTalk API is not bound to loopback.");
const health = await fetch(`${status.apiUrl}/health`, { signal: AbortSignal.timeout(2_000) });
if (!health.ok) throw new Error("HahaTalk API is not healthy.");

const ownerEmail = argument("owner-email")?.trim().toLowerCase();
const ownerName = argument("owner-name")?.trim();
if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new Error("Owner email is invalid.");
if (ownerName) assertText(ownerName, "Owner name", 120);

const database = new Client({
  database: "hahatalk",
  host: "127.0.0.1",
  password: credentials.password,
  port: status.databasePort,
  user: credentials.user
});

await database.connect();
try {
  await database.query("begin");
  await database.query("select pg_advisory_xact_lock(hashtext('hahatalk-installed-test-data-reset'))");
  const migration = await database.query(
    "select 1 from schema_migrations where version = '017_local_ai_conversation.sql'"
  );
  if (!migration.rowCount) throw new Error("HahaTalk 0.19.0 migration 017 must be installed before reset.");
  const assistant = await database.query(
    `select 1 from conversation_spaces
     where id = $1 and archived_at is null and settings_json ->> 'assistantKind' = 'local_ollama'`,
    [assistantSpaceId]
  );
  if (!assistant.rowCount) throw new Error("The local assistant conversation is missing.");

  const before = await database.query(
    `select
       (select count(*)::int from messages) as messages,
       (select count(*)::int from message_deliveries) as deliveries,
       (select count(*)::int from message_attachments) as attachments,
       (select count(*)::int from ai_jobs where space_id is not null) as conversation_ai_jobs`
  );
  await database.query("delete from outbox_events where aggregate_type = 'message'");
  await database.query("delete from mobile_push_jobs where event_key like 'message:%'");
  await database.query("delete from ai_jobs where space_id is not null");
  await database.query("delete from idempotency_keys where scope like 'message.%' or scope like 'media.%'");
  await database.query("delete from messages");
  await database.query(
    `update conversation_spaces
     set updated_at = case when id = $1 then now() else created_at end
     where archived_at is null`,
    [assistantSpaceId]
  );
  if (ownerEmail || ownerName) {
    await database.query(
      `update users
       set email = coalesce($2, email), display_name = coalesce($3, display_name), updated_at = now()
       where id = $1`,
      [ownerId, ownerEmail ?? null, ownerName ?? null]
    );
  }
  const owner = await database.query(
    "select email::text, display_name from users where id = $1",
    [ownerId]
  );
  if (!owner.rows[0]) throw new Error("The HahaTalk owner account is missing.");
  await database.query(
    `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
     values (
       '00000000-0000-4000-8000-000000000001', $1,
       'maintenance.local_test_messages_reset', 'conversation_space', $2, $3::jsonb
     )`,
    [ownerId, assistantSpaceId, JSON.stringify(before.rows[0])]
  );
  await database.query("commit");
  process.stdout.write(`${JSON.stringify({
    assistantSpaceId,
    cleared: before.rows[0],
    owner: owner.rows[0],
    version: status.version
  }, null, 2)}\n`);
} catch (error) {
  await database.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await database.end();
}
