/**
 * SQLite storage: migrations run automatically at startup, and deduplication by
 * date is enforced by a UNIQUE constraint on `summary_date`.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { FeedItem } from "../fetcher/types.js";
import type { StructuredSummary } from "./claude.js";

/** Summary metadata, without the structured body (used for listings). */
export interface SummaryMeta {
  id: number;
  date: string;
  title: string;
  model: string;
  itemCount: number;
  sources: Record<string, number>;
  createdAt: string;
}

/** A full summary, with structured data included. */
export interface Summary extends SummaryMeta {
  structuredData: StructuredSummary;
}

/** Data required to store a new summary. */
export interface NewSummary {
  date: string;
  title: string;
  structuredData: StructuredSummary;
  model: string;
  items: FeedItem[];
}

/** Raw row of the `summaries` table. */
interface SummaryRow {
  id: number;
  summary_date: string;
  title: string;
  model: string;
  item_count: number;
  sources: string;
  created_at: string;
}

/**
 * Migrations run in order. To evolve the schema, add an entry with a higher
 * `version`.
 */
const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "initial-schema",
    sql: `
      CREATE TABLE IF NOT EXISTS summaries (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_date TEXT    NOT NULL UNIQUE,
        title        TEXT    NOT NULL,
        model        TEXT    NOT NULL,
        item_count   INTEGER NOT NULL DEFAULT 0,
        sources      TEXT    NOT NULL DEFAULT '{}',
        created_at   TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_id   INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        source_id    TEXT    NOT NULL,
        source       TEXT    NOT NULL,
        title        TEXT    NOT NULL,
        url          TEXT    NOT NULL,
        description  TEXT,
        author       TEXT,
        published_at TEXT,
        stars        INTEGER,
        forks        INTEGER,
        reactions    INTEGER,
        comments     INTEGER,
        reading_minutes INTEGER,
        language     TEXT,
        version      TEXT,
        UNIQUE (summary_id, source_id)
      );

      CREATE TABLE IF NOT EXISTS item_tags (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        tag      TEXT    NOT NULL,
        position INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_summaries_date ON summaries (summary_date DESC);
      CREATE INDEX IF NOT EXISTS idx_items_summary ON items (summary_id);
      CREATE INDEX IF NOT EXISTS idx_items_source ON items (source);
      CREATE INDEX IF NOT EXISTS idx_item_tags_item ON item_tags (item_id);

      CREATE TABLE IF NOT EXISTS summary_highlights (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_id INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        content    TEXT    NOT NULL,
        position   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS github_trending (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_id INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        name       TEXT    NOT NULL,
        url        TEXT    NOT NULL,
        language   TEXT,
        stars      INTEGER,
        summary    TEXT    NOT NULL,
        position   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS github_releases (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_id INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        repository TEXT    NOT NULL,
        version    TEXT    NOT NULL,
        url        TEXT    NOT NULL,
        summary    TEXT    NOT NULL,
        position   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devto_articles (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_id INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        title      TEXT    NOT NULL,
        url        TEXT    NOT NULL,
        author     TEXT    NOT NULL,
        summary    TEXT    NOT NULL,
        position   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS summary_trends (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_id INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        content    TEXT    NOT NULL,
        position   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS summary_watch_items (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_id INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        content    TEXT    NOT NULL,
        position   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_highlights_summary ON summary_highlights (summary_id);
      CREATE INDEX IF NOT EXISTS idx_trending_summary ON github_trending (summary_id);
      CREATE INDEX IF NOT EXISTS idx_releases_summary ON github_releases (summary_id);
      CREATE INDEX IF NOT EXISTS idx_articles_summary ON devto_articles (summary_id);
      CREATE INDEX IF NOT EXISTS idx_trends_summary ON summary_trends (summary_id);
      CREATE INDEX IF NOT EXISTS idx_watch_summary ON summary_watch_items (summary_id);
    `,
  },
];

function toSummary(
  row: SummaryRow,
  structuredData: StructuredSummary,
): Summary {
  let sources: Record<string, number> = {};
  try {
    sources = JSON.parse(row.sources) as Record<string, number>;
  } catch {
    sources = {};
  }

  return {
    id: row.id,
    date: row.summary_date,
    title: row.title,
    structuredData,
    model: row.model,
    itemCount: row.item_count,
    sources,
    createdAt: row.created_at,
  };
}

function toSummaryMeta(summary: Summary): SummaryMeta {
  const { structuredData: _structuredData, ...meta } = summary;
  return meta;
}

/** Access layer for the SQLite store of watch summaries. */
export class SummaryStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = config.dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    // WAL: one writer and several concurrent readers.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");

    this.runMigrations();
    logger.debug(`SQLite store opened: ${dbPath}`);
  }

  /** Runs the missing migrations, one transaction per migration. */
  private runMigrations(): void {
    const currentVersion = Number(
      this.db.pragma("user_version", { simple: true }),
    );

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue;

      logger.info(
        `Running SQLite migration ${migration.version} (${migration.name})...`,
      );
      const run = this.db.transaction(() => {
        this.db.exec(migration.sql);
      });
      run();
      this.db.pragma(`user_version = ${migration.version}`);
      logger.success(`Migration ${migration.version} applied.`);
    }
  }

  /** Whether a summary already exists for that date (deduplication). */
  hasSummary(date: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM summaries WHERE summary_date = ?")
      .get(date) as { present: number } | undefined;
    return row !== undefined;
  }

  private readStructuredData(
    summaryId: number,
    title: string,
  ): StructuredSummary {
    const highlights = this.db
      .prepare(
        "SELECT content FROM summary_highlights WHERE summary_id = ? ORDER BY position",
      )
      .all(summaryId) as { content: string }[];
    const githubTrending = this.db
      .prepare(
        "SELECT name, url, language, stars, summary FROM github_trending WHERE summary_id = ? ORDER BY position",
      )
      .all(summaryId) as {
      name: string;
      url: string;
      language: string | null;
      stars: number | null;
      summary: string;
    }[];
    const githubReleases = this.db
      .prepare(
        "SELECT repository, version, url, summary FROM github_releases WHERE summary_id = ? ORDER BY position",
      )
      .all(summaryId) as {
      repository: string;
      version: string;
      url: string;
      summary: string;
    }[];
    const devtoArticles = this.db
      .prepare(
        "SELECT title, url, author, summary FROM devto_articles WHERE summary_id = ? ORDER BY position",
      )
      .all(summaryId) as {
      title: string;
      url: string;
      author: string;
      summary: string;
    }[];
    const trends = this.db
      .prepare(
        "SELECT content FROM summary_trends WHERE summary_id = ? ORDER BY position",
      )
      .all(summaryId) as { content: string }[];
    const watch = this.db
      .prepare(
        "SELECT content FROM summary_watch_items WHERE summary_id = ? ORDER BY position",
      )
      .all(summaryId) as { content: string }[];

    return {
      title,
      highlights: highlights.map((entry) => entry.content),
      githubTrending: githubTrending.map((entry) => ({
        name: entry.name,
        url: entry.url,
        ...(entry.language === null ? {} : { language: entry.language }),
        ...(entry.stars === null ? {} : { stars: entry.stars }),
        summary: entry.summary,
      })),
      githubReleases,
      devtoArticles,
      trends: trends.map((entry) => entry.content),
      watch: watch.map((entry) => entry.content),
    };
  }

  /** Returns the full summary for a date, or `null`. */
  getSummary(date: string): Summary | null {
    const row = this.db
      .prepare("SELECT * FROM summaries WHERE summary_date = ?")
      .get(date) as SummaryRow | undefined;
    if (row === undefined) return null;
    const structuredData = this.readStructuredData(row.id, row.title);
    return toSummary(row, structuredData);
  }

  /** Returns the most recent summary, or `null` if the store is empty. */
  getLatestSummary(): Summary | null {
    const row = this.db
      .prepare("SELECT * FROM summaries ORDER BY summary_date DESC LIMIT 1")
      .get() as SummaryRow | undefined;
    if (row === undefined) return null;
    const structuredData = this.readStructuredData(row.id, row.title);
    return toSummary(row, structuredData);
  }

  /** Lists available summaries, newest first. */
  listSummaries(limit = 50): SummaryMeta[] {
    const rows = this.db
      .prepare("SELECT * FROM summaries ORDER BY summary_date DESC LIMIT ?")
      .all(limit) as SummaryRow[];
    return rows.map((row) => {
      const structuredData = this.readStructuredData(row.id, row.title);
      return toSummaryMeta(toSummary(row, structuredData));
    });
  }

  /** Returns the raw items attached to a summary. */
  getItems(summaryId: number): FeedItem[] {
    const rows = this.db
      .prepare("SELECT * FROM items WHERE summary_id = ? ORDER BY id ASC")
      .all(summaryId) as Record<string, string | number | null>[];

    return rows.map((row) => {
      const tags = this.db
        .prepare(
          "SELECT tag FROM item_tags WHERE item_id = ? ORDER BY position",
        )
        .all(row.id) as { tag: string }[];
      const metrics: FeedItem["metrics"] = {};

      if (row.stars !== null) metrics.stars = Number(row.stars);
      if (row.forks !== null) metrics.forks = Number(row.forks);
      if (row.reactions !== null) metrics.reactions = Number(row.reactions);
      if (row.comments !== null) metrics.comments = Number(row.comments);
      if (row.reading_minutes !== null) {
        metrics.readingMinutes = Number(row.reading_minutes);
      }
      if (row.language !== null) metrics.language = String(row.language);
      if (row.version !== null) metrics.version = String(row.version);

      return {
        id: String(row.source_id),
        source: String(row.source) as FeedItem["source"],
        title: String(row.title),
        url: String(row.url),
        description: row.description === null ? "" : String(row.description),
        publishedAt: row.published_at === null ? "" : String(row.published_at),
        ...(row.author === null ? {} : { author: String(row.author) }),
        tags: tags.map((entry) => entry.tag),
        metrics,
      };
    });
  }

  /**
   * Stores a summary and its items in a single transaction. Refuses to overwrite
   * an existing summary unless `replace` is `true`.
   */
  saveSummary(entry: NewSummary, replace = false): Summary {
    if (this.hasSummary(entry.date)) {
      if (!replace) {
        throw new Error(
          `A summary already exists for ${entry.date}. Use --force to replace it.`,
        );
      }
      this.deleteSummary(entry.date);
    }

    const sources: Record<string, number> = {};
    for (const item of entry.items) {
      sources[item.source] = (sources[item.source] ?? 0) + 1;
    }

    const insertSummary = this.db.prepare(`
      INSERT INTO summaries
        (summary_date, title, model, item_count, sources, created_at)
      VALUES (@date, @title, @model, @itemCount, @sources, @createdAt)
    `);

    const insertItem = this.db.prepare(`
      INSERT OR IGNORE INTO items
        (summary_id, source_id, source, title, url, description, author, published_at,
         stars, forks, reactions, comments, reading_minutes, language, version)
      VALUES
        (@summaryId, @sourceId, @source, @title, @url, @description, @author, @publishedAt,
         @stars, @forks, @reactions, @comments, @readingMinutes, @language, @version)
    `);
    const insertItemTag = this.db.prepare(`
      INSERT INTO item_tags (item_id, tag, position)
      VALUES (@itemId, @tag, @position)
    `);

    const insertHighlight = this.db.prepare(`
      INSERT INTO summary_highlights (summary_id, content, position)
      VALUES (@summaryId, @content, @position)
    `);
    const insertTrending = this.db.prepare(`
      INSERT INTO github_trending (summary_id, name, url, language, stars, summary, position)
      VALUES (@summaryId, @name, @url, @language, @stars, @summary, @position)
    `);
    const insertRelease = this.db.prepare(`
      INSERT INTO github_releases (summary_id, repository, version, url, summary, position)
      VALUES (@summaryId, @repository, @version, @url, @summary, @position)
    `);
    const insertArticle = this.db.prepare(`
      INSERT INTO devto_articles (summary_id, title, url, author, summary, position)
      VALUES (@summaryId, @title, @url, @author, @summary, @position)
    `);
    const insertTrend = this.db.prepare(`
      INSERT INTO summary_trends (summary_id, content, position)
      VALUES (@summaryId, @content, @position)
    `);
    const insertWatch = this.db.prepare(`
      INSERT INTO summary_watch_items (summary_id, content, position)
      VALUES (@summaryId, @content, @position)
    `);

    const transaction = this.db.transaction((): number => {
      const result = insertSummary.run({
        date: entry.date,
        title: entry.title,
        model: entry.model,
        itemCount: entry.items.length,
        sources: JSON.stringify(sources),
        createdAt: new Date().toISOString(),
      });

      const summaryId = Number(result.lastInsertRowid);

      for (const item of entry.items) {
        const result = insertItem.run({
          summaryId,
          sourceId: item.id,
          source: item.source,
          title: item.title,
          url: item.url,
          description: item.description,
          author: item.author ?? null,
          publishedAt: item.publishedAt,
          stars: item.metrics.stars ?? null,
          forks: item.metrics.forks ?? null,
          reactions: item.metrics.reactions ?? null,
          comments: item.metrics.comments ?? null,
          readingMinutes: item.metrics.readingMinutes ?? null,
          language: item.metrics.language ?? null,
          version: item.metrics.version ?? null,
        });

        const itemId = Number(result.lastInsertRowid);
        item.tags.forEach((tag, position) => {
          insertItemTag.run({ itemId, tag, position });
        });
      }

      entry.structuredData.highlights.forEach((content, position) => {
        insertHighlight.run({ summaryId, content, position });
      });
      entry.structuredData.githubTrending.forEach((entry, position) => {
        insertTrending.run({
          summaryId,
          ...entry,
          language: entry.language ?? null,
          stars: entry.stars ?? null,
          position,
        });
      });
      entry.structuredData.githubReleases.forEach((entry, position) => {
        insertRelease.run({ summaryId, ...entry, position });
      });
      entry.structuredData.devtoArticles.forEach((entry, position) => {
        insertArticle.run({ summaryId, ...entry, position });
      });
      entry.structuredData.trends.forEach((content, position) => {
        insertTrend.run({ summaryId, content, position });
      });
      entry.structuredData.watch.forEach((content, position) => {
        insertWatch.run({ summaryId, content, position });
      });

      return summaryId;
    });

    const summaryId = transaction();
    logger.success(
      `Summary for ${entry.date} stored (id ${summaryId}, ${entry.items.length} item(s)).`,
    );

    const stored = this.getSummary(entry.date);
    if (stored === null) {
      throw new Error(
        `Unexpected failure: summary for ${entry.date} missing after insert.`,
      );
    }
    return stored;
  }

  /** Deletes a summary and, by cascade, its items. */
  deleteSummary(date: string): boolean {
    const result = this.db
      .prepare("DELETE FROM summaries WHERE summary_date = ?")
      .run(date);
    return result.changes > 0;
  }

  /** Global statistics. */
  stats(): {
    summaryCount: number;
    firstDate: string | null;
    lastDate: string | null;
  } {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS total, MIN(summary_date) AS first, MAX(summary_date) AS last FROM summaries",
      )
      .get() as { total: number; first: string | null; last: string | null };

    return {
      summaryCount: row.total,
      firstDate: row.first,
      lastDate: row.last,
    };
  }

  close(): void {
    this.db.close();
    logger.debug("SQLite store closed.");
  }
}

/** Opens the store and applies pending migrations. */
export function openStore(dbPath: string = config.dbPath): SummaryStore {
  return new SummaryStore(dbPath);
}
