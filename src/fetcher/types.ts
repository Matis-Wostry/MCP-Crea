/**
 * Shared interfaces for the collectors. Each source normalises its responses
 * into a `FeedItem`, so the summarisation step only knows one shape.
 */

export type FeedSource = 'github-trending' | 'github-release' | 'devto';

/** Human-readable labels, used in the prompt sent to Claude. */
export const SOURCE_LABELS: Record<FeedSource, string> = {
  'github-trending': 'GitHub - trending repositories',
  'github-release': 'GitHub - new releases',
  devto: 'Dev.to - popular articles',
};

/** Engagement metrics, all optional since they depend on the source. */
export interface ItemMetrics {
  stars?: number;
  forks?: number;
  reactions?: number;
  comments?: number;
  readingMinutes?: number;
  language?: string;
  version?: string;
}

/** Normalised item, the unit handled throughout the pipeline. */
export interface FeedItem {
  /** Stable identifier, used for deduplication. */
  id: string;
  source: FeedSource;
  title: string;
  url: string;
  description: string;
  /** Publication date in ISO 8601 format. */
  publishedAt: string;
  author?: string;
  tags: string[];
  metrics: ItemMetrics;
}

/** Non-blocking failure encountered while collecting from one source. */
export interface SourceError {
  source: string;
  message: string;
}

/** Outcome of a collection run: the items gathered and the partial failures. */
export interface FetchResult {
  items: FeedItem[];
  errors: SourceError[];
}

/** Truncates a text, appending an ellipsis. */
export function truncate(text: string | null | undefined, maxLength = 320): string {
  if (text === null || text === undefined) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Counts items per source, for the statistics stored alongside a summary. */
export function countBySource(items: FeedItem[]): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const item of items) {
    counters[item.source] = (counters[item.source] ?? 0) + 1;
  }
  return counters;
}
