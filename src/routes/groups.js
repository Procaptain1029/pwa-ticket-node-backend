import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  computeGroupStats,
  saveGroupSnapshot,
  classifyCategory,
  recalculateAllGroups,
  getGroupHistory,
  getLatestGroupRankings
} from '../services/groupAnalytics.js';

const router = Router();

// Apply authentication to all routes
router.use(authenticate);

// Validation schemas
const createGroupSchema = z.object({
  code: z.string().min(1, 'Code is required').max(50),
  name: z.string().min(1, 'Name is required').max(100),
  description: z.string().optional()
});

const updateGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  is_active: z.boolean().optional(),
  category: z.enum(['A', 'B', 'C']).optional().nullable()
});

/**
 * GET /api/groups
 * List all groups
 */
router.get('/', asyncHandler(async (req, res) => {
  const { active_only } = req.query;
  
  let query = supabaseAdmin
    .from('groups')
    .select('*')
    .order('name', { ascending: true });
  
  if (active_only === 'true') {
    query = query.eq('is_active', true);
  }
  
  const { data, error } = await query;
  
  if (error) throw error;
  
  res.json({ groups: data });
}));

/**
 * POST /api/groups
 * Create new group (admin only)
 */
router.post('/',
  authorize(['admin']),
  asyncHandler(async (req, res) => {
    const validated = createGroupSchema.parse(req.body);
    
    const { data, error } = await supabaseAdmin
      .from('groups')
      .insert(validated)
      .select()
      .single();
    
    if (error) {
      if (error.code === '23505') { // Unique constraint violation
        return res.status(400).json({
          error: 'Group code already exists',
          code: 'DUPLICATE_CODE'
        });
      }
      throw error;
    }
    
    res.status(201).json({ group: data });
  })
);

/**
 * PUT /api/groups/:id
 * Update group (admin only)
 */
router.put('/:id',
  authorize(['admin']),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const validated = updateGroupSchema.parse(req.body);
    
    const { data, error } = await supabaseAdmin
      .from('groups')
      .update(validated)
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ group: data });
  })
);

/**
 * DELETE /api/groups/:id
 * Deactivate group (soft delete)
 */
router.delete('/:id',
  authorize(['admin']),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    const { data, error } = await supabaseAdmin
      .from('groups')
      .update({ is_active: false })
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ 
      message: 'Group deactivated',
      group: data 
    });
  })
);

// ═══════════════════════════════════════════════════════════════
// GROUP ANALYTICS ENDPOINTS
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/groups/analytics/rankings
 * Get latest monthly analytics for all groups (dashboard view).
 */
router.get('/analytics/rankings', asyncHandler(async (req, res) => {
  const rankings = await getLatestGroupRankings();
  res.json({ rankings });
}));

/**
 * GET /api/groups/:code/analytics
 * Get analytics history for a specific group.
 * Query params: ?months=12 (default 12)
 */
router.get('/:code/analytics', asyncHandler(async (req, res) => {
  const { code } = req.params;
  const months = Math.min(parseInt(req.query.months) || 12, 24);

  const history = await getGroupHistory(code, months);

  // Also get the group record to include current category
  const { data: group } = await supabaseAdmin
    .from('groups')
    .select('id, code, name, category, category_updated_at')
    .eq('code', code)
    .maybeSingle();

  res.json({ group: group || { code }, history });
}));

/**
 * POST /api/groups/analytics/recalculate
 * Recalculate analytics for all groups in a given month.
 * Body: { month: "2025-06" } (optional, defaults to current month)
 * Admin only.
 */
router.post('/analytics/recalculate',
  authorize(['admin']),
  asyncHandler(async (req, res) => {
    const { month } = req.body;
    const result = await recalculateAllGroups(month || undefined);
    res.json(result);
  })
);

/**
 * PUT /api/groups/:id/category
 * Manually set category for a group (admin override).
 */
router.put('/:id/category',
  authorize(['admin']),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const schema = z.object({ category: z.enum(['A', 'B', 'C']).nullable() });
    const { category } = schema.parse(req.body);

    const { data, error } = await supabaseAdmin
      .from('groups')
      .update({ category, category_updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ group: data });
  })
);

export default router;
