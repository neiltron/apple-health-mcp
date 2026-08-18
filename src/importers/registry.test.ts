import { describe, test, expect } from 'bun:test';
import { ImporterRegistry, MultipleFormatsError } from './registry';
import type { DetectionResult, FormatImporter } from './types';

function fakeImporter(
  id: string,
  displayName: string,
  result: DetectionResult
): FormatImporter {
  return {
    id,
    displayName,
    detect: async () => result,
    load: async () => 0
  };
}

describe('ImporterRegistry', () => {
  test('returns the claiming importer tables with the importer attached', async () => {
    const importer = fakeImporter('fake-csv', 'Fake CSV', {
      claimed: true,
      tables: [
        { tableName: 'hkquantitytypeidentifierheartrate', path: '/data/a.csv', kind: 'quantity' },
        { tableName: 'hkworkoutactivitytype', path: '/data/b.csv', kind: 'workout' }
      ]
    });
    const registry = new ImporterRegistry([importer]);

    const tables = await registry.detectAll('/data');

    expect(tables.length).toBe(2);
    expect(tables[0].tableName).toBe('hkquantitytypeidentifierheartrate');
    expect(tables[0].importer).toBe(importer);
    expect(tables[1].importer).toBe(importer);
  });

  test('no claiming importer yields an empty result without error', async () => {
    const importer = fakeImporter('fake-csv', 'Fake CSV', { claimed: false, tables: [] });
    const registry = new ImporterRegistry([importer]);

    expect(await registry.detectAll('/data')).toEqual([]);
  });

  test('a claimed format with zero tables still claims the directory', async () => {
    const empty = fakeImporter('fake-empty', 'Fake Empty', { claimed: true, tables: [] });
    const other = fakeImporter('fake-other', 'Fake Other', {
      claimed: true,
      tables: [{ tableName: 'hkquantitytypeidentifiersteps', path: '/data/s.csv', kind: 'quantity' }]
    });

    // Alone, an empty claim yields an empty catalog without error.
    expect(await new ImporterRegistry([empty]).detectAll('/data')).toEqual([]);

    // Combined with a second claiming format, it still counts as a conflict.
    await expect(new ImporterRegistry([empty, other]).detectAll('/data')).rejects.toThrow(
      MultipleFormatsError
    );
  });

  test('two claiming formats produce an error naming both display names', async () => {
    const a = fakeImporter('format-a', 'Format A', {
      claimed: true,
      tables: [{ tableName: 'hkquantitytypeidentifiersteps', path: '/data/a.csv', kind: 'quantity' }]
    });
    const b = fakeImporter('format-b', 'Format B', {
      claimed: true,
      tables: [{ tableName: 'hkquantitytypeidentifiermass', path: '/data/b.json', kind: 'quantity' }]
    });

    const error = await new ImporterRegistry([a, b])
      .detectAll('/data')
      .then(() => null)
      .catch((err: Error) => err);

    expect(error).toBeInstanceOf(MultipleFormatsError);
    expect(error!.message).toContain('Format A');
    expect(error!.message).toContain('Format B');
    expect(error!.message).toContain('separate directories');
  });

  test('a detect that throws propagates as a scan failure', async () => {
    const broken: FormatImporter = {
      id: 'broken',
      displayName: 'Broken',
      detect: async () => {
        throw new Error('permission denied');
      },
      load: async () => 0
    };

    await expect(new ImporterRegistry([broken]).detectAll('/data')).rejects.toThrow(
      'permission denied'
    );
  });
});
