import { createHash } from 'node:crypto';
import type { CachedResult, QueryResult } from '../types';

export class QueryCache {
  private cache: Map<string, CachedResult> = new Map();
  private maxSize: number;
  private defaultTTL: number = 5 * 60 * 1000; // 5 minutes
  
  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }
  
  private getCacheKey(query: string, params?: any): string {
    const input = query + (params ? JSON.stringify(params) : '');
    return createHash('sha256').update(input).digest('hex');
  }
  
  private getTTL(query: string): number {
    // Longer TTL for aggregate queries
    if (query.toLowerCase().includes('group by') || 
        query.toLowerCase().includes('avg(') ||
        query.toLowerCase().includes('sum(')) {
      return 10 * 60 * 1000; // 10 minutes
    }
    
    // Shorter TTL for recent data queries
    if (query.toLowerCase().includes('current_date') ||
        query.toLowerCase().includes('now()')) {
      return 60 * 1000; // 1 minute
    }
    
    return this.defaultTTL;
  }
  
  get(query: string, params?: any): QueryResult | undefined {
    const key = this.getCacheKey(query, params);
    const cached = this.cache.get(key);
    
    if (!cached) return undefined;
    
    if (Date.now() - cached.timestamp > cached.ttl) {
      this.cache.delete(key);
      return undefined;
    }
    
    console.log(`Cache hit for query: ${query.substring(0, 50)}...`);
    return cached.result;
  }
  
  set(query: string, result: QueryResult, params?: any): void {
    const key = this.getCacheKey(query, params);
    
    // Evict oldest entries if cache is full
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.findOldestEntry();
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    
    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      ttl: this.getTTL(query)
    });
    
    console.log(`Cached query result: ${query.substring(0, 50)}...`);
  }
  
  private findOldestEntry(): string | undefined {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    
    for (const [key, value] of this.cache) {
      if (value.timestamp < oldestTime) {
        oldestTime = value.timestamp;
        oldestKey = key;
      }
    }
    
    return oldestKey;
  }
  
  clear(): void {
    this.cache.clear();
    console.log('Query cache cleared');
  }
  
  getSize(): number {
    return this.cache.size;
  }
  
  async getOrExecute(
    query: string, 
    executor: () => Promise<QueryResult>,
    params?: any
  ): Promise<QueryResult> {
    const cached = this.get(query, params);
    if (cached) return cached;
    
    const result = await executor();
    this.set(query, result, params);
    return result;
  }
}