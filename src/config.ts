/**
 * Centralised configuration. Every value comes from environment variables
 * (.env locally, container variables in Docker): no API key is hard-coded.
 */
import path from 'node:path';
import dotenv from 'dotenv';

// `quiet` keeps dotenv off stdout, which is reserved for the MCP protocol.
dotenv.config({ quiet: true });

function readString(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : fallback;
}

function readOptionalString(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

function readInt(name: string, fallback: number, min = 1, max = 1000): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase().trim());
}

function readList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const DEFAULT_REPOSITORIES = [
  'microsoft/TypeScript',
  'nodejs/node',
  'facebook/react',
  'vercel/next.js',
  'vitejs/vite',
  'oven-sh/bun',
  'denoland/deno',
  'sveltejs/svelte',
  'tailwindlabs/tailwindcss',
  'anthropics/anthropic-sdk-typescript',
  'modelcontextprotocol/servers',
];

export const config = {
  dbPath: path.resolve(readString('DB_PATH', './data/watch.db')),

  anthropic: {
    apiKey: readOptionalString('ANTHROPIC_API_KEY'),
    model: readString('CLAUDE_MODEL', 'claude-opus-5'),
    /** Used when Claude declines the request. */
    fallbackModel: readString('CLAUDE_FALLBACK_MODEL', 'claude-opus-4-8'),
    maxTokens: readInt('CLAUDE_MAX_TOKENS', 16000, 1024, 64000),
    /** Reasoning depth: low | medium | high | xhigh | max. */
    effort: readString('CLAUDE_EFFORT', 'high'),
    enableFallback: readBool('CLAUDE_ENABLE_FALLBACK', true),
    retries: readInt('CLAUDE_RETRIES', 3, 1, 10),
  },

  github: {
    /** Optional: 60 requests/hour without a token, 5000 with one. */
    token: readOptionalString('GITHUB_TOKEN'),
    watchedRepos: readList('GITHUB_WATCHED_REPOS', DEFAULT_REPOSITORIES),
    trendingLimit: readInt('GITHUB_TRENDING_LIMIT', 15, 1, 100),
    releasesPerRepo: readInt('GITHUB_RELEASES_PER_REPO', 3, 1, 20),
    lookbackDays: readInt('GITHUB_LOOKBACK_DAYS', 7, 1, 90),
    customQuery: readOptionalString('GITHUB_TRENDING_QUERY'),
  },

  devto: {
    apiKey: readOptionalString('DEVTO_API_KEY'),
    articleLimit: readInt('DEVTO_ARTICLE_LIMIT', 15, 1, 100),
    topDays: readInt('DEVTO_TOP_DAYS', 1, 1, 30),
  },

  /** Cap on items sent to Claude, to keep cost and context under control. */
  maxItemsPerSummary: readInt('MAX_ITEMS_PER_SUMMARY', 80, 5, 300),
  httpTimeout: readInt('HTTP_TIMEOUT_MS', 20000, 1000, 120000),

  mcp: {
    name: readString('MCP_NAME', 'dev-stack-watcher'),
    version: readString('MCP_VERSION', '1.0.0'),

    http: {
      port: readInt('MCP_PORT', 3000, 1, 65535),
      host: readString('MCP_HOST', '127.0.0.1'),
      path: readString('MCP_PATH', '/mcp'),
      /** MCP clients do not always signal disconnection, so sessions expire. */
      sessionTtlMs: readInt('MCP_SESSION_TTL_MIN', 30, 1, 1440) * 60_000,
    },

    token: readOptionalString('MCP_TOKEN'),
  },
} as const;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/** Checks the API key is present before any call to Claude. */
export function assertClaudeConfigured(): void {
  if (config.anthropic.apiKey === undefined) {
    throw new ConfigurationError(
      'ANTHROPIC_API_KEY is missing. Copy .env.example to .env and fill in your key ' +
        '(https://console.anthropic.com/settings/keys).',
    );
  }
}

/** Today's date as `YYYY-MM-DD` (UTC, to stay deterministic). */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Checks a string is a real `YYYY-MM-DD` date. */
export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The date `days` days ago, as `YYYY-MM-DD`. */
export function daysAgo(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}
