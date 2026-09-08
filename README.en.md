# dev-stack-watcher-mcp

*[Version française](README.md)*

Automated tech watch: every day the project collects **GitHub** and **Dev.to** activity,
asks **Claude** to turn it into a markdown digest, stores it in **SQLite** (one summary per
day) and exposes it through an **MCP** server.

The code is in English; **the generated digests are in French**, since that is the
deliverable meant to be read.

> **School project** — CREA, 2nd year, AI module · Author: Matis Wostry

---

## Architecture

```
STAGE 1 — Collect           STAGE 2 — Summarise + store        STAGE 3 — Expose
┌────────────────────┐      ┌──────────────────────────┐       ┌──────────────────┐
│ GitHub API         │      │ Claude API               │       │ MCP server       │
│  trending repos    │──┐   │  → structured markdown   │   ┌──▶│                  │
│  releases (7 d)    │  ├──▶├──────────────────────────┤───┤   │ summaries://list │
├────────────────────┤  │   │ SQLite                   │   │   │ summary://{date} │
│ Dev.to API         │──┘   │  1 summary / day (UNIQUE)│   └──▶│ 3 MCP tools      │
│  articles of today │      │  automatic migrations    │       └──────────────────┘
└────────────────────┘      └──────────────────────────┘
```

**Deduplication** — the `summary_date` column carries a `UNIQUE` constraint, and the check
runs *before* the Claude call: running twice on the same day spends no tokens.

---

## Requirements

- **Node.js ≥ 20** (tested on 22.12)
- An **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com/settings/keys)
- A **GitHub token** (optional, but raises the limit from 60 to 5000 requests/hour)

## Installation

```bash
npm install
cp .env.example .env      # then fill in ANTHROPIC_API_KEY
npm run build             # optional during development
```

The SQLite store and its tables are created automatically on first run.

---

## Configuration

Everything goes through the `.env` file (see `.env.example` for the full list).

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Required** to generate a summary |
| `CLAUDE_MODEL` | `claude-opus-5` | Model used for summarisation |
| `GITHUB_TOKEN` | — | Scope-less token; lifts the 60 req/h limit |
| `GITHUB_LOOKBACK_DAYS` | `7` | Window for trending repositories and releases |
| `DEVTO_ARTICLE_LIMIT` | `15` | Number of articles collected |
| `DB_PATH` | `./data/watch.db` | SQLite file location |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |

> Every log line goes to `stderr`: `stdout` is reserved for the MCP server's JSON-RPC
> protocol, and a single stray line would break the connection.

---

## Usage

### Generate today's summary

```bash
npm run fetch
```

```
INFO  Collecting data (GitHub + Dev.to)...
INFO  Dev.to: 15 article(s) collected.
INFO  GitHub: 26 item(s) collected, 0 error(s).
INFO  Generating summary with claude-opus-5 (41 item(s), effort high).
OK    Summary for 2026-09-08 stored (id 1, 41 item(s)).
```

Options (after `--` with npm):

```bash
npm run fetch -- --skip-summary      # collection only, no Claude call
npm run fetch -- --force             # regenerate and replace today's summary
npm run fetch -- --date=2026-09-01   # target another date
```

### Read the summaries

```bash
npm run list                         # catalogue of stored summaries
npm run show                         # print the most recent one
npm run show -- 2026-09-08           # print a specific date
```

### Start the MCP server

```bash
npm run mcp        # stdio: Claude spawns the process itself
npm run mcp:http   # HTTP:  http://127.0.0.1:3000/mcp
```

In stdio mode the server waits silently: that is expected, it is driven by the client.

---

## Connecting an MCP client

The server exposes **two resources** and **three tools**.

| Resource | Content |
|---|---|
| `summaries://list` | JSON catalogue: date, title, model, item count |
| `summary://{date}` | Markdown summary for one day (`YYYY-MM-DD`) |

| Tool | Parameters |
|---|---|
| `list_summaries` | `limit` (1–200, default 30) |
| `get_summary` | `date` (`YYYY-MM-DD`, required) |
| `latest_summary` | — |

The tools let Claude query the store in natural language: "show me the digest for
September 8th", "what shipped on the Next.js side?".

**Claude Desktop** — in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dev-stack-watcher": {
      "command": "node",
      "args": ["D:/CREA/2eAnnee/IA/dev-stack-watcher-mcp/dist/cli.js", "mcp"]
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add dev-stack-watcher -- node <absolute-path>/dist/cli.js mcp
```

Run `npm run build` first, then restart the client.

---

## Project structure

```
src/
├── fetcher/
│   ├── github.ts      Trending repositories + releases from the last 7 days
│   ├── devto.ts       Popular articles of the day
│   └── types.ts       FeedItem and shared helpers
├── summarizer/
│   ├── claude.ts      Prompt, API call, network retries
│   └── storage.ts     SQLite: migrations, deduplication, reads and writes
├── mcp/
│   ├── server.ts      MCP server: resources, tools, stdio transport
│   └── http.ts        HTTP transport (sessions, /health probe)
├── config.ts          Centralised configuration (.env)
├── logger.ts          Logging to stderr
├── cli.ts             Command-line interface
└── index.ts           runWatch() pipeline + public API
```

`Dockerfile` and `docker-compose.yml` allow running the project in a container.
