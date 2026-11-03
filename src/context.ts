import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which brain a request may touch. Set once by the auth middleware from the key
 * presented, and read by every REST route and MCP tool. A department key
 * (card #271) resolves to its own schema, e.g. `brain_coop`; Scott's original
 * BRAIN_KEY resolves to `brain`.
 */
export interface BrainContext {
  schema: string;
  /** Who holds the key: set for per-person department keys, null for the original key. */
  person: string | null;
  /**
   * Schemas this key may READ: its own, plus the shared org reference
   * (`brain_org`) for department keys once it exists. Writes only ever go to
   * `schema`; nobody's key can write to brain_org (scripts/load-org.mjs owns it).
   */
  read: string[];
}

/** The shared, generated org reference every department brain can read. */
export const ORG_SCHEMA = 'brain_org';
/** Schemas a key row may never point at: Scott's brain and the org layer. */
export const RESERVED_SCHEMAS: readonly string[] = ['brain', ORG_SCHEMA];

const store = new AsyncLocalStorage<BrainContext>();

export function runWithBrain<T>(ctx: BrainContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/**
 * The brain for this request. Throws rather than falling back to `brain`: a
 * department key that somehow lost its context must never land in Scott's brain.
 */
export function currentBrain(): BrainContext {
  const ctx = store.getStore();
  if (!ctx) throw new Error('No brain context for this request');
  return ctx;
}

/** Metadata for a new thought: a department key also records who captured it. */
export function captureMetadata(metadata: object, source: string): Record<string, unknown> {
  const { person } = currentBrain();
  return person ? { ...metadata, source, captured_by: person } : { ...metadata, source };
}

/** `brain`, or `brain_<dept>` with a lowercase slug. Anything else is refused. */
export const SCHEMA_RE = /^brain(_[a-z][a-z0-9]{1,30})?$/;

export function assertSchema(schema: string): string {
  if (!SCHEMA_RE.test(schema)) throw new Error(`Invalid brain schema: ${schema}`);
  return schema;
}
