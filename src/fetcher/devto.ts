/**
 * Dev.to collector: the most popular articles of the day. The `top=N` parameter
 * returns the most-reacted articles of the last N days.
 */
import axios, { type AxiosInstance } from 'axios';
import { config } from '../config.js';
import { logger, errorMessage } from '../logger.js';
import { type FeedItem, type SourceError, type FetchResult, truncate } from './types.js';

/** Relevant fields of a Dev.to article. */
interface DevToArticle {
  id: number;
  title: string;
  description: string | null;
  url: string;
  published_at: string | null;
  published_timestamp: string | null;
  tag_list: string[] | string;
  positive_reactions_count: number;
  comments_count: number;
  reading_time_minutes: number | null;
  user: { name: string | null; username: string } | null;
}

function createClient(): AxiosInstance {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.forem.api-v1+json',
    'User-Agent': 'dev-stack-watcher-mcp',
  };

  if (config.devto.apiKey !== undefined) {
    headers['api-key'] = config.devto.apiKey;
  }

  return axios.create({
    baseURL: 'https://dev.to/api',
    timeout: config.httpTimeout,
    headers,
  });
}

/** `tag_list` comes back sometimes as an array, sometimes as a string. */
function normalizeTags(tags: string[] | string | null | undefined): string[] {
  if (Array.isArray(tags)) return tags.filter((tag) => tag.trim() !== '');
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');
  }
  return [];
}

function describeError(error: unknown): SourceError {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;

    if (status === 429) {
      return { source: 'devto', message: 'Dev.to rate limit reached (429). Try again later.' };
    }

    if (status === 401) {
      return { source: 'devto', message: 'DEVTO_API_KEY is invalid (401).' };
    }

    return { source: 'devto', message: `HTTP error ${status ?? 'network'}: ${error.message}` };
  }

  return { source: 'devto', message: errorMessage(error) };
}

/** Never throws: failures are returned in `errors`. */
export async function fetchDevTo(): Promise<FetchResult> {
  const client = createClient();

  try {
    logger.debug(
      `Dev.to: fetching the ${config.devto.articleLimit} most popular articles ` +
        `over ${config.devto.topDays} day(s).`,
    );

    const response = await client.get<DevToArticle[]>('/articles', {
      params: {
        top: config.devto.topDays,
        per_page: config.devto.articleLimit,
      },
    });

    const articles = response.data ?? [];

    const items: FeedItem[] = articles.map((article) => {
      const publishedAt =
        article.published_at ?? article.published_timestamp ?? new Date().toISOString();
      const author = article.user?.name ?? article.user?.username;

      return {
        id: `devto:${article.id}`,
        source: 'devto' as const,
        title: article.title,
        url: article.url,
        description: truncate(article.description ?? 'No summary provided.'),
        publishedAt,
        ...(author !== undefined && author !== null ? { author } : {}),
        tags: normalizeTags(article.tag_list).slice(0, 8),
        metrics: {
          reactions: article.positive_reactions_count,
          comments: article.comments_count,
          ...(article.reading_time_minutes !== null
            ? { readingMinutes: article.reading_time_minutes }
            : {}),
        },
      };
    });

    logger.info(`Dev.to: ${items.length} article(s) collected.`);
    return { items, errors: [] };
  } catch (error) {
    const described = describeError(error);
    logger.warn(`Dev.to collection failed: ${described.message}`);
    return { items: [], errors: [described] };
  }
}
