# YAILA + Endee Semantic Search Demo

This workspace contains the existing YAILA application plus a small backend-first semantic search demo built around an Endee client abstraction.

The demo is intentionally additive:

- Existing YAILA document upload, extraction, chunking, AI, roadmap, graph, and quiz flows stay unchanged.
- New semantic-search demo routes are public and isolated under `/api/semantic`.
- Endee is treated as an optional external service at `http://localhost:8080`.
- If Endee is unavailable, the backend automatically falls back to an in-memory mock-safe store so the demo still works.

## Project Overview

- Endee source/fork lives in this repo root and is not required for the demo flow.
- YAILA app lives under `app/YAILA`.
- Backend lives under `app/YAILA/backend`.
- Frontend lives under `app/YAILA/frontend 2`.

The semantic demo is backend-first and interview-safe. You can demo it with curl even if there is no frontend running and no external Endee process available.

## How Endee Is Used

The backend uses an `endeeClient.js` abstraction with three core methods:

- `createIndex()`
- `upsertChunks(chunks)`
- `search(queryEmbedding, topK = 5)`

Behavior:

- `createIndex()` tries to create a demo index in Endee.
- `upsertChunks()` always mirrors chunk records into a local in-memory fallback store, and also tries to upsert them into Endee when available.
- `search()` returns JSON results from the local fallback store using cosine similarity over deterministic local embeddings.

This keeps the API stable and the demo reliable while avoiding MessagePack search decoding in v1.

## Architecture Summary

Public semantic demo flow:

1. `POST /api/semantic/index`
2. backend normalizes pasted text
3. backend reuses YAILA chunking where possible
4. backend falls back to a simple fixed-size chunker for short/plain demo text
5. backend generates deterministic local embeddings
6. backend calls `endeeClient.createIndex()` and `endeeClient.upsertChunks()`
7. backend stores safe fallback records in memory for search

Search flow:

1. `POST /api/semantic/search`
2. backend generates a deterministic local query embedding
3. backend calls `endeeClient.search()`
4. backend returns top semantic matches as JSON

## Setup

### Backend

Run from the backend directory:

```bash
cd app/YAILA/backend
npm install
npm run dev
```

Backend default API base:

```text
http://localhost:5001/api
```

Optional Endee runtime:

- Expected URL: `http://localhost:8080`
- If Endee is not running, the semantic demo still works in mock/fallback mode.

## Demo Flow

### 1. Health check

```bash
curl http://localhost:5001/api/health
```

### 2. Endee probe

```bash
curl http://localhost:5001/api/test-endee
```

### 3. Index text

```bash
curl -X POST http://localhost:5001/api/semantic/index \
  -H "Content-Type: application/json" \
  -d '{
    "doc_name": "Logic Notes",
    "text": "Propositional logic studies statements and connectives. A conjunction is true when both operands are true. A disjunction is true when at least one operand is true. Implication is false only when the antecedent is true and the consequent is false."
  }'
```

### 4. Search

```bash
curl -X POST http://localhost:5001/api/semantic/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "When is implication false?",
    "topK": 3
  }'
```

## Public Endpoints

- `GET /api/test-endee`
- `POST /api/semantic/index`
- `POST /api/semantic/search`

## Limitations

- The fallback semantic store is in-memory only and resets when the backend restarts.
- `POST /api/semantic/index` accepts raw text only in this demo path. It does not fetch user-owned YAILA documents by ID because the route is intentionally public.
- Existing YAILA retrieval remains the primary app retrieval path. The Endee demo does not replace it.
- External Endee search is not decoded in v1 because the current server returns MessagePack for search responses. The demo stays JSON-first and fallback-safe instead.
