// Trycord Backend Enhancements
// Major functionality improvements for production stability and performance

const db = require('../db');
const { now, uuid } = require('../util');
const crypto = require('crypto');

// ============================================================================
// PERFORMANCE OPTIMIZATIONS
// ============================================================================

/**
 * Cache management system for reducing database queries
 */
class CacheManager {
  constructor() {
    this.cache = new Map();
    this.ttl = 5 * 60 * 1000; // 5 minutes default TTL
  }

  set(key, value, ttl = this.ttl) {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttl
    });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return item.value;
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  // Batch operations
  async batchSet(entries) {
    const promises = entries.map(([key, value]) => this.set(key, value));
    await Promise.all(promises);
  }

  async batchGet(keys) {
    const promises = keys.map(key => this.get(key));
    return Promise.all(promises);
  }
}

// Global cache instance
const cache = new CacheManager();

/**
 * Batch database queries for performance
 */
async function batchSelect(table, conditions = {}) {
  const { limit = 100, offset = 0, orderBy = 'created_at', order = 'DESC' } = conditions;

  const where = Object.entries(conditions)
    .filter(([key]) => key !== 'limit' && key !== 'offset' && key !== 'orderBy' && key !== 'order')
    .map(([key, value]) => `${key} = ?`)
    .join(' AND ');

  const query = `
    SELECT * FROM ${table}
    ${where ? `WHERE ${where}` : ''}
    ORDER BY ${orderBy} ${order}
    LIMIT ? OFFSET ?
  `;

  const params = Object.values(conditions)
    .filter(v => typeof v !== 'string' || (v !== 'limit' && v !== 'offset' && v !== 'orderBy' && v !== 'order'))
    .concat([limit, offset]);

  return await db.all(query, params);
}

/**
 * Optimized user search with caching
 */
async function optimizedUserSearch(query, options = {}) {
  const cacheKey = `user_search:${query}:${JSON.stringify(options)}`;

  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { limit = 10, excludeUserId = null } = options;

  let sql = `
    SELECT id, username, display_name, avatar, created_at
    FROM users
    WHERE username LIKE ? OR display_name LIKE ?
    ${excludeUserId ? 'AND id != ?' : ''}
    ORDER BY created_at DESC
    LIMIT ?
  `;

  const params = [
    `%${query}%`,
    `%${query}%`,
    ...(excludeUserId ? [excludeUserId] : []),
    limit
  ];

  const results = await db.all(sql, params);

  // Cache results
  cache.set(cacheKey, results, 30 * 1000); // 30 seconds

  return results;
}

// ============================================================================
// SECURITY ENHANCEMENTS
// ============================================================================

/**
 * Rate limiting system with IP-based tracking
 */
const rateLimiters = new Map();

function getRateLimiter(ip, key = 'default', window = 60 * 1000, max = 100) {
  const limiterKey = `${ip}:${key}`;

  if (!rateLimiters.has(limiterKey)) {
    rateLimiters.set(limiterKey, {
      count: 0,
      reset: Date.now() + window,
      ip,
      key
    });
  }

  return rateLimiters.get(limiterKey);
}

function checkRateLimit(ip, key = 'default', window = 60 * 1000, max = 100) {
  const limiter = getRateLimiter(ip, key, window, max);

  if (Date.now() > limiter.reset) {
    limiter.count = 0;
    limiter.reset = Date.now() + window;
  }

  if (limiter.count >= max) {
    return {
      allowed: false,
      remaining: 0,
      reset: limiter.reset
    };
  }

  limiter.count++;
  return {
    allowed: true,
    remaining: max - limiter.count,
    reset: limiter.reset
  };
}

/**
 * Rate limit decorator for routes
 */
function rateLimit(limit, window = 60 * 1000, key = 'default') {
  return (req, res, next) => {
    const limitResult = checkRateLimit(req.ip, key, window, limit);
    if (!limitResult.allowed) {
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((limitResult.reset - Date.now()) / 1000)
      });
    }

    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', limitResult.remaining);
    res.setHeader('X-RateLimit-Reset', Math.floor(limitResult.reset / 1000));
    next();
  };
}

/**
 * Request validation middleware
 */
function validateRequest(requiredFields) {
  return (req, res, next) => {
    const missing = requiredFields.filter(field => !(field in req.body));

    if (missing.length > 0) {
      return res.status(400).json({
        error: 'Missing required fields',
        fields: missing
      });
    }

    next();
  };
}

// ============================================================================
// ANALYTICS & MONITORING
// ============================================================================

/**
 * Activity tracking
 */
async function trackActivity(userId, activityType, metadata = {}) {
  const activity = {
    id: uuid(),
    user_id: userId,
    activity_type: activityType,
    metadata: JSON.stringify(metadata),
    ip_address: metadata.ip || null,
    user_agent: metadata.userAgent || null,
    created_at: now()
  };

  await db.run(
    'INSERT INTO user_activities (id, user_id, activity_type, metadata, ip_address, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      activity.id,
      activity.user_id,
      activity.activity_type,
      activity.metadata,
      activity.ip_address,
      activity.user_agent,
      activity.created_at
    ]
  );

  // Cleanup old activities
  const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await db.run(
    'DELETE FROM user_activities WHERE created_at < ?',
    [threeMonthsAgo]
  );

  return activity;
}

/**
 * Performance metrics collection
 */
const performanceMetrics = {
  queries: [],
  requests: [],
  errors: [],

  recordQuery(duration, query) {
    this.queries.push({
      duration,
      query: query.substring(0, 200),
      timestamp: Date.now()
    });

    // Keep only last 1000 queries
    if (this.queries.length > 1000) {
      this.queries = this.queries.slice(-1000);
    }
  },

  recordRequest(requestTime, route) {
    this.requests.push({
      requestTime,
      route,
      timestamp: Date.now()
    });

    if (this.requests.length > 1000) {
      this.requests = this.requests.slice(-1000);
    }
  },

  recordError(error, route) {
    this.errors.push({
      error: error.message,
      stack: error.stack,
      route,
      timestamp: Date.now()
    });

    if (this.errors.length > 1000) {
      this.errors = this.errors.slice(-1000);
    }
  }
};

// ============================================================================
// DATA INTEGRITY
// ============================================================================

/**
 * Sanitize user input
 */
function sanitizeInput(input, options = {}) {
  const {
    allowHTML = false,
    maxLength = null,
    sanitize = true
  } = options;

  let result = input;

  if (sanitize && !allowHTML) {
    result = result
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  if (maxLength && result.length > maxLength) {
    result = result.substring(0, maxLength);
  }

  return result;
}

/**
 * Validate email format
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate username format
 */
function isValidUsername(username) {
  const usernameRegex = /^[a-zA-Z0-9_]{3,32}$/;
  return usernameRegex.test(username);
}

/**
 * Validate password strength
 */
function isValidPassword(password) {
  const minLength = 12;
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);

  return (
    password.length >= minLength &&
    hasUpperCase &&
    hasLowerCase &&
    hasNumber &&
    hasSpecial
  );
}

// ============================================================================
// FILE HANDLING
// ============================================================================

/**
 * Safe file upload with validation
 */
async function validateAndStoreFile(file, options = {}) {
  const {
    maxSize = 10 * 1024 * 1024, // 10MB default
    allowedTypes = ['image/jpeg', 'image/png', 'image/gif'],
    sanitizeName = true
  } = options;

  // Validate file size
  if (file.size > maxSize) {
    throw new Error(`File size exceeds ${maxSize / 1024 / 1024}MB limit`);
  }

  // Validate file type
  if (allowedTypes.length > 0 && !allowedTypes.includes(file.mimetype)) {
    throw new Error('Invalid file type');
  }

  // Sanitize filename
  let filename = file.originalname || file.name;
  if (sanitizeName) {
    filename = crypto.randomBytes(16).toString('hex') + '.' + filename.split('.').pop();
  }

  return {
    filename,
    mimetype: file.mimetype,
    size: file.size,
    buffer: file.buffer
  };
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Custom error classes
 */
class TrycordError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

class ValidationError extends TrycordError {
  constructor(message) {
    super('VALIDATION_ERROR', message, 400);
  }
}

class NotFoundError extends TrycordError {
  constructor(resource = 'Resource') {
    super('NOT_FOUND', `${resource} not found`, 404);
  }
}

class PermissionError extends TrycordError {
  constructor(message = 'Permission denied') {
    super('PERMISSION_DENIED', message, 403);
  }
}

class RateLimitError extends TrycordError {
  constructor() {
    super('RATE_LIMIT', 'Too many requests', 429);
  }
}

/**
 * Error response formatter
 */
function formatErrorResponse(error) {
  if (error instanceof TrycordError) {
    return {
      error: error.message,
      code: error.code
    };
  }

  return {
    error: 'Internal server error',
    code: 'INTERNAL_ERROR'
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Pagination helper
 */
function createPagination(page = 1, limit = 20, total = 0) {
  const totalPages = Math.ceil(total / limit);
  const hasNext = page < totalPages;
  const hasPrevious = page > 1;

  return {
    page: Number(page),
    limit: Number(limit),
    total: Number(total),
    totalPages: Number(totalPages),
    hasNext: Boolean(hasNext),
    hasPrevious: Boolean(hasPrevious),
    next: hasNext ? `?page=${page + 1}&limit=${limit}` : null,
    previous: hasPrevious ? `?page=${page - 1}&limit=${limit}` : null
  };
}

/**
 * Generate pagination from request params
 */
function getPaginationParams(req, defaultLimit = 20) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || defaultLimit));

  return {
    page,
    limit,
    offset: (page - 1) * limit
  };
}

/**
 * Get user-friendly date
 */
function formatDate(date, format = 'relative') {
  const now = new Date();
  const diff = now - new Date(date);
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

  return new Date(date).toLocaleDateString();
}

/**
 * Generate unique ID
 */
function generateId(prefix = '', length = 8) {
  return prefix + crypto.randomBytes(length).toString('hex');
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Cache
  cache,
  CacheManager,

  // Performance
  batchSelect,
  optimizedUserSearch,

  // Security
  checkRateLimit,
  rateLimit,
  validateRequest,
  sanitizeInput,
  isValidEmail,
  isValidUsername,
  isValidPassword,

  // Analytics
  trackActivity,
  performanceMetrics,

  // File handling
  validateAndStoreFile,

  // Error handling
  TrycordError,
  ValidationError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  formatErrorResponse,

  // Utilities
  createPagination,
  getPaginationParams,
  formatDate,
  generateId
};