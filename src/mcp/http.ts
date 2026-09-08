/**
 * Streamable HTTP transport: same server as the stdio mode, but behind a URL.
 * POST /mcp (JSON-RPC), GET /mcp (SSE stream), DELETE /mcp (end a session) and
 * GET /health. Each initialisation creates a session identified by the
 * `mcp-session-id` header.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { config } from '../config.js';
import { logger, errorMessage } from '../logger.js';
import { openStore, type SummaryStore } from '../summarizer/storage.js';
import { createMcpServer } from './server.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SWEEP_INTERVAL_MS = 60_000;

/**
 * An active session. `lastActivity` drives expiry: an MCP client is not required
 * to send a DELETE, so without a sweep sessions would leak.
 */
interface McpSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

function sendError(
  response: http.ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const block = chunk as Buffer;
    size += block.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`Request body too large (limit ${MAX_BODY_BYTES} bytes).`);
    }
    chunks.push(block);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  return JSON.parse(text);
}

/** Constant-time comparison, so the token does not leak through timing. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Checks the Authorization header when `MCP_TOKEN` is set. */
function isUnauthorized(request: http.IncomingMessage): boolean {
  const expected = config.mcp.token;
  if (expected === undefined) return false;

  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return true;

  return !tokenMatches(header.slice('Bearer '.length).trim(), expected);
}

/** Starts the server and resolves once it is listening. */
export async function startHttpServer(): Promise<http.Server> {
  const store: SummaryStore = openStore();
  const sessions = new Map<string, McpSession>();

  const httpServer = http.createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

        // Health probe: outside authentication, carries no sensitive data.
        if (url.pathname === '/health' && request.method === 'GET') {
          const stats = store.stats();
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({
              status: 'ok',
              server: config.mcp.name,
              version: config.mcp.version,
              summaryCount: stats.summaryCount,
              lastDate: stats.lastDate,
              activeSessions: sessions.size,
            }),
          );
          return;
        }

        if (url.pathname !== config.mcp.http.path) {
          sendError(
            response,
            404,
            -32601,
            `Unknown path: ${url.pathname}. MCP endpoint: ${config.mcp.http.path}`,
          );
          return;
        }

        if (isUnauthorized(request)) {
          logger.warn(
            `Request refused (missing or invalid token) from ${request.socket.remoteAddress ?? 'unknown'}.`,
          );
          response.setHeader('WWW-Authenticate', 'Bearer');
          sendError(response, 401, -32001, 'Missing or invalid token (Authorization: Bearer header).');
          return;
        }

        const rawSessionId = request.headers['mcp-session-id'];
        const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

        if (request.method === 'GET' || request.method === 'DELETE') {
          const session = sessionId === undefined ? undefined : sessions.get(sessionId);
          if (session === undefined) {
            sendError(response, 400, -32000, 'Missing mcp-session-id header or unknown session.');
            return;
          }
          session.lastActivity = Date.now();
          await session.transport.handleRequest(request, response);
          return;
        }

        if (request.method !== 'POST') {
          sendError(response, 405, -32601, `Method ${request.method ?? '?'} is not supported.`);
          return;
        }

        let body: unknown;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          sendError(response, 400, -32700, `Invalid JSON body: ${errorMessage(error)}`);
          return;
        }

        const existing = sessionId === undefined ? undefined : sessions.get(sessionId);
        if (existing !== undefined) {
          existing.lastActivity = Date.now();
          await existing.transport.handleRequest(request, response, body);
          return;
        }

        if (!isInitializeRequest(body)) {
          sendError(
            response,
            400,
            -32000,
            sessionId === undefined
              ? 'No session: the first request must be an MCP initialisation.'
              : `Unknown or expired session: ${sessionId}. Reconnect to start a new one.`,
          );
          return;
        }

        const mcpServer = createMcpServer(store);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, {
              server: mcpServer,
              transport,
              lastActivity: Date.now(),
            });
            logger.info(`MCP session opened: ${newSessionId} (${sessions.size} active).`);
          },
          onsessionclosed: (closedSessionId) => {
            sessions.delete(closedSessionId);
            logger.info(`MCP session closed: ${closedSessionId} (${sessions.size} remaining).`);
          },
        });

        // Safety net if the transport dies without onsessionclosed.
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id !== undefined && sessions.delete(id)) {
            logger.debug(`MCP session removed after transport close: ${id}.`);
          }
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(request, response, body);
      } catch (error) {
        logger.error(`HTTP handling error: ${errorMessage(error)}`);
        sendError(response, 500, -32603, `Internal error: ${errorMessage(error)}`);
      }
    })();
  });

  // Idle-session expiry; `unref()` does not keep the process alive.
  const sweep = setInterval(
    () => {
      const cutoff = Date.now() - config.mcp.http.sessionTtlMs;

      for (const [id, session] of sessions) {
        if (session.lastActivity > cutoff) continue;

        const idleMinutes = Math.round((Date.now() - session.lastActivity) / 60000);
        logger.info(`MCP session ${id} expired after ${idleMinutes} min idle.`);
        sessions.delete(id);
        void session.transport.close().catch((error: unknown) => {
          logger.debug(`Closing session ${id}: ${errorMessage(error)}`);
        });
      }
      // At least two sweeps per TTL: a session never outlives 1.5 x TTL.
    },
    Math.min(MAX_SWEEP_INTERVAL_MS, Math.max(config.mcp.http.sessionTtlMs / 2, 1000)),
  );
  sweep.unref();
  httpServer.on('close', () => clearInterval(sweep));

  const { host, port, path: endpointPath } = config.mcp.http;

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const stats = store.stats();
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  logger.success(
    `MCP server "${config.mcp.name}" v${config.mcp.version} listening on ` +
      `http://${displayHost}:${port}${endpointPath} (${stats.summaryCount} summary/ies stored).`,
  );

  const onLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!onLoopback && config.mcp.token === undefined) {
    logger.warn(
      `Listening on ${host} without authentication: anyone who can reach it can read your ` +
        'summaries. Set MCP_TOKEN to require a Bearer header.',
    );
  }

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}: shutting down the HTTP server.`);
    httpServer.close(() => {
      void Promise.allSettled([...sessions.values()].map((session) => session.transport.close()))
        .then(() => {
          sessions.clear();
          store.close();
          process.exit(0);
        });
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return httpServer;
}
