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
});

describe('HealthQueryTool output formats', () => {
  test('preserves existing CSV serialization for strings and composites', async () => {
    const result = await tool.execute({
      query: "SELECT 'a,b' AS label, [1, 2] AS values",
      format: 'csv'
    });

    expect(result).toBe('label,values\\n"a,b",1,2');
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
  const rejected: Array<[string, string]> = [
    ["SET max_temp_directory_size = '10GB'", 'set'],
    ['SELECT 1; PRAGMA database_list', 'pragma'],
    ['RESET memory_limit', 'reset'],
    ['DROP TABLE hkquantitytypeidentifierheartrate', 'drop'],
    ['INSERT INTO hkquantitytypeidentifierheartrate VALUES (1)', 'insert'],
    ['UPDATE hkquantitytypeidentifierheartrate SET value = 0', 'update']
  ];

  for (const [query, keyword] of rejected) {
    test(`rejects ${keyword}`, async () => {
      await expect(tool.execute({ query })).rejects.toThrow(
        `forbidden keyword: ${keyword}`
      );
    });
  }

  test('rejects a statement with no SELECT', async () => {
    await expect(tool.execute({ query: 'SHOW TABLES' })).rejects.toThrow(
      'Only SELECT queries are allowed'
    );
  });
});
