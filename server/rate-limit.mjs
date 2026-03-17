const stores = new Map();

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || "unknown";
}

export function createRateLimitMiddleware({ key, windowMs, max, message }) {
  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const storeKey = `${key}:${getClientIp(req)}`;
    const record = stores.get(storeKey);

    if (!record || record.resetAt <= now) {
      stores.set(storeKey, {
        count: 1,
        resetAt: now + windowMs,
      });
      return next();
    }

    if (record.count >= max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        error: message,
      });
    }

    record.count += 1;
    stores.set(storeKey, record);
    next();
  };
}
