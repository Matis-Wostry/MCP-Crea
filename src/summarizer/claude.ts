/**
 * Summary generation through the Claude API. The model receives the collected
 * items grouped by source and returns a structured JSON digest.
 *
 * The prompt is written in French on purpose: the generated digest is the
 * project's deliverable and is meant to be read in French.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod.js";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod.js";
import { z } from "zod";
import { config, assertClaudeConfigured } from "../config.js";
import { logger, errorMessage } from "../logger.js";
import {
  SOURCE_LABELS,
  type FeedItem,
  type FeedSource,
} from "../fetcher/types.js";

const githubTrendingSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  language: z.string().optional(),
  stars: z.number().optional(),
  summary: z.string(),
});

const githubReleaseSchema = z.object({
  repository: z.string(),
  version: z.string(),
  url: z.string().url(),
  summary: z.string(),
});

const devtoArticleSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  author: z.string(),
  summary: z.string(),
});

export const structuredSummarySchema = z.object({
  title: z.string(),
  highlights: z.array(z.string()),
  githubTrending: z.array(githubTrendingSchema),
  githubReleases: z.array(githubReleaseSchema),
  devtoArticles: z.array(devtoArticleSchema),
  trends: z.array(z.string()),
  watch: z.array(z.string()),
});

export type StructuredSummary = z.infer<typeof structuredSummarySchema>;

/** Result of the summarisation, ready to be stored. */
export interface GeneratedSummary {
  structuredData: StructuredSummary;
  model: string;
}

/** Summarisation instructions, stable across runs so the prompt stays cached. */
const SYSTEM_PROMPT = `Tu es un analyste de veille technologique pour une equipe de developpeurs francophones.

On te fournit une liste brute d'elements collectes le jour meme sur GitHub et Dev.to.
Tu produis une synthese quotidienne en francais.

REGLES ABSOLUES :
- N'invente jamais un fait, un chiffre, une version ou un lien. Utilise uniquement les donnees fournies.
- Utilise les URLs exactes fournies dans le corpus.
- Ecris les textes en francais, avec un ton professionnel et direct.
Si une source n'a aucun element, indique-le dans la categorie correspondante.`;

function createClient(): Anthropic {
  assertClaudeConfigured();
  return new Anthropic({
    apiKey: config.anthropic.apiKey,
    maxRetries: 0, // Retries are handled explicitly by `withRetries`.
  });
}

function formatMetrics(item: FeedItem): string {
  const parts: string[] = [];
  const { metrics } = item;

  if (metrics.stars !== undefined) parts.push(`${metrics.stars} stars`);
  if (metrics.forks !== undefined) parts.push(`${metrics.forks} forks`);
  if (metrics.language !== undefined)
    parts.push(`language ${metrics.language}`);
  if (metrics.version !== undefined) parts.push(`version ${metrics.version}`);
  if (metrics.reactions !== undefined)
    parts.push(`${metrics.reactions} reactions`);
  if (metrics.comments !== undefined)
    parts.push(`${metrics.comments} comments`);
  if (metrics.readingMinutes !== undefined)
    parts.push(`${metrics.readingMinutes} min read`);

  return parts.length > 0 ? parts.join(", ") : "no metrics";
}

/** Assembles the items into a plain-text corpus grouped by source. */
export function buildCorpus(items: FeedItem[], date: string): string {
  const groups = new Map<FeedSource, FeedItem[]>();
  for (const item of items) {
    const list = groups.get(item.source) ?? [];
    list.push(item);
    groups.set(item.source, list);
  }

  const sections: string[] = [
    `Date de collecte : ${date}`,
    `Nombre total d'elements : ${items.length}`,
    "",
  ];

  for (const source of Object.keys(SOURCE_LABELS) as FeedSource[]) {
    const list = groups.get(source) ?? [];
    sections.push(
      `### SOURCE : ${SOURCE_LABELS[source]} (${list.length} element(s))`,
    );

    if (list.length === 0) {
      sections.push("(aucun element collecte pour cette source)", "");
      continue;
    }

    list.forEach((item, index) => {
      const lines = [
        `${index + 1}. TITRE : ${item.title}`,
        `   URL : ${item.url}`,
        `   AUTEUR : ${item.author ?? "inconnu"}`,
        `   PUBLIE LE : ${item.publishedAt}`,
        `   METRIQUES : ${formatMetrics(item)}`,
        `   TAGS : ${item.tags.length > 0 ? item.tags.join(", ") : "aucun"}`,
        `   DESCRIPTION : ${item.description}`,
      ];
      sections.push(lines.join("\n"));
    });

    sections.push("");
  }

  return sections.join("\n");
}

/** Transient failures: network, rate limit, 5xx. */
function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIError) {
    return error.status !== undefined && error.status >= 500;
  }
  return false;
}

async function withRetries<T>(
  operation: () => Promise<T>,
  attempts: number,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === attempts) break;

      const delay = 2 ** (attempt - 1) * 1500;
      logger.warn(
        `Claude call failed (attempt ${attempt}/${attempts}): ${errorMessage(error)}. ` +
          `Retrying in ${delay} ms.`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Walks the `cause` chain. The SDK wraps any network failure in an
 * `APIConnectionError` with a constant message: the real reason lives in `cause`.
 */
function describeCause(error: unknown): string {
  const reasons: string[] = [];
  let current: unknown = (error as { cause?: unknown })?.cause;

  for (
    let depth = 0;
    current !== undefined && current !== null && depth < 5;
    depth += 1
  ) {
    const node = current as {
      code?: string;
      message?: string;
      cause?: unknown;
    };
    const code = node.code !== undefined ? `${node.code}: ` : "";
    const text = node.message ?? String(current);
    if (text !== "") reasons.push(`${code}${text}`);
    current = node.cause;
  }

  return reasons.length > 0 ? ` Network reason: ${reasons.join(" <- ")}.` : "";
}

function describeClaudeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "ANTHROPIC_API_KEY is invalid or revoked (401). Check the key in your .env file.";
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return "Access denied (403): the key lacks permission for this model.";
  }
  if (error instanceof Anthropic.NotFoundError) {
    return `Model not found (404): check the CLAUDE_MODEL value ("${config.anthropic.model}").`;
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Rate limit reached (429) after several attempts. Try again later.";
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `Invalid request (400): ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return (
      `Timed out while calling the Claude API.${describeCause(error)} ` +
      "Lower MAX_ITEMS_PER_SUMMARY or CLAUDE_EFFORT to shorten the generation."
    );
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return (
      `Could not reach the Claude API after ${config.anthropic.retries} attempt(s).` +
      `${describeCause(error)} ` +
      "Check connectivity to api.anthropic.com (network, firewall, proxy) and retry: " +
      "the collection step will simply run again."
    );
  }
  if (error instanceof Anthropic.APIError) {
    return `API error ${error.status ?? "?"}: ${error.message}`;
  }
  return errorMessage(error);
}

/**
 * Generates the structured digest for a given day.
 *
 * @param items Normalised items produced by the collectors.
 * @param date  Summary date in `YYYY-MM-DD` format.
 */
export async function generateSummary(
  items: FeedItem[],
  date: string,
): Promise<GeneratedSummary> {
  if (items.length === 0) {
    throw new Error("No items collected: summary generation aborted.");
  }

  const client = createClient();

  const selection = items.slice(0, config.maxItemsPerSummary);
  if (selection.length < items.length) {
    logger.warn(
      `${items.length} items collected, only the first ${selection.length} are sent ` +
        "(see MAX_ITEMS_PER_SUMMARY).",
    );
  }

  const corpus = buildCorpus(selection, date);
  const instruction =
    `Voici les elements de veille collectes le ${date}. Produis la synthese en respectant ` +
    `strictement le plan impose et remplace <DATE> par ${date}.\n\n${corpus}`;

  logger.info(
    `Generating summary with ${config.anthropic.model} ` +
      `(${selection.length} item(s), effort ${config.anthropic.effort}).`,
  );

  const baseParams = {
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system: [
      {
        type: "text" as const,
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" as const },
      },
    ],
    output_config: {
      effort: config.anthropic.effort as
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max",
    },
    messages: [{ role: "user" as const, content: instruction }],
  };

  try {
    // Streaming rather than a blocking call: generation runs over a minute, and
    // with no traffic a proxy or undici would drop the connection as idle.
    const response = await withRetries(async () => {
      if (config.anthropic.enableFallback) {
        // If the primary model declines, the API replays on the fallback model.
        const stream = client.beta.messages.stream({
          ...baseParams,
          output_config: {
            ...baseParams.output_config,
            format: betaZodOutputFormat(structuredSummarySchema),
          },
          betas: ["server-side-fallback-2026-06-01"],
          fallbacks: [{ model: config.anthropic.fallbackModel }],
        });
        return await stream.finalMessage();
      }
      const stream = client.messages.stream({
        ...baseParams,
        output_config: {
          ...baseParams.output_config,
          format: zodOutputFormat(structuredSummarySchema),
        },
      });
      return await stream.finalMessage();
    }, config.anthropic.retries);

    if (response.stop_reason === "refusal") {
      throw new Error(
        "Claude refused to process the request (stop_reason: refusal). The collected content " +
          "likely tripped a safety filter. Re-run the collection or lower MAX_ITEMS_PER_SUMMARY.",
      );
    }

    if (response.stop_reason === "max_tokens") {
      logger.warn(
        "Response truncated (max_tokens reached). Raise CLAUDE_MAX_TOKENS.",
      );
    }

    const structuredData =
      "parsed_output" in response ? response.parsed_output : undefined;
    if (structuredData === undefined || structuredData === null) {
      throw new Error("Claude returned no structured output.");
    }

    logger.success(
      `Summary generated (${response.usage.input_tokens} input tokens, ` +
        `${response.usage.output_tokens} output).`,
    );

    return {
      structuredData,
      model: response.model,
    };
  } catch (error) {
    const description = describeClaudeError(error);
    logger.error(`Summary generation failed: ${description}`);
    throw new Error(description);
  }
}
