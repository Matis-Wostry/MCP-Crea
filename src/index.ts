/**
 * Orchestrates the three stages (collect, summarise, store) and re-exports the
 * project's public API.
 */
import { today, isValidDate, assertClaudeConfigured } from "./config.js";
import { logger } from "./logger.js";
import { fetchGitHub } from "./fetcher/github.js";
import { fetchDevTo } from "./fetcher/devto.js";
import {
  countBySource,
  type FeedItem,
  type SourceError,
} from "./fetcher/types.js";
import { generateSummary } from "./summarizer/claude.js";
import { SummaryStore, openStore, type Summary } from "./summarizer/storage.js";

/** Options for a pipeline run. */
export interface WatchOptions {
  date?: string;
  force?: boolean;
  skipSummary?: boolean;
  store?: SummaryStore;
}

export type WatchStatus = "created" | "existing" | "fetch-only" | "no-data";

/** Report of a pipeline run. */
export interface WatchReport {
  status: WatchStatus;
  date: string;
  items: FeedItem[];
  bySource: Record<string, number>;
  errors: SourceError[];
  summary: Summary | null;
}

/**
 * Stage 1: queries GitHub and Dev.to in parallel, drops duplicates and sorts
 * newest first.
 */
export async function collectItems(): Promise<{
  items: FeedItem[];
  errors: SourceError[];
}> {
  logger.info("Collecting data (GitHub + Dev.to)...");

  const [github, devto] = await Promise.all([fetchGitHub(), fetchDevTo()]);

  const seen = new Set<string>();
  const items: FeedItem[] = [];

  for (const item of [...github.items, ...devto.items]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }

  items.sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );

  return { items, errors: [...github.errors, ...devto.errors] };
}

/**
 * Full pipeline. Deduplication by date happens before the Claude call: if a
 * summary already exists for the day, no token is spent.
 */
export async function runWatch(
  options: WatchOptions = {},
): Promise<WatchReport> {
  const date = options.date ?? today();

  if (!isValidDate(date)) {
    throw new Error(`Invalid date: "${date}". Expected format: YYYY-MM-DD.`);
  }

  const storeProvided = options.store !== undefined;
  const store = options.store ?? openStore();

  try {
    if (!(options.force ?? false) && store.hasSummary(date)) {
      const existing = store.getSummary(date);
      logger.info(
        `A summary already exists for ${date}: skipping (use --force to regenerate).`,
      );
      return {
        status: "existing",
        date,
        items: existing === null ? [] : store.getItems(existing.id),
        bySource: existing?.sources ?? {},
        errors: [],
        summary: existing,
      };
    }

    // No point burning the GitHub quota if summarisation will fail anyway.
    if (!(options.skipSummary ?? false)) {
      assertClaudeConfigured();
    }

    const { items, errors } = await collectItems();
    const bySource = countBySource(items);

    logger.info(
      `Collection finished: ${items.length} item(s) total ` +
        `(${Object.entries(bySource)
          .map(([source, count]) => `${source}: ${count}`)
          .join(", ")}).`,
    );

    if (options.skipSummary ?? false) {
      logger.info(
        "Fetch-only mode: no Claude call, nothing written to the store.",
      );
      return {
        status: "fetch-only",
        date,
        items,
        bySource,
        errors,
        summary: null,
      };
    }

    if (items.length === 0) {
      logger.error(
        "No data collected: the summary cannot be generated. See the errors above.",
      );
      return {
        status: "no-data",
        date,
        items,
        bySource,
        errors,
        summary: null,
      };
    }

    const generated = await generateSummary(items, date);
    const summary = store.saveSummary(
      {
        date,
        title: generated.structuredData.title,
        structuredData: generated.structuredData,
        model: generated.model,
        items,
      },
      options.force ?? false,
    );

    return { status: "created", date, items, bySource, errors, summary };
  } finally {
    if (!storeProvided) store.close();
  }
}

export {
  config,
  today,
  isValidDate,
  daysAgo,
  assertClaudeConfigured,
} from "./config.js";
export { logger, errorMessage } from "./logger.js";
export * from "./fetcher/types.js";
export {
  fetchGitHub,
  fetchTrendingRepos,
  fetchRecentReleases,
} from "./fetcher/github.js";
export { fetchDevTo } from "./fetcher/devto.js";
export {
  generateSummary,
  buildCorpus,
  type GeneratedSummary,
} from "./summarizer/claude.js";
export {
  SummaryStore,
  openStore,
  type SummaryMeta,
  type Summary,
  type NewSummary,
} from "./summarizer/storage.js";
