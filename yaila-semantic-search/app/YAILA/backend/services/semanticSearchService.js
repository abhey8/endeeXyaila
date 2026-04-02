import crypto from 'crypto';
import endeeClient from '../endeeClient.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { normalizeWhitespace, slugify, tokenizeEstimate } from '../lib/text.js';
import { buildLocalEmbeddings } from './localEmbeddingService.js';
import { buildChunks } from './chunkingService.js';

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 10;
const FALLBACK_CHUNK_SIZE = 1200;
const FALLBACK_CHUNK_OVERLAP = 200;

const DEFAULT_TEST_RESULT = {
  score: 0.99,
  text: 'Endee semantic demo ready for YAILA.',
  metadata: {
    doc_id: 'demo-doc',
    doc_name: 'Semantic Demo Document',
    chunk_id: 'chunk-001',
    text: 'This is a safe mock semantic search result returned by the YAILA backend.',
  },
};

const clampTopK = (value) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_TOP_K;
  }

  return Math.min(MAX_TOP_K, Math.max(1, Math.floor(parsed)));
};

const buildDocId = (docName) => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const slug = slugify(docName || '') || 'semantic-demo';

  return `${slug}-${suffix}`;
};

const buildDocName = (value, text) => {
  const providedName = normalizeWhitespace(value || '');
  if (providedName) {
    return providedName.slice(0, 120);
  }

  const preview = normalizeWhitespace(text).slice(0, 60);
  return preview ? `${preview}${text.length > 60 ? '...' : ''}` : 'Semantic Demo Document';
};

const buildFallbackChunks = (text) => {
  const chunks = [];
  const step = Math.max(250, FALLBACK_CHUNK_SIZE - FALLBACK_CHUNK_OVERLAP);

  for (let start = 0; start < text.length; start += step) {
    const content = text.slice(start, start + FALLBACK_CHUNK_SIZE).trim();

    if (!content) {
      continue;
    }

    chunks.push({
      content,
      sectionTitle: 'Semantic Demo',
      tokenCount: tokenizeEstimate(content),
      charStart: start,
      charEnd: start + content.length,
      window: {
        semanticGroup: 0,
        overlapFrom: Math.max(0, start - FALLBACK_CHUNK_OVERLAP),
      },
    });
  }

  return chunks;
};

const buildSemanticChunks = (text) => {
  const semanticChunks = buildChunks(text);

  if (semanticChunks.length) {
    return semanticChunks;
  }

  return buildFallbackChunks(text);
};

export const indexSemanticDocument = async ({ text, doc_id, doc_name }) => {
  const rawText = `${text || ''}`.trim();
  const normalizedText = normalizeWhitespace(rawText);

  if (!normalizedText) {
    throw new AppError('text is required for semantic indexing', 400, 'MISSING_TEXT');
  }

  const docName = buildDocName(doc_name, rawText);
  const docId = normalizeWhitespace(doc_id || '') || buildDocId(docName);
  const chunkDrafts = buildSemanticChunks(rawText);

  if (!chunkDrafts.length) {
    throw new AppError('Unable to create semantic chunks for the provided text', 400, 'NO_CHUNKS_CREATED');
  }

  const embeddings = buildLocalEmbeddings(chunkDrafts.map((chunk) => chunk.content));
  const chunkRecords = chunkDrafts.map((chunk, index) => {
    const chunkId = `chunk-${String(index + 1).padStart(3, '0')}`;

    return {
      id: `${docId}:${chunkId}`,
      text: chunk.content,
      embedding: embeddings[index] || [],
      metadata: {
        doc_id: docId,
        doc_name: docName,
        chunk_id: chunkId,
        text: chunk.content,
      },
    };
  });

  await endeeClient.createIndex();
  await endeeClient.upsertChunks(chunkRecords);

  const status = endeeClient.getStatus();

  logger.info('[Semantic] Indexed demo document', {
    docId,
    docName,
    chunkCount: chunkRecords.length,
    mode: status.mode,
  });

  return {
    success: true,
    mode: status.mode,
    index_name: status.index_name,
    doc_id: docId,
    doc_name: docName,
    chunk_count: chunkRecords.length,
  };
};

export const searchSemanticDocuments = async ({ query, topK }) => {
  const normalizedQuery = normalizeWhitespace(query || '');

  if (!normalizedQuery) {
    throw new AppError('query is required for semantic search', 400, 'MISSING_QUERY');
  }

  const safeTopK = clampTopK(topK);
  const [queryEmbedding] = buildLocalEmbeddings([normalizedQuery]);
  const results = await endeeClient.search(queryEmbedding, safeTopK);
  const status = endeeClient.getStatus();

  logger.info('[Semantic] Search completed', {
    queryLength: normalizedQuery.length,
    topK: safeTopK,
    resultCount: results.length,
    mode: status.mode,
  });

  return {
    success: true,
    mode: status.mode,
    query: normalizedQuery,
    topK: safeTopK,
    results,
  };
};

export const getSemanticProbe = async () => {
  await endeeClient.createIndex();

  const status = endeeClient.getStatus();

  return {
    success: true,
    mode: status.mode,
    index_name: status.index_name,
    remote_available: status.remote_available,
    sample_result: endeeClient.getFallbackSample() || DEFAULT_TEST_RESULT,
  };
};
