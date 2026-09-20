import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

type JsonRpcValue = string | number | boolean | null | JsonRpcObject | JsonRpcValue[];

interface JsonRpcObject {
  [key: string]: JsonRpcValue;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: JsonRpcValue;
  error?: {
    code: number;
    message: string;
  };
}

let buildDir: string;
let dataDir: string;
let serverPath: string;

beforeAll(() => {
  buildDir = mkdtempSync(join(process.cwd(), 'node_modules', '.health-query-stdio-build-'));
  dataDir = mkdtempSync(join(process.cwd(), 'node_modules', '.health-query-stdio-data-'));
  execFileSync(
    'bun',
    [
      'build',
      'src/server.ts',
      '--outdir',
      buildDir,
      '--target',
      'node',
      '--format',
      'esm',
      '--external',
      'duckdb'
    ],
    { cwd: process.cwd(), stdio: 'pipe' }
  );
  serverPath = join(buildDir, 'server.js');
});

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

function protocolSession(child: ChildProcessWithoutNullStreams) {
  const stdoutLines: string[] = [];
  const waiters = new Map<number, (response: JsonRpcResponse) => void>();
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.length === 0) continue;
      stdoutLines.push(line);
      try {
        // SAFETY: the test server is the producer; required response fields are
        // checked before use and malformed lines remain in stdoutLines.
        const response = JSON.parse(line) as JsonRpcResponse;
        if (response.id === undefined) continue;
        const waiter = waiters.get(response.id);
        if (waiter) {
          waiters.delete(response.id);
          waiter(response);
        }
      } catch {
        // Retain native/non-protocol output for the assertions below.
      }
    }
  });

  const send = (message: JsonRpcObject) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const request = (id: number, method: string, params: JsonRpcObject): Promise<JsonRpcResponse> => {
    send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Timed out waiting for JSON-RPC response ${id}`));
      }, 5_000);
      waiters.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  };

  const finish = () => {
    if (buffer.length > 0) stdoutLines.push(buffer);
  };

  return { stdoutLines, send, request, finish };
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close', { signal: AbortSignal.timeout(3_000) });
  child.kill('SIGINT');
  try {
    await closed;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
    const killed = once(child, 'close', { signal: AbortSignal.timeout(1_000) });
    child.kill('SIGKILL');
    await killed;
  }
}

describe('built MCP stdio query guardrails', () => {
  test('rejects stdout logging and keeps the following query on the JSON-RPC stream', async () => {
    const child = spawn('node', [serverPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HEALTH_DATA_DIR: dataDir,
        MAX_MEMORY_MB: '512'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child.stderr.resume();
    const session = protocolSession(child);
    const marker = 'health-query-native-stdout-marker';
    let logging: JsonRpcResponse | undefined;
    let serializedSql: JsonRpcResponse | undefined;
    let benign: JsonRpcResponse | undefined;

    try {
      const initialized = await session.request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'health-query-stdio-test', version: '1.0.0' }
      });
      expect(initialized.error).toBeUndefined();
      session.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

      logging = await session.request(2, 'tools/call', {
        name: 'health_query',
        arguments: {
          query: "SELECT * FROM enable_logging(storage := 'stdout')"
        }
      });
      serializedSql = await session.request(3, 'tools/call', {
        name: 'health_query',
        arguments: {
          query: "SELECT * FROM json_execute_serialized_sql('{}')"
        }
      });
      benign = await session.request(4, 'tools/call', {
        name: 'health_query',
        arguments: { query: `SELECT 1 /* ${marker} */` }
      });
    } finally {
      await stopChild(child);
      session.finish();
    }

    expect(logging).toBeDefined();
    expect(logging!.error).toBeDefined();
    expect(logging!.error!.message).toContain('restricted operational function');
    expect(serializedSql).toBeDefined();
    expect(serializedSql!.error).toBeDefined();
    expect(serializedSql!.error!.message).toContain('restricted operational function');
    expect(benign).toBeDefined();
    expect(benign!.error).toBeUndefined();

    for (const line of session.stdoutLines) {
      // SAFETY: successful parsing is the assertion under test; the response
      // shape is then checked through its required jsonrpc field.
      const record = JSON.parse(line) as JsonRpcResponse;
      expect(record.jsonrpc).toBe('2.0');
      expect(line).not.toContain(marker);
      expect(line.toLowerCase()).not.toContain('querylog');
    }
  }, 20_000);

  for (const timezone of ['UTC', 'America/New_York']) {
    test(`returns CSV text and consistent dates in ${timezone}`, async () => {
      const child = spawn('node', [serverPath], {
        cwd: process.cwd(),
        env: { ...process.env, TZ: timezone, HEALTH_DATA_DIR: dataDir, MAX_MEMORY_MB: '512' },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      child.stderr.resume();
      const session = protocolSession(child);
      try {
        const initialized = await session.request(1, 'initialize', {
          protocolVersion: '2025-06-18', capabilities: {},
          clientInfo: { name: 'csv-test', version: '1.0.0' }
        });
        expect(initialized.error).toBeUndefined();
        session.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

        const query = `SELECT TIMESTAMP '2026-07-27 00:30:00.123' AS sample,
          DATE '2026-07-27' AS day, 'say "hi",' || chr(10) || 'next' AS label,
          42::BIGINT AS count, NULL AS missing`;
        const texts: Record<string, string> = {};
        let id = 2;
        for (const format of ['csv', 'json', 'summary']) {
          const response = await session.request(id++, 'tools/call', {
            name: 'health_query', arguments: { query, format }
          });
          expect(response.error).toBeUndefined();
          // SAFETY: assert the MCP text content shape before reading it.
          const result = response.result as { content: Array<{ type: string; text: string }> };
          expect(result.content).toHaveLength(1);
          expect(result.content[0].type).toBe('text');
          texts[format] = result.content[0].text;
        }
        expect(texts.csv).toBe('sample,day,label,count,missing\n2026-07-27T00:30:00.123Z,2026-07-27T00:00:00.000Z,"say ""hi"",\nnext",42,');
        const rows = [['2026-07-27T00:30:00.123Z', '2026-07-27T00:00:00.000Z', 'say "hi",\nnext', '42', null]];
        expect(JSON.parse(texts.json).rows).toEqual(rows);
        expect(JSON.parse(texts.summary).sampleRows).toEqual(rows);
      } finally {
        await stopChild(child);
      }
    }, 20_000);
  }
});
