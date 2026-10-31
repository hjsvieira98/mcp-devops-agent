#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from './config.js';
import { SERVER_NAME } from './constants.js';
import { startHttpServer } from './http.js';
import { createRuntimeServer } from './runtime.js';
import { readVersion } from './version.js';

const USAGE = `Usage: devops-mcp [--http]

Default transport is stdio, which Claude Desktop and Cursor launch as a child process.
--http serves Streamable HTTP on 127.0.0.1:$MCP_HTTP_PORT (default 3333) at /mcp.

Environment:
  GITHUB_TOKEN          Personal access token. Required for GitHub calls.
  GITHUB_REPOS          Comma-separated owner/repo watchlist.
  GITHUB_API_BASE_URL   Optional API origin. Defaults to https://api.github.com.
  MCP_HTTP_PORT         Port for --http.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.error(USAGE);
    return;
  }
  if (args.some((arg) => arg !== '--http')) {
    console.error('Unknown argument. Run with --help.');
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(process.env);
  if (!config.githubToken) {
    console.error(
      `${SERVER_NAME}: GITHUB_TOKEN is not set. The server will start, and GitHub tools will return an error until you set it.`,
    );
  }

  if (args.includes('--http')) {
    const handle = await startHttpServer({
      port: config.httpPort,
      createServer: () => createRuntimeServer(),
    });
    console.error(
      `${SERVER_NAME} ${readVersion()} listening on http://127.0.0.1:${handle.port}/mcp`,
    );
    const shutdown = (): void => {
      void handle.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  console.error(`${SERVER_NAME} ${readVersion()} listening on stdio`);
  const handle = serveStdio(() => createRuntimeServer());
  const shutdown = (): void => {
    void handle.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
