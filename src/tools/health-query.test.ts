import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthDataDB } from '../db/database';
import { FileCatalog } from '../db/catalog';
import { defaultRegistry } from '../importers';
import { TableLoader } from '../db/loader';
import { QueryCache } from '../core/cache';
import { HealthQueryTool } from './health-query';

let dataDir: string;
let db: HealthDataDB;
let tool: HealthQueryTool;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'health-query-test-'));
  const rows = [
    'sep=,',
    'type,sourceName,sourceVersion,productType,device,startDate,endDate,unit,value',
    'HKQuantityTypeIdentifierHeartRate,Apple Watch,10.0,Watch7,1,2019-04-08 07:15:00 +0000,2019-04-08 07:15:00 +0000,count/min,62'
  ];
  writeFileSync(
    join(dataDir, 'HKQuantityTypeIdentifierHeartRate.csv'),
    rows.join('\r\n') + '\r\n'
  );

  db = new HealthDataDB({ dataDir, maxMemoryMB: 512 });
  await db.initialize();
  const catalog = new FileCatalog(dataDir, defaultRegistry());
  await catalog.initialize();
  const loader = new TableLoader(db, catalog);
  tool = new HealthQueryTool(db, new QueryCache(10), loader);
});

afterAll(async () => {
  await db.close();
  rmSync(dataDir, { recursive: true, force: true });
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

  // The validator restricts statement kind and count, never query shape: a
  // single read-only SELECT of any internal complexity is accepted.
  const complexAccepted: Array<[string, string]> = [
    [
      'a self-join',
      `SELECT a.value FROM hkquantitytypeidentifierheartrate a
       JOIN hkquantitytypeidentifierheartrate b ON DATE(a.startDate) = DATE(b.startDate)`
    ],
    [
      'a CTE feeding an aggregate',
      `WITH daily AS (
         SELECT DATE(startDate) AS d, AVG(value) AS avg_hr
         FROM hkquantitytypeidentifierheartrate GROUP BY d
       ) SELECT MAX(avg_hr) FROM daily`
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
    [
      'a UNION ALL of two selects',
      `SELECT value FROM hkquantitytypeidentifierheartrate
       UNION ALL SELECT value FROM hkquantitytypeidentifierheartrate`
    ],
    ['a trailing semicolon', 'SELECT COUNT(*) FROM hkquantitytypeidentifierheartrate;'],
    ['FROM-first syntax', 'FROM hkquantitytypeidentifierheartrate SELECT AVG(value)']
  ];

  for (const [label, query] of complexAccepted) {
    test(`accepts ${label}`, async () => {
      const result = await tool.execute({ query });
      expect(result.rowCount).toBeGreaterThanOrEqual(1);
    });
  }

  // String literals and identifiers that merely contain a former blocklist
  // keyword are no longer false positives, because the parser decides.
  const falsePositivesFixed: Array<[string, string]> = [
    ['a literal containing "drop table"', "SELECT 'drop table users' AS note"],
    ['a literal containing "reset"', "SELECT 'please reset your goals' AS tip"],
    ['a literal containing "delete"', "SELECT 'delete me' AS label"]
  ];

  for (const [label, query] of falsePositivesFixed) {
    test(`accepts ${label}`, async () => {
      const result = await tool.execute({ query });
      expect(result.rowCount).toBe(1);
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

describe('HealthQueryTool rejected queries', () => {
  const REJECTION = 'Only a single read-only SELECT statement is allowed';

  // Anything that is not exactly one read-only SELECT is rejected. The engine
  // sandbox blocks the file/config reachability underneath these; this check is
  // the layer that also stops the one write form the engine permits —
  // COPY (SELECT ...) TO a file inside the data directory.
  const rejected: Array<[string, string]> = [
    ['a config statement (SET)', "SET max_temp_directory_size = '10GB'"],
    ['a config statement (RESET)', 'RESET memory_limit'],
    ['a config statement (PRAGMA)', 'PRAGMA database_list'],
    ['a second statement after a SELECT', 'SELECT 1; PRAGMA database_list'],
    ['two SELECT statements', 'SELECT 1; SELECT 2'],
    ['DROP', 'DROP TABLE hkquantitytypeidentifierheartrate'],
    ['INSERT', 'INSERT INTO hkquantitytypeidentifierheartrate VALUES (1)'],
    ['UPDATE', 'UPDATE hkquantitytypeidentifierheartrate SET value = 0'],
    ['DELETE', 'DELETE FROM hkquantitytypeidentifierheartrate'],
    ['COPY ... TO (writes health data out even inside the data dir)', "COPY (SELECT 1) TO 'leak.csv'"],
    ['ATTACH', "ATTACH '/tmp/x.db'"],
    ['empty input', ''],
    ['whitespace only', '   '],
    ['unparseable garbage', 'not a query at all']
  ];

  for (const [label, query] of rejected) {
    test(`rejects ${label}`, async () => {
      await expect(tool.execute({ query })).rejects.toThrow(REJECTION);
    });
  }

  // A file/URL read is a valid single SELECT, so it passes the validator and is
  // stopped by the engine sandbox instead. This proves the two layers are
  // independent: the read never succeeds even though the validator allows the
  // statement shape.
  const engineBlocked: Array<[string, string]> = [
    ['a local file read via read_text', "SELECT * FROM read_text('/etc/hosts')"],
    ['a URL read via read_csv', "SELECT * FROM read_csv('https://example.com/x.csv')"]
  ];

  for (const [label, query] of engineBlocked) {
    test(`blocks ${label} at the engine`, async () => {
      // Not the validator's message — the engine's Permission Error.
      const error = await tool.execute({ query }).then(() => null, (e: Error) => e);
      expect(error).not.toBeNull();
      expect(error!.message).not.toContain(REJECTION);
    });
  }

  test('rejects lowercase and comment-obfuscated forms (parser, not substring)', async () => {
    await expect(tool.execute({ query: "copy (select 1) to 'x'" })).rejects.toThrow(REJECTION);
    await expect(
      tool.execute({ query: 'SELECT 1 -- inline\n; DROP TABLE hkquantitytypeidentifierheartrate' })
    ).rejects.toThrow(REJECTION);
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
      ).rejects.toThrow(REJECTION);
      expect(executed).toEqual([]);
    } finally {
      db.execute = originalExecute;
    }
  });

  test('an accepted query is validated before it executes', async () => {
    const order: string[] = [];
    const originalIsSingleSelect = db.isSingleSelect.bind(db);
    const originalExecute = db.execute.bind(db);
    // SAFETY: the spy keeps isSingleSelect's signature, so it is a drop-in
    // replacement that only records call order before delegating.
    db.isSingleSelect = ((query: string, sessionId?: string) => {
      order.push('validate');
      return originalIsSingleSelect(query, sessionId);
    }) as typeof db.isSingleSelect;
    // SAFETY: the spy keeps execute's signature, so it is a drop-in
    // replacement that only records call order before delegating.
    db.execute = ((query: string, sessionId?: string) => {
      if (!query.includes('json_serialize_sql')) order.push('execute');
      return originalExecute(query, sessionId);
    }) as typeof db.execute;

    try {
      await tool.execute({
        query: 'SELECT COUNT(*) FROM hkquantitytypeidentifierheartrate'
      });
      // Validation must precede execution; a dropped await would reverse this
      // or run them concurrently.
      expect(order[0]).toBe('validate');
      expect(order).toContain('execute');
      expect(order.indexOf('validate')).toBeLessThan(order.indexOf('execute'));
    } finally {
      db.isSingleSelect = originalIsSingleSelect;
      db.execute = originalExecute;
    }
  });
});
