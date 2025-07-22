import type { TableLoader } from '../db/loader';

export class QueryOptimizer {
  private loader: TableLoader;
  
  constructor(loader: TableLoader) {
    this.loader = loader;
  }
  
  async optimizeQuery(query: string): Promise<string> {
    // Extract required tables from the query
    const requiredTables = this.loader.extractTableNames(query);
    
    // Ensure all required tables are loaded
    await Promise.all(
      requiredTables.map(table => this.loader.ensureTableLoaded(table))
    );
    
    // Return the original query - let the LLM handle query optimization
    return query;
  }
}