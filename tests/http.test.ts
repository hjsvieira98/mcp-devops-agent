import { request as httpRequest } from 'node:http';

import { describe, expect, it } from 'vitest';

import { createDevOpsServer } from '../src/server/create-server.js';
import { MemoryGitHub } from '../src/github/memory.js';
import { startHttpServer } from '../src/http.js';

describe('streamable HTTP entry', () => {
  it('serves health on loopback and rejects a foreign Host before MCP', async () => {
    const handle = await startHttpServer({
      port: 0,
      createServer: () =>
        createDevOpsServer({
          github: new MemoryGitHub({ repositories: {} }),
          repositories: [],
          version: '0.0.0-test',
        }),
    });
    try {
      const health = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({ ok: true, name: 'devops-mcp' });

      const missing = await fetch(`http://127.0.0.1:${handle.port}/nope`);
      expect(missing.status).toBe(404);

      const forbidden = await rawRequest(handle.port, {
        method: 'POST',
        path: '/mcp',
        host: 'evil.example',
      });
      expect(forbidden.status).toBe(403);
    } finally {
      await handle.close();
    }
  });
});

function rawRequest(
  port: number,
  options: { method: string; path: string; host: string },
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        method: options.method,
        path: options.path,
        headers: { host: options.host },
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
