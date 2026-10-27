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

function meaningfulEvent(existing, row, next) {
  if (!existing && next.connected_at) return 'connected';
  if (row.connected_at && row.connected_at !== existing?.connected_at) return 'connected';
  if (row.last_refresh_at && row.last_refresh_at !== existing?.last_refresh_at) return 'token_refreshed';
  if (row.status && row.status !== existing?.status) return 'status_changed';
  if (row.reason && row.reason !== existing?.reason) return 'status_reason_changed';
  return '';
}

export async function createConnectionStore({ secretFingerprint = '' } = {}) {
  const memory = new Map();
  const memoryHistory = new Map();
  const redisUrl = String(process.env.REDIS_URL || '').trim();
  const requireShared = String(
    process.env.WPGO_REQUIRE_SHARED_OAUTH_STATE || (process.env.NODE_ENV === 'production' ? '1' : '0')
  ) === '1';
  let redis = null;
  let redisReady = false;

  const secretKey = 'wpgo:mcp:secret-fingerprint:v1';
  const ttlSeconds = 60 * 60 * 24 * 100;
  const historyLimit = 25;

  function siteKey(site) {
    return `wpgo:mcp:connection:site:${digest(site)}`;
  }

  function connectionKey(site, clientId) {
    return `wpgo:mcp:connection:${digest(`${site}|${clientId}`)}`;
  }

  function historyKey(site) {
    return `wpgo:mcp:connection-history:${digest(site)}`;
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

  async function appendHistory(site, event) {
    if (!site || !event) return;
    const encoded = JSON.stringify(event);
    if (redis && redisReady) {
      try {
        await redis.multi()
          .lPush(historyKey(site), encoded)
          .lTrim(historyKey(site), 0, historyLimit - 1)
          .expire(historyKey(site), ttlSeconds)
          .exec();
        return;
      } catch (error) {
        redisReady = false;
        console.error(JSON.stringify({ event: 'connection_history_write_error', message: String(error?.message || error).slice(0, 300) }));
        if (requireShared) throw sharedUnavailable();
      }
    } else if (requireShared) {
      throw sharedUnavailable();
    }
    const key = historyKey(site);
    const rows = memoryHistory.get(key) || [];
    rows.unshift(event);
    memoryHistory.set(key, rows.slice(0, historyLimit));
  }

  async function history(site) {
    if (!site) return [];
    if (redis && redisReady) {
      try {
        const rows = await redis.lRange(historyKey(site), 0, historyLimit - 1);
        return rows.map(value => {
          try { return JSON.parse(value); } catch { return null; }
        }).filter(Boolean);
      } catch (error) {
        redisReady = false;
        console.error(JSON.stringify({ event: 'connection_history_read_error', message: String(error?.message || error).slice(0, 300) }));
        if (requireShared) throw sharedUnavailable();
      }
    } else if (requireShared) {
      throw sharedUnavailable();
    }
    return memoryHistory.get(historyKey(site)) || [];
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
      reason: String(row.reason || existing?.reason || '').slice(0, 160),
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
      } catch (error) {
        redisReady = false;
        console.error(JSON.stringify({ event: 'connection_state_write_error', message: String(error?.message || error).slice(0, 300) }));
        if (requireShared) throw sharedUnavailable();
      }
    } else if (requireShared) {
      throw sharedUnavailable();
    } else {
      memory.set(siteKey(site), next);
      memory.set(connectionKey(site, clientId), next);
    }

    const eventType = String(row.event_type || meaningfulEvent(existing, row, next));
    if (eventType) {
      await appendHistory(site, {
        type: eventType.slice(0, 60),
        client_name: next.client_name,
        status: next.status,
        reason: next.reason,
        time: now
      });
    }
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
    async getHistory(site) {
      return history(site);
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
      memoryHistory.clear();
    }
  };
}
