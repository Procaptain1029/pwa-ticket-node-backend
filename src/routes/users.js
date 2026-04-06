import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

// Apply authentication to all routes
router.use(authenticate);

// Validation schemas
const updateUserSchema = z.object({
  full_name: z.string().min(2).optional(),
  role: z.enum(['operator', 'dispatcher', 'seller', 'admin']).optional(),
  is_active: z.boolean().optional()
});

/**
 * GET /api/users
 * List all users (admin only)
 */
router.get('/',
  authorize(['admin', 'dispatcher']),
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 50, role, is_active } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let query = supabaseAdmin
      .from('users')
      .select('*', { count: 'exact' });
    
    if (role) query = query.eq('role', role);
    if (is_active !== undefined) query = query.eq('is_active', is_active === 'true');
    
    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);
    
    const { data, error, count } = await query;
    
    if (error) throw error;
    
    res.json({
      users: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        total_pages: Math.ceil(count / parseInt(limit))
      }
    });
  })
);

/**
 * GET /api/users/:id
 * Get single user
 */
router.get('/:id',
  authorize(['admin', 'dispatcher']),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', id)
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
      }
      throw error;
    }
    
    res.json({ user });
  })
);

/**
 * PUT /api/users/:id
 * Update user (admin only)
 */
router.put('/:id',
  authorize(['admin']),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const validated = updateUserSchema.parse(req.body);
    
    // Prevent self-demotion from admin
    if (id === req.user.id && validated.role && validated.role !== 'admin') {
      return res.status(400).json({
        error: 'Cannot change your own admin role',
        code: 'SELF_DEMOTION'
      });
    }
    
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .update(validated)
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ user });
  })
);

/**
 * DELETE /api/users/:id
 * Deactivate user (soft delete)
 */
router.delete('/:id',
  authorize(['admin']),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    // Prevent self-deletion
    if (id === req.user.id) {
      return res.status(400).json({
        error: 'Cannot deactivate your own account',
        code: 'SELF_DELETE'
      });
    }
    
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .update({ is_active: false })
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ 
      message: 'User deactivated',
      user 
    });
  })
);

/**
 * GET /api/users/stats/overview
 * Get user statistics
 */
router.get('/stats/overview',
  authorize(['admin', 'dispatcher']),
  asyncHandler(async (req, res) => {
    // Total users by role
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('role, is_active');
    
    const byRole = users?.reduce((acc, u) => {
      acc[u.role] = (acc[u.role] || 0) + 1;
      return acc;
    }, {}) || {};
    
    const active = users?.filter(u => u.is_active).length || 0;
    const inactive = users?.filter(u => !u.is_active).length || 0;
    
    res.json({
      total: users?.length || 0,
      active,
      inactive,
      by_role: byRole
    });
  })
);

export default router;
