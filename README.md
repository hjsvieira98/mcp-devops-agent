# mcp-devops-agent

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives an AI assistant a small, typed set of GitHub tools, and a command-line agent that calls those tools in a loop.

This is a portfolio project by [Humberto Vieira](https://github.com/hjsvieira98), a senior React and TypeScript developer moving into AI engineering. The interesting part is not a chat wrapper. It is the boundary between a model and a side effect: schema-validated tools, a protocol a host can launch, a step budget, and a confirmation gate in front of writes. The same server runs inside Claude Desktop, Cursor, or the CLI agent. The agent never imports the GitHub client. It only speaks MCP.

Nothing here is deployed, and the repository does not claim usage numbers. Tests and evals run against an in-memory GitHub and a scripted model, so they do not need API keys or a GitHub App private key.

## What it does

Ask a host, or the CLI, things like:

- Give me a morning standup summary of my repos.
- Which open pull requests have a failing check?
- Summarize pull request 17 in `acme/web`.
- Open an issue on `acme/web` titled "Investigate checkout CI".

Reads run immediately. Creating an issue is a write: the CLI asks before it calls GitHub, and it refuses the write in a non-interactive shell unless you pass `--yes`. Claude Desktop and Cursor have their own approval UI. The server marks `create_issue` with `readOnlyHint: false` so a host can tell the difference.

## Architecture

```mermaid
flowchart LR
  subgraph hosts [Hosts]
    Claude[Claude Desktop]
    Cursor[Cursor]
  end

  subgraph cli [devops-agent]
    Model[Anthropic or OpenAI adapter]
    Loop[Tool-calling loop]
    Guard[Step budget and write confirmation]
  end

  subgraph mcp [devops-mcp]
    Protocol[MCP server]
    Tools[Tools, resources, prompts]
    GitHubClient[GitHub REST client]
  end

  API[(GitHub REST API)]

  Claude -->|stdio| Protocol
  Cursor -->|stdio or local HTTP| Protocol
  Model --> Loop --> Guard
  Guard -->|MCP client over stdio| Protocol
  Protocol --> Tools --> GitHubClient --> API
```

The CLI reads `devops://watchlist` before the first model turn and puts those repositories in the system prompt. Hosts that already surface MCP resources can read the same URI themselves. Prompts are templates the host fills in. They are not tools, and the model does not have to call them.

`summarize_pull_request` does not call a language model. It returns a bounded digest of the pull request and the diff. The host model writes the prose. That keeps the tool deterministic, testable, and free of a second hidden prompt.

## Tools, resources, and prompts

| Name                           | Kind              | Effect                                                                                                                                                                                                       |
| ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_open_pull_requests`      | Tool, read        | Open pull requests plus a CI rollup. Failure wins over pending, which wins over success. No checks at all is `unknown`, not a pass. One page per call. Pass `nextCursor` back as `cursor` for the next page. |
| `summarize_pull_request`       | Tool, read        | Title, author, branches, truncated description, and truncated patches.                                                                                                                                       |
| `list_issues`                  | Tool, read        | Issues only. GitHub's issues API also returns pull requests; those are filtered out of each page, so a page can be shorter than the limit. Pass `nextCursor` back as `cursor` for the next page.             |
| `get_repo_activity`            | Tool, read        | Commits, updated issues, and updated pull requests. Defaults to the last 24 hours.                                                                                                                           |
| `create_issue`                 | Tool, write       | Opens an issue. Not idempotent: calling it twice creates two issues.                                                                                                                                         |
| `devops://watchlist`           | Resource          | JSON list of `owner` / `repo` pairs from `GITHUB_REPOS`.                                                                                                                                                     |
| `github://repo/{owner}/{repo}` | Resource template | Description, default branch, visibility, and open-issue count. Watched repos are also listed.                                                                                                                |
| `morning_standup`              | Prompt            | Tells the model to read the watchlist, then activity and open pull requests, and to write a standup from those results only.                                                                                 |
| `pr_review_brief`              | Prompt            | Tells the model to brief one pull request from `summarize_pull_request`.                                                                                                                                     |

Every tool argument is a Zod schema. The MCP SDK turns that schema into the JSON Schema the model sees and rejects a bad call before the handler runs. GitHub responses are parsed with Zod as well, so a shape the client does not understand becomes an error instead of a silent `undefined`. Tool failures are returned as `isError: true` with a message the model can read. Credentials are not tool arguments. A personal access token, an installation token, the App JWT, and the private key are stripped from error text if an upstream body echoes them.

`list_open_pull_requests` and `list_issues` return one page. Pass the `nextCursor` from that result back as `cursor`, with the same owner, repository, state, and limit, to read the next page. Each page holds at most 30 items. The default is 10. Following cursors stops at 100 items. Only whole pages are returned, so the total never exceeds 100. When GitHub still has more rows, `nextCursor` is null and the result says the cap was reached. The cursor is opaque. Zod checks its shape and signature, and rejects a malformed or edited cursor before any GitHub call. A cursor is only valid for the server process that issued it. Do not invent one. `get_repo_activity`, commits, and diff files stay on the first page. Diff text defaults to 8,000 characters and cannot exceed 20,000. That is a context-window limit, not a claim that the digest is a full review.

## Requirements

- Node.js 20 or newer. CI uses Node 22.
- GitHub credentials only when you call the real API. See [GitHub credentials](#github-credentials). Tests and local evals do not need them.
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` only for the CLI agent. Claude Desktop and Cursor use their own model.

This project does not load a `.env` file. [`.env.example`](.env.example) is a checklist. Export the variables in your shell, or put them in the host's MCP config. The host config is the better place for the credential, because the server process receives it and the chat does not.

## GitHub credentials

The server accepts a GitHub App installation or a personal access token. It reads them from its own environment. Tool arguments never include a token, a private key, or an installation id.

### GitHub App

When the App variables are complete, the server signs a short-lived RS256 JWT with the App's private key and exchanges it at `POST /app/installations/{installation_id}/access_tokens`. GitHub installation tokens expire after one hour. This server caches the token and requests a new one when a minute or less remains. The private key, the JWT, and the installation token stay in the server process.

| Variable                      | Value                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`               | The App's numeric id.                                                                                                                 |
| `GITHUB_APP_INSTALLATION_ID`  | The installation id. After you install the App, it is the number at the end of the installation settings URL.                         |
| `GITHUB_APP_PRIVATE_KEY`      | The App's PEM private key. In an environment variable, replace real newlines with `\n`.                                               |
| `GITHUB_APP_PRIVATE_KEY_PATH` | A path to that PEM file, instead of inlining it. Use an absolute path in a desktop host config. The server reads the file at startup. |

Set the key or the path, not both. If any App variable is set and another required piece is missing, or both key forms are set, the process exits at startup. It does not fall back to `GITHUB_TOKEN`. A half-configured App is a mistake, not a signal to use the personal access token.

If the App variables and `GITHUB_TOKEN` are both fully set, the App wins. API calls use the installation token.

Create a GitHub App, generate a private key, and install the App on the account that owns the repositories. The server does not look up an installation id. You set `GITHUB_APP_INSTALLATION_ID`. Do not commit the PEM.

Repository permissions on the installation:

| Permission      | Access         | Why                                                                                                                  |
| --------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Metadata        | Read           | Repository snapshot. GitHub grants this with every App.                                                              |
| Contents        | Read           | Commits in `get_repo_activity`.                                                                                      |
| Issues          | Read and write | Listing issues, and `create_issue`. Read is enough if you will not create issues.                                    |
| Pull requests   | Read           | Open pull requests and the diff digest.                                                                              |
| Commit statuses | Read           | The combined status in the CI rollup.                                                                                |
| Checks          | Read           | Check runs. If this is missing, the pull-request tool still returns commit statuses and says check runs were denied. |

The installation has to include the repositories in `GITHUB_REPOS`.

### Personal access token

If none of the App variables are set, the server uses `GITHUB_TOKEN`, as before. Classic tokens need `repo` for private repositories. Fine-grained tokens need read access to metadata, pull requests, issues, and commit statuses, plus permission to read checks for check-run details. Creating issues needs write access to issues. An empty `GITHUB_TOKEN` does not prevent the process from starting: GitHub tools return an error until you set a credential.

## Setup from a fresh clone

```bash
git clone https://github.com/hjsvieira98/mcp-devops-agent.git
cd mcp-devops-agent
npm install
npm test
npm run eval
npm run lint
npm run build
```

`npm test` and `npm run eval` do not call GitHub or a model provider.

Run the server over stdio. It waits for a host. Logs go to stderr, because stdout is the JSON-RPC stream.

```bash
export GITHUB_APP_ID="123456"
export GITHUB_APP_INSTALLATION_ID="7890123"
export GITHUB_APP_PRIVATE_KEY_PATH="/absolute/path/github-app.pem"
export GITHUB_REPOS="owner/repo,owner/other"
node dist/index.js
```

A personal access token still works when none of the App variables are set:

```bash
export GITHUB_TOKEN="github_pat_..."
export GITHUB_REPOS="owner/repo,owner/other"
node dist/index.js
```

During development you can skip the build:

```bash
npm run dev
```

Optional local HTTP, bound to `127.0.0.1` only. The SDK's localhost Host and Origin checks sit in front of the handler. `GET /health` is a plain liveness check. The MCP endpoint is `POST /mcp`.

```bash
npm run dev:http
# devops-mcp listening on http://127.0.0.1:3333/mcp
```

`MCP_HTTP_PORT` changes the port. Prefer stdio for a desktop host. Use HTTP when a client attaches to a URL you already started. Do not expose this process beyond your machine: it holds your GitHub credential and it does not authenticate callers.

The MCP Inspector can list and call the tools without a chat host:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Set the GitHub credential (`GITHUB_TOKEN`, or the App variables) and `GITHUB_REPOS` in that shell first.

## Claude Desktop

Claude Desktop launches the server as a child process. Merge this into the config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Use the absolute path to `dist/index.js` from the clone. Restart Claude Desktop after saving.

```json
{
  "mcpServers": {
    "devops-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/mcp-devops-agent/dist/index.js"],
      "env": {
        "GITHUB_APP_ID": "123456",
        "GITHUB_APP_INSTALLATION_ID": "7890123",
        "GITHUB_APP_PRIVATE_KEY_PATH": "/ABSOLUTE/PATH/github-app.pem",
        "GITHUB_REPOS": "owner/repo,owner/other"
      }
    }
  }
}
```

To use a personal access token instead, omit every `GITHUB_APP_*` variable and set `GITHUB_TOKEN`. If any App variable is present, the rest of the App configuration is required.

In the chat, you can ask for a standup or attach the `morning_standup` prompt if the client lists prompts. The server instructions tell the model that `create_issue` writes to GitHub and that it should not ask you to paste a token or a private key.

## Cursor

Project config (`.cursor/mcp.json`) or user config (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "devops-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/mcp-devops-agent/dist/index.js"],
      "env": {
        "GITHUB_APP_ID": "123456",
        "GITHUB_APP_INSTALLATION_ID": "7890123",
        "GITHUB_APP_PRIVATE_KEY_PATH": "/ABSOLUTE/PATH/github-app.pem",
        "GITHUB_REPOS": "owner/repo,owner/other"
      }
    }
  }
}
```

The same rule as Claude Desktop applies: a personal access token works when you set `GITHUB_TOKEN` and no App variable. An incomplete App configuration is a startup error, not a fallback.

If the server is already running with `--http`, Cursor can attach by URL instead of launching a process:

```json
{
  "mcpServers": {
    "devops-mcp": {
      "url": "http://127.0.0.1:3333/mcp"
    }
  }
}
```

The credential still lives in the server process, not in Cursor's chat.

## CLI agent

The agent is a separate program. It spawns the MCP server, lists tools, and runs a loop: ask the model, call the tools it requested, append the results, repeat. When the model stops requesting tools, that text is the answer.

```bash
export GITHUB_APP_ID="123456"
export GITHUB_APP_INSTALLATION_ID="7890123"
export GITHUB_APP_PRIVATE_KEY_PATH="/absolute/path/github-app.pem"
export GITHUB_REPOS="owner/repo,owner/other"
export ANTHROPIC_API_KEY="sk-ant-..."
# optional: LLM_PROVIDER=openai and OPENAI_API_KEY instead
# optional: LLM_MODEL=claude-sonnet-5-5 or gpt-5.4
npm run agent -- "Give me a morning standup summary of my repos"
```

`LLM_PROVIDER` is optional when only one key is set. The default models are `claude-sonnet-5-5` and `gpt-5.4`. Override them with `LLM_MODEL` when you want a different snapshot. The adapters talk to the providers over HTTP. They do not depend on the provider SDKs, and they do not send sampling parameters such as `temperature`.

Model keys are not copied into the server's environment. The child receives `PATH` and the GitHub variables only, including the App id, installation id, and private key when those are set. A personal access token is forwarded too, and the server uses it only when no App variable is set.

```bash
npm run agent -- --max-steps 4 "Which pull requests are failing CI?"
npm run agent -- --yes "Open an issue on owner/repo titled \"Investigate flaky login\""
```

`--max-steps` is the number of tool executions allowed, from 1 to 30, default 8. A declined write counts, so a model cannot spend the budget retrying a confirmation you refused. After the budget is spent, the model gets one more turn with the tools removed and has to answer from what it already collected.

Without `--yes`, a terminal prompts on stderr:

```text
About to call create_issue with {
  "owner": "owner",
  "repo": "repo",
  "title": "Investigate flaky login"
}
Proceed? [y/N]
```

A pipe or CI job is not a terminal. The write is denied unless `--yes` is present. Progress is printed to stderr. The final answer is printed to stdout.

After `npm run build`, the same CLI is `node dist/agent/cli.js`. `npm run agent` uses `tsx` and spawns `src/index.ts`, so the build is optional for local runs and required for the host config above.

### Example session

This transcript uses the fixture repositories from the eval suite (`acme/web` and `acme/api`). It shows the CLI's real progress format. The standup paragraph is an illustration of the answer the system prompt asks for, written from those fixture facts. It is not a recording of a live model, and it is not a log from a real GitHub account.

```text
$ npm run agent -- "Give me a morning standup summary of my repos."
devops-agent  provider=anthropic model=claude-sonnet-5-5  maxSteps=8
watched: acme/web, acme/api
→ get_repo_activity {"owner":"acme","repo":"web"}
← get_repo_activity ok
→ list_open_pull_requests {"owner":"acme","repo":"web"}
← list_open_pull_requests ok
→ get_repo_activity {"owner":"acme","repo":"api"}
← get_repo_activity ok
→ list_open_pull_requests {"owner":"acme","repo":"api"}
← list_open_pull_requests ok

Since yesterday on acme/web, ada committed "Add health check".
Pull request #17, "Reduce checkout latency", is open and its CI rollup is failure
(the build status and the unit check both failed).
acme/api has no commits in the window. Pull request #8, "Document auth", is open
and its build status is success.
Next: look at the failing build on #17 before reviewing the checkout change.
```

A matching eval, `morning-standup`, drives the real server and the real loop with a scripted model. It asserts those four tool calls, asserts `create_issue` was not executed, and asserts the final text contains facts that were present only in the tool results (`Reduce checkout latency`, `failure`, `Document auth`, `Add health check`). That checks the wiring. It does not score a live model.

## Tests and evals

```bash
npm test          # Vitest. GitHub fetch, the App token exchange, and both model APIs are mocked.
npm run eval      # Prints PASS/FAIL for each agent scenario.
npm run typecheck
npm run lint
npm run format:check
```

GitHub Actions runs lint, format, typecheck, tests, evals, and the production build on pull requests.

The eval scenarios live in [`src/evals/scenarios.ts`](src/evals/scenarios.ts):

| Scenario                 | What it locks in                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `morning-standup`        | Activity and open pull requests for each watched repo, and no writes.                                                             |
| `pr-digest`              | `summarize_pull_request` for a named pull request, and the filename comes back from the tool.                                     |
| `create-issue-declined`  | Confirmation denied. The GitHub client never sees `createIssue`.                                                                  |
| `create-issue-confirmed` | Confirmation allowed. The created issue number is `#101` from the fixture.                                                        |
| `step-budget`            | `maxSteps: 2` stops a model that would keep calling `list_issues`.                                                                |
| `paginate-issues`        | The second `list_issues` call passes the cursor from the first page. The answer includes an issue that was only on the next page. |

The scripted model is a replay, not a judge. Its final sentence is built from the tool text it was given, so a broken loop that drops tool results fails the scenario. Replacing that replay with a live model, or adding a model-graded rubric, is future work and would need keys.

## Design decisions

**One server, three hosts.** Tools are registered in `createDevOpsServer`. Stdio (`serveStdio`) and Streamable HTTP (`createMcpHandler`) are thin entries around that factory. The official MCP TypeScript SDK v2 (`@modelcontextprotocol/server` and `@modelcontextprotocol/client`) implements the 2026-07-28 revision and, by default, still serves 2025-era clients. Desktop hosts that spawn a local process speak stdio, so that is the path the config samples use.

**The agent is an MCP client.** It cannot call `GitHubRestClient` directly. A change to a tool is visible to Claude Desktop, Cursor, and the CLI together. The cost is an extra process and a JSON-RPC hop, which is the point of the protocol.

**Validation on the way in and on the way out.** Zod schemas on tool inputs stop a bad `owner` before any HTTP call. Zod schemas on GitHub JSON stop a partial payload from becoming a pull request with a missing SHA. The handler then returns `structuredContent` that the SDK checks against the tool's `outputSchema`.

**CI is two GitHub APIs.** Commit statuses and check runs are different systems. The rollup merges them and prefers failure over pending over success. A cancelled, timed-out, or action-required check counts as failure. A skipped or neutral check does not. If the credential cannot read check runs, the tool reports the denial and still returns statuses, instead of failing the whole call.

**Writes are gated in the client, not by blocking on stdin inside the server.** The server's stdin is the protocol stream. A confirmation prompt there would corrupt JSON-RPC. The CLI asks the user. Hosts do the equivalent with their own permission UI, using `readOnlyHint`. A tool with no hint is treated as a write. The safe default is to ask.

**Bounded pages and patches.** `list_open_pull_requests` and `list_issues` return one page and a `nextCursor` when another page exists. The cursor is opaque. Zod checks its shape and signature, and rejects a cursor that was edited or that this process did not issue. Each page holds at most 30 items. Following cursors stops at 100 items, and only whole pages are returned, so a caller cannot walk a busy repository without bound. The server does not follow every `Link` header on its own. A standup uses the first page unless the caller asks for more. Activity, commits, and diff files stay on the first page. The digest says when a patch or a file list was cut short, and the prompts tell the model to pass that on.

**Credentials stay in the process that needs them.** The server reads either GitHub App credentials or `GITHUB_TOKEN`. The agent forwards those GitHub variables to the child and drops `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. Tool arguments have no token, private key, or installation id, so the model is not asked to repeat one.

**A GitHub App installation token, with a personal access token as fallback.** When `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and a private key are all set, the server signs an RS256 JWT and exchanges it for an installation access token. The token is cached and replaced when a minute or less remains. That App configuration wins even if `GITHUB_TOKEN` is also set. If any App variable is set and the configuration is incomplete, the process exits at startup instead of silently using the personal access token. With no App variables, `GITHUB_TOKEN` works as before.

**Evals that can fail in CI.** A scenario file that nobody runs does not constrain the loop. `npm run eval` executes the scenarios in-process over `InMemoryTransport`, with `MemoryGitHub` behind the same tool handlers the stdio server uses.

## Project layout

```text
src/index.ts            stdio by default, --http for Streamable HTTP
src/server/             tool, resource, and prompt registration
src/github/             REST client, App installation tokens, errors, and the in-memory client
src/agent/              loop, guardrails, provider adapters, CLI
src/evals/              scenarios and the runner behind npm run eval
tests/                  Vitest
```

## Roadmap

These are not started. They are the next pieces this design leaves room for.

- Reviewers, review state, and a bounded slice of workflow logs for a failed check.
- MCP OAuth on the HTTP entry, so a shared server does not rely on a token in the environment. The local stdio path would stay as it is.
- Live-model evals with a frozen fixture set, kept separate from the deterministic tool-call checks above.

## License

[MIT](LICENSE) © 2026 Humberto Vieira
