/**
 * MCP server exposed over stdio.
 *
 * Resources: `summaries://list` (JSON catalogue) and `summary://{date}` (markdown).
 * Tools:     `list_summaries`, `get_summary`, `latest_summary`.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { config, isValidDate } from '../config.js';
import { logger, errorMessage } from '../logger.js';
import { openStore, type SummaryStore } from '../summarizer/storage.js';

const SUMMARY_PREFIX = 'summary://';
const LIST_URI = 'summaries://list';

/** Extracts the date from a `summary://YYYY-MM-DD` URI. */
function dateFromUri(uri: string): string | null {
  if (!uri.startsWith(SUMMARY_PREFIX)) return null;
  const date = decodeURIComponent(uri.slice(SUMMARY_PREFIX.length)).replace(/\/+$/, '');
  return date === '' ? null : date;
}

function buildCatalog(store: SummaryStore): string {
  const stats = store.stats();
  const summaries = store.listSummaries(200);

  return JSON.stringify(
    {
      server: config.mcp.name,
      summaryCount: stats.summaryCount,
      firstDate: stats.firstDate,
      lastDate: stats.lastDate,
      summaries: summaries.map((summary) => ({
        date: summary.date,
        title: summary.title,
        uri: `${SUMMARY_PREFIX}${summary.date}`,
        model: summary.model,
        itemCount: summary.itemCount,
        sources: summary.sources,
        createdAt: summary.createdAt,
      })),
    },
    null,
    2,
  );
}

function toolResponse(text: string, isError = false): {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
} {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

/** Creates the server and registers its request handlers. */
export function createMcpServer(store: SummaryStore): Server {
  const server = new Server(
    { name: config.mcp.name, version: config.mcp.version },
    { capabilities: { resources: {}, tools: {} } },
  );

  // --- Resources ------------------------------------------------------------

  // Catalogue plus one resource per date, so clients can browse without a tool.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const summaries = store.listSummaries(200);

    return {
      resources: [
        {
          uri: LIST_URI,
          name: 'Watch summary catalogue',
          description:
            'JSON catalogue of every available summary: date, title, model, item count and read URI.',
          mimeType: 'application/json',
        },
        ...summaries.map((summary) => ({
          uri: `${SUMMARY_PREFIX}${summary.date}`,
          name: `Watch summary for ${summary.date}`,
          description: `${summary.title} (${summary.itemCount} item(s), model ${summary.model})`,
          mimeType: 'text/markdown',
        })),
      ],
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: `${SUMMARY_PREFIX}{date}`,
        name: 'Watch summary by date',
        description: 'Markdown body of one day\'s summary. `date` in YYYY-MM-DD format.',
        mimeType: 'text/markdown',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    if (uri === LIST_URI) {
      return { contents: [{ uri, mimeType: 'application/json', text: buildCatalog(store) }] };
    }

    const date = dateFromUri(uri);
    if (date === null) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unrecognised URI: "${uri}". Accepted forms: "${LIST_URI}" or "${SUMMARY_PREFIX}YYYY-MM-DD".`,
      );
    }

    if (!isValidDate(date)) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid date: "${date}". Expected YYYY-MM-DD.`);
    }

    const summary = store.getSummary(date);
    if (summary === null) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No summary available for ${date}. See "${LIST_URI}" for the existing dates.`,
      );
    }

    return { contents: [{ uri, mimeType: 'text/markdown', text: summary.markdown }] };
  });

  // --- Tools ----------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_summaries',
        description:
          'Lists the watch summaries available in the store, newest first (metadata only).',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              description: 'Maximum number of summaries to return (1 to 200).',
              minimum: 1,
              maximum: 200,
              default: 30,
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: 'get_summary',
        description: 'Returns the full markdown watch summary for a given date.',
        inputSchema: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'Summary date in YYYY-MM-DD format.',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            },
          },
          required: ['date'],
          additionalProperties: false,
        },
      },
      {
        name: 'latest_summary',
        description: 'Returns the most recent watch summary available in the store.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'list_summaries': {
          const rawLimit = Number((args as { limit?: unknown })?.limit ?? 30);
          const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 30;
          const summaries = store.listSummaries(limit);

          if (summaries.length === 0) {
            return toolResponse(
              'No summary in the store. Run `npm run fetch` to generate today\'s digest.',
            );
          }

          return toolResponse(JSON.stringify(summaries, null, 2));
        }

        case 'get_summary': {
          const date = String((args as { date?: unknown })?.date ?? '');

          if (!isValidDate(date)) {
            return toolResponse(`Invalid date: "${date}". Expected YYYY-MM-DD.`, true);
          }

          const summary = store.getSummary(date);
          if (summary === null) {
            const available = store.listSummaries(10).map((entry) => entry.date);
            return toolResponse(
              `No summary for ${date}. Available dates: ` +
                `${available.length > 0 ? available.join(', ') : 'none'}.`,
              true,
            );
          }

          return toolResponse(summary.markdown);
        }

        case 'latest_summary': {
          const summary = store.getLatestSummary();
          if (summary === null) {
            return toolResponse(
              'No summary in the store. Run `npm run fetch` to generate today\'s digest.',
              true,
            );
          }
          return toolResponse(summary.markdown);
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: "${name}".`);
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      logger.error(`Error while calling tool "${name}": ${errorMessage(error)}`);
      return toolResponse(`Internal error: ${errorMessage(error)}`, true);
    }
  });

  return server;
}

/** Starts the server on stdio and blocks until the transport closes. */
export async function startStdioServer(): Promise<void> {
  const store = openStore();
  const server = createMcpServer(store);
  const transport = new StdioServerTransport();

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}: shutting down the MCP server.`);
    void server.close().finally(() => {
      store.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(transport);

  const stats = store.stats();
  logger.success(
    `MCP server "${config.mcp.name}" v${config.mcp.version} started on stdio ` +
      `(${stats.summaryCount} summary/ies stored, file ${config.dbPath}).`,
  );
}

// Direct execution of this file.
const entryPath = process.argv[1];
if (entryPath !== undefined) {
  const currentModule = path.resolve(fileURLToPath(import.meta.url));
  const entryModule = path.resolve(fileURLToPath(pathToFileURL(entryPath).href));

  if (currentModule === entryModule) {
    startStdioServer().catch((error: unknown) => {
      logger.error(`Could not start the MCP server: ${errorMessage(error)}`);
      process.exit(1);
    });
  }
}
