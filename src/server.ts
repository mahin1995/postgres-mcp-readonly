#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import { Pool, PoolClient } from "pg";
import { z } from "zod";

dotenv.config({ quiet: true });

// Type definitions
interface TableInfo {
  schema: string;
  table: string;
  approxRows: number | null;
}

interface ColumnInfo {
  name: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  default: string | null;
  position: number;
}

interface ForeignKeyInfo {
  column: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
}

interface TableSchema {
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
}

interface SchemaOutput {
  mode: "full";
  schemas: Record<string, Record<string, TableSchema>>;
}

interface SchemaSummaryOutput {
  mode: "summary";
  tables: TableInfo[];
}

interface QueryInput {
  sql: string;
  params?: any[];
  maxRows?: number;
  database?: string;
}

interface PreviewInput {
  table: string;
  limit?: number;
  database?: string;
}

interface WatchInput {
  table: string;
  cursorColumn?: string;
  lastCursor?: string | number | null;
  batchSize?: number;
  database?: string;
}

interface CountInput {
  table: string;
  database?: string;
}

interface ParsedTableName {
  schema: string;
  table: string;
}

interface DatabaseConfig {
  urls: Record<string, string>;
  defaultDatabase: string;
}

function validateDatabaseUrl(value: string, sourceName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `Invalid ${sourceName} format. Expected: postgres://user:password@host:5432/dbname`,
    );
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(
      `${sourceName} must start with postgres:// or postgresql://`,
    );
  }

  return value;
}

function assertDatabaseAlias(name: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error(
      `Invalid database alias: ${name}. Use letters, numbers, underscore, or hyphen.`,
    );
  }
}

function getDatabaseConfig(): DatabaseConfig {
  const urls: Record<string, string> = {};

  const singleUrl = (process.env.DATABASE_URL || "").trim();
  if (singleUrl) {
    urls.default = validateDatabaseUrl(singleUrl, "DATABASE_URL");
  }

  const multiRaw = (process.env.DATABASE_URLS || "").trim();
  if (multiRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(multiRaw);
    } catch {
      throw new Error(
        "Invalid DATABASE_URLS format. Expected JSON object like {\"main\":\"postgres://...\",\"analytics\":\"postgres://...\"}",
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        "Invalid DATABASE_URLS format. Expected JSON object with alias -> connection string mappings.",
      );
    }

    for (const [alias, value] of Object.entries(parsed as Record<string, unknown>)) {
      assertDatabaseAlias(alias);
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`DATABASE_URLS entry '${alias}' must be a non-empty string.`);
      }
      urls[alias] = validateDatabaseUrl(value.trim(), `DATABASE_URLS.${alias}`);
    }
  }

  if (Object.keys(urls).length === 0) {
    throw new Error(
      "Missing database configuration. Set DATABASE_URL or DATABASE_URLS.",
    );
  }

  const requestedDefault = (process.env.DEFAULT_DATABASE || "default").trim();
  assertDatabaseAlias(requestedDefault);

  if (!urls[requestedDefault]) {
    const configured = Object.keys(urls).sort().join(", ");
    throw new Error(
      `DEFAULT_DATABASE '${requestedDefault}' is not configured. Available aliases: ${configured}`,
    );
  }

  return {
    urls,
    defaultDatabase: requestedDefault,
  };
}

const { urls: DATABASE_URLS, defaultDatabase: DEFAULT_DATABASE } =
  getDatabaseConfig();
const STATEMENT_TIMEOUT_MS = Number(process.env.STATEMENT_TIMEOUT_MS || 5000);
const DEFAULT_MAX_ROWS = Number(process.env.MAX_ROWS || 500);
const pools = new Map<string, Pool>(
  Object.entries(DATABASE_URLS).map(([alias, connectionString]) => [
    alias,
    new Pool({ connectionString, max: 10 }),
  ]),
);

function resolveDatabase(database?: string): string {
  const selected = (database || DEFAULT_DATABASE).trim();
  if (!selected) {
    throw new Error("Database alias cannot be empty.");
  }
  if (!DATABASE_URLS[selected]) {
    const available = Object.keys(DATABASE_URLS).sort().join(", ");
    throw new Error(
      `Unknown database alias '${selected}'. Available aliases: ${available}`,
    );
  }
  return selected;
}

async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>,
  database?: string,
): Promise<T> {
  const alias = resolveDatabase(database);
  const pool = pools.get(alias);
  if (!pool) {
    throw new Error(`Database pool not initialized for alias '${alias}'.`);
  }

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    await client.query("SET lock_timeout = '1000ms'");
    await client.query("SET idle_in_transaction_session_timeout = '5000ms'");
    return await fn(client);
  } finally {
    client.release();
  }
}

const BLOCKLIST = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "vacuum",
  "analyze",
  "reindex",
  "copy",
  "call",
  "do",
  "execute",
] as const;

function normalizeSql(sql: string): string {
  return sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
}

function findStatementSeparators(sql: string): number[] {
  const separators: number[] = [];
  let quote: "'" | '"' | null = null;
  let dollarQuote: string | null = null;

  for (let i = 0; i < sql.length; i += 1) {
    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, i)) {
        i += dollarQuote.length - 1;
        dollarQuote = null;
      }
      continue;
    }

    const char = sql[i];

    if (quote) {
      if (char === quote) {
        if (quote === "'" && sql[i + 1] === "'") {
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "$") {
      const match = sql.slice(i).match(/^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/);
      if (match) {
        dollarQuote = match[0];
        i += match[0].length - 1;
      }
      continue;
    }

    if (char === ";") {
      separators.push(i);
    }
  }

  return separators;
}

function stripTrailingStatementTerminator(sql: string): string {
  const s = normalizeSql(sql);
  const separators = findStatementSeparators(s);
  if (separators.length === 0) {
    return s;
  }

  const lastNonWhitespace = s.search(/\s*$/) - 1;
  if (
    separators.length === 1 &&
    separators[0] === lastNonWhitespace
  ) {
    return s.slice(0, lastNonWhitespace).trimEnd();
  }

  throw new Error(
    "Only single-statement queries are allowed. Send one SELECT query per db.query call.",
  );
}

function assertSelectOnly(sql: string): void {
  const s = stripTrailingStatementTerminator(sql).toLowerCase();
  if (!s.startsWith("select") && !s.startsWith("with")) {
    throw new Error("Only SELECT queries are allowed.");
  }
  for (const bad of BLOCKLIST) {
    if (new RegExp(`\\b${bad}\\b`, "i").test(s)) {
      throw new Error(`Blocked keyword detected: ${bad}`);
    }
  }
}

function enforceLimit(sql: string, maxRows: number = DEFAULT_MAX_ROWS): string {
  const s = stripTrailingStatementTerminator(sql);
  if (!/\blimit\b/i.test(s)) {
    return `${s} LIMIT ${maxRows}`;
  }

  // If LIMIT exists, extract it and ensure it doesn't exceed maxRows
  const limitMatch = s.match(/\blimit\s+(\d+)/i);
  if (limitMatch) {
    const existingLimit = parseInt(limitMatch[1], 10);
    if (existingLimit <= maxRows) {
      return s; // Trust existing LIMIT if within bounds
    }
  }

  // Wrap query to enforce maxRows if existing LIMIT exceeds it
  return `SELECT * FROM (${s}) AS _q LIMIT ${maxRows}`;
}

function sanitizeError(error: any): Error {
  // Sanitize database errors to prevent information leakage
  const message = error.message || String(error);

  // Remove connection details, file paths, and sensitive info
  let sanitized = message
    .replace(
      /\b(?:password|pwd|secret|token|key)\s*=\s*[^\s;]*/gi,
      "[REDACTED]",
    )
    .replace(/\b(?:host|server)\s*=\s*[^\s;,]*/gi, "[HOST]")
    .replace(/[A-Za-z]:\\[^\s"]*/g, "[PATH]")
    .replace(/\/(?:home|usr|var)\/[^\s"]*/g, "[PATH]");

  // Preserve common PostgreSQL error patterns that are safe
  const safePatterns = [
    /column "[^"]+" does not exist/i,
    /relation "[^"]+" does not exist/i,
    /syntax error/i,
    /permission denied/i,
    /statement timeout/i,
    /lock timeout/i,
  ];

  const isSafe = safePatterns.some((pattern) => pattern.test(message));
  if (!isSafe && message.length > 200) {
    sanitized = sanitized.substring(0, 200) + "...";
  }

  const sanitizedError = new Error(sanitized);
  sanitizedError.name = error.name || "DatabaseError";
  return sanitizedError;
}

function assertIdentifier(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
}

function parseTableName(input: string): ParsedTableName {
  const parts = input.split(".");
  if (parts.length === 1) {
    assertIdentifier(parts[0]);
    return { schema: "public", table: parts[0] };
  }
  if (parts.length === 2) {
    assertIdentifier(parts[0]);
    assertIdentifier(parts[1]);
    return { schema: parts[0], table: parts[1] };
  }
  throw new Error("Invalid table name format. Use table or schema.table");
}

async function dbSchema({
  mode = "summary",
  filter = "",
  database,
}: {
  mode?: "summary" | "full";
  filter?: string;
  database?: string;
} = {}): Promise<
  SchemaOutput | SchemaSummaryOutput
> {
  const Mode = z.enum(["summary", "full"]);
  Mode.parse(mode);

  const filterLike = `%${filter}%`;

  return withClient(async (client) => {
    const tablesRes = await client.query(
      `
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type='BASE TABLE'
        AND table_schema NOT IN ('pg_catalog','information_schema')
        AND ($1 = '%%' OR table_name ILIKE $1 OR table_schema ILIKE $1)
      ORDER BY table_schema, table_name
      `,
      [filter ? filterLike : "%%"],
    );

    if (mode === "summary") {
      const countsRes = await client.query(
        `
        SELECT schemaname AS table_schema, relname AS table_name, n_live_tup::bigint AS approx_rows
        FROM pg_stat_user_tables
        `,
      );
      const countMap = new Map<string, number>(
        countsRes.rows.map((row: any) => [
          `${row.table_schema}.${row.table_name}`,
          row.approx_rows,
        ]),
      );

      return {
        mode: "summary",
        tables: tablesRes.rows.map((row: any) => ({
          schema: row.table_schema,
          table: row.table_name,
          approxRows:
            countMap.get(`${row.table_schema}.${row.table_name}`) ?? null,
        })),
      };
    }

    const colsRes = await client.query(
      `
      SELECT
        c.table_schema,
        c.table_name,
        c.ordinal_position,
        c.column_name,
        c.data_type,
        c.udt_name,
        c.is_nullable,
        c.column_default
      FROM information_schema.columns c
      WHERE c.table_schema NOT IN ('pg_catalog','information_schema')
        AND ($1 = '%%' OR c.table_name ILIKE $1 OR c.table_schema ILIKE $1)
      ORDER BY c.table_schema, c.table_name, c.ordinal_position
      `,
      [filter ? filterLike : "%%"],
    );

    const pkRes = await client.query(
      `
      SELECT
        tc.table_schema,
        tc.table_name,
        kcu.column_name,
        kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema NOT IN ('pg_catalog','information_schema')
        AND ($1 = '%%' OR tc.table_name ILIKE $1 OR tc.table_schema ILIKE $1)
      ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position
      `,
      [filter ? filterLike : "%%"],
    );

    const fkRes = await client.query(
      `
      SELECT
        tc.table_schema,
        tc.table_name,
        kcu.column_name,
        ccu.table_schema AS foreign_table_schema,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema NOT IN ('pg_catalog','information_schema')
        AND ($1 = '%%' OR tc.table_name ILIKE $1 OR tc.table_schema ILIKE $1)
      ORDER BY tc.table_schema, tc.table_name
      `,
      [filter ? filterLike : "%%"],
    );

    const out: SchemaOutput = { mode: "full", schemas: {} };
    for (const row of tablesRes.rows) {
      out.schemas[row.table_schema] ??= {};
      out.schemas[row.table_schema][row.table_name] = {
        columns: [],
        primaryKey: [],
        foreignKeys: [],
      };
    }

    for (const row of colsRes.rows) {
      const table = out.schemas?.[row.table_schema]?.[row.table_name];
      if (!table) {
        continue;
      }
      table.columns.push({
        name: row.column_name,
        dataType: row.data_type,
        udtName: row.udt_name,
        nullable: row.is_nullable === "YES",
        default: row.column_default,
        position: row.ordinal_position,
      });
    }

    for (const row of pkRes.rows) {
      const table = out.schemas?.[row.table_schema]?.[row.table_name];
      if (!table) {
        continue;
      }
      table.primaryKey.push(row.column_name);
    }

    for (const row of fkRes.rows) {
      const table = out.schemas?.[row.table_schema]?.[row.table_name];
      if (!table) {
        continue;
      }
      table.foreignKeys.push({
        column: row.column_name,
        refSchema: row.foreign_table_schema,
        refTable: row.foreign_table_name,
        refColumn: row.foreign_column_name,
      });
    }

    return out;
  }, database);
}

async function dbQuery({
  sql,
  params = [],
  maxRows = DEFAULT_MAX_ROWS,
  database,
}: QueryInput): Promise<{ rowCount: number; fields: string[]; rows: any[] }> {
  z.object({
    sql: z.string().min(1),
    params: z.array(z.any()).optional(),
    maxRows: z.number().int().min(1).max(5000).optional(),
  }).parse({ sql, params, maxRows });

  assertSelectOnly(sql);
  const safeSql = enforceLimit(sql, maxRows);

  return withClient(async (client) => {
    await client.query("BEGIN READ ONLY");
    try {
      const result = await client.query(safeSql, params);
      await client.query("COMMIT");
      return {
        rowCount: result.rowCount || 0,
        fields: result.fields.map((field) => field.name),
        rows: result.rows,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw sanitizeError(error);
    }
  }, database);
}

async function dbPreview({
  table,
  limit = 50,
  database,
}: PreviewInput): Promise<{ table: string; rowCount: number; rows: any[] }> {
  z.object({
    table: z.string().min(1),
    limit: z.number().int().min(1).max(500).optional(),
  }).parse({ table, limit });

  const parsed = parseTableName(table);
  return withClient(async (client) => {
    await client.query("BEGIN READ ONLY");
    try {
      const result = await client.query(
        `SELECT * FROM "${parsed.schema}"."${parsed.table}" LIMIT $1`,
        [limit],
      );
      await client.query("COMMIT");
      return {
        table: `${parsed.schema}.${parsed.table}`,
        rowCount: result.rowCount || 0,
        rows: result.rows,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw sanitizeError(error);
    }
  }, database);
}

async function dbWatch({
  table,
  cursorColumn = "updated_at",
  lastCursor = null,
  batchSize = 200,
  database,
}: WatchInput): Promise<{
  table: string;
  cursorColumn: string;
  cursorType: string;
  lastCursor: string | number;
  rows: any[];
}> {
  z.object({
    table: z.string().min(1),
    cursorColumn: z.string().min(1).optional(),
    lastCursor: z.union([z.string(), z.number(), z.null()]).optional(),
    batchSize: z.number().int().min(1).max(1000).optional(),
  }).parse({ table, cursorColumn, lastCursor, batchSize });

  const parsed = parseTableName(table);
  assertIdentifier(cursorColumn);

  const cursorType = await withClient(async (client) => {
    const res = await client.query(
      `
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
      `,
      [parsed.schema, parsed.table, cursorColumn],
    );
    if (res.rows.length === 0) {
      throw new Error(`Cursor column not found: ${cursorColumn}`);
    }
    return res.rows[0].data_type;
  }, database);

  const isTimestamp = /timestamp|date|time/i.test(cursorType);
  const effectiveCursor =
    lastCursor !== null && lastCursor !== undefined
      ? lastCursor
      : isTimestamp
        ? "1970-01-01T00:00:00.000Z"
        : 0;

  return withClient(async (client) => {
    await client.query("BEGIN READ ONLY");
    try {
      const sql = `
        SELECT *
        FROM "${parsed.schema}"."${parsed.table}"
        WHERE "${cursorColumn}" > $1
        ORDER BY "${cursorColumn}" ASC
        LIMIT $2
      `;
      const result = await client.query(sql, [effectiveCursor, batchSize]);
      await client.query("COMMIT");

      const nextCursor =
        result.rows.length > 0
          ? result.rows[result.rows.length - 1][cursorColumn]
          : effectiveCursor;

      return {
        table: `${parsed.schema}.${parsed.table}`,
        cursorColumn,
        cursorType,
        lastCursor: nextCursor,
        rows: result.rows,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw sanitizeError(error);
    }
  }, database);
}

async function dbCount({
  table,
  database,
}: CountInput): Promise<{ table: string; count: number }> {
  z.object({
    table: z.string().min(1),
  }).parse({ table });

  const parsed = parseTableName(table);
  return withClient(async (client) => {
    await client.query("BEGIN READ ONLY");
    try {
      const result = await client.query(
        `SELECT COUNT(*) AS count FROM "${parsed.schema}"."${parsed.table}"`,
      );
      await client.query("COMMIT");
      return {
        table: `${parsed.schema}.${parsed.table}`,
        count: parseInt(result.rows[0].count, 10),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw sanitizeError(error);
    }
  }, database);
}

function asTextContent(payload: any) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

const server = new McpServer({
  name: "pg_saga_db",
  version: "1.0.0",
});

server.registerTool(
  "db.databases",
  {
    description:
      "List configured database aliases and the currently selected default alias.",
    inputSchema: {},
  },
  async () =>
    asTextContent({
      defaultDatabase: DEFAULT_DATABASE,
      databases: Object.keys(DATABASE_URLS).sort(),
    }),
);

server.registerTool(
  "db.schema",
  {
    description:
      "Inspect database schema. Use mode='summary' for table list or mode='full' for columns and keys.",
    inputSchema: {
      mode: z.enum(["summary", "full"]).optional(),
      filter: z.string().optional(),
      database: z.string().min(1).optional(),
    },
  },
  async ({ mode = "summary", filter = "", database }: any) =>
    asTextContent(await dbSchema({ mode, filter, database })),
);

server.registerTool(
  "db.query",
  {
    description:
      "Run one read-only SELECT query with optional parameters and row limit. Do not send multiple SQL statements; one trailing semicolon is accepted.",
    inputSchema: {
      sql: z.string().min(1),
      params: z.array(z.any()).optional(),
      maxRows: z.number().int().min(1).max(5000).optional(),
      database: z.string().min(1).optional(),
    },
  },
  async ({ sql, params = [], maxRows = DEFAULT_MAX_ROWS, database }: any) =>
    asTextContent(await dbQuery({ sql, params, maxRows, database })),
);

server.registerTool(
  "db.preview",
  {
    description: "Preview rows from a table using table or schema.table name.",
    inputSchema: {
      table: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
      database: z.string().min(1).optional(),
    },
  },
  async ({ table, limit = 50, database }: any) =>
    asTextContent(await dbPreview({ table, limit, database })),
);

server.registerTool(
  "db.watch",
  {
    description:
      "Fetch one incremental batch where cursorColumn > lastCursor. Repeat client-side for polling.",
    inputSchema: {
      table: z.string().min(1),
      cursorColumn: z.string().min(1).optional(),
      lastCursor: z.union([z.string(), z.number(), z.null()]).optional(),
      batchSize: z.number().int().min(1).max(1000).optional(),
      database: z.string().min(1).optional(),
    },
  },
  async ({
    table,
    cursorColumn = "updated_at",
    lastCursor = null,
    batchSize = 200,
    database,
  }: any) =>
    asTextContent(
      await dbWatch({ table, cursorColumn, lastCursor, batchSize, database }),
    ),
);

server.registerTool(
  "db.count",
  {
    description:
      "Get exact row count for a table. Use table or schema.table name.",
    inputSchema: {
      table: z.string().min(1),
      database: z.string().min(1).optional(),
    },
  },
  async ({ table, database }: any) =>
    asTextContent(await dbCount({ table, database })),
);

const SCHEMA_SUMMARY_URI = "pg://schema/summary";
const SCHEMA_FULL_URI = "pg://schema/full";

server.registerResource(
  "schema-summary",
  SCHEMA_SUMMARY_URI,
  {
    mimeType: "application/json",
    description: "Summary of tables and approximate row counts.",
  },
  async () => {
    const payload = await dbSchema({ mode: "summary" });
    return {
      contents: [
        {
          uri: SCHEMA_SUMMARY_URI,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  },
);

server.registerResource(
  "schema-full",
  SCHEMA_FULL_URI,
  {
    mimeType: "application/json",
    description:
      "Full schema including columns, primary keys, and foreign keys.",
  },
  async () => {
    const payload = await dbSchema({ mode: "full" });
    return {
      contents: [
        {
          uri: SCHEMA_FULL_URI,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  },
);

async function closeResources() {
  try {
    await server.close();
  } finally {
    await Promise.allSettled(
      Array.from(pools.values()).map((pool) => pool.end()),
    );
  }
}

process.on("SIGINT", () => {
  closeResources().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  closeResources().finally(() => process.exit(0));
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("pg_saga_db MCP server error:", error);
  process.exit(1);
});
