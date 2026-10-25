import crypto from 'node:crypto';
import { createClient } from 'redis';

export async function createAuthCodeStore() {
  const memory = new Map();
  const redisUrl = String(process.env.REDIS_URL || '').trim();
  const requireShared = String(
    process.env.WPGO_REQUIRE_SHARED_OAUTH_STATE || (process.env.NODE_ENV === 'production' ? '1' : '0')
  ) === '1';
  let redis = null;
  let redisReady = false;

  function key(code) {
    return `wpgo:mcp:oauth:code:${crypto.createHash('sha256').update(String(code)).digest('hex')}`;
  }

  function cleanupMemory() {
    const now = Date.now();
    for (const [code, row] of memory) {
      if (!row || Number(row.expiresAt || 0) < now) memory.delete(code);
    }
  }

  function sharedUnavailable() {
    const error = new Error('Shared OAuth state store is unavailable.');
    error.code = 'oauth_state_store_unavailable';
    return error;
  }

  setInterval(cleanupMemory, 60000).unref();

  if (!redisUrl && requireShared) {
    throw new Error('REDIS_URL is required when WPGO_REQUIRE_SHARED_OAUTH_STATE=1.');
  }

  if (redisUrl) {
    redis = createClient({ url: redisUrl });
    redis.on('error', error => {
      redisReady = false;
      console.error(JSON.stringify({
        event: 'oauth_state_store_error',
        message: String(error?.message || error).slice(0, 300)
      }));
    });
    redis.on('ready', () => { redisReady = true; });
    redis.on('end', () => { redisReady = false; });

    try {
      await redis.connect();
      redisReady = true;
      console.log(JSON.stringify({ event: 'oauth_state_store_ready', backend: 'redis' }));
    } catch (error) {
      redisReady = false;
      if (requireShared) throw error;
      console.error(JSON.stringify({
        event: 'oauth_state_store_fallback',
        backend: 'memory',
        message: String(error?.message || error).slice(0, 300)
      }));
    }
  }

  return {
    mode() {
      if (!redisUrl) return 'memory';
      return redisReady ? 'redis' : (requireShared ? 'redis-unavailable' : 'memory-fallback');
    },

    ready() {
      return requireShared ? Boolean(redisReady) : true;
    },

    requiresShared() {
      return requireShared;
    },

    async put(code, row) {
      if (!code || !row || Number(row.expiresAt || 0) <= Date.now()) {
        throw new Error('Refused invalid OAuth authorization-code state.');
      }

      if (redis && redisReady) {
        const ttl = Math.max(1, Math.ceil((Number(row.expiresAt) - Date.now()) / 1000));
        const result = await redis.set(key(code), JSON.stringify(row), { EX: ttl, NX: true });
        if (result !== 'OK') throw new Error('OAuth authorization code collision.');
        if (!requireShared) memory.set(code, row);
        return;
      }

      if (requireShared) throw sharedUnavailable();
      memory.set(code, row);
    },

    async take(code) {
      if (redis && redisReady) {
        try {
          const raw = await redis.sendCommand(['GETDEL', key(code)]);
          memory.delete(code);
          return raw ? JSON.parse(raw) : null;
        } catch (error) {
          redisReady = false;
          console.error(JSON.stringify({
            event: 'oauth_state_store_take_error',
            message: String(error?.message || error).slice(0, 300)
          }));
          if (requireShared) throw sharedUnavailable();
        }
      } else if (requireShared) {
        throw sharedUnavailable();
      }

      const row = memory.get(code) || null;
      memory.delete(code);
      return row;
    },

    async close() {
      if (redis?.isOpen) {
        try { await redis.quit(); } catch { redis.destroy(); }
      }
      redisReady = false;
      memory.clear();
    }
  };
}
