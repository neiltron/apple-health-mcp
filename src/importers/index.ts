import { ImporterRegistry } from './registry';
import { SimpleCsvImporter } from './simple-csv/importer';

export function defaultRegistry(): ImporterRegistry {
  return new ImporterRegistry([new SimpleCsvImporter()]);
}
