import { Router } from 'express';
import { z } from 'zod';
import { supabase, supabaseAdmin } from '../config/supabase.js';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

// Validation schemas
const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password must be at least 6 characters')
});

const registerSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  full_name: z.string().min(2, 'Name must be at least 2 characters'),
  role: z.enum(['operator', 'dispatcher', 'seller', 'admin']).optional()
});

/**
 * POST /api/auth/login
 * Login with email and password
 */
router.post('/login', asyncHandler(async (req, res) => {
  const validated = loginSchema.parse(req.body);
  
  const { data, error } = await supabase.auth.signInWithPassword({
    email: validated.email,
    password: validated.password
  });
  
  if (error) {
    return res.status(401).json({
      error: 'Invalid credentials',
      code: 'AUTH_INVALID_CREDENTIALS'
    });
  }
  
  // Get user profile
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('id', data.user.id)
    .single();
  
  if (profileError || !profile) {
    return res.status(401).json({
      error: 'User profile not found',
      code: 'AUTH_NO_PROFILE'
    });
  }
  
  if (!profile.is_active) {
    return res.status(403).json({
      error: 'Tu cuenta está pendiente de aprobación por un administrador',
      code: 'AUTH_ACCOUNT_INACTIVE'
    });
  }
  
  res.json({
    user: profile,
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at
    }
  });
}));

/**
 * POST /api/auth/register
 * Register a new user (admin only in production)
 */
router.post('/register', asyncHandler(async (req, res) => {
  const validated = registerSchema.parse(req.body);
  
  // Create auth user
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email: validated.email,
    password: validated.password,
    email_confirm: true
  });
  
  if (authError) {
    if (authError.message.includes('already registered')) {
      return res.status(400).json({
        error: 'Email already registered',
        code: 'AUTH_EMAIL_EXISTS'
      });
    }
    throw authError;
  }
  
  // Create user profile (inactive by default - requires admin approval)
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .insert({
      id: authData.user.id,
      email: validated.email,
      full_name: validated.full_name,
      role: validated.role || 'operator',
      is_active: false // New users require admin approval
    })
    .select()
    .single();
  
  if (profileError) {
    // Rollback: delete auth user
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    throw profileError;
  }
  
  res.status(201).json({
    message: 'User created successfully. Account pending admin approval.',
    user: profile,
    pending_approval: true
  });
}));

/**
 * POST /api/auth/logout
 * Logout current session
 */
router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  const { error } = await supabase.auth.signOut();
  
  if (error) {
    console.error('Logout error:', error);
  }
  
  res.json({ message: 'Logged out successfully' });
}));

/**
 * POST /api/auth/refresh
 * Refresh access token
 */
router.post('/refresh', asyncHandler(async (req, res) => {
  const { refresh_token } = req.body;
  
  if (!refresh_token) {
    return res.status(400).json({
      error: 'Refresh token required',
      code: 'AUTH_NO_REFRESH_TOKEN'
    });
  }
  
  const { data, error } = await supabase.auth.refreshSession({
    refresh_token
  });
  
  if (error) {
    return res.status(401).json({
      error: 'Invalid refresh token',
      code: 'AUTH_INVALID_REFRESH'
    });
  }
  
  res.json({
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at
    }
  });
}));

/**
 * GET /api/auth/me
 * Get current user profile
 */
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  res.json({ user: req.user });
}));

/**
 * PUT /api/auth/password
 * Change password
 */
router.put('/password', authenticate, asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;
  
  if (!current_password || !new_password) {
    return res.status(400).json({
      error: 'Current and new password required',
      code: 'AUTH_PASSWORDS_REQUIRED'
    });
  }
  
  if (new_password.length < 6) {
    return res.status(400).json({
      error: 'New password must be at least 6 characters',
      code: 'AUTH_PASSWORD_TOO_SHORT'
    });
  }
  
  // Verify current password
  const { error: verifyError } = await supabase.auth.signInWithPassword({
    email: req.user.email,
    password: current_password
  });
  
  if (verifyError) {
    return res.status(401).json({
      error: 'Current password is incorrect',
      code: 'AUTH_WRONG_PASSWORD'
    });
  }
  
  // Update password
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
    req.user.id,
    { password: new_password }
  );
  
  if (updateError) throw updateError;
  
  res.json({ message: 'Password updated successfully' });
}));

export default router;
