/**
 * GitHub collector: trending repositories (`/search/repositories`) and new
 * releases from the watched repositories (`/repos/{owner}/{repo}/releases`).
 */
import axios, { type AxiosInstance } from 'axios';
import { config, daysAgo } from '../config.js';
import { logger, errorMessage } from '../logger.js';
import { type FeedItem, type SourceError, type FetchResult, truncate } from './types.js';

/** Relevant fields of a GitHub repository. */
interface GitHubRepo {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  created_at: string;
  pushed_at: string;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  topics?: string[];
  owner: { login: string } | null;
}

/** Relevant fields of a GitHub release. */
interface GitHubRelease {
  id: number;
  name: string | null;
  tag_name: string;
  html_url: string;
  body: string | null;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  author: { login: string } | null;
}

function createClient(): AxiosInstance {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dev-stack-watcher-mcp',
  };

  if (config.github.token !== undefined) {
    headers.Authorization = `Bearer ${config.github.token}`;
  }

  return axios.create({
    baseURL: 'https://api.github.com',
    timeout: config.httpTimeout,
    headers,
  });
}

/** Turns an axios error into an actionable message. */
function describeError(context: string, error: unknown): SourceError {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const remaining = error.response?.headers?.['x-ratelimit-remaining'];

    if ((status === 403 || status === 429) && remaining === '0') {
      return {
        source: context,
        message:
          'GitHub rate limit exhausted. Set GITHUB_TOKEN in your .env file to go from 60 to 5000 requests/hour.',
      };
    }

    if (status === 401) {
      return { source: context, message: 'GITHUB_TOKEN is invalid or expired (401).' };
    }

    if (status === 404) {
      return {
        source: context,
        message: 'GitHub resource not found (404): check GITHUB_WATCHED_REPOS.',
      };
    }

    return { source: context, message: `HTTP error ${status ?? 'network'}: ${error.message}` };
  }

  return { source: context, message: errorMessage(error) };
}

/**
 * Most-starred repositories created within the configured window. GitHub does
 * not expose its /trending page as an API, so this is the closest equivalent.
 */
export async function fetchTrendingRepos(
  client: AxiosInstance = createClient(),
): Promise<FeedItem[]> {
  const since = daysAgo(config.github.lookbackDays);
  const query = config.github.customQuery ?? `created:>=${since}`;

  logger.debug(`GitHub: searching repositories with query "${query}"`);

  const response = await client.get<{ items: GitHubRepo[]; total_count: number }>(
    '/search/repositories',
    {
      params: {
        q: query,
        sort: 'stars',
        order: 'desc',
        per_page: config.github.trendingLimit,
      },
    },
  );

  const repos = response.data.items ?? [];
  logger.debug(`GitHub: ${repos.length} trending repository/ies fetched.`);

  return repos.map((repo) => ({
    id: `github-trending:${repo.full_name}`,
    source: 'github-trending' as const,
    title: repo.full_name,
    url: repo.html_url,
    description: truncate(repo.description ?? 'No description provided.'),
    publishedAt: repo.created_at,
    author: repo.owner?.login,
    tags: (repo.topics ?? []).slice(0, 8),
    metrics: {
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      ...(repo.language !== null ? { language: repo.language } : {}),
    },
  }));
}

/**
 * Releases published within the configured window. Repositories are queried in
 * parallel: one failure does not prevent the others from being returned.
 */
export async function fetchRecentReleases(
  client: AxiosInstance = createClient(),
): Promise<FetchResult> {
  const cutoff = Date.now() - config.github.lookbackDays * 24 * 60 * 60 * 1000;
  const items: FeedItem[] = [];
  const errors: SourceError[] = [];

  const results = await Promise.allSettled(
    config.github.watchedRepos.map(async (repo) => {
      const response = await client.get<GitHubRelease[]>(`/repos/${repo}/releases`, {
        params: { per_page: config.github.releasesPerRepo },
      });
      return { repo, releases: response.data ?? [] };
    }),
  );

  results.forEach((result, index) => {
    const repo = config.github.watchedRepos[index] ?? 'unknown-repo';

    if (result.status === 'rejected') {
      errors.push(describeError(`github:releases:${repo}`, result.reason));
      return;
    }

    for (const release of result.value.releases) {
      if (release.draft || release.prerelease) continue;
      if (release.published_at === null) continue;
      if (new Date(release.published_at).getTime() < cutoff) continue;

      const versionName =
        release.name !== null && release.name.trim() !== '' ? release.name : release.tag_name;
      const organisation = repo.split('/')[0] ?? '';

      items.push({
        id: `github-release:${repo}@${release.tag_name}`,
        source: 'github-release',
        title: `${repo} ${versionName}`,
        url: release.html_url,
        description: truncate(release.body ?? 'No release notes provided.', 500),
        publishedAt: release.published_at,
        author: release.author?.login ?? organisation,
        tags: organisation !== '' ? [organisation] : [],
        metrics: { version: release.tag_name },
      });
    }
  });

  items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  logger.debug(`GitHub: ${items.length} recent release(s) found.`);
  return { items, errors };
}

/**
 * Aggregates trending repositories and releases. Never throws: partial failures
 * are returned in `errors`.
 */
export async function fetchGitHub(): Promise<FetchResult> {
  const client = createClient();
  const items: FeedItem[] = [];
  const errors: SourceError[] = [];

  if (config.github.token === undefined) {
    logger.warn(
      'GITHUB_TOKEN is missing: rate limit capped at 60 requests/hour. Collection may partially fail.',
    );
  }

  try {
    items.push(...(await fetchTrendingRepos(client)));
  } catch (error) {
    const described = describeError('github:trending', error);
    logger.warn(`GitHub collection (trending) failed: ${described.message}`);
    errors.push(described);
  }

  try {
    const result = await fetchRecentReleases(client);
    items.push(...result.items);
    errors.push(...result.errors);
    for (const error of result.errors) {
      logger.warn(`GitHub collection (${error.source}): ${error.message}`);
    }
  } catch (error) {
    const described = describeError('github:releases', error);
    logger.warn(`GitHub collection (releases) failed: ${described.message}`);
    errors.push(described);
  }

  logger.info(`GitHub: ${items.length} item(s) collected, ${errors.length} error(s).`);
  return { items, errors };
}
