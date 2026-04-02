import express from 'express';
import { indexSemantic, searchSemantic } from '../controllers/semanticController.js';

const router = express.Router();

router.post('/index', indexSemantic);
router.post('/search', searchSemantic);

export default router;
