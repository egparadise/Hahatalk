import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

const defaultDatabaseUrl = "postgresql://hahatalk:hahatalk_dev_only@127.0.0.1:54329/hahatalk";
const migrationLockName = "hahatalk-schema-migrations";
const stage4PreReleaseChecksum = "363d058bc257074438363ac3cd445371d72a8f791d7da11b64c6773bc320a387";
const stage4AcceptedChecksum = "27897a9854b9eed6cc5774430e97f241ca960497f225a7e8bf58fc8fffd40261";
const stage4ExpectedColumns = new Set([
  "contact_collection_consents.collection_id", "contact_collection_consents.decided_at",
  "contact_collection_consents.decision", "contact_collection_consents.evidence_json",
  "contact_collection_consents.id", "contact_collection_consents.policy_version", "contact_collection_consents.user_id",
  "contact_collection_members.added_at", "contact_collection_members.added_by",
  "contact_collection_members.collection_id", "contact_collection_members.follow_up_at",
  "contact_collection_members.follow_up_state", "contact_collection_members.private_label",
  "contact_collection_members.relationship_notes", "contact_collection_members.removed_at",
  "contact_collection_members.sort_order", "contact_collection_members.status",
  "contact_collection_members.updated_at", "contact_collection_members.user_id",
  "contact_collection_policies.changed_by", "contact_collection_policies.collection_id",
  "contact_collection_policies.created_at", "contact_collection_policies.policy_json",
  "contact_collection_policies.roster_visibility", "contact_collection_policies.version",
  "contact_collection_policies.visibility", "contact_collections.archived_at", "contact_collections.created_at",
  "contact_collections.description", "contact_collections.id", "contact_collections.kind",
  "contact_collections.name", "contact_collections.organization_id", "contact_collections.owner_id",
  "contact_collections.policy_version", "contact_collections.roster_visibility", "contact_collections.updated_at",
  "contact_collections.visibility", "contact_member_tags.collection_id", "contact_member_tags.created_at",
  "contact_member_tags.tag", "contact_member_tags.user_id"
]);
const stage4ExpectedIndexes = new Set([
  "contact_collection_consents_effective_idx", "contact_collection_consents_pkey",
  "contact_collection_consents_user_idx", "contact_collection_members_follow_up_idx",
  "contact_collection_members_pkey", "contact_collection_members_user_active_idx",
  "contact_collection_policies_pkey", "contact_collections_active_owner_name_idx",
  "contact_collections_org_owner_idx", "contact_collections_pkey", "contact_member_tags_pkey"
]);
const stage4RequiredConstraints = new Set([
  "contact_collection_consents_collection_id_policy_version_fkey",
  "contact_collection_consents_collection_id_user_id_fkey",
  "contact_collection_members_check",
  "contact_collection_members_follow_up_state_check",
  "contact_collections_check",
  "contact_collections_kind_check",
  "contact_member_tags_collection_id_user_id_fkey",
  "contact_member_tags_tag_check1"
]);

export function getDatabaseUrl() {
  return process.env.DATABASE_URL?.trim() || defaultDatabaseUrl;
}

function resolveMigrationsDirectory() {
  const candidates = [
    process.env.HAHATALK_MIGRATIONS_DIR,
    path.resolve(process.cwd(), "migrations"),
    path.resolve(process.cwd(), "apps", "api", "migrations")
  ].filter((candidate): candidate is string => Boolean(candidate));

  const directory = candidates.find((candidate) => existsSync(candidate));
  if (!directory) {
    throw new Error(`HahaTalk migrations directory was not found. Checked: ${candidates.join(", ")}`);
  }

  return directory;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool = new Pool({
    application_name: "hahatalk-api",
    connectionString: getDatabaseUrl(),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10)
  });

  async onModuleInit() {
    this.pool.on("error", (error) => this.logger.error("Unexpected PostgreSQL pool error", error.stack));
    await this.runMigrations();
    await this.pool.query("select 1");
    this.logger.log("PostgreSQL is ready.");
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  query<TResult extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<TResult>> {
    return this.pool.query<TResult>(text, values);
  }

  async transaction<TResult>(work: (client: PoolClient) => Promise<TResult>) {
    const client = await this.pool.connect();
    let transactionStarted = false;
    try {
      await client.query("begin");
      transactionStarted = true;
      const result = await work(client);
      await client.query("commit");
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        await client.query("rollback").catch((rollbackError: Error) => {
          this.logger.error("PostgreSQL transaction rollback failed", rollbackError.stack);
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async health() {
    const startedAt = performance.now();
    await this.pool.query("select 1");
    return {
      ok: true,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt))
    };
  }

  private async runMigrations() {
    const migrationsDirectory = resolveMigrationsDirectory();
    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((fileName) => /^\d+_[a-z0-9_-]+\.sql$/i.test(fileName))
      .sort((left, right) => left.localeCompare(right));

    if (migrationFiles.length === 0) {
      throw new Error(`No HahaTalk SQL migrations were found in ${migrationsDirectory}.`);
    }

    const client = await this.pool.connect();
    try {
      await client.query(`
        create table if not exists schema_migrations (
          version text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )
      `);
      await client.query(`
        create table if not exists schema_migration_reconciliations (
          id bigserial primary key,
          version text not null,
          previous_checksum text not null,
          accepted_checksum text not null,
          reason text not null,
          reconciled_at timestamptz not null default now(),
          unique (version, previous_checksum, accepted_checksum)
        )
      `);
      await client.query("select pg_advisory_lock(hashtext($1), 0)", [migrationLockName]);

      for (const fileName of migrationFiles) {
        await this.applyMigration(client, migrationsDirectory, fileName);
      }
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1), 0)", [migrationLockName]).catch(() => undefined);
      client.release();
    }
  }

  private async applyMigration(client: PoolClient, directory: string, fileName: string) {
    const sql = await readFile(path.join(directory, fileName), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const applied = await client.query<{ checksum: string }>(
      "select checksum from schema_migrations where version = $1",
      [fileName]
    );

    if (applied.rowCount) {
      if (applied.rows[0]?.checksum !== checksum) {
        if (await this.reconcileKnownMigrationRevision(client, fileName, applied.rows[0]!.checksum, checksum)) {
          return;
        }
        throw new Error(`Applied migration checksum changed: ${fileName}`);
      }
      return;
    }

    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into schema_migrations(version, checksum) values ($1, $2)",
        [fileName, checksum]
      );
      await client.query("commit");
      this.logger.log(`Applied migration ${fileName}.`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }

  private async reconcileKnownMigrationRevision(
    client: PoolClient,
    fileName: string,
    previousChecksum: string,
    acceptedChecksum: string
  ) {
    if (
      fileName !== "004_contacts_family_managed_groups.sql"
      || previousChecksum !== stage4PreReleaseChecksum
      || acceptedChecksum !== stage4AcceptedChecksum
    ) {
      return false;
    }
    await client.query("begin");
    try {
      const columns = await client.query<{ column_name: string; table_name: string }>(
        `select table_name, column_name
         from information_schema.columns
         where table_schema = 'public' and table_name like 'contact_%'`
      );
      const indexes = await client.query<{ indexname: string }>(
        `select indexname from pg_indexes
         where schemaname = 'public' and tablename like 'contact_%'`
      );
      const constraints = await client.query<{ conname: string }>(
        `select conname from pg_constraint
         where connamespace = 'public'::regnamespace
           and conrelid::regclass::text like 'contact_%'`
      );
      const actualColumns = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
      const actualIndexes = new Set(indexes.rows.map((row) => row.indexname));
      const actualConstraints = new Set(constraints.rows.map((row) => row.conname));
      const exactColumns = actualColumns.size === stage4ExpectedColumns.size
        && [...stage4ExpectedColumns].every((name) => actualColumns.has(name));
      const exactIndexes = actualIndexes.size === stage4ExpectedIndexes.size
        && [...stage4ExpectedIndexes].every((name) => actualIndexes.has(name));
      const requiredConstraints = [...stage4RequiredConstraints].every((name) => actualConstraints.has(name));
      if (!exactColumns || !exactIndexes || !requiredConstraints) {
        throw new Error("Stage 4 migration revision has an unexpected database shape.");
      }
      await client.query(
        `insert into schema_migration_reconciliations (
           version, previous_checksum, accepted_checksum, reason
         ) values ($1, $2, $3, 'stage4-pre-release-schema-equivalent')
         on conflict do nothing`,
        [fileName, previousChecksum, acceptedChecksum]
      );
      await client.query(
        "update schema_migrations set checksum = $2 where version = $1 and checksum = $3",
        [fileName, acceptedChecksum, previousChecksum]
      );
      await client.query("commit");
      this.logger.warn(`Reconciled schema-equivalent pre-release checksum for ${fileName}.`);
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
}
