#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_MAX_STEPS } from '../constants.js';
import { buildSystemPrompt } from './system-prompt.js';
import { runAgent } from './loop.js';
import {
  callMcpTool,
  connectStdioServer,
  readWatchlist,
  serverEnvironment,
  toolFromMcp,
} from './mcp.js';
import { createModelFromEnv, ModelRequestError } from './providers.js';
import type { ToolCall } from './types.js';

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  confirm: (call: ToolCall) => Promise<boolean>;
  isTTY: boolean;
};

export type ParsedArgs = {
  help: boolean;
  yes: boolean;
  maxSteps: number;
  task: string;
  serverEntry: string | null;
};

const USAGE = `Usage: devops-agent [options] "<task>"

Runs a tool-calling loop against the local devops-mcp server.

Options:
  --max-steps <n>   Tool executions before the agent must answer. Default ${DEFAULT_MAX_STEPS}. Max 30.
  --yes             Allow write tools such as create_issue without a confirmation prompt.
  --server <path>   MCP server entry file. Defaults to the built server next to this CLI.
  --help            Show this help.

Environment:
  LLM_PROVIDER=anthropic|openai     Optional when only one API key is set.
  LLM_MODEL                         Overrides the provider default.
  ANTHROPIC_API_KEY or OPENAI_API_KEY
  GITHUB_TOKEN and GITHUB_REPOS     Forwarded to the MCP server. Model keys are not.

Write tools require confirmation. A non-interactive shell denies them unless you pass --yes.
`;

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let maxSteps = DEFAULT_MAX_STEPS;
  let yes = false;
  let help = false;
  let serverEntry: string | null = null;
  const task: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--yes') {
      yes = true;
    } else if (arg === '--max-steps') {
      const value = argv[index + 1];
      index += 1;
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed < 1 || parsed > 30) {
        throw new Error('--max-steps must be an integer from 1 to 30.');
      }
      maxSteps = parsed;
    } else if (arg === '--server') {
      const value = argv[index + 1];
      index += 1;
      if (!value || value.startsWith('--')) throw new Error('--server requires a path.');
      serverEntry = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}.`);
    } else {
      task.push(arg);
    }
  }

  return { help, yes, maxSteps, task: task.join(' ').trim(), serverEntry };
}

export function defaultServerLaunch(serverEntry: string | null): {
  command: string;
  args: string[];
} {
  const entry = serverEntry ?? defaultServerPath();
  if (entry.endsWith('.ts')) {
    return { command: process.execPath, args: ['--import', 'tsx', entry] };
  }
  return { command: process.execPath, args: [entry] };
}

function defaultServerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (here.endsWith(`${path.sep}src${path.sep}agent`)) {
    return path.resolve(here, '../index.ts');
  }
  return path.resolve(here, '../index.js');
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr(USAGE);
    return 1;
  }
  if (parsed.help) {
    io.stderr(USAGE);
    return 0;
  }
  if (!parsed.task) {
    io.stderr(USAGE);
    return 1;
  }

  let model;
  try {
    model = createModelFromEnv(env);
  } catch (error) {
    io.stderr(error instanceof ModelRequestError ? error.message : String(error));
    return 1;
  }

  const launch = defaultServerLaunch(parsed.serverEntry);
  io.stderr(
    `devops-agent  provider=${model.provider} model=${model.model}  maxSteps=${parsed.maxSteps}`,
  );
  const session = await connectStdioServer({
    command: launch.command,
    args: launch.args,
    env: serverEnvironment(env),
  });

  try {
    const repositories = await readWatchlist(session.client);
    io.stderr(
      repositories.length > 0
        ? `watched: ${repositories.map((repository) => `${repository.owner}/${repository.repo}`).join(', ')}`
        : 'watched: (none — GITHUB_REPOS is empty)',
    );
    const listed = await session.client.listTools();
    const tools = listed.tools.map((tool) => toolFromMcp(tool));
    const result = await runAgent({
      model,
      tools,
      system: buildSystemPrompt(repositories),
      task: parsed.task,
      maxSteps: parsed.maxSteps,
      execute: (call) => callMcpTool(session.client, call),
      confirmWrite: async (call) => {
        if (parsed.yes) return true;
        if (!io.isTTY) {
          io.stderr(
            `Refusing write tool ${call.name} because stdin is not a terminal. Re-run with --yes to allow it.`,
          );
          return false;
        }
        return io.confirm(call);
      },
      onEvent: (event) => {
        if (event.type === 'tool_start') {
          io.stderr(`→ ${event.call.name} ${JSON.stringify(event.call.arguments)}`);
        } else if (event.type === 'tool_declined') {
          io.stderr(`× ${event.call.name} declined`);
        } else if (event.type === 'tool_end') {
          io.stderr(`← ${event.call.name} ${event.isError ? 'error' : 'ok'}`);
        }
      },
    });
    const text =
      result.text.trim() ||
      (result.stoppedReason === 'max_steps'
        ? `Stopped after ${result.steps} tool calls without a final answer.`
        : 'The model returned an empty answer.');
    io.stdout(text);
    if (result.stoppedReason === 'max_steps') {
      io.stderr(`Stopped because the tool-call budget of ${parsed.maxSteps} was reached.`);
    }
    return 0;
  } finally {
    await session.close();
  }
}

function defaultIo(): CliIo {
  return {
    isTTY: Boolean(process.stdin.isTTY),
    stdout: (text) => {
      process.stdout.write(`${text}\n`);
    },
    stderr: (text) => {
      process.stderr.write(`${text}\n`);
    },
    confirm: async (call) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question(
          `About to call ${call.name} with ${JSON.stringify(call.arguments, null, 2)}\nProceed? [y/N] `,
        );
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
  };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectRun()) {
  runCli(process.argv.slice(2), defaultIo(), process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
