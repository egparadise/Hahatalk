import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

const defaultDatabaseUrl = "postgresql://hahatalk:hahatalk_dev_only@127.0.0.1:54329/hahatalk";
const migrationLockName = "hahatalk-schema-migrations";

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
}
