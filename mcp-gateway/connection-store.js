import crypto from 'node:crypto';
import { createClient } from 'redis';

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''), 'utf8');
  const right = Buffer.from(String(rightValue || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function createConnectionStore({ secretFingerprint = '' } = {}) {
  const memory = new Map();
  const redisUrl = String(process.env.REDIS_URL || '').trim();
  const requireShared = String(
    process.env.WPGO_REQUIRE_SHARED_OAUTH_STATE || (process.env.NODE_ENV === 'production' ? '1' : '0')
  ) === '1';
  let redis = null;
  let redisReady = false;

  const secretKey = 'wpgo:mcp:secret-fingerprint:v1';
  const ttlSeconds = 60 * 60 * 24 * 100;

  function siteKey(site) {
    return `wpgo:mcp:connection:site:${digest(site)}`;
  }

  function connectionKey(site, clientId) {
    return `wpgo:mcp:connection:${digest(`${site}|${clientId}`)}`;
  }

  function sharedUnavailable() {
    const error = new Error('Shared WPGo connection state is unavailable.');
    error.code = 'connection_state_store_unavailable';
    return error;
  }

  async function assertSecretContinuity() {
    if (!redis || !redisReady || !secretFingerprint) return;
    const result = await redis.set(secretKey, secretFingerprint, { NX: true });
    if (result === 'OK') return;
    const existing = await redis.get(secretKey);
    if (!existing || !safeEqual(existing, secretFingerprint)) {
      const error = new Error('WPGO_MCP_SECRET changed while persistent OAuth state exists. Refusing to invalidate existing AI connections.');
      error.code = 'mcp_secret_continuity_violation';
      throw error;
    }
  }

  if (!redisUrl && requireShared) {
    throw new Error('REDIS_URL is required for durable WPGo connection state in production.');
  }

  if (redisUrl) {
    redis = createClient({ url: redisUrl });
    redis.on('error', error => {
      redisReady = false;
      console.error(JSON.stringify({
        event: 'connection_state_store_error',
        message: String(error?.message || error).slice(0, 300)
      }));
    });
    redis.on('ready', () => { redisReady = true; });
    redis.on('end', () => { redisReady = false; });
    try {
      await redis.connect();
      redisReady = true;
      await assertSecretContinuity();
      console.log(JSON.stringify({ event: 'connection_state_store_ready', backend: 'redis' }));
    } catch (error) {
      redisReady = false;
      try { if (redis?.isOpen) await redis.quit(); } catch {}
      if (requireShared || error?.code === 'mcp_secret_continuity_violation') throw error;
      console.error(JSON.stringify({
        event: 'connection_state_store_fallback',
        backend: 'memory',
        message: String(error?.message || error).slice(0, 300)
      }));
    }
  }

  async function read(site) {
    if (!site) return null;
    if (redis && redisReady) {
      try {
        const raw = await redis.get(siteKey(site));
        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        redisReady = false;
        console.error(JSON.stringify({ event: 'connection_state_read_error', message: String(error?.message || error).slice(0, 300) }));
        if (requireShared) throw sharedUnavailable();
      }
    } else if (requireShared) {
      throw sharedUnavailable();
    }
    return memory.get(siteKey(site)) || null;
  }

  async function write(row) {
    const site = String(row?.site || '');
    const clientId = String(row?.client_id || '');
    if (!site || !clientId) return null;
    const existing = await read(site).catch(() => null);
    const now = new Date().toISOString();
    const next = {
      ...(existing && existing.client_key === digest(clientId) ? existing : {}),
      site,
      client_key: digest(clientId),
      client_name: String(row.client_name || existing?.client_name || 'MCP client').slice(0, 120),
      resource: String(row.resource || existing?.resource || '').slice(0, 4096),
      status: String(row.status || existing?.status || 'unknown').slice(0, 60),
      reason: String(row.reason || '').slice(0, 160),
      authorized_at: row.authorized_at || existing?.authorized_at || null,
      connected_at: row.connected_at || existing?.connected_at || null,
      last_refresh_at: row.last_refresh_at || existing?.last_refresh_at || null,
      last_seen_at: row.last_seen_at || existing?.last_seen_at || null,
      refresh_expires_at: row.refresh_expires_at || existing?.refresh_expires_at || null,
      updated_at: now
    };
    const encoded = JSON.stringify(next);
    if (redis && redisReady) {
      try {
        await redis.multi()
          .set(siteKey(site), encoded, { EX: ttlSeconds })
          .set(connectionKey(site, clientId), encoded, { EX: ttlSeconds })
          .exec();
        return next;
      } catch (error) {
        redisReady = false;
        console.error(JSON.stringify({ event: 'connection_state_write_error', message: String(error?.message || error).slice(0, 300) }));
        if (requireShared) throw sharedUnavailable();
      }
    } else if (requireShared) {
      throw sharedUnavailable();
    }
    memory.set(siteKey(site), next);
    memory.set(connectionKey(site, clientId), next);
    return next;
  }

  return {
    mode() {
      if (!redisUrl) return 'memory';
      return redisReady ? 'redis' : (requireShared ? 'redis-unavailable' : 'memory-fallback');
    },
    ready() {
      return requireShared ? Boolean(redisReady) : true;
    },
    async getBySite(site) {
      return read(site);
    },
    async record(row) {
      return write(row);
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
