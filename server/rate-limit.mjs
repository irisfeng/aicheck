const stores = new Map();

export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || "unknown";
}

function getStoreKey(key, identity) {
  return `${key}:${identity}`;
}

function readRecord(storeKey, windowMs) {
  const now = Date.now();
  const record = stores.get(storeKey);

  if (!record || record.resetAt <= now) {
    return {
      count: 0,
      resetAt: now + windowMs,
    };
  }

  return record;
}

export function getRateLimitStatus({ key, identity, windowMs, max }) {
  const storeKey = getStoreKey(key, identity);
  const now = Date.now();
  const record = readRecord(storeKey, windowMs);

  return {
    limited: record.count >= max,
    retryAfterSeconds: Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
  };
}

export function consumeRateLimit({ key, identity, windowMs }) {
  const storeKey = getStoreKey(key, identity);
  const record = readRecord(storeKey, windowMs);
  record.count += 1;
  stores.set(storeKey, record);
  return record;
}

export function resetRateLimit({ key, identity }) {
  stores.delete(getStoreKey(key, identity));
}

export function createRateLimitMiddleware({ key, windowMs, max, message }) {
  return function rateLimitMiddleware(req, res, next) {
    const identity = getClientIp(req);
    const status = getRateLimitStatus({
      key,
      identity,
      windowMs,
      max,
    });

    if (status.limited) {
      res.setHeader("Retry-After", String(status.retryAfterSeconds));
      return res.status(429).json({
        error: message,
      });
    }

    consumeRateLimit({
      key,
      identity,
      windowMs,
    });
    next();
  };
}
