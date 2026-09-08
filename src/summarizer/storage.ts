/**
 * SQLite storage: migrations run automatically at startup, and deduplication by
 * date is enforced by a UNIQUE constraint on `summary_date`.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { FeedItem } from '../fetcher/types.js';

/** Summary metadata, without the markdown body (used for listings). */
export interface SummaryMeta {
  id: number;
  date: string;
  title: string;
  model: string;
  itemCount: number;
  sources: Record<string, number>;
  createdAt: string;
}

/** A full summary, markdown body included. */
export interface Summary extends SummaryMeta {
  markdown: string;
}

/** Data required to store a new summary. */
export interface NewSummary {
  date: string;
  title: string;
  markdown: string;
  model: string;
  items: FeedItem[];
}

/** Raw row of the `summaries` table. */
interface SummaryRow {
  id: number;
  summary_date: string;
  title: string;
  markdown: string;
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
    name: 'initial-schema',
    sql: `
      CREATE TABLE IF NOT EXISTS summaries (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_date TEXT    NOT NULL UNIQUE,
        title        TEXT    NOT NULL,
        markdown     TEXT    NOT NULL,
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
        tags         TEXT    NOT NULL DEFAULT '[]',
        metrics      TEXT    NOT NULL DEFAULT '{}',
        UNIQUE (summary_id, source_id)
      );

      CREATE INDEX IF NOT EXISTS idx_summaries_date ON summaries (summary_date DESC);
      CREATE INDEX IF NOT EXISTS idx_items_summary ON items (summary_id);
      CREATE INDEX IF NOT EXISTS idx_items_source ON items (source);
    `,
  },
];

function toSummary(row: SummaryRow): Summary {
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
    markdown: row.markdown,
    model: row.model,
    itemCount: row.item_count,
    sources,
    createdAt: row.created_at,
  };
}

function toSummaryMeta(summary: Summary): SummaryMeta {
  const { markdown: _markdown, ...meta } = summary;
  return meta;
}

/** Access layer for the SQLite store of watch summaries. */
export class SummaryStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = config.dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    // WAL: one writer and several concurrent readers.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    this.runMigrations();
    logger.debug(`SQLite store opened: ${dbPath}`);
  }

  /** Runs the missing migrations, one transaction per migration. */
  private runMigrations(): void {
    const currentVersion = Number(this.db.pragma('user_version', { simple: true }));

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue;

      logger.info(`Running SQLite migration ${migration.version} (${migration.name})...`);
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
      .prepare('SELECT 1 AS present FROM summaries WHERE summary_date = ?')
      .get(date) as { present: number } | undefined;
    return row !== undefined;
  }

  /** Returns the full summary for a date, or `null`. */
  getSummary(date: string): Summary | null {
    const row = this.db.prepare('SELECT * FROM summaries WHERE summary_date = ?').get(date) as
      | SummaryRow
      | undefined;
    return row === undefined ? null : toSummary(row);
  }

  /** Returns the most recent summary, or `null` if the store is empty. */
  getLatestSummary(): Summary | null {
    const row = this.db
      .prepare('SELECT * FROM summaries ORDER BY summary_date DESC LIMIT 1')
      .get() as SummaryRow | undefined;
    return row === undefined ? null : toSummary(row);
  }

  /** Lists available summaries, newest first. */
  listSummaries(limit = 50): SummaryMeta[] {
    const rows = this.db
      .prepare('SELECT * FROM summaries ORDER BY summary_date DESC LIMIT ?')
      .all(limit) as SummaryRow[];
    return rows.map((row) => toSummaryMeta(toSummary(row)));
  }

  /** Returns the raw items attached to a summary. */
  getItems(summaryId: number): FeedItem[] {
    const rows = this.db
      .prepare('SELECT * FROM items WHERE summary_id = ? ORDER BY id ASC')
      .all(summaryId) as Record<string, string | number | null>[];

    return rows.map((row) => ({
      id: String(row.source_id),
      source: String(row.source) as FeedItem['source'],
      title: String(row.title),
      url: String(row.url),
      description: row.description === null ? '' : String(row.description),
      publishedAt: row.published_at === null ? '' : String(row.published_at),
      ...(row.author === null ? {} : { author: String(row.author) }),
      tags: JSON.parse(String(row.tags ?? '[]')) as string[],
      metrics: JSON.parse(String(row.metrics ?? '{}')) as FeedItem['metrics'],
    }));
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
      INSERT INTO summaries (summary_date, title, markdown, model, item_count, sources, created_at)
      VALUES (@date, @title, @markdown, @model, @itemCount, @sources, @createdAt)
    `);

    const insertItem = this.db.prepare(`
      INSERT OR IGNORE INTO items
        (summary_id, source_id, source, title, url, description, author, published_at, tags, metrics)
      VALUES
        (@summaryId, @sourceId, @source, @title, @url, @description, @author, @publishedAt, @tags, @metrics)
    `);

    const transaction = this.db.transaction((): number => {
      const result = insertSummary.run({
        date: entry.date,
        title: entry.title,
        markdown: entry.markdown,
        model: entry.model,
        itemCount: entry.items.length,
        sources: JSON.stringify(sources),
        createdAt: new Date().toISOString(),
      });

      const summaryId = Number(result.lastInsertRowid);

      for (const item of entry.items) {
        insertItem.run({
          summaryId,
          sourceId: item.id,
          source: item.source,
          title: item.title,
          url: item.url,
          description: item.description,
          author: item.author ?? null,
          publishedAt: item.publishedAt,
          tags: JSON.stringify(item.tags),
          metrics: JSON.stringify(item.metrics),
        });
      }

      return summaryId;
    });

    const summaryId = transaction();
    logger.success(
      `Summary for ${entry.date} stored (id ${summaryId}, ${entry.items.length} item(s)).`,
    );

    const stored = this.getSummary(entry.date);
    if (stored === null) {
      throw new Error(`Unexpected failure: summary for ${entry.date} missing after insert.`);
    }
    return stored;
  }

  /** Deletes a summary and, by cascade, its items. */
  deleteSummary(date: string): boolean {
    const result = this.db.prepare('DELETE FROM summaries WHERE summary_date = ?').run(date);
    return result.changes > 0;
  }

  /** Global statistics. */
  stats(): { summaryCount: number; firstDate: string | null; lastDate: string | null } {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS total, MIN(summary_date) AS first, MAX(summary_date) AS last FROM summaries',
      )
      .get() as { total: number; first: string | null; last: string | null };

    return { summaryCount: row.total, firstDate: row.first, lastDate: row.last };
  }

  close(): void {
    this.db.close();
    logger.debug('SQLite store closed.');
  }
}

/** Opens the store and applies pending migrations. */
export function openStore(dbPath: string = config.dbPath): SummaryStore {
  return new SummaryStore(dbPath);
}
