/**
 * API Key authentication middleware for external service integrations (e.g. PUTIX).
 *
 * Expects header:  X-API-Key: <key>
 *
 * The key is validated against PUTIX_API_KEY in .env.
 * If both API key and Bearer JWT are provided, API key takes priority for
 * service-to-service calls, and req.user is set to a synthetic service account.
 */
export const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({
      error: 'API key required. Send header X-API-Key.',
      code: 'API_KEY_MISSING'
    });
  }

  const validKey = process.env.PUTIX_API_KEY;

  if (!validKey) {
    console.error('[API-KEY] PUTIX_API_KEY not configured in environment');
    return res.status(500).json({
      error: 'API key authentication not configured on server',
      code: 'API_KEY_NOT_CONFIGURED'
    });
  }

  // Constant-time comparison to prevent timing attacks
  if (apiKey.length !== validKey.length || !timingSafeEqual(apiKey, validKey)) {
    return res.status(401).json({
      error: 'Invalid API key',
      code: 'API_KEY_INVALID'
    });
  }

  // Attach a synthetic service identity so downstream code can use req.user
  req.user = {
    id: '00000000-0000-0000-0000-000000000000',
    email: 'putix-service@system',
    full_name: 'PUTIX Service',
    role: 'service',
    is_active: true
  };
  req.isServiceCall = true;

  next();
};

/**
 * Constant-time string comparison (avoids timing side-channel).
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
