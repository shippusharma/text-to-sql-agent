import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
  connectionProfileSchema,
  type ConnectionProfile,
  type QueryColumn,
  type QueryResult,
  type SchemaSnapshot,
} from '../types';
import { UserFacingError } from './error';
import { boundRows } from './result';

type PostgresProfile = Extract<ConnectionProfile, { dialect: 'postgresql' }>;
type MysqlProfile = Extract<ConnectionProfile, { dialect: 'mysql' }>;
type SqliteProfile = Extract<ConnectionProfile, { dialect: 'sqlite' }>;

const SCHEMA_CACHE_TTL_MS = 60_000;
const SCHEMA_CACHE_MAX_ENTRIES = 20;
const schemaCache = new Map<string, { expiresAt: number; snapshot: SchemaSnapshot }>();

function envList(name: string) {
  return (process.env[name] ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * Optional server-side guard rails. When `ALLOWED_DB_HOSTS` or `SQLITE_ALLOWED_DIRS` is set, the
 * server refuses to connect anywhere else, so the API cannot be used to probe internal hosts or
 * open arbitrary files.
 */
function assertTargetAllowed(profile: ConnectionProfile) {
  if (profile.dialect === 'sqlite') {
    const allowedDirs = envList('SQLITE_ALLOWED_DIRS').map(dir => {
      try {
        return realpathSync(dir);
      } catch {
        return path.resolve(dir);
      }
    });
    if (!allowedDirs.length) return profile;
    let resolved: string;
    try {
      resolved = realpathSync(profile.path);
    } catch {
      throw new UserFacingError('This SQLite file does not exist or could not be resolved.');
    }
    if (!allowedDirs.some(dir => resolved === dir || resolved.startsWith(`${dir}${path.sep}`)))
      throw new UserFacingError(
        'This SQLite path is outside the directories allowed by the server.',
      );
    // Open the canonical path that was checked, not a symlink that could be retargeted afterward.
    return { ...profile, path: resolved };
  }
  const allowedHosts = envList('ALLOWED_DB_HOSTS').map(host => host.toLowerCase());
  if (allowedHosts.length && !allowedHosts.includes(profile.host.toLowerCase()))
    throw new UserFacingError('This database host is not allowed by the server.');
  return profile;
}

function assertProfile(profile: ConnectionProfile) {
  const parsed = connectionProfileSchema.parse(profile);
  return assertTargetAllowed(parsed);
}

async function openSqlite(profile: SqliteProfile) {
  const Database = (await import('better-sqlite3')).default;
  return new Database(profile.path, { readonly: true, fileMustExist: true });
}

async function openPostgres(profile: PostgresProfile) {
  const { Client } = await import('pg');
  const client = new Client({
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.username,
    password: profile.password,
    ssl: profile.ssl ? { rejectUnauthorized: profile.sslRejectUnauthorized } : undefined,
    connectionTimeoutMillis: profile.timeoutMs,
    query_timeout: profile.timeoutMs + 5_000,
  });
  await client.connect();
  return client;
}

async function openMysql(profile: MysqlProfile) {
  const mysql = await import('mysql2/promise');
  return mysql.createConnection({
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.username,
    password: profile.password,
    ssl: profile.ssl ? { rejectUnauthorized: profile.sslRejectUnauthorized } : undefined,
    connectTimeout: profile.timeoutMs,
  });
}

export async function healthCheck(input: ConnectionProfile) {
  const profile = assertProfile(input);
  const started = performance.now();
  let version: string;

  if (profile.dialect === 'sqlite') {
    const db = await openSqlite(profile);
    try {
      version = (db.prepare('SELECT sqlite_version() AS version').get() as { version: string })
        .version;
    } finally {
      db.close();
    }
  } else if (profile.dialect === 'postgresql') {
    const client = await openPostgres(profile);
    try {
      const result = await client.query('SELECT version() AS version');
      version = String(result.rows[0]?.version ?? 'PostgreSQL');
    } finally {
      await client.end();
    }
  } else {
    const connection = await openMysql(profile);
    try {
      const [rows] = await connection.execute('SELECT VERSION() AS version');
      version = (rows as Array<{ version: string }>)[0]?.version ?? 'MySQL';
    } finally {
      await connection.end();
    }
  }

  return {
    ok: true,
    version,
    latencyMs: Math.round(performance.now() - started),
    schemaAvailable: true,
  };
}

function schemaCacheKey(profile: ConnectionProfile) {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

/** Reads the schema, reusing a snapshot from the last minute unless `fresh` is requested. */
export async function introspect(
  input: ConnectionProfile,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<SchemaSnapshot> {
  const profile = assertProfile(input);
  const key = schemaCacheKey(profile);
  const cached = schemaCache.get(key);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.snapshot;

  const snapshot = await readSchema(profile);
  schemaCache.delete(key);
  schemaCache.set(key, { expiresAt: Date.now() + SCHEMA_CACHE_TTL_MS, snapshot });
  while (schemaCache.size > SCHEMA_CACHE_MAX_ENTRIES) {
    const oldest = schemaCache.keys().next().value;
    if (oldest === undefined) break;
    schemaCache.delete(oldest);
  }
  return snapshot;
}

async function readSchema(profile: ConnectionProfile): Promise<SchemaSnapshot> {
  let tables: SchemaSnapshot['tables'];
  let relationships: SchemaSnapshot['relationships'];

  if (profile.dialect === 'sqlite') {
    const db = await openSqlite(profile);
    try {
      const names = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      tables = names.map(({ name }) => ({
        name,
        columns: (
          db.prepare(`PRAGMA table_info(${quoteIdentifier(name, 'sqlite')})`).all() as Array<{
            name: string;
            type: string;
          }>
        ).map(column => ({ name: column.name, type: column.type || 'unknown' })),
      }));
      relationships = names.flatMap(({ name }) => {
        const foreignKeys = db
          .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name, 'sqlite')})`)
          .all() as Array<{ table: string; from: string; to: string }>;
        return foreignKeys.map(foreignKey => ({
          fromTable: name,
          fromColumn: foreignKey.from,
          toTable: foreignKey.table,
          toColumn: foreignKey.to,
        }));
      });
    } finally {
      db.close();
    }
  } else if (profile.dialect === 'postgresql') {
    const client = await openPostgres(profile);
    try {
      const result = await client.query(
        `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position`,
      );
      tables = groupColumns(
        result.rows.map(row => ({
          schema: row.table_schema,
          name: row.table_name,
          column: row.column_name,
          type: row.data_type,
        })),
      );
      try {
        const foreignKeys = await client.query(
          `SELECT from_ns.nspname AS from_schema, from_table.relname AS from_table, from_column.attname AS from_column, to_ns.nspname AS to_schema, to_table.relname AS to_table, to_column.attname AS to_column FROM pg_constraint constraint_row JOIN pg_class from_table ON from_table.oid = constraint_row.conrelid JOIN pg_namespace from_ns ON from_ns.oid = from_table.relnamespace JOIN pg_class to_table ON to_table.oid = constraint_row.confrelid JOIN pg_namespace to_ns ON to_ns.oid = to_table.relnamespace JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS from_key(attnum, position) ON true JOIN LATERAL unnest(constraint_row.confkey) WITH ORDINALITY AS to_key(attnum, position) ON to_key.position = from_key.position JOIN pg_attribute from_column ON from_column.attrelid = constraint_row.conrelid AND from_column.attnum = from_key.attnum JOIN pg_attribute to_column ON to_column.attrelid = constraint_row.confrelid AND to_column.attnum = to_key.attnum WHERE constraint_row.contype = 'f' AND from_ns.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY from_ns.nspname, from_table.relname, constraint_row.conname, from_key.position`,
        );
        relationships = foreignKeys.rows.map(row => ({
          fromSchema: row.from_schema,
          fromTable: row.from_table,
          fromColumn: row.from_column,
          toSchema: row.to_schema,
          toTable: row.to_table,
          toColumn: row.to_column,
        }));
      } catch {
        relationships = [];
      }
    } finally {
      await client.end();
    }
  } else {
    const connection = await openMysql(profile);
    try {
      const [rows] = await connection.execute(
        `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type FROM information_schema.columns WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [profile.database],
      );
      tables = groupColumns(
        (rows as Array<Record<string, string>>).map(row => ({
          schema: row.table_schema,
          name: row.table_name,
          column: row.column_name,
          type: row.data_type,
        })),
      );
      try {
        const [foreignKeyRows] = await connection.execute(
          `SELECT TABLE_SCHEMA AS from_schema, TABLE_NAME AS from_table, COLUMN_NAME AS from_column, REFERENCED_TABLE_SCHEMA AS to_schema, REFERENCED_TABLE_NAME AS to_table, REFERENCED_COLUMN_NAME AS to_column FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
          [profile.database],
        );
        relationships = (foreignKeyRows as Array<Record<string, string>>).map(row => ({
          fromSchema: row.from_schema,
          fromTable: row.from_table,
          fromColumn: row.from_column,
          toSchema: row.to_schema,
          toTable: row.to_table,
          toColumn: row.to_column,
        }));
      } catch {
        relationships = [];
      }
    } finally {
      await connection.end();
    }
  }

  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ tables, relationships }))
    .digest('hex')
    .slice(0, 16);
  return { tables, relationships, fingerprint };
}

export type TableRowCount = { schema: string | null; table: string; rows: number | null };

/**
 * Row counts per table. PostgreSQL and MySQL use the planner's statistics, which return instantly
 * (exact COUNT(*) scans every table and easily exceeds the query timeout on real databases).
 * SQLite files are local, so they are counted exactly.
 */
export async function tableRowCounts(
  input: ConnectionProfile,
): Promise<{ estimated: boolean; counts: TableRowCount[] }> {
  const profile = assertProfile(input);

  if (profile.dialect === 'sqlite') {
    const db = await openSqlite(profile);
    try {
      const names = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      const counts = names.map(({ name }) => ({
        schema: null,
        table: name,
        rows: (
          db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(name, 'sqlite')}`).get() as {
            n: number;
          }
        ).n,
      }));
      return { estimated: false, counts };
    } finally {
      db.close();
    }
  }

  if (profile.dialect === 'postgresql') {
    const client = await openPostgres(profile);
    try {
      // reltuples is -1 for tables that have never been vacuumed or analyzed; partitioned tables
      // report the sum of their partitions.
      const result = await client.query(
        `SELECT n.nspname AS schema, c.relname AS "table", CASE WHEN c.relkind = 'p' THEN (SELECT SUM(GREATEST(part.reltuples, 0)) FROM pg_inherits inh JOIN pg_class part ON part.oid = inh.inhrelid WHERE inh.inhparent = c.oid)::bigint WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS "rows" FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY n.nspname, c.relname`,
      );
      return {
        estimated: true,
        counts: result.rows.map(row => ({
          schema: row.schema,
          table: row.table,
          rows: row.rows === null ? null : Number(row.rows),
        })),
      };
    } finally {
      await client.end();
    }
  }

  const connection = await openMysql(profile);
  try {
    const [rows] = await connection.execute(
      `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, TABLE_ROWS AS table_rows FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      [profile.database],
    );
    return {
      estimated: true,
      counts: (rows as Array<Record<string, unknown>>).map(row => ({
        schema: String(row.table_schema),
        table: String(row.table_name),
        rows: row.table_rows === null ? null : Number(row.table_rows),
      })),
    };
  } finally {
    await connection.end();
  }
}

function groupColumns(rows: Array<{ schema: string; name: string; column: string; type: string }>) {
  const grouped = new Map<string, SchemaSnapshot['tables'][number]>();
  rows.forEach(row => {
    const key = `${row.schema}.${row.name}`;
    const table = grouped.get(key) ?? { schema: row.schema, name: row.name, columns: [] };
    table.columns.push({ name: row.column, type: row.type });
    grouped.set(key, table);
  });
  return [...grouped.values()];
}

function quoteIdentifier(value: string, dialect: 'sqlite' | 'postgresql' | 'mysql') {
  const quote = dialect === 'mysql' ? '`' : '"';
  return `${quote}${value.replaceAll(quote, quote + quote)}${quote}`;
}

/** Applies a per-statement time limit on MySQL (max_execution_time) or MariaDB (max_statement_time). */
async function setMysqlTimeout(
  connection: Awaited<ReturnType<typeof openMysql>>,
  timeoutMs: number,
) {
  try {
    await connection.query(`SET SESSION max_execution_time = ${Math.round(timeoutMs)}`);
  } catch {
    try {
      await connection.query(`SET SESSION max_statement_time = ${Math.ceil(timeoutMs / 1000)}`);
    } catch {
      // Older servers support neither variable; the connection timeout still applies.
    }
  }
}

function isStatementTimeout(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const { code, errno, message } = error as { code?: unknown; errno?: unknown; message?: unknown };
  return (
    code === '57014' || // PostgreSQL query_canceled (statement_timeout)
    code === 'PROTOCOL_SEQUENCE_TIMEOUT' || // mysql2 client-side query timeout
    errno === 3024 || // MySQL ER_QUERY_TIMEOUT (max_execution_time)
    errno === 1969 || // MariaDB ER_STATEMENT_TIMEOUT (max_statement_time)
    (typeof message === 'string' &&
      /statement timeout|query read timeout|query inactivity timeout|maximum statement execution time/i.test(
        message,
      ))
  );
}

function abortError() {
  return new DOMException('The request was cancelled.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

/** Runs an approved query, turning a timeout into an explanation the user can act on. */
export async function executeReadOnly(
  input: ConnectionProfile,
  sql: string,
  signal?: AbortSignal,
): Promise<QueryResult> {
  try {
    return await runReadOnly(input, sql, signal);
  } catch (error) {
    if (!isStatementTimeout(error)) throw error;
    const seconds = Math.round(input.timeoutMs / 1000);
    throw new UserFacingError(
      `The database stopped this query after ${seconds}s because it exceeded the query timeout. Try a narrower question (fewer tables, a filter or a date range), or raise "Query timeout (ms)" in the database settings.`,
    );
  }
}

async function runReadOnly(input: ConnectionProfile, sql: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const profile = assertProfile(input);
  const started = performance.now();
  let rows: Record<string, unknown>[];
  let columns: QueryColumn[];

  if (profile.dialect === 'sqlite') {
    const db = await openSqlite(profile);
    try {
      db.pragma('query_only = ON');
      const statement = db.prepare(sql);
      columns = statement.columns().map(column => ({
        name: column.name,
        ...(column.type ? { type: column.type } : {}),
      }));
      rows = statement.all() as Record<string, unknown>[];
      throwIfAborted(signal);
    } finally {
      db.close();
    }
  } else if (profile.dialect === 'postgresql') {
    const client = await openPostgres(profile);
    const abort = () => void client.end().catch(() => undefined);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      throwIfAborted(signal);
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${Math.round(profile.timeoutMs)}`);
      const response = await client.query(sql);
      rows = response.rows as Record<string, unknown>[];
      columns = response.fields.map(field => ({
        name: field.name,
        type: String(field.dataTypeID),
      }));
      await client.query('ROLLBACK');
      throwIfAborted(signal);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      await client.end().catch(() => undefined);
    }
  } else {
    const connection = await openMysql(profile);
    const abort = () => connection.destroy();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      throwIfAborted(signal);
      await setMysqlTimeout(connection, profile.timeoutMs);
      await connection.query('SET TRANSACTION READ ONLY');
      await connection.beginTransaction();
      const [resultRows, fields] = await connection.query({ sql, timeout: profile.timeoutMs });
      rows = resultRows as Record<string, unknown>[];
      columns = (fields as Array<{ name: string }>).map(field => ({ name: field.name }));
      await connection.rollback();
      throwIfAborted(signal);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (connection.state !== 'disconnected') await connection.end().catch(() => undefined);
    }
  }

  return boundRows(
    rows,
    columns,
    profile.maxRows,
    profile.maxResponseBytes,
    Math.round(performance.now() - started),
  );
}
