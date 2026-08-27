/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion -- Focused partial class doubles exercise fail-closed and ordering paths without constructing unrelated native DuckDB state. */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthDataDB, type QueryInspection } from '../db/database';
import { FileCatalog } from '../db/catalog';
import { defaultRegistry } from '../importers';
import { TableLoader } from '../db/loader';
import { QueryCache } from '../core/cache';
import { HealthQueryTool } from './health-query';

let testRoot: string;
let dataDir: string;
let outsideTextPath: string;
let outsideCsvPath: string;
let db: HealthDataDB;
let loader: TableLoader;
let cache: QueryCache;
let tool: HealthQueryTool;

beforeAll(async () => {
  testRoot = mkdtempSync(join(tmpdir(), 'health-query-test-'));
  dataDir = join(testRoot, 'data');
  mkdirSync(dataDir);

  const header = [
    'sep=,',
    'type,sourceName,sourceVersion,productType,device,startDate,endDate,unit,value'
  ];
  writeFileSync(
    join(dataDir, 'HKQuantityTypeIdentifierHeartRate.csv'),
    [...header, 'HKQuantityTypeIdentifierHeartRate,Apple Watch,10.0,Watch7,1,2019-04-08 07:15:00 +0000,2019-04-08 07:15:00 +0000,count/min,62'].join('\r\n') + '\r\n'
  );
  writeFileSync(
    join(dataDir, 'HKQuantityTypeIdentifierStepCount.csv'),
    [...header, 'HKQuantityTypeIdentifierStepCount,iPhone,16.0,iPhone15,2,2019-04-08 08:00:00 +0000,2019-04-08 08:15:00 +0000,count,1200'].join('\r\n') + '\r\n'
  );

  outsideTextPath = join(testRoot, 'known-readable.txt');
  outsideCsvPath = join(testRoot, 'known-readable.csv');
  writeFileSync(outsideTextPath, 'known readable fixture\n');
  writeFileSync(outsideCsvPath, 'value\n1\n');

  db = new HealthDataDB({ dataDir, maxMemoryMB: 512 });
  await db.initialize();
  const catalog = new FileCatalog(dataDir, defaultRegistry());
  await catalog.initialize();
  loader = new TableLoader(db, catalog);
  cache = new QueryCache(10);
  tool = new HealthQueryTool(db, cache, loader);
});

afterAll(async () => {
  await db.close();
  rmSync(testRoot, { recursive: true, force: true });
});

describe('HealthQueryTool accepted queries', () => {
  test('runs a plain SELECT', async () => {
    const result = await tool.execute({
      query: 'SELECT COUNT(*) as count FROM hkquantitytypeidentifierheartrate'
    });
    expect(result.rowCount).toBe(1);
    expect(Number(result.rows[0][0])).toBe(1);
  });

  test('allows OFFSET and words that merely contain a forbidden statement', async () => {
    const result = await tool.execute({
      query:
        'SELECT value FROM hkquantitytypeidentifierheartrate ORDER BY startDate LIMIT 1 OFFSET 0'
    });
    expect(result.rowCount).toBe(1);
  });

  // Pin the supported SELECT-family corpus explicitly. Statement count does
  // not constrain joins, CTEs, subqueries, set operations, or DuckDB's other
  // parser-classified analytical forms.
  const compatibilityCorpus: Array<[string, string]> = [
    [
      'a join across two catalog tables',
      `SELECT heart.value AS heart_rate, steps.value AS steps
       FROM hkquantitytypeidentifierheartrate heart
       JOIN hkquantitytypeidentifierstepcount steps
         ON DATE(heart.startDate) = DATE(steps.startDate)`
    ],
    [
      'multiple CTEs feeding a scalar subquery',
      `WITH samples AS (
         SELECT DATE(startDate) AS day, value
         FROM hkquantitytypeidentifierheartrate
       ), daily AS (
         SELECT day, AVG(value) AS avg_hr FROM samples GROUP BY day
       ) SELECT (SELECT MAX(avg_hr) FROM daily) AS peak_daily_average`
    ],
    [
      'a correlated subquery in WHERE',
      `SELECT value FROM hkquantitytypeidentifierheartrate a
       WHERE value = (SELECT MAX(value) FROM hkquantitytypeidentifierheartrate b
                      WHERE DATE(b.startDate) = DATE(a.startDate))`
    ],
    [
      'a scalar subquery in the select list',
      `SELECT value, (SELECT COUNT(*) FROM hkquantitytypeidentifierheartrate) AS total
       FROM hkquantitytypeidentifierheartrate`
    ],
    ['UNION', 'SELECT 1 AS value UNION SELECT 1 AS value'],
    ['UNION ALL', 'SELECT 1 AS value UNION ALL SELECT 1 AS value'],
    ['INTERSECT', 'SELECT 1 AS value INTERSECT SELECT 1 AS value'],
    ['EXCEPT', 'SELECT 1 AS value EXCEPT SELECT 2 AS value'],
    ['FROM-first syntax', 'FROM hkquantitytypeidentifierheartrate SELECT AVG(value)'],
    [
      'DESCRIBE SELECT',
      'DESCRIBE SELECT value FROM hkquantitytypeidentifierheartrate'
    ],
    [
      'SUMMARIZE',
      'SUMMARIZE SELECT value FROM hkquantitytypeidentifierheartrate'
    ],
    ['SHOW', 'SHOW hkquantitytypeidentifierheartrate'],
    ['TABLE', 'TABLE hkquantitytypeidentifierheartrate'],
    ['VALUES', 'VALUES (1), (2)'],
    [
      'mixed case, comments, whitespace, and a trailing semicolon',
      '  \nSeLeCt /* compatibility */ COUNT(*) FROM hkquantitytypeidentifierheartrate;  \n'
    ]
  ];

  for (const [label, query] of compatibilityCorpus) {
    test(`accepts ${label}`, async () => {
      const result = await tool.execute({ query });
      expect(result.rowCount).toBeGreaterThanOrEqual(1);
    });
  }

  // String literals, comments, aliases, and identifiers containing policy
  // words are not restricted function calls and must remain accepted.
  const falsePositivesFixed: Array<[string, string]> = [
    ['a literal containing DDL', "SELECT 'drop table users' AS note"],
    ['a literal containing a restricted function', "SELECT 'enable_logging write_log query' AS note"],
    ['a predicate containing "please reset"', "SELECT 1 WHERE 'please reset' = 'please reset'"],
    ['a restricted name in a comment', 'SELECT 1 /* disable_logging query */'],
    ['DDL and a restricted name in an alias', 'SELECT 1 AS "drop table write_log"'],
    ['an updated_at identifier', 'WITH metadata(updated_at) AS (VALUES (42)) SELECT updated_at FROM metadata'],
    ['the mathematical log function', 'SELECT log(10)'],
    ['the range function', 'SELECT * FROM range(3)'],
    [
      'query_table relation indirection',
      "SELECT COUNT(*) FROM query_table('hkquantitytypeidentifierheartrate')"
    ]
  ];

  for (const [label, query] of falsePositivesFixed) {
    test(`accepts ${label}`, async () => {
      const result = await tool.execute({ query });
      expect(result.rowCount).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('HealthQueryTool output formats', () => {
  test('separates CSV rows with real newlines and quotes composite values', async () => {
    const result = await tool.execute({
      query: "SELECT 'a,b' AS label, [1, 2] AS values",
      format: 'csv'
    });

    expect(result).toBe('label,values\n"a,b","1,2"');
  });

  test('doubles embedded quotes and quotes fields containing line breaks', async () => {
    const result = await tool.execute({
      query: `SELECT 'say "hi"' AS quoted, 'line1' || chr(10) || 'line2' AS multiline`,
      format: 'csv'
    });

    expect(result).toBe('quoted,multiline\n"say ""hi""","line1\nline2"');
  });

  test('includes non-finite numbers in summary statistics', async () => {
    const result = await tool.execute({
      query:
        "SELECT CAST('NaN' AS DOUBLE) AS nan, CAST('Infinity' AS DOUBLE) AS infinity",
      format: 'summary'
    });

    expect(Number.isNaN(result.statistics.nan.min)).toBe(true);
    expect(Number.isNaN(result.statistics.nan.max)).toBe(true);
    expect(Number.isNaN(result.statistics.nan.avg)).toBe(true);
    expect(result.statistics.nan.count).toBe(1);
    expect(result.statistics.infinity).toEqual({
      min: Infinity,
      max: Infinity,
      avg: Infinity,
      count: 1
    });
  });
});

describe('HealthDataDB query inspection', () => {
  const restrictedQueries: Array<[string, string]> = [
    ['write_log in the select list', "SELECT write_log('marker')"],
    ['write_log in a filter', "SELECT 1 WHERE write_log('marker')"],
    ['write_log in a CASE expression', "SELECT CASE WHEN true THEN write_log('marker') END"],
    ['write_log in an order expression', "SELECT 1 ORDER BY write_log('marker')"],
    ['write_log in a nested subquery', "SELECT (SELECT write_log('marker'))"],
    ['write_log in a CTE', "WITH logged AS (SELECT write_log('marker')) SELECT * FROM logged"],
    ['write_log in a set-operation branch', "SELECT 1 UNION ALL SELECT write_log('marker')"],
    ['enable_logging in FROM', "SELECT * FROM enable_logging(storage := 'stdout')"],
    ['disable_logging in FROM', 'SELECT * FROM disable_logging()'],
    ['truncate_duckdb_logs in FROM', 'SELECT * FROM truncate_duckdb_logs()'],
    [
      'enable_logging in a JOIN',
      "SELECT * FROM range(1) JOIN enable_logging(storage := 'stdout') ON true"
    ],
    [
      'enable_logging in a nested FROM',
      "SELECT * FROM (SELECT * FROM enable_logging(storage := 'stdout')) nested"
    ],
    ['dynamic SQL containing write_log', "SELECT * FROM query('SELECT write_log(''marker'')')"],
    [
      'dynamic SQL containing enable_logging',
      "SELECT * FROM query('SELECT * FROM enable_logging(storage := ''stdout'')')"
    ],
    ['uppercase spelling', "SELECT WRITE_LOG('marker')"],
    ['mixed-case spelling', "SELECT WrItE_LoG('marker')"],
    ['quoted spelling', `SELECT "write_log"('marker')`],
    ['quoted mixed-case spelling', `SELECT "WrItE_LoG"('marker')`],
    ['schema-qualified spelling', "SELECT main.write_log('marker')"]
  ];

  for (const [label, query] of restrictedQueries) {
    test(`finds ${label}`, async () => {
      await expect(db.inspectQuery(query)).resolves.toEqual({
        outcome: 'restricted-function'
      });
    });
  }

  test('distinguishes accepted and statement-shape outcomes', async () => {
    await expect(db.inspectQuery('SELECT 1')).resolves.toEqual({
      outcome: 'accepted'
    });
    await expect(db.inspectQuery('SELECT 1; SELECT 2')).resolves.toEqual({
      outcome: 'statement-rejected'
    });
  });

  test('maps parser callback errors to validator infrastructure failure', async () => {
    const inspectionDb = Object.create(HealthDataDB.prototype) as HealthDataDB;
    inspectionDb.getConnection = (async () => ({
      all: (_sql: string, _query: string, callback: (error: Error | null, rows: unknown[]) => void) => {
        callback(new Error('parser unavailable'), []);
      }
    })) as typeof inspectionDb.getConnection;

    await expect(inspectionDb.inspectQuery('SELECT 1')).resolves.toEqual({
      outcome: 'validator-failure'
    });
  });

  test('maps connection and synchronous parser failures to validator infrastructure failure', async () => {
    // SAFETY: this test double inherits HealthDataDB and replaces the first
    // dependency inspectQuery reaches.
    const connectionFailureDb = Object.create(HealthDataDB.prototype) as HealthDataDB;
    connectionFailureDb.getConnection = async () => {
      throw new Error('connection unavailable');
    };
    await expect(connectionFailureDb.inspectQuery('SELECT 1')).resolves.toEqual({
      outcome: 'validator-failure'
    });

    // SAFETY: this test double inherits HealthDataDB and replaces the only
    // dependency inspectQuery reaches before the synchronous throw.
    const parserFailureDb = Object.create(HealthDataDB.prototype) as HealthDataDB;
    // SAFETY: the replacement preserves getConnection's async return contract
    // and supplies the callback-style all method inspectQuery invokes.
    parserFailureDb.getConnection = (async () => ({
      all: () => {
        throw new Error('synchronous parser failure');
      }
    })) as unknown as typeof parserFailureDb.getConnection;
    await expect(parserFailureDb.inspectQuery('SELECT 1')).resolves.toEqual({
      outcome: 'validator-failure'
    });
  });

  test('maps missing and malformed serialized ASTs to validator infrastructure failure', async () => {
    const malformedAsts = [
      undefined,
      '{not-json',
      '{"error":false}',
      '{"error":false,"statements":[{}]}',
      '{"error":false,"statements":[{"node":null}]}',
      '{"error":false,"statements":[{"node":{}}]}',
      '{"error":false,"statements":[{"node":{"type":"SELECT_NODE","function":{"function_name":null}}}]}'
    ];

    for (const ast of malformedAsts) {
      const inspectionDb = Object.create(HealthDataDB.prototype) as HealthDataDB;
      inspectionDb.getConnection = (async () => ({
        all: (_sql: string, _query: string, callback: (error: Error | null, rows: unknown[]) => void) => {
          callback(null, ast === undefined ? [] : [{ ast }]);
        }
      })) as typeof inspectionDb.getConnection;

      await expect(inspectionDb.inspectQuery('SELECT 1')).resolves.toEqual({
        outcome: 'validator-failure'
      });
    }
  });

  test('scans deeply nested serialized ASTs without using the JavaScript call stack', async () => {
    const depth = 30_000;
    const nestedNode = `{"type":"SELECT_NODE","child":${'{"child":'.repeat(depth)}{"function_name":"log"}${'}'.repeat(depth)}}`;
    const ast = `{"error":false,"statements":[{"node":${nestedNode}}]}`;
    const inspectionDb = Object.create(HealthDataDB.prototype) as HealthDataDB;
    inspectionDb.getConnection = (async () => ({
      all: (_sql: string, _query: string, callback: (error: Error | null, rows: unknown[]) => void) => {
        callback(null, [{ ast }]);
      }
    })) as typeof inspectionDb.getConnection;

    await expect(inspectionDb.inspectQuery('SELECT 1')).resolves.toEqual({
      outcome: 'accepted'
    });
  });
});

describe('HealthQueryTool rejected queries', () => {
  const STATEMENT_REJECTION = 'Only one DuckDB SELECT-family statement is allowed';
  const RESTRICTED_REJECTION = 'Query uses a restricted operational function';
  const VALIDATOR_FAILURE = 'Query validation is unavailable';

  async function expectStatementRejectedBeforeDownstream(query: string): Promise<void> {
    const downstreamCalls: string[] = [];
    const trackingDb = {
      inspectQuery: (candidate: string) => db.inspectQuery(candidate),
      execute: async () => {
        downstreamCalls.push('execute');
        return [];
      }
    } as unknown as HealthDataDB;
    const trackingLoader = {
      ensureTablesForQuery: async () => {
        downstreamCalls.push('load');
      }
    } as unknown as TableLoader;
    const trackingCache = {
      getOrExecute: async (_query: string, executor: () => Promise<unknown>) => {
        downstreamCalls.push('cache');
        return executor();
      }
    } as unknown as QueryCache;
    const trackingTool = new HealthQueryTool(trackingDb, trackingCache, trackingLoader);

    await expect(trackingTool.execute({ query })).rejects.toThrow(STATEMENT_REJECTION);
    expect(downstreamCalls).toEqual([]);
  }

  const rejected: Array<[string, string]> = [
    ['CREATE', 'CREATE TABLE rejected_create(value INTEGER)'],
    ['ALTER', 'ALTER TABLE hkquantitytypeidentifierheartrate ADD COLUMN rejected INTEGER'],
    ['DROP', 'DROP TABLE hkquantitytypeidentifierheartrate'],
    ['INSERT', 'INSERT INTO hkquantitytypeidentifierheartrate VALUES (1)'],
    ['UPDATE', 'UPDATE hkquantitytypeidentifierheartrate SET value = 0'],
    ['DELETE', 'DELETE FROM hkquantitytypeidentifierheartrate'],
    ['COPY', "COPY (SELECT 1) TO 'leak.csv'"],
    ['ATTACH', "ATTACH '/tmp/x.db'"],
    ['INSTALL', 'INSTALL httpfs'],
    ['LOAD', 'LOAD icu'],
    ['SET', "SET max_temp_directory_size = '10GB'"],
    ['RESET', 'RESET memory_limit'],
    ['PRAGMA', 'PRAGMA database_list'],
    ['a second statement after a SELECT', 'SELECT 1; PRAGMA database_list'],
    ['two SELECT statements', 'SELECT 1; SELECT 2'],
    ['empty input', ''],
    ['whitespace only', '   '],
    ['comments only', '-- no statement\n/* still no statement */'],
    ['malformed input', 'SELECT FROM']
  ];

  for (const [label, query] of rejected) {
    test(`rejects ${label} before downstream work`, async () => {
      await expectStatementRejectedBeforeDownstream(query);
    });
  }

  // These are valid one-statement SELECT-family queries. Known-readable local
  // fixtures rule out incidental missing-file failures: the engine must deny
  // them specifically because they are outside dataDir or use a URL.
  const engineBlocked: Array<[string, () => string, () => string]> = [
    [
      'a local file read via read_text',
      () => `SELECT * FROM read_text('${outsideTextPath.replace(/'/g, "''")}')`,
      () => outsideTextPath
    ],
    [
      'a local file read via read_csv',
      () => `SELECT * FROM read_csv('${outsideCsvPath.replace(/'/g, "''")}')`,
      () => outsideCsvPath
    ],
    [
      'a local glob',
      () => `SELECT * FROM glob('${testRoot.replace(/'/g, "''")}/*.csv')`,
      () => `${testRoot}/*.csv`
    ],
    [
      'a URL read via read_csv',
      () => "SELECT * FROM read_csv('https://example.com/known.csv')",
      () => 'https://example.com/known.csv'
    ]
  ];

  for (const [label, queryForTest, deniedTarget] of engineBlocked) {
    test(`blocks ${label} at the engine with a permission error`, async () => {
      const error = await tool.execute({ query: queryForTest() }).then(
        () => null,
        (caught: Error) => caught
      );
      expect(error).not.toBeNull();
      expect(error!.message).not.toContain(STATEMENT_REJECTION);
      expect(error!.message).toContain('Permission Error');
      expect(error!.message).toContain('file system operations are disabled by configuration');
      expect(error!.message).toContain(deniedTarget());
    });
  }

  test('allows direct in-dataDir COPY but rejects it through the tool without creating a file', async () => {
    const outputPath = join(dataDir, 'copy-layer-control.csv');
    const escapedOutputPath = outputPath.replace(/'/g, "''");
    const copy = `COPY (SELECT 'engine-direct-success' AS marker) TO '${escapedOutputPath}'`;

    try {
      await expect(db.execute(copy)).resolves.toBeDefined();
      expect(existsSync(outputPath)).toBe(true);

      rmSync(outputPath);
      await expect(tool.execute({ query: copy })).rejects.toThrow(STATEMENT_REJECTION);
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      rmSync(outputPath, { force: true });
    }
  });

  test('rejects lowercase and comment-obfuscated forms (parser, not substring)', async () => {
    await expect(tool.execute({ query: "copy (select 1) to 'x'" })).rejects.toThrow(STATEMENT_REJECTION);
    await expect(
      tool.execute({ query: 'SELECT 1 -- inline\n; DROP TABLE hkquantitytypeidentifierheartrate' })
    ).rejects.toThrow(STATEMENT_REJECTION);
  });

  test('accepts a comment inside a single SELECT', async () => {
    const result = await tool.execute({
      query: 'SELECT /* leading comment */ COUNT(*) FROM hkquantitytypeidentifierheartrate'
    });
    expect(result.rowCount).toBe(1);
  });

  test('a rejected query never reaches the database', async () => {
    const executed: string[] = [];
    const originalExecute = db.execute.bind(db);
    // SAFETY: the spy has the same (query, sessionId?) => Promise<any[]>
    // signature as HealthDataDB.execute, so it is a drop-in replacement.
    db.execute = ((query: string, sessionId?: string) => {
      // Ignore the validator's own json_serialize_sql probe; record real runs.
      if (!query.includes('json_serialize_sql')) executed.push(query);
      return originalExecute(query, sessionId);
    }) as typeof db.execute;

    try {
      await expect(
        tool.execute({ query: "COPY (SELECT 1) TO 'leak.csv'" })
      ).rejects.toThrow(STATEMENT_REJECTION);
      expect(executed).toEqual([]);
    } finally {
      db.execute = originalExecute;
    }
  });

  test('rejects restricted functions before loading, caching, or execution', async () => {
    const downstreamCalls: string[] = [];
    const originalEnsureTables = loader.ensureTablesForQuery.bind(loader);
    const originalGetOrExecute = cache.getOrExecute.bind(cache);
    const originalExecute = db.execute.bind(db);
    loader.ensureTablesForQuery = (async () => {
      downstreamCalls.push('load');
    }) as typeof loader.ensureTablesForQuery;
    cache.getOrExecute = (async () => {
      downstreamCalls.push('cache');
      throw new Error('cache should not run');
    }) as typeof cache.getOrExecute;
    db.execute = (async () => {
      downstreamCalls.push('execute');
      return [];
    }) as typeof db.execute;

    try {
      await expect(tool.execute({ query: "SELECT write_log('marker')" })).rejects.toThrow(
        RESTRICTED_REJECTION
      );
      expect(downstreamCalls).toEqual([]);
    } finally {
      loader.ensureTablesForQuery = originalEnsureTables;
      cache.getOrExecute = originalGetOrExecute;
      db.execute = originalExecute;
    }
  });

  test('reports validator infrastructure failure distinctly and stops downstream work', async () => {
    const downstreamCalls: string[] = [];
    const originalInspectQuery = db.inspectQuery.bind(db);
    const originalEnsureTables = loader.ensureTablesForQuery.bind(loader);
    const originalGetOrExecute = cache.getOrExecute.bind(cache);
    const originalExecute = db.execute.bind(db);
    db.inspectQuery = async () => ({ outcome: 'validator-failure' });
    loader.ensureTablesForQuery = (async () => {
      downstreamCalls.push('load');
    }) as typeof loader.ensureTablesForQuery;
    cache.getOrExecute = (async () => {
      downstreamCalls.push('cache');
      throw new Error('cache should not run');
    }) as typeof cache.getOrExecute;
    db.execute = (async () => {
      downstreamCalls.push('execute');
      return [];
    }) as typeof db.execute;

    try {
      await expect(tool.execute({ query: 'SELECT 1' })).rejects.toThrow(VALIDATOR_FAILURE);
      expect(downstreamCalls).toEqual([]);
    } finally {
      db.inspectQuery = originalInspectQuery;
      loader.ensureTablesForQuery = originalEnsureTables;
      cache.getOrExecute = originalGetOrExecute;
      db.execute = originalExecute;
    }
  });

  test('awaits accepted inspection completion before loading, cache lookup, or execution', async () => {
    const order: string[] = [];
    let resolveInspection!: (inspection: QueryInspection) => void;
    const inspection = new Promise<QueryInspection>((resolve) => {
      resolveInspection = resolve;
    });
    const orderingDb = {
      inspectQuery: async () => {
        order.push('inspection-started');
        return inspection;
      },
      execute: async () => {
        order.push('execute');
        return [{ value: 1 }];
      }
    } as unknown as HealthDataDB;
    const orderingLoader = {
      ensureTablesForQuery: async () => {
        order.push('load');
      }
    } as unknown as TableLoader;
    const orderingCache = new QueryCache(1);
    const originalGetOrExecute = orderingCache.getOrExecute.bind(orderingCache);
    orderingCache.getOrExecute = (async (query, executor, params) => {
      order.push('cache');
      return originalGetOrExecute(query, executor, params);
    }) as typeof orderingCache.getOrExecute;
    const orderingTool = new HealthQueryTool(orderingDb, orderingCache, orderingLoader);

    const pending = orderingTool.execute({ query: 'SELECT 1 AS validation_order_control' });
    expect(order).toEqual(['inspection-started']);

    resolveInspection({ outcome: 'accepted' });
    await expect(pending).resolves.toMatchObject({ rowCount: 1 });
    expect(order).toEqual(['inspection-started', 'load', 'cache', 'execute']);
  });

  test('awaits rejected inspection completion and never starts downstream work', async () => {
    const order: string[] = [];
    let resolveInspection!: (inspection: QueryInspection) => void;
    const inspection = new Promise<QueryInspection>((resolve) => {
      resolveInspection = resolve;
    });
    const orderingDb = {
      inspectQuery: async () => {
        order.push('inspection-started');
        return inspection;
      },
      execute: async () => {
        order.push('execute');
        return [];
      }
    } as unknown as HealthDataDB;
    const orderingLoader = {
      ensureTablesForQuery: async () => {
        order.push('load');
      }
    } as unknown as TableLoader;
    const orderingCache = new QueryCache(1);
    const originalGetOrExecute = orderingCache.getOrExecute.bind(orderingCache);
    orderingCache.getOrExecute = (async (query, executor, params) => {
      order.push('cache');
      return originalGetOrExecute(query, executor, params);
    }) as typeof orderingCache.getOrExecute;
    const orderingTool = new HealthQueryTool(orderingDb, orderingCache, orderingLoader);

    const pending = orderingTool.execute({ query: 'SELECT 1' });
    expect(order).toEqual(['inspection-started']);

    resolveInspection({ outcome: 'statement-rejected' });
    await expect(pending).rejects.toThrow(STATEMENT_REJECTION);
    expect(order).toEqual(['inspection-started']);
  });
});
