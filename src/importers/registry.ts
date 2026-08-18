import type { DetectedTable, FormatImporter } from './types';

export interface ClaimedTable extends DetectedTable {
  importer: FormatImporter;
}

export class MultipleFormatsError extends Error {
  constructor(displayNames: string[]) {
    super(
      `Multiple export formats found in the data directory: ${displayNames.join(', ')}. ` +
        `Use one format per directory — split the exports into separate directories ` +
        `and point HEALTH_DATA_DIR at one of them.`
    );
    this.name = 'MultipleFormatsError';
  }
}

export class ImporterRegistry {
  private importers: FormatImporter[];

  constructor(importers: FormatImporter[]) {
    this.importers = importers;
  }

  // Runs every importer's detect and enforces the one-format-per-directory
  // rule. A format claims the directory when its files are present, even with
  // zero resulting tables. Returns the claiming format's tables with the
  // owning importer attached; importers themselves stay unaware of the
  // registry. Table order preserves each importer's directory iteration order
  // so duplicate canonical names keep last-entry-wins semantics downstream.
  async detectAll(dataDir: string): Promise<ClaimedTable[]> {
    const claims: Array<{ importer: FormatImporter; tables: DetectedTable[] }> = [];

    for (const importer of this.importers) {
      const result = await importer.detect(dataDir);
      if (result.claimed) {
        claims.push({ importer, tables: result.tables });
      }
    }

    if (claims.length > 1) {
      throw new MultipleFormatsError(claims.map((claim) => claim.importer.displayName));
    }

    const claim = claims[0];
    if (!claim) {
      return [];
    }

    return claim.tables.map((table) => ({ ...table, importer: claim.importer }));
  }
}
