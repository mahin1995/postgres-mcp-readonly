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

interface ValidateInsertInput {
  sql: string;
  params?: any[];
  database?: string;
}

interface ValidateSqlInput {
  mode: "select" | "insert" | "update" | "delete";
  sql: string;
  params?: any[];
  database?: string;
}

interface ExplainInput {
  sql: string;
  params?: any[];
  database?: string;
}

interface TableInfoInput {
  table: string;
  database?: string;
}

interface CatalogFilterInput {
  table?: string;
  database?: string;
}

interface SampleValuesInput {
  table: string;
  columns: string[];
  limit?: number;
  database?: string;
}

interface QueryResultOutput {
  rowCount: number;
  fields: string[];
  rows: any[];
}

interface QueryBatchOutput {
  statementCount: number;
  results: Array<QueryResultOutput & { statement: number }>;
}

type QueryOutput = QueryResultOutput | QueryBatchOutput;

interface InsertValidationResult {
  statement: number;
  valid: boolean;
  sql: string;
  planNode?: string;
  error?: string;
}

interface InsertValidationOutput {
  valid: boolean;
  executed: false;
  validatedBy: "EXPLAIN (FORMAT JSON)";
  statementCount: number;
  results: InsertValidationResult[];
}

interface SqlValidationOutput {
  mode: "select" | "insert" | "update" | "delete";
  valid: boolean;
  executed: false;
  validatedBy: "EXPLAIN (FORMAT JSON)";
  statementCount: number;
  results: InsertValidationResult[];
}

interface ExplainOutput {
  statementCount: number;
  plans: Array<{
    statement: number;
    sql: string;
    plan: any;
  }>;
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
const MAX_STATEMENTS = Number(process.env.MAX_STATEMENTS || 10);
const AUDIT_LOG = /^(1|true|yes)$/i.test(process.env.AUDIT_LOG || "");
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

function auditLog(
  tool: string,
  database: string | undefined,
  startedAt: number,
  details: Record<string, unknown> = {},
): void {
  if (!AUDIT_LOG) {
    return;
  }

  const entry = {
    tool,
    database: database || DEFAULT_DATABASE,
    durationMs: Date.now() - startedAt,
    ...details,
  };
  console.error(`[audit] ${JSON.stringify(entry)}`);
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

function splitSqlStatements(sql: string): string[] {
  const s = normalizeSql(sql);
  const separators = findStatementSeparators(s);
  if (separators.length === 0) {
    return s ? [s] : [];
  }

  const statements: string[] = [];
  let start = 0;

  for (const separator of separators) {
    const statement = s.slice(start, separator).trim();
    if (statement) {
      statements.push(statement);
    }
    start = separator + 1;
  }

  const trailingStatement = s.slice(start).trim();
  if (trailingStatement) {
    statements.push(trailingStatement);
  }

  return statements;
}

function assertStatementLimit(statements: string[]): void {
  if (statements.length > MAX_STATEMENTS) {
    throw new Error(
      `Too many SQL statements. Maximum allowed per call is ${MAX_STATEMENTS}.`,
    );
  }
}

function assertSelectOnly(statement: string): void {
  const s = statement.toLowerCase();
  if (!s.startsWith("select") && !s.startsWith("with")) {
    throw new Error("Only SELECT queries are allowed in db.query.");
  }
  for (const bad of BLOCKLIST) {
    if (new RegExp(`\\b${bad}\\b`, "i").test(s)) {
      throw new Error(`Blocked keyword detected: ${bad}`);
    }
  }
}

function prepareReadOnlyStatements(sql: string): string[] {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) {
    throw new Error("SQL query cannot be empty.");
  }
  assertStatementLimit(statements);

  for (const statement of statements) {
    assertSelectOnly(statement);
  }

  return statements;
}

function assertStatementMode(
  statement: string,
  mode: "select" | "insert" | "update" | "delete",
): void {
  if (mode === "select") {
    assertSelectOnly(statement);
    return;
  }

  if (!new RegExp(`^${mode}\\b`, "i").test(statement)) {
    throw new Error(`Only ${mode.toUpperCase()} statements are allowed for this validation mode.`);
  }
}

function prepareValidationStatements(
  sql: string,
  mode: "select" | "insert" | "update" | "delete",
): string[] {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) {
    throw new Error("SQL query cannot be empty.");
  }
  assertStatementLimit(statements);

  for (const statement of statements) {
    assertStatementMode(statement, mode);
  }

  return statements;
}

function enforceLimit(statement: string, maxRows: number = DEFAULT_MAX_ROWS): string {
  if (!/\blimit\b/i.test(statement)) {
    return `${statement} LIMIT ${maxRows}`;
  }

  // If LIMIT exists, extract it and ensure it doesn't exceed maxRows
  const limitMatch = statement.match(/\blimit\s+(\d+)/i);
  if (limitMatch) {
    const existingLimit = parseInt(limitMatch[1], 10);
    if (existingLimit <= maxRows) {
      return statement; // Trust existing LIMIT if within bounds
    }
  }

  // Wrap query to enforce maxRows if existing LIMIT exceeds it
  return `SELECT * FROM (${statement}) AS _q LIMIT ${maxRows}`;
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
    /duplicate key value violates unique constraint/i,
    /violates foreign key constraint/i,
    /violates not-null constraint/i,
    /violates check constraint/i,
    /null value in column "[^"]+" violates not-null constraint/i,
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

function optionalParsedTableName(input?: string): ParsedTableName | null {
  return input ? parseTableName(input) : null;
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
  const startedAt = Date.now();

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

      const output: SchemaSummaryOutput = {
        mode: "summary",
        tables: tablesRes.rows.map((row: any) => ({
          schema: row.table_schema,
          table: row.table_name,
          approxRows:
            countMap.get(`${row.table_schema}.${row.table_name}`) ?? null,
        })),
      };
      auditLog("db.schema", database, startedAt, {
        mode,
        tableCount: output.tables.length,
      });
      return output;
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

    auditLog("db.schema", database, startedAt, {
      mode,
      schemaCount: Object.keys(out.schemas).length,
    });
    return out;
  }, database);
}

async function dbQuery({
  sql,
  params = [],
  maxRows = DEFAULT_MAX_ROWS,
  database,
}: QueryInput): Promise<QueryOutput> {
  z.object({
    sql: z.string().min(1),
    params: z.array(z.any()).optional(),
    maxRows: z.number().int().min(1).max(5000).optional(),
  }).parse({ sql, params, maxRows });

  const statements = prepareReadOnlyStatements(sql);
  if (statements.length > 1 && params.length > 0) {
    throw new Error(
      "Parameterized multi-statement queries are not supported. Send one parameterized SELECT per db.query call.",
    );
  }
  const safeStatements = statements.map((statement) =>
    enforceLimit(statement, maxRows),
  );
  const startedAt = Date.now();

  return withClient(async (client) => {
    await client.query("BEGIN READ ONLY");
    try {
      const results: Array<QueryResultOutput & { statement: number }> = [];

      for (let index = 0; index < safeStatements.length; index += 1) {
        const statement = safeStatements[index];
        const result = await client.query(
          statement,
          safeStatements.length === 1 ? params : [],
        );
        results.push({
          statement: index + 1,
          rowCount: result.rowCount || 0,
          fields: result.fields.map((field) => field.name),
          rows: result.rows,
        });
      }

      await client.query("COMMIT");

      if (results.length === 1) {
        const singleResult = results[0];
        auditLog("db.query", database, startedAt, {
          statementCount: 1,
          rowCount: singleResult.rowCount,
        });
        return {
          rowCount: singleResult.rowCount,
          fields: singleResult.fields,
          rows: singleResult.rows,
        };
      }

      auditLog("db.query", database, startedAt, {
        statementCount: results.length,
        rowCount: results.reduce((sum, result) => sum + result.rowCount, 0),
      });
      return {
        statementCount: results.length,
        results,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw sanitizeError(error);
    }
  }, database);
}

async function dbValidateInsert({
  sql,
  params = [],
  database,
}: ValidateInsertInput): Promise<InsertValidationOutput> {
  const startedAt = Date.now();
  const output = await dbValidateSql({ mode: "insert", sql, params, database });
  auditLog("db.validate_insert", database, startedAt, {
    statementCount: output.statementCount,
    valid: output.valid,
  });

  return {
    valid: output.valid,
    executed: false,
    validatedBy: "EXPLAIN (FORMAT JSON)",
    statementCount: output.statementCount,
    results: output.results,
  };
}

async function dbValidateSql({
  mode,
  sql,
  params = [],
  database,
}: ValidateSqlInput): Promise<SqlValidationOutput> {
  z.object({
    mode: z.enum(["select", "insert", "update", "delete"]),
    sql: z.string().min(1),
    params: z.array(z.any()).optional(),
  }).parse({ mode, sql, params });

  const statements = prepareValidationStatements(sql, mode);
  if (statements.length > 1 && params.length > 0) {
    throw new Error(
      "Parameterized multi-statement SQL validation is not supported. Validate one parameterized statement per call.",
    );
  }
  const startedAt = Date.now();

  return withClient(async (client) => {
    await client.query("BEGIN READ ONLY");
    const results: InsertValidationResult[] = [];

    try {
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index];
        const savepointName = `validate_insert_${index + 1}`;

        await client.query(`SAVEPOINT ${savepointName}`);
        try {
          const explainResult = await client.query(
            `EXPLAIN (FORMAT JSON) ${statement}`,
            statements.length === 1 ? params : [],
          );
          await client.query(`RELEASE SAVEPOINT ${savepointName}`);

          const explainPlan = explainResult.rows[0]?.["QUERY PLAN"];
          const planNode = explainPlan?.[0]?.Plan?.["Node Type"];
          results.push({
            statement: index + 1,
            valid: true,
            sql: statement,
            planNode,
          });
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          await client.query(`RELEASE SAVEPOINT ${savepointName}`);

          results.push({
            statement: index + 1,
            valid: false,
            sql: statement,
            error: sanitizeError(error).message,
          });
        }
      }

      await client.query("ROLLBACK");

      const output: SqlValidationOutput = {
        mode,
        valid: results.every((result) => result.valid),
        executed: false,
        validatedBy: "EXPLAIN (FORMAT JSON)",
        statementCount: results.length,
        results,
      };
      auditLog("db.validate_sql", database, startedAt, {
        mode,
        statementCount: output.statementCount,
        valid: output.valid,
      });
      return output;
    } catch (error) {
      await client.query("ROLLBACK");
      throw sanitizeError(error);
    }
  }, database);
}

async function dbExplain({
  sql,
  params = [],
  database,
}: ExplainInput): Promise<ExplainOutput> {
  z.object({
    sql: z.string().min(1),
    params: z.array(z.any()).optional(),
  }).parse({ sql, params });

  const statements = prepareValidationStatements(sql, "select");
  if (statements.length > 1 && params.length > 0) {
    throw new Error(
      "Parameterized multi-statement EXPLAIN is not supported. Explain one parameterized SELECT per call.",
    );
  }
  const startedAt = Date.now();

  return withClient(async (client) => {
    await client.query("BEGIN READ ONLY");
    try {
      const plans: ExplainOutput["plans"] = [];
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index];
        const result = await client.query(
          `EXPLAIN (FORMAT JSON) ${statement}`,
          statements.length === 1 ? params : [],
        );
        plans.push({
          statement: index + 1,
          sql: statement,
          plan: result.rows[0]?.["QUERY PLAN"] ?? null,
        });
      }

      await client.query("ROLLBACK");
      const output = {
        statementCount: plans.length,
        plans,
      };
      auditLog("db.explain", database, startedAt, {
        statementCount: output.statementCount,
      });
      return output;
    } catch (error) {
      await client.query("ROLLBACK");
      throw sanitizeError(error);
    }
  }, database);
}

async function dbIndexes({
  table,
  database,
}: CatalogFilterInput): Promise<{ indexes: any[] }> {
  z.object({
    table: z.string().min(1).optional(),
  }).parse({ table });

  const parsed = optionalParsedTableName(table);
  const startedAt = Date.now();

  return withClient(async (client) => {
    const result = await client.query(
      `
      SELECT schemaname AS schema, tablename AS table, indexname AS name, indexdef AS definition
      FROM pg_indexes
      WHERE schemaname NOT IN ('pg_catalog','information_schema')
        AND ($1::text IS NULL OR schemaname = $1)
        AND ($2::text IS NULL OR tablename = $2)
      ORDER BY schemaname, tablename, indexname
      `,
      [parsed?.schema ?? null, parsed?.table ?? null],
    );
    auditLog("db.indexes", database, startedAt, {
      table: table ?? null,
      rowCount: result.rowCount || 0,
    });
    return { indexes: result.rows };
  }, database);
}

async function dbConstraints({
  table,
  database,
}: CatalogFilterInput): Promise<{ constraints: any[] }> {
  z.object({
    table: z.string().min(1).optional(),
  }).parse({ table });

  const parsed = optionalParsedTableName(table);
  const startedAt = Date.now();

  return withClient(async (client) => {
    const result = await client.query(
      `
      SELECT
        n.nspname AS schema,
        c.relname AS table,
        con.conname AS name,
        CASE con.contype
          WHEN 'p' THEN 'primary_key'
          WHEN 'f' THEN 'foreign_key'
          WHEN 'u' THEN 'unique'
          WHEN 'c' THEN 'check'
          WHEN 'x' THEN 'exclusion'
          ELSE con.contype::text
        END AS type,
        pg_get_constraintdef(con.oid, true) AS definition
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema')
        AND ($1::text IS NULL OR n.nspname = $1)
        AND ($2::text IS NULL OR c.relname = $2)
      ORDER BY n.nspname, c.relname, con.conname
      `,
      [parsed?.schema ?? null, parsed?.table ?? null],
    );
    auditLog("db.constraints", database, startedAt, {
      table: table ?? null,
      rowCount: result.rowCount || 0,
    });
    return { constraints: result.rows };
  }, database);
}

async function dbRelationships({
  table,
  database,
}: CatalogFilterInput): Promise<{ relationships: any[] }> {
  z.object({
    table: z.string().min(1).optional(),
  }).parse({ table });

  const parsed = optionalParsedTableName(table);
  const startedAt = Date.now();

  return withClient(async (client) => {
    const result = await client.query(
      `
      SELECT
        ns.nspname AS source_schema,
        rel.relname AS source_table,
        con.conname AS constraint_name,
        array_agg(att.attname ORDER BY cols.ordinality) AS source_columns,
        ref_ns.nspname AS target_schema,
        ref_rel.relname AS target_table,
        array_agg(ref_att.attname ORDER BY cols.ordinality) AS target_columns,
        pg_get_constraintdef(con.oid, true) AS definition
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      JOIN pg_class ref_rel ON ref_rel.oid = con.confrelid
      JOIN pg_namespace ref_ns ON ref_ns.oid = ref_rel.relnamespace
      JOIN unnest(con.conkey, con.confkey) WITH ORDINALITY AS cols(attnum, ref_attnum, ordinality)
        ON true
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = cols.attnum
      JOIN pg_attribute ref_att ON ref_att.attrelid = ref_rel.oid AND ref_att.attnum = cols.ref_attnum
      WHERE con.contype = 'f'
        AND ns.nspname NOT IN ('pg_catalog','information_schema')
        AND ($1::text IS NULL OR ns.nspname = $1 OR ref_ns.nspname = $1)
        AND ($2::text IS NULL OR rel.relname = $2 OR ref_rel.relname = $2)
      GROUP BY ns.nspname, rel.relname, con.conname, ref_ns.nspname, ref_rel.relname, con.oid
      ORDER BY ns.nspname, rel.relname, con.conname
      `,
      [parsed?.schema ?? null, parsed?.table ?? null],
    );
    auditLog("db.relationships", database, startedAt, {
      table: table ?? null,
      rowCount: result.rowCount || 0,
    });
    return { relationships: result.rows };
  }, database);
}

async function dbTableInfo({
  table,
  database,
}: TableInfoInput): Promise<{
  table: string;
  columns: any[];
  indexes: any[];
  constraints: any[];
  relationships: any[];
  triggers: any[];
}> {
  z.object({
    table: z.string().min(1),
  }).parse({ table });

  const parsed = parseTableName(table);
  const startedAt = Date.now();

  return withClient(async (client) => {
    const columns = await client.query(
      `
      SELECT
        column_name AS name,
        data_type,
        udt_name,
        is_nullable = 'YES' AS nullable,
        column_default AS default,
        ordinal_position AS position
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
      `,
      [parsed.schema, parsed.table],
    );

    const indexes = await client.query(
      `
      SELECT indexname AS name, indexdef AS definition
      FROM pg_indexes
      WHERE schemaname = $1 AND tablename = $2
      ORDER BY indexname
      `,
      [parsed.schema, parsed.table],
    );

    const constraints = await client.query(
      `
      SELECT
        con.conname AS name,
        CASE con.contype
          WHEN 'p' THEN 'primary_key'
          WHEN 'f' THEN 'foreign_key'
          WHEN 'u' THEN 'unique'
          WHEN 'c' THEN 'check'
          WHEN 'x' THEN 'exclusion'
          ELSE con.contype::text
        END AS type,
        pg_get_constraintdef(con.oid, true) AS definition
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
      ORDER BY con.conname
      `,
      [parsed.schema, parsed.table],
    );

    const relationships = await dbRelationships({ table: `${parsed.schema}.${parsed.table}`, database });

    const triggers = await client.query(
      `
      SELECT
        tg.tgname AS name,
        CASE tg.tgenabled
          WHEN 'O' THEN 'enabled'
          WHEN 'D' THEN 'disabled'
          WHEN 'R' THEN 'replica'
          WHEN 'A' THEN 'always'
          ELSE tg.tgenabled::text
        END AS enabled,
        pg_get_triggerdef(tg.oid, true) AS definition
      FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT tg.tgisinternal
        AND n.nspname = $1
        AND c.relname = $2
      ORDER BY tg.tgname
      `,
      [parsed.schema, parsed.table],
    );

    auditLog("db.table_info", database, startedAt, {
      table: `${parsed.schema}.${parsed.table}`,
      columns: columns.rowCount || 0,
    });

    return {
      table: `${parsed.schema}.${parsed.table}`,
      columns: columns.rows,
      indexes: indexes.rows,
      constraints: constraints.rows,
      relationships: relationships.relationships,
      triggers: triggers.rows,
    };
  }, database);
}

async function dbSampleValues({
  table,
  columns,
  limit = 10,
  database,
}: SampleValuesInput): Promise<{ table: string; limit: number; samples: Record<string, any[]> }> {
  z.object({
    table: z.string().min(1),
    columns: z.array(z.string().min(1)).min(1).max(20),
    limit: z.number().int().min(1).max(100).optional(),
  }).parse({ table, columns, limit });

  const parsed = parseTableName(table);
  for (const column of columns) {
    assertIdentifier(column);
  }
  const startedAt = Date.now();

  return withClient(async (client) => {
    const samples: Record<string, any[]> = {};
    for (const column of columns) {
      const result = await client.query(
        `
        SELECT DISTINCT "${column}" AS value
        FROM "${parsed.schema}"."${parsed.table}"
        WHERE "${column}" IS NOT NULL
        LIMIT $1
        `,
        [limit],
      );
      samples[column] = result.rows.map((row) => row.value);
    }

    auditLog("db.sample_values", database, startedAt, {
      table: `${parsed.schema}.${parsed.table}`,
      columns,
    });

    return {
      table: `${parsed.schema}.${parsed.table}`,
      limit,
      samples,
    };
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
  const startedAt = Date.now();
  return withClient(async (client) => {
    await client.query("BEGIN READ ONLY");
    try {
      const result = await client.query(
        `SELECT * FROM "${parsed.schema}"."${parsed.table}" LIMIT $1`,
        [limit],
      );
      await client.query("COMMIT");
      const output = {
        table: `${parsed.schema}.${parsed.table}`,
        rowCount: result.rowCount || 0,
        rows: result.rows,
      };
      auditLog("db.preview", database, startedAt, {
        table: output.table,
        rowCount: output.rowCount,
      });
      return output;
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
  const startedAt = Date.now();

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

      const output = {
        table: `${parsed.schema}.${parsed.table}`,
        cursorColumn,
        cursorType,
        lastCursor: nextCursor,
        rows: result.rows,
      };
      auditLog("db.watch", database, startedAt, {
        table: output.table,
        rowCount: output.rows.length,
      });
      return output;
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
  const startedAt = Date.now();
  return withClient(async (client) => {
    await client.query("BEGIN READ ONLY");
    try {
      const result = await client.query(
        `SELECT COUNT(*) AS count FROM "${parsed.schema}"."${parsed.table}"`,
      );
      await client.query("COMMIT");
      const output = {
        table: `${parsed.schema}.${parsed.table}`,
        count: parseInt(result.rows[0].count, 10),
      };
      auditLog("db.count", database, startedAt, {
        table: output.table,
        count: output.count,
      });
      return output;
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
  async () => {
    const startedAt = Date.now();
    const payload = {
      defaultDatabase: DEFAULT_DATABASE,
      databases: Object.keys(DATABASE_URLS).sort(),
    };
    auditLog("db.databases", undefined, startedAt, {
      databaseCount: payload.databases.length,
    });
    return asTextContent(payload);
  },
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
      "Run one or more read-only SELECT queries with optional row limits. Multi-statement calls are allowed for non-parameterized SELECT/WITH statements; parameterized queries must be single-statement.",
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
  "db.validate_insert",
  {
    description:
      "Validate one or more INSERT statements without executing them. Uses EXPLAIN without ANALYZE, so rows are never inserted. Parameterized validation must be single-statement.",
    inputSchema: {
      sql: z.string().min(1),
      params: z.array(z.any()).optional(),
      database: z.string().min(1).optional(),
    },
  },
  async ({ sql, params = [], database }: any) =>
    asTextContent(await dbValidateInsert({ sql, params, database })),
);

server.registerTool(
  "db.validate_sql",
  {
    description:
      "Validate SELECT, INSERT, UPDATE, or DELETE statements without executing them by using EXPLAIN without ANALYZE.",
    inputSchema: {
      mode: z.enum(["select", "insert", "update", "delete"]),
      sql: z.string().min(1),
      params: z.array(z.any()).optional(),
      database: z.string().min(1).optional(),
    },
  },
  async ({ mode, sql, params = [], database }: any) =>
    asTextContent(await dbValidateSql({ mode, sql, params, database })),
);

server.registerTool(
  "db.explain",
  {
    description:
      "Return PostgreSQL EXPLAIN plans for one or more SELECT/WITH statements without executing them.",
    inputSchema: {
      sql: z.string().min(1),
      params: z.array(z.any()).optional(),
      database: z.string().min(1).optional(),
    },
  },
  async ({ sql, params = [], database }: any) =>
    asTextContent(await dbExplain({ sql, params, database })),
);

server.registerTool(
  "db.table_info",
  {
    description:
      "Inspect one table's columns, indexes, constraints, foreign-key relationships, and triggers.",
    inputSchema: {
      table: z.string().min(1),
      database: z.string().min(1).optional(),
    },
  },
  async ({ table, database }: any) =>
    asTextContent(await dbTableInfo({ table, database })),
);

server.registerTool(
  "db.indexes",
  {
    description:
      "List PostgreSQL indexes for all user tables or one table using table or schema.table name.",
    inputSchema: {
      table: z.string().min(1).optional(),
      database: z.string().min(1).optional(),
    },
  },
  async ({ table, database }: any) =>
    asTextContent(await dbIndexes({ table, database })),
);

server.registerTool(
  "db.constraints",
  {
    description:
      "List constraints for all user tables or one table, including primary keys, foreign keys, unique constraints, and checks.",
    inputSchema: {
      table: z.string().min(1).optional(),
      database: z.string().min(1).optional(),
    },
  },
  async ({ table, database }: any) =>
    asTextContent(await dbConstraints({ table, database })),
);

server.registerTool(
  "db.relationships",
  {
    description:
      "List foreign-key relationships for all user tables or one table.",
    inputSchema: {
      table: z.string().min(1).optional(),
      database: z.string().min(1).optional(),
    },
  },
  async ({ table, database }: any) =>
    asTextContent(await dbRelationships({ table, database })),
);

server.registerTool(
  "db.sample_values",
  {
    description:
      "Return small distinct non-null sample values for selected columns in a table.",
    inputSchema: {
      table: z.string().min(1),
      columns: z.array(z.string().min(1)).min(1).max(20),
      limit: z.number().int().min(1).max(100).optional(),
      database: z.string().min(1).optional(),
    },
  },
  async ({ table, columns, limit = 10, database }: any) =>
    asTextContent(await dbSampleValues({ table, columns, limit, database })),
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
