import crypto from 'node:crypto';
import { createClient } from 'redis';

export async function createAuthCodeStore() {
  const memory = new Map();
  const redisUrl = String(process.env.REDIS_URL || '').trim();
  let redis = null;
  let redisReady = false;

  function key(code) {
    return `wpgo:mcp:oauth:code:${crypto.createHash('sha256').update(String(code)).digest('hex')}`;
  }
  function cleanupMemory() {
    const now = Date.now();
    for (const [code, row] of memory) if (!row || row.expiresAt < now) memory.delete(code);
  }
  setInterval(cleanupMemory, 60000).unref();

  if (redisUrl) {
    redis = createClient({ url: redisUrl });
    redis.on('error', error => {
      redisReady = false;
      console.error(JSON.stringify({event:'oauth_state_store_error',message:String(error?.message||error).slice(0,300)}));
    });
    redis.on('ready', () => { redisReady = true; });
    redis.on('end', () => { redisReady = false; });
    try {
      await redis.connect();
      redisReady = true;
      console.log(JSON.stringify({event:'oauth_state_store_ready',backend:'redis'}));
    } catch (error) {
      redisReady = false;
      console.error(JSON.stringify({event:'oauth_state_store_fallback',backend:'memory',message:String(error?.message||error).slice(0,300)}));
    }
  }

  return {
    mode() { return redisUrl ? (redisReady ? 'redis' : 'memory-fallback') : 'memory'; },
    async put(code, row) {
      memory.set(code, row);
      if (redis && redisReady) {
        const ttl = Math.max(1, Math.ceil((Number(row?.expiresAt || Date.now()+300000) - Date.now()) / 1000));
        await redis.set(key(code), JSON.stringify(row), { EX: ttl, NX: true });
      }
    },
    async take(code) {
      if (redis && redisReady) {
        try {
          const raw = await redis.sendCommand(['GETDEL', key(code)]);
          memory.delete(code);
          return raw ? JSON.parse(raw) : null;
        } catch (error) {
          console.error(JSON.stringify({event:'oauth_state_store_take_fallback',message:String(error?.message||error).slice(0,300)}));
        }
      }
      const row = memory.get(code) || null;
      memory.delete(code);
      return row;
    }
  };
}
