#!/usr/bin/env node
/**
 * Command-line interface.
 *
 * Commands:
 *   fetch [--date=YYYY-MM-DD] [--force] [--skip-summary]  collect + summarise + store
 *   list  [--limit=N]                                     list stored summaries
 *   show  <date>                                          print a summary as JSON
 *   delete <date>                                         delete a summary
 *   mcp                                                   start the MCP server (stdio)
 *   mcp-http                                              start the MCP server (HTTP)
 *   help                                                  print this help
 *
 * Only `show` writes to stdout; everything else goes through the logger (stderr).
 */
import { config, today, isValidDate, ConfigurationError } from "./config.js";
import { logger, errorMessage } from "./logger.js";
import { runWatch } from "./index.js";
import { openStore } from "./summarizer/storage.js";
import { startStdioServer } from "./mcp/server.js";
import { startHttpServer } from "./mcp/http.js";

interface CliArgs {
  command: string;
  positional: string[];
  options: Map<string, string>;
  flags: Set<string>;
}

/** Parses `process.argv`: command, positional args, `--key=value` and `--flag`. */
function parseArgs(argv: string[]): CliArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();

  for (const argument of rest) {
    if (argument.startsWith("--")) {
      const content = argument.slice(2);
      const separator = content.indexOf("=");

      if (separator === -1) {
        flags.add(content);
      } else {
        options.set(content.slice(0, separator), content.slice(separator + 1));
      }
    } else {
      positional.push(argument);
    }
  }

  return { command, positional, options, flags };
}

function printHelp(): void {
  const help = `
dev-stack-watcher-mcp - GitHub + Dev.to tech watch, summarised by Claude, exposed over MCP.

USAGE
  npm run fetch                          Collect, summarise and store today's digest
  npm run mcp                            Start the MCP server on stdio
  npm run mcp:http                       Start the MCP server on http://127.0.0.1:3000/mcp
  npm run list                           List the available summaries
  npm run show -- 2026-09-08             Print one summary as JSON

  npx tsx src/cli.ts <command> [options]

COMMANDS
  fetch       Collect GitHub + Dev.to, generate the summary through Claude, store it in SQLite.
              --date=YYYY-MM-DD   Summary date (default: today).
              --force             Regenerate and replace an existing summary.
              --skip-summary      Stop after collection (no Claude call, nothing stored).

  list        List stored summaries, newest first.
              --limit=N           Maximum number of rows (default: 30).

  show        Print a summary's structured JSON on standard output.
              show <date>         Date in YYYY-MM-DD format (default: the most recent).

  delete      Delete the summary for a given date.
              delete <date>       Date in YYYY-MM-DD format.

  mcp         Start the MCP server (stdio transport): Claude spawns the process itself.

  mcp-http    Start the MCP server (Streamable HTTP transport): Claude connects by URL.
              Configurable through MCP_PORT, MCP_HOST, MCP_PATH and MCP_TOKEN.

  help        Print this message.

CONFIGURATION
  .env file (see .env.example).
  SQLite store : ${config.dbPath}
  MCP endpoint : http://${config.mcp.http.host}:${config.mcp.http.port}${config.mcp.http.path} (token ${config.mcp.token === undefined ? "disabled" : "required"})
`;
  process.stderr.write(`${help.trim()}\n`);
}

async function runFetchCommand(args: CliArgs): Promise<void> {
  const date = args.options.get("date") ?? today();
  const force = args.flags.has("force");
  const skipSummary = args.flags.has("skip-summary");

  const report = await runWatch({ date, force, skipSummary });

  for (const error of report.errors) {
    logger.warn(`Source partially failed [${error.source}]: ${error.message}`);
  }

  switch (report.status) {
    case "created":
      logger.success(
        `Summary for ${report.date} created and stored. Read it with: npm run show -- ${report.date}`,
      );
      break;
    case "existing":
      logger.info(
        `Summary for ${report.date} already exists (deduplication). Re-run with --force to regenerate.`,
      );
      break;
    case "fetch-only":
      logger.success(
        `Collection finished: ${report.items.length} item(s), no summary generated.`,
      );
      for (const item of report.items.slice(0, 10)) {
        logger.info(`  [${item.source}] ${item.title} - ${item.url}`);
      }
      if (report.items.length > 10) {
        logger.info(`  ... and ${report.items.length - 10} more item(s).`);
      }
      break;
    case "no-data":
      logger.error(
        "No data collected: check network connectivity and GITHUB_TOKEN.",
      );
      process.exitCode = 1;
      break;
  }
}

function runListCommand(args: CliArgs): void {
  const limit = Number.parseInt(args.options.get("limit") ?? "30", 10);
  const store = openStore();

  try {
    const summaries = store.listSummaries(Number.isNaN(limit) ? 30 : limit);

    if (summaries.length === 0) {
      logger.info(
        "No summary stored. Run `npm run fetch` to generate today's digest.",
      );
      return;
    }

    logger.info(`${summaries.length} summary/ies available:`);
    for (const summary of summaries) {
      const sourceBreakdown = Object.entries(summary.sources)
        .map(([source, count]) => `${source}=${count}`)
        .join(" ");
      logger.info(
        `  ${summary.date}  ${String(summary.itemCount).padStart(3)} items  ` +
          `${summary.model.padEnd(18)}  ${sourceBreakdown}`,
      );
    }
  } finally {
    store.close();
  }
}

function runShowCommand(args: CliArgs): void {
  const store = openStore();

  try {
    const requestedDate = args.positional[0] ?? args.options.get("date");

    if (requestedDate === undefined) {
      const latest = store.getLatestSummary();
      if (latest === null) {
        logger.error("No summary stored.");
        process.exitCode = 1;
        return;
      }
      logger.info(`Most recent summary: ${latest.date}`);
      process.stdout.write(
        `${JSON.stringify(latest.structuredData, null, 2)}\n`,
      );
      return;
    }

    if (!isValidDate(requestedDate)) {
      logger.error(`Invalid date: "${requestedDate}". Expected YYYY-MM-DD.`);
      process.exitCode = 1;
      return;
    }

    const summary = store.getSummary(requestedDate);
    if (summary === null) {
      const available = store.listSummaries(10).map((entry) => entry.date);
      logger.error(
        `No summary for ${requestedDate}. Available dates: ` +
          `${available.length > 0 ? available.join(", ") : "none"}.`,
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `${JSON.stringify(summary.structuredData, null, 2)}\n`,
    );
  } finally {
    store.close();
  }
}

function runDeleteCommand(args: CliArgs): void {
  const date = args.positional[0] ?? args.options.get("date");

  if (date === undefined || !isValidDate(date)) {
    logger.error("Usage: delete <YYYY-MM-DD>");
    process.exitCode = 1;
    return;
  }

  const store = openStore();
  try {
    if (store.deleteSummary(date)) {
      logger.success(`Summary for ${date} deleted.`);
    } else {
      logger.warn(`No summary to delete for ${date}.`);
    }
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "fetch":
      await runFetchCommand(args);
      break;

    case "list":
      runListCommand(args);
      break;

    case "show":
      runShowCommand(args);
      break;

    case "delete":
      runDeleteCommand(args);
      break;

    case "mcp":
      await startStdioServer();
      break;

    case "mcp-http":
      await startHttpServer();
      break;

    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;

    default:
      logger.error(`Unknown command: "${args.command}".`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    logger.error(`Incomplete configuration: ${error.message}`);
  } else {
    logger.error(`Command failed: ${errorMessage(error)}`);
    if (process.env.LOG_LEVEL === "debug" && error instanceof Error) {
      logger.debug(error.stack ?? "(no stack trace)");
    }
  }
  process.exitCode = 1;
});
