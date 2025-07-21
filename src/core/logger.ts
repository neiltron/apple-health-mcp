import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export class Logger {
  private static logFile = process.env.LOG_FILE || join(process.cwd(), 'mcp-server.log');
  private static useStderr = process.env.LOG_TO_STDERR === 'true';
  
  static log(...args: any[]): void {
    const timestamp = new Date().toISOString();
    const message = `[${timestamp}] ${args.join(' ')}\n`;
    
    if (this.useStderr) {
      process.stderr.write(message);
    } else {
      try {
        appendFileSync(this.logFile, message);
      } catch (error) {
        // Fail silently - we can't log errors about logging
      }
    }
  }
  
  static error(...args: any[]): void {
    const timestamp = new Date().toISOString();
    const message = `[${timestamp}] ERROR: ${args.join(' ')}\n`;
    
    if (this.useStderr) {
      process.stderr.write(message);
    } else {
      try {
        appendFileSync(this.logFile, message);
      } catch (error) {
        // Fail silently
      }
    }
  }
  
  static debug(...args: any[]): void {
    if (process.env.DEBUG !== 'true') return;
    this.log('DEBUG:', ...args);
  }
}