/**
 * Single source of truth for every file the agent reads/writes at runtime.
 *
 * Why this exists: memory.ts wrote the staging queue to <cwd>/src/…, the
 * worker read it from __dirname/… and taxonomy.ts read learned_taxonomy.json
 * from ITS OWN __dirname. Under ts-node those happened to coincide; once
 * compiled to dist/ they pointed at three different folders, so staged
 * insights were never processed and learned dialect words never reached the
 * router. Everything now resolves from process.cwd()/src.
 */
import path from 'path';

const SRC_DIR = path.join(process.cwd(), 'src');

export const KNOWLEDGE_FILE = path.join(SRC_DIR, 'knowledge_embeddings.json');
export const STAGING_FILE = path.join(SRC_DIR, 'staging_queue.json');
export const LEARNED_TAXONOMY_FILE = path.join(SRC_DIR, 'agent', 'learned_taxonomy.json');
export const REVIEWS_DB_CANDIDATES = [
    path.join(SRC_DIR, 'reviews_db.json'),
    path.join(process.cwd(), 'reviews_db.json'),
];
