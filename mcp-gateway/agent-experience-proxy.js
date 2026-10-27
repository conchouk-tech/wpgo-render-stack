import crypto from 'node:crypto';
import { repairAndValidateJsonSchema } from './schema-guard.js';
import {
  agentGuidanceForAbility,
  enrichAbilitySchema,
  normalizeManifest,
  preflightAbility,
  summarizeApproval
} from './agent-experience.js';

const upstreamFetch = globalThis.fetch.bind(globalThis);
const MANIFEST_TTL_MS = 60_000;
const manifestCache = new Map();

function requestUrl(input) {
  try {
    if (input instanceof URL) return new URL(input.toString());
    if (typeof input === 'string') return new URL(input);
    if (input && typeof input.url === 'string') return new URL(input.url);
  } catch {}
  return null;
}

function headerValue(input, init, name) {
  const headers = new Headers(init?.headers || (input && typeof input === 'object' ? input.headers : undefined));
  return headers.get(name) || '';
}

function siteBaseFromWpJson(url) {
  const marker = '/wp-json/';
  const index = url.pathname.indexOf(marker);
  if (index < 0) return '';
  const prefix = url.pathname.slice(0, index + 1);
  return `${url.origin}${prefix}`;
}

function manifestKey(siteBase, authorization) {
  const fingerprint = crypto.createHash('sha256').update(String(authorization || '')).digest('base64url').slice(0, 16);
  return `${siteBase}|${fingerprint}`;
}

async function manifestFor(siteBase, authorization) {
  if (!siteBase || !authorization) return normalizeManifest({});
  const key = manifestKey(siteBase, authorization);
  const cached = manifestCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.manifest;

  try {
    const url = new URL('wp-json/wpgo/v1/abilities/run', siteBase);
    const response = await upstreamFetch(url.toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: authorization,
        'User-Agent': 'WPGo-Agent-Experience/4.5.0-rc.3'
      },
      body: JSON.stringify({ ability: 'wpgo/platform-manifest', input: {} }),
      redirect: 'manual'
    });
    if (!response.ok) return normalizeManifest({});
    const data = await response.json();
    const manifest = normalizeManifest(data?.result ?? data);
    manifestCache.set(key, { manifest, expiresAt: Date.now() + MANIFEST_TTL_MS });
    if (manifestCache.size > 500) manifestCache.delete(manifestCache.keys().next().value);
    return manifest;
  } catch {
    return normalizeManifest({});
  }
}

function responseFromJson(source, data, status = source.status) {
  const headers = new Headers(source.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.delete('content-length');
  return new Response(JSON.stringify(data), {
    status,
    statusText: status === source.status ? source.statusText : '',
    headers
  });
}

function preflightErrorResponse(result) {
  return new Response(JSON.stringify({
    code: result.code || 'wpgo_preflight_failed',
    message: result.message || 'WPGo rejected the request during preflight.',
    data: {
      status: Number(result.status || 400),
      suggestion: result.suggestion || '',
      valid_commands: result.valid_commands || undefined,
      valid_recipes: result.valid_recipes || undefined,
      preflight: true,
      approval_created: false
    }
  }), {
    status: Number(result.status || 400),
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function parseJsonBody(body) {
  try {
    if (typeof body === 'string') return JSON.parse(body);
    if (body instanceof Uint8Array) return JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {}
  return null;
}

function relevantForCommandPreflight(ability) {
  return ['wpgo/command-read', 'wpgo/command-write', 'wpgo/create-job', 'wpgo/run-recipe'].includes(ability);
}

async function repairAbilityList(response, url, authorization) {
  let data;
  try { data = JSON.parse(await response.text()); }
  catch { return responseFromJson(response, [], response.status); }
  if (!Array.isArray(data)) return responseFromJson(response, data, response.status);

  const siteBase = siteBaseFromWpJson(url);
  const manifest = await manifestFor(siteBase, authorization);
  const repaired = [];

  for (const ability of data) {
    if (!ability || typeof ability !== 'object') continue;
    const copy = structuredClone(ability);
    try {
      const safeSchema = repairAndValidateJsonSchema(copy.input_schema || { type: 'object', additionalProperties: false });
      copy.input_schema = enrichAbilitySchema(String(copy.name || ''), safeSchema, manifest);
      copy.description = `${copy.description || copy.label || copy.name || ''}${agentGuidanceForAbility(String(copy.name || ''))}`.trim();
      repaired.push(copy);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'wpgo_invalid_ability_schema',
        ability: String(copy.name || ''),
        error: String(error?.message || error).slice(0, 500)
      }));
    }
  }

  return responseFromJson(response, repaired, response.status);
}

async function preflightAbilityRequest(input, init, url, authorization) {
  const method = String(init?.method || (input && typeof input === 'object' ? input.method : 'GET') || 'GET').toUpperCase();
  if (method !== 'POST' || !url.pathname.endsWith('/wp-json/wpgo/v1/abilities/run')) return null;
  const body = parseJsonBody(init?.body);
  if (!body || !relevantForCommandPreflight(String(body.ability || ''))) return null;

  const siteBase = siteBaseFromWpJson(url);
  const manifest = await manifestFor(siteBase, authorization);
  const result = preflightAbility(String(body.ability || ''), body.input || {}, manifest);
  if (!result.ok) return preflightErrorResponse(result);
  return { body, summary: summarizeApproval(String(body.ability || ''), body.input || {}) };
}

/**
 * Wrap the already SSRF-guarded fetch implementation. This means schema repair
 * and preflight apply uniformly to Claude, ChatGPT, Gemini and every other MCP
 * client without weakening the WordPress approval boundary.
 */
globalThis.fetch = async (input, init = {}) => {
  const url = requestUrl(input);
  if (!url) return upstreamFetch(input, init);
  const authorization = headerValue(input, init, 'authorization');

  const preflight = await preflightAbilityRequest(input, init, url, authorization);
  if (preflight instanceof Response) return preflight;

  const response = await upstreamFetch(input, init);

  if (
    response.ok &&
    url.pathname.endsWith('/wp-json/wp-abilities/v1/abilities') &&
    String(init?.method || 'GET').toUpperCase() === 'GET'
  ) {
    return repairAbilityList(response, url, authorization);
  }

  if (preflight && response.headers.get('content-type')?.includes('application/json')) {
    try {
      const data = JSON.parse(await response.text());
      if (data && typeof data === 'object') {
        const result = data.result && typeof data.result === 'object' ? data.result : data;
        if (result.approval_required || result.approval_id || result.approval_url) {
          result.approval_summary = preflight.summary;
          result.preflight_passed = true;
        }
        return responseFromJson(response, data, response.status);
      }
    } catch {
      return response;
    }
  }

  return response;
};
