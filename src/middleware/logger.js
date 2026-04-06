/**
 * Request logger middleware
 */
export const requestLogger = (req, res, next) => {
  const start = Date.now();
  
  // Log when response finishes
  res.on('finish', () => {
    const duration = Date.now() - start;
    const log = {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent'),
      userId: req.user?.id || 'anonymous'
    };
    
    // Color code by status
    let statusColor = '\x1b[32m'; // Green
    if (res.statusCode >= 400) statusColor = '\x1b[33m'; // Yellow
    if (res.statusCode >= 500) statusColor = '\x1b[31m'; // Red
    
    console.log(
      `${statusColor}[${log.method}]\x1b[0m ${log.path} - ${log.status} - ${log.duration}`
    );
  });
  
  next();
};
