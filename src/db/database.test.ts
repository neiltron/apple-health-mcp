import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
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
});
