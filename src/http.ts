import { createServer, type Server } from 'node:http';

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';

import { SERVER_NAME } from './constants.js';

export type HttpServerHandle = {
  port: number;
  close: () => Promise<void>;
};

export async function startHttpServer(options: {
  port: number;
  createServer: () => McpServer;
}): Promise<HttpServerHandle> {
  const handler = createMcpHandler(() => options.createServer());
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const httpServer: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (request.method === 'GET' && path === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, name: SERVER_NAME }));
      return;
    }
    if (path !== '/mcp') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    void nodeHandler(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, '127.0.0.1', () => resolve());
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    port,
    async close() {
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
