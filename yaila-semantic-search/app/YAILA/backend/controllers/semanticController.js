import { asyncHandler } from '../lib/asyncHandler.js';
import { getSemanticProbe, indexSemanticDocument, searchSemanticDocuments } from '../services/semanticSearchService.js';

export const indexSemantic = asyncHandler(async (req, res) => {
  const result = await indexSemanticDocument(req.body || {});
  res.json(result);
});

export const searchSemantic = asyncHandler(async (req, res) => {
  const result = await searchSemanticDocuments(req.body || {});
  res.json(result);
});

export const testEndee = asyncHandler(async (req, res) => {
  const result = await getSemanticProbe();
  res.json(result);
});
