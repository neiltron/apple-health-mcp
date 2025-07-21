# MCP Server Architecture for Apple Health Data

## Core Design Principles

### 1. Lazy Loading & Caching
- **In-memory DuckDB** with persistent cache file
- Load CSVs on-demand, not all at startup
- Cache materialized views for common queries
- TTL-based cache invalidation for data freshness

### 2. Connection Management
```typescript
class HealthDataDB {
  private db: DuckDB.Database;
  private connections: Map<string, DuckDB.Connection>;
  private viewsInitialized: Set<string>;
  
  async getConnection(sessionId: string): Promise<DuckDB.Connection> {
    if (!this.connections.has(sessionId)) {
      const conn = await this.db.connect();
      this.connections.set(sessionId, conn);
    }
    return this.connections.get(sessionId);
  }
}
```

### 3. Tool Architecture

#### Tool 1: `health_query`
Direct SQL query execution with safety guards
```typescript
{
  name: "health_query",
  description: "Execute SQL queries on health data",
  parameters: {
    query: { type: "string", description: "SQL query" },
    format: { type: "string", enum: ["json", "csv", "summary"] }
  }
}
```

#### Tool 2: `health_insights`
Natural language to insights
```typescript
{
  name: "health_insights",
  description: "Get health insights using natural language",
  parameters: {
    question: { type: "string" },
    timeframe: { type: "string", default: "last_4_weeks" },
    metrics: { type: "array", items: { type: "string" } }
  }
}
```

#### Tool 3: `health_report`
Structured weekly/monthly reports
```typescript
{
  name: "health_report",
  description: "Generate structured health reports",
  parameters: {
    report_type: { enum: ["weekly", "monthly", "custom"] },
    start_date: { type: "string", format: "date" },
    end_date: { type: "string", format: "date" },
    include_metrics: { type: "array" }
  }
}
```

## Implementation Strategy

### 1. Startup Sequence
```typescript
class AppleHealthMCP {
  async initialize() {
    // 1. Create in-memory database
    this.db = new DuckDB.Database(':memory:');
    
    // 2. Create schema catalog
    await this.catalogAvailableFiles();
    
    // 3. Load core views (lazy)
    this.viewDefinitions = await this.loadViewDefinitions();
    
    // 4. Optional: Pre-warm cache with recent data
    if (config.prewarmCache) {
      await this.prewarmRecentData();
    }
  }
  
  private async catalogAvailableFiles() {
    const files = await fs.readdir(this.dataDir);
    this.catalog = files.reduce((acc, file) => {
      const match = file.match(/^(HK\w+)_.*\.csv$/);
      if (match) {
        acc[match[1]] = {
          path: path.join(this.dataDir, file),
          loaded: false,
          rowCount: null
        };
      }
      return acc;
    }, {});
  }
}
```

### 2. Smart Table Loading
```typescript
async ensureTableLoaded(tableName: string) {
  if (this.catalog[tableName]?.loaded) return;
  
  const filePath = this.catalog[tableName].path;
  const tempTableName = `${tableName}_staging`;
  
  // Load with progress tracking
  await this.db.run(`
    CREATE TABLE ${tempTableName} AS
    SELECT * FROM read_csv('${filePath}',
      header = true,
      skip = 1,
      timestampformat = '%Y-%m-%d %H:%M:%S +0000'
    )
  `);
  
  // Data quality checks
  const stats = await this.getTableStats(tempTableName);
  
  if (stats.rowCount > 0) {
    // Clean and optimize
    await this.cleanAndOptimizeTable(tempTableName, tableName);
    this.catalog[tableName].loaded = true;
    this.catalog[tableName].rowCount = stats.rowCount;
  }
}
```

### 3. Query Optimization Layer
```typescript
class QueryOptimizer {
  async optimizeQuery(query: string): Promise<string> {
    // 1. Parse query to identify required tables
    const requiredTables = this.extractTableNames(query);
    
    // 2. Ensure tables are loaded
    await Promise.all(
      requiredTables.map(table => this.db.ensureTableLoaded(table))
    );
    
    // 3. Check if we can use materialized views
    const optimized = this.substituteViews(query);
    
    // 4. Add appropriate indexes if missing
    await this.ensureIndexes(requiredTables);
    
    return optimized;
  }
}
```

### 4. Natural Language Processing
```typescript
class NLQueryProcessor {
  private templates = {
    weekly_summary: `
      SELECT * FROM athlete_weekly_summary 
      WHERE week_start >= CURRENT_DATE - INTERVAL '{timeframe}'
      ORDER BY week_start DESC
    `,
    
    sleep_quality: `
      SELECT sleep_date, hours_asleep, sleep_efficiency_pct
      FROM sleep_summary
      WHERE sleep_date >= CURRENT_DATE - INTERVAL '{timeframe}'
      AND hours_asleep IS NOT NULL
    `,
    
    workout_trends: `
      SELECT activityType, COUNT(*) as sessions, 
             SUM(duration)/3600 as total_hours
      FROM workouts
      WHERE startDate >= CURRENT_DATE - INTERVAL '{timeframe}'
      GROUP BY activityType
    `
  };
  
  async processNaturalQuery(question: string): Promise<string> {
    // 1. Classify intent
    const intent = await this.classifyIntent(question);
    
    // 2. Extract parameters
    const params = this.extractParameters(question);
    
    // 3. Generate SQL
    if (this.templates[intent]) {
      return this.fillTemplate(this.templates[intent], params);
    }
    
    // 4. Fall back to LLM-generated SQL
    return this.generateSQL(question);
  }
}
```

## Performance Optimizations

### 1. Incremental Loading
```typescript
// Only load data within a rolling window by default
const ROLLING_WINDOW_DAYS = 90;

async loadRecentData(tableName: string) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - ROLLING_WINDOW_DAYS);
  
  await this.db.run(`
    CREATE TABLE ${tableName} AS
    SELECT * FROM read_csv('${this.catalog[tableName].path}',
      header = true,
      skip = 1
    )
    WHERE TRY_CAST(startDate AS TIMESTAMP) >= '${cutoffDate.toISOString()}'
  `);
}
```

### 2. Result Streaming
```typescript
async* streamQueryResults(query: string, chunkSize = 1000) {
  const conn = await this.db.connect();
  const result = await conn.run(query);
  
  let offset = 0;
  while (true) {
    const chunk = await result.getNextChunk(chunkSize);
    if (chunk.length === 0) break;
    
    yield {
      data: chunk,
      offset,
      hasMore: chunk.length === chunkSize
    };
    
    offset += chunk.length;
  }
}
```

### 3. Query Result Caching
```typescript
class QueryCache {
  private cache = new Map<string, CachedResult>();
  
  getCacheKey(query: string, params: any): string {
    return crypto
      .createHash('sha256')
      .update(query + JSON.stringify(params))
      .digest('hex');
  }
  
  async getOrExecute(query: string, executor: Function) {
    const key = this.getCacheKey(query, {});
    
    if (this.cache.has(key)) {
      const cached = this.cache.get(key);
      if (Date.now() - cached.timestamp < cached.ttl) {
        return cached.result;
      }
    }
    
    const result = await executor(query);
    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      ttl: this.getTTL(query)
    });
    
    return result;
  }
}
```

## Resource Management

### 1. Memory Management
```typescript
class MemoryManager {
  private maxMemoryMB = 1024; // 1GB limit
  
  async checkMemoryPressure() {
    const usage = await this.db.getMemoryUsage();
    
    if (usage > this.maxMemoryMB * 0.8) {
      // Evict least recently used tables
      await this.evictLRUTables();
    }
  }
  
  async evictLRUTables() {
    const tables = await this.getTablesByLastAccess();
    
    for (const table of tables) {
      if (await this.getMemoryUsage() < this.maxMemoryMB * 0.6) break;
      
      await this.db.run(`DROP TABLE IF EXISTS ${table}`);
      this.catalog[table].loaded = false;
    }
  }
}
```

### 2. Connection Pooling
```typescript
class ConnectionPool {
  private maxConnections = 10;
  private connections: DuckDB.Connection[] = [];
  private available: DuckDB.Connection[] = [];
  
  async acquire(): Promise<PooledConnection> {
    if (this.available.length > 0) {
      return new PooledConnection(this.available.pop(), this);
    }
    
    if (this.connections.length < this.maxConnections) {
      const conn = await this.db.connect();
      this.connections.push(conn);
      return new PooledConnection(conn, this);
    }
    
    // Wait for available connection
    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }
}
```

## Example MCP Server Implementation

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server({
  name: "apple-health-analytics",
  version: "1.0.0",
});

// Initialize the health data database
const healthDB = new AppleHealthMCP({
  dataDir: process.env.HEALTH_DATA_DIR,
  cacheDir: process.env.CACHE_DIR
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "health_query",
      description: "Execute SQL queries on Apple Health data",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          format: { type: "string", enum: ["json", "csv", "summary"] }
        },
        required: ["query"]
      }
    },
    {
      name: "health_insights",
      description: "Get health insights using natural language",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string" },
          timeframe: { type: "string" }
        },
        required: ["question"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  switch (name) {
    case "health_query":
      return await healthDB.executeQuery(args.query, args.format);
      
    case "health_insights":
      const sql = await healthDB.nlProcessor.processNaturalQuery(args.question);
      const result = await healthDB.executeQuery(sql);
      return await healthDB.formatInsights(result, args.question);
      
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

## Benefits of This Architecture

1. **Efficient Resource Usage**: Only loads data as needed
2. **Fast Query Response**: Caching and materialized views
3. **Natural Language Support**: Templates + LLM fallback
4. **Scalable**: Can handle large datasets incrementally
5. **Flexible**: Supports both SQL and natural language queries
6. **Production-Ready**: Connection pooling, memory management, error handling