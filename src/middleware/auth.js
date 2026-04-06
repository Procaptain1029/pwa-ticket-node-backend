import { createUserClient, supabaseAdmin } from '../config/supabase.js';

/**
 * Authentication middleware - validates Supabase JWT token
 */
export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'No authorization token provided',
        code: 'AUTH_MISSING_TOKEN'
      });
    }

    const token = authHeader.split(' ')[1];
    
    // Verify token with Supabase
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ 
        error: 'Invalid or expired token',
        code: 'AUTH_INVALID_TOKEN'
      });
    }

    // Get user profile from our users table
    const { data: userProfile, error: profileError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError || !userProfile) {
      return res.status(401).json({ 
        error: 'User profile not found',
        code: 'AUTH_NO_PROFILE'
      });
    }

    if (!userProfile.is_active) {
      return res.status(403).json({ 
        error: 'User account is deactivated',
        code: 'AUTH_USER_INACTIVE'
      });
    }

    // Attach user info and token to request
    req.user = userProfile;
    req.authUser = user;
    req.accessToken = token;
    req.supabase = createUserClient(token);
    
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(500).json({ 
      error: 'Authentication failed',
      code: 'AUTH_ERROR'
    });
  }
};

/**
 * Role-based authorization middleware
 * @param {string[]} allowedRoles - Array of roles allowed to access the route
 */
export const authorize = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        error: 'Authentication required',
        code: 'AUTH_REQUIRED'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: 'Insufficient permissions',
        code: 'AUTH_FORBIDDEN',
        required: allowedRoles,
        current: req.user.role
      });
    }

    next();
  };
};

/**
 * Optional authentication - continues if no token, but validates if present
 */
export const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  return authenticate(req, res, next);
};
