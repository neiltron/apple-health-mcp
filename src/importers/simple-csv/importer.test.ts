import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimpleCsvImporter } from './importer';
import { writeCsv, QUANTITY_HEADER, WORKOUT_HEADER } from '../../test-helpers/csv-fixtures';

let dataDir: string;
const importer = new SimpleCsvImporter();

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'simple-csv-detect-'));

  writeCsv(dataDir, 'HKQuantityTypeIdentifierHeartRate_2026-07-21.csv', QUANTITY_HEADER, []);
  writeCsv(dataDir, 'HKCategoryTypeIdentifierSleepAnalysis.csv', QUANTITY_HEADER, []);
  writeCsv(dataDir, 'HKWorkoutActivityType.csv', WORKOUT_HEADER, []);
  writeCsv(dataDir, 'HKWorkoutActivityTypeRunning.csv', WORKOUT_HEADER, []);
  // Recognized by the regex but not a family the loader has verified.
  writeCsv(dataDir, 'HKWorkoutTypeIdentifierTest.csv', WORKOUT_HEADER, []);
  // Not health exports.
  writeFileSync(join(dataDir, 'notes.txt'), 'not health data\n');
  writeCsv(dataDir, 'Workout.csv', WORKOUT_HEADER, []);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('SimpleCsvImporter detect', () => {
  test('maps filenames to the same canonical table names the catalog produced', async () => {
    const result = await importer.detect(dataDir);
    const names = result.tables.map((t) => t.tableName).sort();

    expect(result.claimed).toBe(true);
    expect(names).toEqual([
      'hkcategorytypeidentifiersleepanalysis',
      'hkquantitytypeidentifierheartrate',
      'hkworkoutactivitytype',
      'hkworkoutactivitytyperunning',
      'hkworkouttypeidentifiertest'
    ]);
  });

  test('assigns kinds from the filename family', async () => {
    const result = await importer.detect(dataDir);
    const kinds = new Map(result.tables.map((t) => [t.tableName, t.kind]));

    expect(kinds.get('hkquantitytypeidentifierheartrate')).toBe('quantity');
    expect(kinds.get('hkcategorytypeidentifiersleepanalysis')).toBe('category');
    expect(kinds.get('hkworkoutactivitytype')).toBe('workout');
    expect(kinds.get('hkworkoutactivitytyperunning')).toBe('workout');
    // An unverified identifier family must not assert a shape.
    expect(kinds.get('hkworkouttypeidentifiertest')).toBe('other');
  });

  test('does not claim a directory with no recognized files', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'simple-csv-empty-'));
    try {
      writeFileSync(join(emptyDir, 'readme.md'), 'nothing here\n');
      const result = await importer.detect(emptyDir);
      expect(result.claimed).toBe(false);
      expect(result.tables).toEqual([]);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
