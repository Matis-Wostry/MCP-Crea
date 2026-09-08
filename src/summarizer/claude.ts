/**
 * Summary generation through the Claude API. The model receives the collected
 * items grouped by source and returns a markdown digest following a fixed plan.
 *
 * The prompt is written in French on purpose: the generated digest is the
 * project's deliverable and is meant to be read in French.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config, assertClaudeConfigured } from '../config.js';
import { logger, errorMessage } from '../logger.js';
import { SOURCE_LABELS, type FeedItem, type FeedSource } from '../fetcher/types.js';

/** Result of the summarisation, ready to be stored. */
export interface GeneratedSummary {
  title: string;
  markdown: string;
  model: string;
}

/** Common shape of the blocks in both the standard and beta responses. */
interface ContentBlock {
  type: string;
  text?: string;
}

/** Summarisation instructions, stable across runs so the prompt stays cached. */
const SYSTEM_PROMPT = `Tu es un analyste de veille technologique pour une equipe de developpeurs francophones.

On te fournit une liste brute d'elements collectes le jour meme sur GitHub et Dev.to.
Tu produis une synthese quotidienne en francais, en markdown, directement lisible.

REGLES ABSOLUES :
- N'invente jamais un fait, un chiffre, une version ou un lien. Utilise uniquement les donnees fournies.
- Chaque element cite doit etre un lien markdown vers l'URL exacte fournie.
- Si une section n'a aucune donnee, ecris explicitement "Aucun element collecte pour cette source aujourd'hui."
- Ecris en francais, ton professionnel et direct, sans superlatifs marketing.
- N'ajoute aucun texte avant ou apres le markdown demande (pas de preambule, pas de conclusion meta).

PLAN IMPOSE (respecte les titres et leur niveau) :

# Veille technique - <DATE>

## En bref
3 a 5 puces qui resument la journee. Chaque puce doit apporter une information concrete.

## GitHub - depots en vogue
Pour chaque depot notable : lien, langage, nombre d'etoiles, et une phrase expliquant a quoi il sert
et pourquoi il attire l'attention. Regroupe les depots similaires plutot que de tout lister.

## GitHub - nouvelles releases
Pour chaque release : lien, version, et ce qui change concretement d'apres les notes fournies.
Signale explicitement les changements de rupture si les notes les mentionnent.

## Dev.to - articles du jour
Les articles les plus pertinents pour une equipe de developpeurs, avec lien, auteur,
et l'idee principale de l'article en une phrase.

## Tendances transverses
2 a 4 paragraphes courts identifiant les themes qui reviennent entre les sources.
Si aucun theme transverse ne se degage, dis-le franchement.

## A surveiller
2 a 4 puces : ce qui merite un suivi dans les prochains jours, et pourquoi.`;

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
  if (metrics.language !== undefined) parts.push(`language ${metrics.language}`);
  if (metrics.version !== undefined) parts.push(`version ${metrics.version}`);
  if (metrics.reactions !== undefined) parts.push(`${metrics.reactions} reactions`);
  if (metrics.comments !== undefined) parts.push(`${metrics.comments} comments`);
  if (metrics.readingMinutes !== undefined) parts.push(`${metrics.readingMinutes} min read`);

  return parts.length > 0 ? parts.join(', ') : 'no metrics';
}

/** Assembles the items into a plain-text corpus grouped by source. */
export function buildCorpus(items: FeedItem[], date: string): string {
  const groups = new Map<FeedSource, FeedItem[]>();
  for (const item of items) {
    const list = groups.get(item.source) ?? [];
    list.push(item);
    groups.set(item.source, list);
  }

  const sections: string[] = [`Date de collecte : ${date}`, `Nombre total d'elements : ${items.length}`, ''];

  for (const source of Object.keys(SOURCE_LABELS) as FeedSource[]) {
    const list = groups.get(source) ?? [];
    sections.push(`### SOURCE : ${SOURCE_LABELS[source]} (${list.length} element(s))`);

    if (list.length === 0) {
      sections.push('(aucun element collecte pour cette source)', '');
      continue;
    }

    list.forEach((item, index) => {
      const lines = [
        `${index + 1}. TITRE : ${item.title}`,
        `   URL : ${item.url}`,
        `   AUTEUR : ${item.author ?? 'inconnu'}`,
        `   PUBLIE LE : ${item.publishedAt}`,
        `   METRIQUES : ${formatMetrics(item)}`,
        `   TAGS : ${item.tags.length > 0 ? item.tags.join(', ') : 'aucun'}`,
        `   DESCRIPTION : ${item.description}`,
      ];
      sections.push(lines.join('\n'));
    });

    sections.push('');
  }

  return sections.join('\n');
}

/** Concatenates the text blocks, ignoring reasoning blocks. */
function extractText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim();
}

function extractTitle(markdown: string, date: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  const title = match?.[1]?.trim();
  return title !== undefined && title !== '' ? title : `Veille technique - ${date}`;
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

async function withRetries<T>(operation: () => Promise<T>, attempts: number): Promise<T> {
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

  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    const node = current as { code?: string; message?: string; cause?: unknown };
    const code = node.code !== undefined ? `${node.code}: ` : '';
    const text = node.message ?? String(current);
    if (text !== '') reasons.push(`${code}${text}`);
    current = node.cause;
  }

  return reasons.length > 0 ? ` Network reason: ${reasons.join(' <- ')}.` : '';
}

function describeClaudeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'ANTHROPIC_API_KEY is invalid or revoked (401). Check the key in your .env file.';
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return 'Access denied (403): the key lacks permission for this model.';
  }
  if (error instanceof Anthropic.NotFoundError) {
    return `Model not found (404): check the CLAUDE_MODEL value ("${config.anthropic.model}").`;
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Rate limit reached (429) after several attempts. Try again later.';
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `Invalid request (400): ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return (
      `Timed out while calling the Claude API.${describeCause(error)} ` +
      'Lower MAX_ITEMS_PER_SUMMARY or CLAUDE_EFFORT to shorten the generation.'
    );
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return (
      `Could not reach the Claude API after ${config.anthropic.retries} attempt(s).` +
      `${describeCause(error)} ` +
      'Check connectivity to api.anthropic.com (network, firewall, proxy) and retry: ' +
      'the collection step will simply run again.'
    );
  }
  if (error instanceof Anthropic.APIError) {
    return `API error ${error.status ?? '?'}: ${error.message}`;
  }
  return errorMessage(error);
}

/**
 * Generates the markdown digest for a given day.
 *
 * @param items Normalised items produced by the collectors.
 * @param date  Summary date in `YYYY-MM-DD` format.
 */
export async function generateSummary(items: FeedItem[], date: string): Promise<GeneratedSummary> {
  if (items.length === 0) {
    throw new Error('No items collected: summary generation aborted.');
  }

  const client = createClient();

  const selection = items.slice(0, config.maxItemsPerSummary);
  if (selection.length < items.length) {
    logger.warn(
      `${items.length} items collected, only the first ${selection.length} are sent ` +
        '(see MAX_ITEMS_PER_SUMMARY).',
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
        type: 'text' as const,
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' as const },
      },
    ],
    output_config: { effort: config.anthropic.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' },
    messages: [{ role: 'user' as const, content: instruction }],
  };

  try {
    // Streaming rather than a blocking call: generation runs over a minute, and
    // with no traffic a proxy or undici would drop the connection as idle.
    const response = await withRetries(async () => {
      if (config.anthropic.enableFallback) {
        // If the primary model declines, the API replays on the fallback model.
        const stream = client.beta.messages.stream({
          ...baseParams,
          betas: ['server-side-fallback-2026-06-01'],
          fallbacks: [{ model: config.anthropic.fallbackModel }],
        });
        return await stream.finalMessage();
      }
      const stream = client.messages.stream(baseParams);
      return await stream.finalMessage();
    }, config.anthropic.retries);

    if (response.stop_reason === 'refusal') {
      throw new Error(
        'Claude refused to process the request (stop_reason: refusal). The collected content ' +
          'likely tripped a safety filter. Re-run the collection or lower MAX_ITEMS_PER_SUMMARY.',
      );
    }

    if (response.stop_reason === 'max_tokens') {
      logger.warn('Response truncated (max_tokens reached). Raise CLAUDE_MAX_TOKENS.');
    }

    const markdown = extractText(response.content as readonly ContentBlock[]);
    if (markdown === '') {
      throw new Error('Claude returned no usable text.');
    }

    logger.success(
      `Summary generated (${markdown.length} characters, ${response.usage.input_tokens} input tokens, ` +
        `${response.usage.output_tokens} output).`,
    );

    return {
      title: extractTitle(markdown, date),
      markdown,
      model: response.model,
    };
  } catch (error) {
    const description = describeClaudeError(error);
    logger.error(`Summary generation failed: ${description}`);
    throw new Error(description);
  }
}
