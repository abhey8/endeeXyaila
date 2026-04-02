import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { cosineSimilarity } from './lib/math.js';

const ENDEE_URL = `${process.env.ENDEE_URL || 'http://localhost:8080'}`.replace(/\/+$/, '');
const ENDEE_INDEX_NAME = `${process.env.ENDEE_INDEX_NAME || 'yaila-semantic-demo'}`.trim();
const ENDEE_AUTH_TOKEN = `${process.env.ENDEE_AUTH_TOKEN || ''}`.trim();
const ENDEE_TIMEOUT_MS = Math.max(750, Number(process.env.ENDEE_TIMEOUT_MS || 1500));

const fallbackStore = new Map();

const remoteState = {
  available: false,
  lastError: null,
  connectionWarningLogged: false,
  searchFallbackLogged: false,
};

const getMode = () => (remoteState.available ? 'hybrid' : 'mock');

const buildHeaders = () => {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (ENDEE_AUTH_TOKEN) {
    headers.Authorization = ENDEE_AUTH_TOKEN;
  }

  return headers;
};

const requestEndee = async (pathname, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENDEE_TIMEOUT_MS);

  try {
    return await fetch(`${ENDEE_URL}${pathname}`, {
      method: options.method || 'GET',
      headers: {
        ...buildHeaders(),
        ...(options.headers || {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? `Endee request timed out after ${ENDEE_TIMEOUT_MS}ms`
      : error.message;
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
  }
};

const markRemoteSuccess = () => {
  remoteState.available = true;
  remoteState.lastError = null;
  remoteState.connectionWarningLogged = false;
};

const markRemoteFailure = (message, error) => {
  remoteState.available = false;
  remoteState.lastError = error?.message || message;

  if (!remoteState.connectionWarningLogged) {
    logger.warn(message, {
      endeeUrl: ENDEE_URL,
      error: remoteState.lastError,
    });
    remoteState.connectionWarningLogged = true;
  }
};

const normalizeChunkRecord = (chunk = {}, index = 0) => {
  const metadata = {
    ...(chunk.metadata || {}),
  };
  const text = `${chunk.text || metadata.text || ''}`.trim();
  const docId = `${metadata.doc_id || chunk.doc_id || 'semantic-demo'}`.trim();
  const chunkId = `${metadata.chunk_id || chunk.chunk_id || `chunk-${index + 1}`}`.trim();
  const docName = `${metadata.doc_name || chunk.doc_name || 'Semantic Demo Document'}`.trim();

  return {
    id: `${chunk.id || `${docId}:${chunkId}`}`.trim(),
    text,
    embedding: Array.isArray(chunk.embedding) ? chunk.embedding : [],
    metadata: {
      ...metadata,
      doc_id: docId,
      doc_name: docName,
      chunk_id: chunkId,
      text,
    },
  };
};

const mirrorToFallbackStore = (chunks = []) => {
  chunks.forEach((chunk, index) => {
    const record = normalizeChunkRecord(chunk, index);
    const key = `${record.metadata.doc_id}:${record.metadata.chunk_id}`;

    fallbackStore.set(key, record);
  });
};

const attemptRemoteSearchNotice = async (queryEmbedding, topK) => {
  if (!remoteState.available || remoteState.searchFallbackLogged) {
    return;
  }

  try {
    const response = await requestEndee(`/api/v1/index/${encodeURIComponent(ENDEE_INDEX_NAME)}/search`, {
      method: 'POST',
      body: {
        vector: queryEmbedding,
        k: topK,
      },
    });

    const contentType = response.headers.get('content-type') || '';
    if (response.ok && /application\/msgpack/i.test(contentType)) {
      logger.info('[Endee] Remote search returns MessagePack; using local fallback JSON results for the demo.', {
        indexName: ENDEE_INDEX_NAME,
      });
      remoteState.searchFallbackLogged = true;
      return;
    }

    if (!response.ok) {
      const body = await response.text();
      logger.warn('[Endee] Remote search response could not be used; falling back to local results.', {
        indexName: ENDEE_INDEX_NAME,
        status: response.status,
        error: body.slice(0, 200),
      });
      remoteState.searchFallbackLogged = true;
    }
  } catch (error) {
    markRemoteFailure('[Endee] Remote search is unavailable; using local fallback results.', error);
    remoteState.searchFallbackLogged = true;
  }
};

async function createIndex() {
  const payload = {
    index_name: ENDEE_INDEX_NAME,
    dim: env.embeddingDimensions || 768,
    space_type: 'cosine',
  };

  try {
    const response = await requestEndee('/api/v1/index/create', {
      method: 'POST',
      body: payload,
    });
    const body = await response.text();

    if (response.ok || response.status === 409 || /exist/i.test(body)) {
      markRemoteSuccess();
      return {
        success: true,
        mode: getMode(),
        index_name: ENDEE_INDEX_NAME,
        remote_available: true,
      };
    }

    markRemoteFailure('[Endee] Falling back to in-memory semantic store because index creation failed.', new Error(`HTTP ${response.status}: ${body}`));
  } catch (error) {
    markRemoteFailure('[Endee] Falling back to in-memory semantic store because Endee is unavailable.', error);
  }

  return {
    success: true,
    mode: getMode(),
    index_name: ENDEE_INDEX_NAME,
    remote_available: false,
  };
}

async function upsertChunks(chunks = []) {
  const normalizedChunks = chunks.map((chunk, index) => normalizeChunkRecord(chunk, index));
  mirrorToFallbackStore(normalizedChunks);

  if (!normalizedChunks.length) {
    return {
      success: true,
      mode: getMode(),
      indexed: 0,
      index_name: ENDEE_INDEX_NAME,
    };
  }

  if (!remoteState.available) {
    return {
      success: true,
      mode: getMode(),
      indexed: normalizedChunks.length,
      index_name: ENDEE_INDEX_NAME,
    };
  }

  try {
    const response = await requestEndee(`/api/v1/index/${encodeURIComponent(ENDEE_INDEX_NAME)}/vector/insert`, {
      method: 'POST',
      body: normalizedChunks.map((chunk) => ({
        id: chunk.id,
        vector: chunk.embedding,
        meta: JSON.stringify(chunk.metadata),
        filter: JSON.stringify({
          doc_id: chunk.metadata.doc_id,
          doc_name: chunk.metadata.doc_name,
          chunk_id: chunk.metadata.chunk_id,
        }),
      })),
    });

    if (response.ok) {
      markRemoteSuccess();
      return {
        success: true,
        mode: getMode(),
        indexed: normalizedChunks.length,
        index_name: ENDEE_INDEX_NAME,
      };
    }

    const body = await response.text();
    markRemoteFailure('[Endee] Chunk upsert failed; continuing with local fallback store only.', new Error(`HTTP ${response.status}: ${body}`));
  } catch (error) {
    markRemoteFailure('[Endee] Chunk upsert failed; continuing with local fallback store only.', error);
  }

  return {
    success: true,
    mode: getMode(),
    indexed: normalizedChunks.length,
    index_name: ENDEE_INDEX_NAME,
  };
}

async function search(queryEmbedding, topK = 5) {
  const safeTopK = Math.max(1, Number(topK) || 5);

  if (Array.isArray(queryEmbedding) && queryEmbedding.length) {
    await attemptRemoteSearchNotice(queryEmbedding, safeTopK);
  }

  return [...fallbackStore.values()]
    .map((record) => ({
      score: Number(cosineSimilarity(queryEmbedding, record.embedding).toFixed(6)),
      text: record.text,
      metadata: record.metadata,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, safeTopK);
}

function getStatus() {
  return {
    mode: getMode(),
    index_name: ENDEE_INDEX_NAME,
    remote_available: remoteState.available,
    fallback_size: fallbackStore.size,
    endee_url: ENDEE_URL,
    last_error: remoteState.lastError,
  };
}

function getFallbackSample() {
  const firstRecord = fallbackStore.values().next().value;

  if (!firstRecord) {
    return null;
  }

  return {
    score: 1,
    text: firstRecord.text,
    metadata: firstRecord.metadata,
  };
}

export default {
  createIndex,
  upsertChunks,
  search,
  getStatus,
  getFallbackSample,
};
