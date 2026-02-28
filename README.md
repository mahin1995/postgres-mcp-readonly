# PostgreSQL MCP Server

A secure, read-only PostgreSQL Model Context Protocol (MCP) server that provides safe database introspection and querying capabilities. Built with TypeScript for enhanced type safety and reliability.

## Overview

This MCP server enables AI assistants and other MCP clients to safely interact with PostgreSQL databases through a read-only interface. It provides schema inspection, parameterized queries, table previews, change tracking, and row counting while preventing any data modifications.

## Quick Start

Get started in seconds with npx (no installation required):

```bash
# Set your database connection
export DATABASE_URL="postgres://user:password@localhost:5432/dbname"

# Run the server
npx -y postgres-mcp-readonly
```

**For Claude Desktop**, add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "postgres-mcp-readonly"],
      "env": {
        "DATABASE_URL": "postgres://user:pass@localhost:5432/mydb"
      }
    }
  }
}
```

Restart Claude Desktop, and you'll have database access in your conversations! 🎉

## Features

### 🔒 Security First

- **Read-only enforcement** - Blocks all write operations (INSERT, UPDATE, DELETE, etc.)
- **SQL injection protection** - Validates identifiers and sanitizes queries
- **Automatic LIMIT enforcement** - Prevents unbounded result sets
- **Query timeouts** - Prevents long-running queries from blocking resources
- **Error sanitization** - Prevents leakage of sensitive connection details
- **Transaction isolation** - All queries run in READ ONLY transactions

### 🛠️ Tools Provided

1. **db.schema** - Inspect database structure
2. **db.query** - Execute parameterized SELECT queries
3. **db.preview** - Quick table preview
4. **db.watch** - Poll for incremental changes
5. **db.count** - Get exact row counts

### 📊 Resources

- **schema-summary** (`pg://schema/summary`) - Table list with approximate row counts
- **schema-full** (`pg://schema/full`) - Complete schema with columns, keys, and relationships

## Installation & Usage

### Prerequisites

- Node.js 18+
- PostgreSQL database (accessible via network)

### Option 1: Using npx (Recommended)

No installation required! Use directly with npx:

```bash
# Run with environment variables
export DATABASE_URL="postgres://user:pass@localhost:5432/mydb"
npx -y postgres-mcp-readonly
```

**For Windows PowerShell:**

```powershell
$env:DATABASE_URL="postgres://user:pass@localhost:5432/mydb"
npx -y postgres-mcp-readonly
```

**With Claude Desktop** - Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "postgres-mcp-readonly"],
      "env": {
        "DATABASE_URL": "postgres://user:pass@localhost:5432/mydb",
        "STATEMENT_TIMEOUT_MS": "5000",
        "MAX_ROWS": "500"
      }
    }
  }
}
```

**With MCP Inspector:**

```bash
npx @modelcontextprotocol/inspector npx -y postgres-mcp-readonly
```

### Option 2: Global Installation

Install once, use everywhere:

```bash
npm install -g postgres-mcp-readonly
```

**Then run:**

```bash
export DATABASE_URL="postgres://user:pass@localhost:5432/mydb"
postgres-mcp-readonly
```

**With Claude Desktop:**

```json
{
  "mcpServers": {
    "postgres": {
      "command": "postgres-mcp-readonly",
      "env": {
        "DATABASE_URL": "postgres://user:pass@localhost:5432/mydb"
      }
    }
  }
}
```

### Option 3: Local Development

For contributing or customizing:

1. **Clone the repository**

   ```bash
   git clone https://github.com/mahin1995/postgres-mcp-readonly.git
   cd postgres-mcp-readonly
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Build the TypeScript code**

   ```bash
   npm run build
   ```

4. **Configure environment variables**

   Create a `.env` file:

   ```env
   DATABASE_URL=postgres://username:password@localhost:5432/database_name
   STATEMENT_TIMEOUT_MS=5000
   MAX_ROWS=500
   ```

5. **Test the connection**
   ```bash
   npm start
   ```

**With Claude Desktop (local development):**

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": ["/absolute/path/to/postgres-mcp-readonly/dist/server.js"],
      "env": {
        "DATABASE_URL": "postgres://user:pass@localhost:5432/mydb"
      }
    }
  }
}
```

## Configuration

### Environment Variables

| Variable               | Required | Default | Description                   |
| ---------------------- | -------- | ------- | ----------------------------- |
| `DATABASE_URL`         | ✓        | -       | PostgreSQL connection string  |
| `STATEMENT_TIMEOUT_MS` | ✗        | 5000    | Query timeout in milliseconds |
| `MAX_ROWS`             | ✗        | 500     | Default maximum rows returned |

### Connection String Format

```
postgres://username:password@host:5432/database_name
postgresql://username:password@host:5432/database_name
```

## Tools Documentation

### 1. db.schema

Inspect database schema information.

**Parameters:**

- `mode` (optional): `"summary"` or `"full"` (default: `"summary"`)
- `filter` (optional): Filter tables by name or schema (case-insensitive)

**Examples:**

```javascript
// Get table list with row counts
{
  "mode": "summary"
}

// Get full schema with columns and keys
{
  "mode": "full"
}

// Filter specific tables
{
  "mode": "full",
  "filter": "users"
}
```

**Response (summary):**

```json
{
  "mode": "summary",
  "tables": [
    {
      "schema": "public",
      "table": "users",
      "approxRows": 1250
    }
  ]
}
```

**Response (full):**

```json
{
  "mode": "full",
  "schemas": {
    "public": {
      "users": {
        "columns": [
          {
            "name": "id",
            "dataType": "integer",
            "udtName": "int4",
            "nullable": false,
            "default": "nextval('users_id_seq'::regclass)",
            "position": 1
          }
        ],
        "primaryKey": ["id"],
        "foreignKeys": []
      }
    }
  }
}
```

### 2. db.query

Execute a read-only SELECT query with optional parameters.

**Parameters:**

- `sql` (required): SELECT query (with or without LIMIT)
- `params` (optional): Array of parameter values for $1, $2, etc.
- `maxRows` (optional): Maximum rows to return (1-5000, default: 500)

**Examples:**

```javascript
// Simple query
{
  "sql": "SELECT * FROM users WHERE active = true"
}

// Parameterized query
{
  "sql": "SELECT id, name, email FROM users WHERE country = $1 AND age > $2",
  "params": ["USA", 25],
  "maxRows": 100
}

// Query with existing LIMIT (will be honored if <= maxRows)
{
  "sql": "SELECT * FROM orders ORDER BY created_at DESC LIMIT 10"
}
```

**Response:**

```json
{
  "rowCount": 10,
  "fields": ["id", "name", "email"],
  "rows": [{ "id": 1, "name": "John Doe", "email": "john@example.com" }]
}
```

**Security Notes:**

- Only SELECT and WITH (CTE) queries allowed
- Single statement only (no semicolons)
- Automatic LIMIT enforcement if not specified
- Query timeout: 5 seconds (default)

### 3. db.preview

Quick preview of table rows.

**Parameters:**

- `table` (required): Table name (use `schema.table` or just `table`)
- `limit` (optional): Number of rows (1-500, default: 50)

**Examples:**

```javascript
// Preview public.users table
{
  "table": "users",
  "limit": 20
}

// Preview from specific schema
{
  "table": "analytics.events"
}
```

**Response:**

```json
{
  "table": "public.users",
  "rowCount": 20,
  "rows": [{ "id": 1, "name": "Alice", "created_at": "2024-01-15T10:30:00Z" }]
}
```

### 4. db.watch

Poll for incremental changes using cursor-based pagination.

**Parameters:**

- `table` (required): Table name
- `cursorColumn` (optional): Column to track (default: `"updated_at"`)
- `lastCursor` (optional): Last cursor value from previous call
- `batchSize` (optional): Rows per batch (1-1000, default: 200)

**Examples:**

```javascript
// Initial fetch (gets oldest records first)
{
  "table": "orders",
  "cursorColumn": "created_at"
}

// Subsequent fetch (pass lastCursor from previous response)
{
  "table": "orders",
  "cursorColumn": "created_at",
  "lastCursor": "2024-01-15T14:23:45.123Z",
  "batchSize": 100
}

// Track by numeric ID
{
  "table": "logs",
  "cursorColumn": "id",
  "lastCursor": 5042
}
```

**Response:**

```json
{
  "table": "public.orders",
  "cursorColumn": "created_at",
  "cursorType": "timestamp with time zone",
  "lastCursor": "2024-01-15T15:30:00Z",
  "rows": [...]
}
```

**Use Case:**

- Real-time monitoring
- ETL/sync processes
- Audit log tracking
- Event streaming

### 5. db.count

Get exact row count for a table.

**Parameters:**

- `table` (required): Table name (use `schema.table` or just `table`)

**Examples:**

```javascript
// Count rows in public.users
{
  "table": "users"
}

// Count in specific schema
{
  "table": "analytics.pageviews"
}
```

**Response:**

```json
{
  "table": "public.users",
  "count": 15247
}
```

## Usage Examples

### Quick Start with npx

```bash
# Set your database URL
export DATABASE_URL="postgres://user:pass@localhost:5432/mydb"

# Run the server
npx -y postgres-mcp-readonly
```

The server will start and wait for MCP protocol messages. Press `Ctrl+C` to stop.

### Testing with MCP Inspector

The MCP Inspector provides a web UI to test your server:

```bash
# Set environment first
export DATABASE_URL="postgres://user:pass@localhost:5432/mydb"

# Launch inspector with your server
npx @modelcontextprotocol/inspector npx -y postgres-mcp-readonly
```

This opens a browser where you can:

- View all available tools
- Call tools with parameters
- See responses in real-time

### With Claude Desktop

Claude Desktop is the primary way to use MCP servers with AI assistants.

**Using npx (recommended):**

Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "postgres-mcp-readonly"],
      "env": {
        "DATABASE_URL": "postgres://user:pass@localhost:5432/mydb",
        "STATEMENT_TIMEOUT_MS": "5000",
        "MAX_ROWS": "500"
      }
    }
  }
}
```

**Using global install:**

```json
{
  "mcpServers": {
    "postgres": {
      "command": "postgres-mcp-readonly",
      "env": {
        "DATABASE_URL": "postgres://user:pass@localhost:5432/mydb"
      }
    }
  }
}
```

### Example Conversation Flow

**User:** "Show me the database schema"

**AI uses:** `db.schema` with `mode: "summary"`

---

**User:** "How many users do we have?"

**AI uses:** `db.count` with `table: "users"`

---

**User:** "Show me the 10 most recent orders"

**AI uses:** `db.query` with SQL:

```sql
SELECT * FROM orders ORDER BY created_at DESC LIMIT 10
```

---

**User:** "Watch for new signups"

**AI uses:** `db.watch` with `table: "users"`, `cursorColumn: "created_at"`

## Security Features

### Query Validation

The server performs multiple security checks:

1. **Keyword Blocklist** - Prevents: INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, GRANT, REVOKE, VACUUM, ANALYZE, REINDEX, COPY, CALL, DO, EXECUTE

2. **Comment Stripping** - Removes SQL comments to prevent obfuscation

3. **Single Statement** - Only one query per request (no semicolons)

4. **SELECT-only** - Must start with SELECT or WITH

5. **Identifier Validation** - Table/column names must match `[a-zA-Z_][a-zA-Z0-9_]*`

6. **Parameterization** - Supports bind parameters ($1, $2, etc.) to prevent injection

### Error Sanitization

Database errors are sanitized to prevent leaking:

- Connection strings and passwords
- Server hostnames
- File system paths
- Overly verbose stack traces

### Connection Safety

- **Connection pooling** with max 10 connections
- **Statement timeout** (5s default) prevents runaway queries
- **Lock timeout** (1s) prevents deadlock situations
- **Idle transaction timeout** (5s) frees stuck connections
- **Graceful shutdown** on SIGINT/SIGTERM

## Best Practices

### For AI Assistants

1. **Always check schema first** - Use `db.schema` before querying unknown tables
2. **Use parameterization** - Never concatenate user input into SQL strings
3. **Start with small limits** - Use low `maxRows` for exploratory queries
4. **Use db.count for totals** - Don't SELECT COUNT(\*) manually
5. **Handle errors gracefully** - Sanitized errors are safe to show users

### For Database Admins

1. **Use read-only database user** - Grant only SELECT permissions
2. **Monitor connection usage** - Set appropriate pool size
3. **Adjust timeouts** - Based on your query complexity
4. **Enable query logging** - In PostgreSQL for audit trail
5. **Use SSL connections** - Add `?sslmode=require` to DATABASE_URL

### Performance Tips

1. **Ensure indexed columns** - Especially for `db.watch` cursor columns
2. **Use filters in db.schema** - Don't fetch full schema repeatedly
3. **Keep maxRows reasonable** - Large result sets slow serialization
4. **Add indexes on sort columns** - For ORDER BY performance

## Troubleshooting

### Connection Issues

**Problem:** `Missing DATABASE_URL` error

**Solution:** Create `.env` file with valid connection string

---

**Problem:** `ECONNREFUSED` or connection timeout

**Solution:**

- Verify PostgreSQL is running
- Check host/port in DATABASE_URL
- Ensure firewall allows connections
- Test with `psql` command line first

---

**Problem:** `password authentication failed`

**Solution:** Verify username/password in DATABASE_URL

### Query Errors

**Problem:** `Blocked keyword detected: insert`

**Solution:** This is intentional - only SELECT queries are allowed

---

**Problem:** `Only SELECT queries are allowed`

**Solution:** Ensure query starts with SELECT or WITH, not EXPLAIN, SHOW, etc.

---

**Problem:** `statement timeout`

**Solution:**

- Increase STATEMENT_TIMEOUT_MS
- Optimize query with indexes
- Reduce dataset with WHERE clause

### Schema Issues

**Problem:** `relation "table_name" does not exist`

**Solution:**

- Check table name spelling
- Use `schema.table` if not in `public` schema
- Run `db.schema` to see available tables

## Development

This section is for contributors working on the package itself.

### Setting Up Development Environment

```bash
# Clone the repository
git clone https://github.com/mahin1995/postgres-mcp-readonly.git
cd postgres-mcp-readonly

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your database credentials
```

### Running Locally

```bash
# Build TypeScript
npm run build

# Run the server
npm start

# Or use dev mode (builds and runs)
npm run dev

# Watch mode (auto-rebuild on changes)
npm run build:watch
```

### Testing

**Quick Connection Test:**

```bash
node test-client.js
```

This runs a basic test to verify:

- Server starts successfully
- MCP protocol communication works
- All tools are registered

**Interactive Testing with MCP Inspector:**

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/server.js
```

### Publishing

```bash
# Build first
npm run build

# Publish to npm (requires authentication)
npm publish --otp=YOUR_2FA_CODE
```

## License

MIT

## Contributing

Contributions welcome! Please ensure:

- Security best practices maintained
- All tools remain read-only
- Tests pass (if added)
- Documentation updated

## Support

For issues or questions:

1. Check this README first
2. Review PostgreSQL connection docs
3. Test with `psql` to isolate database issues
4. Open an issue with sanitized error messages

---

**Remember:** This server is read-only by design. For database modifications, use traditional database tools or separate admin interfaces.
