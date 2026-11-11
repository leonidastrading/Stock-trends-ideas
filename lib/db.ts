/** Postgres access (Neon serverless driver). Tests swap in PGlite. */

import { neon } from "@neondatabase/serverless";
import { schemaStatements } from "./schema";

export type Row = Record<string, any>;

export interface Querier {
  query(text: string, params?: unknown[]): Promise<Row[]>;
}

let cached: Querier | null = null;
let schemaReady: Promise<void> | null = null;

export function db(): Querier {
  if (!cached) {
    const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const sql = neon(url);
    cached = { query: (text, params = []) => sql.query(text, params) as Promise<Row[]> };
  }
  return cached;
}

export function setQuerierForTests(q: Querier | null): void {
  cached = q;
  schemaReady = null;
}

export function hasDatabase(): boolean {
  return cached !== null || !!(process.env.DATABASE_URL ?? process.env.POSTGRES_URL);
}

function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const st of schemaStatements()) await db().query(st);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/** Run a query after making sure the schema exists. */
export const query = async (text: string, params: unknown[] = []): Promise<Row[]> => {
  await ensureSchema();
  return db().query(text, params);
};
