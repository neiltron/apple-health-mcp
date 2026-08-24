import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthDataDB } from './database';

const MAX_MEMORY_MB = 512;

let db: HealthDataDB;

beforeAll(async () => {
  db = new HealthDataDB({ dataDir: '/nonexistent', maxMemoryMB: MAX_MEMORY_MB });
  await db.initialize();
});

afterAll(async () => {
  await db.close();
});

describe('HealthDataDB settings', () => {
  test('gives the temporary directory zero capacity so health rows cannot spill to disk', async () => {
    const result = await db.execute(
      `SELECT current_setting('max_temp_directory_size') as max_temp_directory_size`
    );
    expect(String(result[0].max_temp_directory_size)).toBe('0 bytes');
  });

  test('applies the configured memory limit', async () => {
    const result = await db.execute(
      `SELECT current_setting('memory_limit') as memory_limit`
    );
    // DuckDB reports the limit in MiB, slightly below the requested MB value.
    const limitMiB = parseFloat(String(result[0].memory_limit));
    expect(limitMiB).toBeGreaterThan(MAX_MEMORY_MB * 0.9);
    expect(limitMiB).toBeLessThanOrEqual(MAX_MEMORY_MB);
  });

  test('defaults the memory limit to 2048MB', async () => {
    const defaultDb = new HealthDataDB({ dataDir: '/nonexistent' });
    await defaultDb.initialize();
    try {
      const result = await defaultDb.execute(
        `SELECT current_setting('memory_limit') as memory_limit`
      );
      // DuckDB renders 2048MB as "1.9 GiB".
      const setting = String(result[0].memory_limit);
      expect(setting.endsWith('GiB')).toBe(true);
      expect(parseFloat(setting)).toBeGreaterThanOrEqual(1.9);
      expect(parseFloat(setting)).toBeLessThanOrEqual(2.0);
    } finally {
      await defaultDb.close();
    }
  });

  test('locks configuration so later queries cannot loosen the sandbox', async () => {
    await expect(db.execute(`SET memory_limit = '64MB'`)).rejects.toThrow();
  });
});

describe('HealthDataDB query boundary', () => {
  let boundaryDir: string;
  let boundaryDb: HealthDataDB;

  beforeAll(async () => {
    boundaryDir = mkdtempSync(join(tmpdir(), 'health-boundary-'));
    writeFileSync(join(boundaryDir, 'inside.csv'), 'a\n1\n2\n');
    boundaryDb = new HealthDataDB({ dataDir: boundaryDir, maxMemoryMB: MAX_MEMORY_MB });
    await boundaryDb.initialize();
  });

  afterAll(async () => {
    await boundaryDb.close();
    rmSync(boundaryDir, { recursive: true, force: true });
  });

  test('reads a CSV inside the data directory (the loader path stays open)', async () => {
    const inside = join(boundaryDir, 'inside.csv').replace(/'/g, "''");
    const result = await boundaryDb.execute(
      `SELECT COUNT(*) as count FROM read_csv('${inside}')`
    );
    expect(Number(result[0].count)).toBe(2);
  });

  test('blocks reading a file outside the data directory', async () => {
    await expect(
      boundaryDb.execute(`SELECT * FROM read_text('/etc/hosts')`)
    ).rejects.toThrow();
  });

  test('blocks writing a file outside the data directory', async () => {
    await expect(
      boundaryDb.execute(`COPY (SELECT 1) TO '/tmp/health-leak.csv'`)
    ).rejects.toThrow();
  });

  test('blocks attaching an external database', async () => {
    await expect(
      boundaryDb.execute(`ATTACH '/tmp/health-attach.db'`)
    ).rejects.toThrow();
  });

  test('blocks installing an extension', async () => {
    await expect(boundaryDb.execute(`INSTALL httpfs`)).rejects.toThrow();
  });

  // LOAD of an already-bundled extension is NOT blocked at the engine (only
  // INSTALL needs external access). The validator layer stops it because LOAD
  // is not a SELECT; this test pins the engine-layer behavior so the doc's
  // narrower claim stays honest.
  test('does not block LOAD of a bundled extension at the engine', async () => {
    await expect(boundaryDb.execute(`LOAD icu`)).resolves.toBeDefined();
  });
});

describe('HealthDataDB with a quote in the data directory', () => {
  let quotedDir: string;
  let quotedDb: HealthDataDB;

  beforeAll(async () => {
    // A directory name containing a single quote must not break out of the
    // allowed_directories SQL literal or corrupt the surrounding SET batch.
    quotedDir = mkdtempSync(join(tmpdir(), "health-o'brien-"));
    writeFileSync(join(quotedDir, 'inside.csv'), 'a\n1\n');
    quotedDb = new HealthDataDB({ dataDir: quotedDir, maxMemoryMB: MAX_MEMORY_MB });
    await quotedDb.initialize();
  });

  afterAll(async () => {
    await quotedDb.close();
    rmSync(quotedDir, { recursive: true, force: true });
  });

  test('still confines file access and locks configuration', async () => {
    const inside = join(quotedDir, 'inside.csv').replace(/'/g, "''");
    const result = await quotedDb.execute(`SELECT COUNT(*) as count FROM read_csv('${inside}')`);
    expect(Number(result[0].count)).toBe(1);
    await expect(quotedDb.execute(`SELECT * FROM read_text('/etc/hosts')`)).rejects.toThrow();
    await expect(quotedDb.execute(`SET memory_limit = '64MB'`)).rejects.toThrow();
  });
});
