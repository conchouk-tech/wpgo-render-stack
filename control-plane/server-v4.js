import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

const VERSION = '4.5.2';
const nodeEnv = String(process.env.NODE_ENV || 'production').toLowerCase();
const port = Number(process.env.PORT || 8090);
const adminToken = process.env.WPGO_CONTROL_ADMIN_TOKEN || '';
const signingKeyPath = process.env.WPGO_SIGNING_KEY_PATH || '';
const storePath = process.env.WPGO_LICENSE_STORE || '';
const auditPath = process.env.WPGO_CONTROL_AUDIT_LOG || '';
const databaseUrl = String(process.env.DATABASE_URL || '');
const allowUnbound = process.env.WPGO_ALLOW_UNBOUND_LICENSES === '1';
const requireAccountEntitlement = nodeEnv === 'production' && process.env.WPGO_REQUIRE_ACCOUNT_ENTITLEMENT !== '0';
const staticRevokedIds = new Set(String(process.env.WPGO_REVOKED_LICENSE_IDS || '').split(',').map(v => v.trim()).filter(Boolean));
const release = {
  version: process.env.WPGO_RELEASE_VERSION || '4.5.0',
  package: process.env.WPGO_RELEASE_PACKAGE || '',
  sha256: (process.env.WPGO_RELEASE_SHA256 || '').toLowerCase(),
  url: process.env.WPGO_RELEASE_URL || '',
  requires: process.env.WPGO_RELEASE_REQUIRES || '6.9',
  tested: process.env.WPGO_RELEASE_TESTED || '7.1.3',
  requires_php: process.env.WPGO_RELEASE_REQUIRES_PHP || '8.0',
  name: 'WPGo',
  sections: {
    description: 'Provider-neutral WordPress automation through secure MCP, approvals, commerce intelligence and site operations.',
    changelog: process.env.WPGO_RELEASE_CHANGELOG || 'See the bundled WPGo release notes.'
  }
};

function privateKeyPemFromSeed(seedText) {
  if (!seedText) return '';
  const seed = crypto.createHash('sha256').update(String(seedText)).digest();
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der = Buffer.concat([prefix, seed]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' }).toString();
}
function loadOrCreateSigningKey() {
  const fromEnv = (process.env.WPGO_SIGNING_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
  if (fromEnv) return fromEnv;
  const fromSeed = privateKeyPemFromSeed(process.env.WPGO_SIGNING_SEED || '');
  if (fromSeed) return fromSeed;
  if (!signingKeyPath) return '';
  try {
    if (fs.existsSync(signingKeyPath)) return fs.readFileSync(signingKeyPath, 'utf8');
    fs.mkdirSync(path.dirname(signingKeyPath), { recursive: true });
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.writeFileSync(signingKeyPath, pem, { mode: 0o600 });
    return pem;
  } catch (error) {
    console.error(JSON.stringify({ event:'signing_key_error', message:String(error?.message || error) }));
    return '';
  }
}
const privateKeyPem = loadOrCreateSigningKey();
const publicKey = privateKeyPem ? crypto.createPublicKey(privateKeyPem) : null;

if (nodeEnv === 'production') {
  const missing = [];
  if (adminToken.length < 32) missing.push('WPGO_CONTROL_ADMIN_TOKEN>=32chars');
  if (!privateKeyPem) missing.push('WPGO_SIGNING_SEED or WPGO_SIGNING_PRIVATE_KEY_PEM');
  if (!databaseUrl) missing.push('DATABASE_URL');
  if (missing.length) {
    console.error(JSON.stringify({ event:'startup_config_invalid', missing }));
    process.exit(1);
  }
}

const pool = databaseUrl ? new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized:false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000
}) : null;

async function initDb() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS wpgo_license_revocations (
    license_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT '',
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS wpgo_license_revocations_v2 (
    revocation_key TEXT PRIMARY KEY,
    license_id TEXT NOT NULL DEFAULT '',
    token_id TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS wpgo_license_revocations_v2_account_idx ON wpgo_license_revocations_v2(license_id)`);
}

let licenses = {};
function loadStore() {
  if (storePath && fs.existsSync(storePath)) {
    try { licenses = JSON.parse(fs.readFileSync(storePath, 'utf8')) || {}; return; } catch { licenses = {}; return; }
  }
  try { licenses = JSON.parse(process.env.WPGO_LICENSES_JSON || '{}') || {}; } catch { licenses = {}; }
}
function saveStore() {
  if (!storePath) return false;
  fs.mkdirSync(path.dirname(storePath), { recursive:true });
  const tmp = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(licenses, null, 2), { mode:0o600 });
  fs.renameSync(tmp, storePath);
  return true;
}
function audit(event, details = {}) {
  const record = { time:new Date().toISOString(), event, ...details };
  console.log(JSON.stringify({ event:'control_audit', ...record }));
  if (!auditPath) return;
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive:true });
    fs.appendFileSync(auditPath, JSON.stringify(record) + '\n', { mode:0o600 });
  } catch {}
}
loadStore();

class FixedWindowLimiter {
  constructor(limit=120, windowMs=60000, maxKeys=10000) { this.limit=limit; this.windowMs=windowMs; this.maxKeys=maxKeys; this.hits=new Map(); }
  limited(key) {
    const now=Date.now(); let state=this.hits.get(key);
    if (!state || now-state.start > this.windowMs) state={ start:now, count:0 };
    state.count++; this.hits.set(key,state);
    if (this.hits.size > this.maxKeys) this.sweep(now);
    return state.count > this.limit;
  }
  sweep(now=Date.now()) {
    for (const [k,v] of this.hits) if (now-v.start > this.windowMs) this.hits.delete(k);
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value);
  }
}
const limiter = new FixedWindowLimiter();
setInterval(() => limiter.sweep(), 5*60000).unref();

function sortDeep(value) { if (Array.isArray(value)) return value.map(sortDeep); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortDeep(value[k])])); return value; }
function canonical(value) { return JSON.stringify(sortDeep(value)); }
function sign(payload) { if (!privateKeyPem) return { payload, signature:'', signing:'disabled' }; return { payload, signature:crypto.sign(null, Buffer.from(canonical(payload)), privateKeyPem).toString('base64'), signing:'ed25519' }; }
function publicKeyBase64() { if (!publicKey) return ''; const pub=publicKey.export({ type:'spki', format:'der' }); return Buffer.from(pub).subarray(-32).toString('base64'); }
function bearer(req) { const v=req.get('authorization') || ''; return v.startsWith('Bearer ') ? v.slice(7).trim() : ''; }
function safeEqual(a,b) { const aa=Buffer.from(String(a)),bb=Buffer.from(String(b)); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
function adminAuthorized(req) { return adminToken.length>=32 && safeEqual(bearer(req),adminToken); }
function keyRef(key) { return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0,16); }
function siteHost(siteUrl) { try { const u=new URL(String(siteUrl||'')); if (!['http:','https:'].includes(u.protocol)) return ''; return u.hostname.toLowerCase().replace(/^www\./,''); } catch { return ''; } }
function validHost(host) { return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host); }
function normalizeHosts(values) { return [...new Set((Array.isArray(values)?values:[]).map(v=>String(v).trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*$/,'').replace(/^www\./,'')).filter(validHost))].slice(0,25); }
function cleanId(value,max=100) { return String(value||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,max); }
function cleanRecord(body={}) {
  const expires=body.expires_gmt ? new Date(body.expires_gmt) : null;
  return {
    license_id: cleanId(body.license_id || crypto.randomUUID(),80),
    token_id: cleanId(body.token_id || crypto.randomUUID(),100),
    status: ['active','revoked','suspended'].includes(String(body.status||'active')) ? String(body.status||'active') : 'active',
    plan: cleanId(body.plan || 'free',80),
    expires_gmt: expires && !Number.isNaN(expires.getTime()) ? expires.toISOString() : '',
    features: Array.isArray(body.features) ? [...new Set(body.features.map(v=>String(v).toLowerCase().replace(/[^a-z0-9_-]/g,'')).filter(Boolean))].slice(0,100) : [],
    site_hosts: normalizeHosts(body.site_hosts),
    issued_gmt: new Date().toISOString()
  };
}
function b64urlEncode(value) { return Buffer.from(value).toString('base64url'); }
function issueToken(record) {
  if (!privateKeyPem) throw new Error('signing_not_configured');
  const payload=b64urlEncode(canonical(record));
  const signingInput=`wpgo1.${payload}`;
  const signature=crypto.sign(null,Buffer.from(signingInput),privateKeyPem).toString('base64url');
  return `${signingInput}.${signature}`;
}
function parseToken(token) {
  if (!publicKey || typeof token!=='string' || !token.startsWith('wpgo1.') || token.length>8192) return null;
  const parts=token.split('.'); if (parts.length!==3 || parts[0]!=='wpgo1') return null;
  try {
    const signingInput=`${parts[0]}.${parts[1]}`;
    if (!crypto.verify(null,Buffer.from(signingInput),publicKey,Buffer.from(parts[2],'base64url'))) return null;
    const record=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
    return record && typeof record==='object' ? record : null;
  } catch { return null; }
}
function licenseLookup(key) {
  const stored=licenses[key]; if (stored && typeof stored==='object') return { record:stored, source:'store' };
  const token=parseToken(key); if (token) return { record:token, source:'signed-token' };
  return { record:null, source:'none' };
}
function tokenRevocationKey(record) { return record?.token_id ? `token:${cleanId(record.token_id,100)}` : ''; }
function accountRevocationKey(record) { return record?.license_id ? `account:${cleanId(record.license_id,80)}` : ''; }
async function dbRevocationStatus(record) {
  if (!pool || !record?.license_id) return false;
  const keys=[tokenRevocationKey(record),accountRevocationKey(record)].filter(Boolean);
  if (keys.length) {
    const r=await pool.query(`SELECT 1 FROM wpgo_license_revocations_v2 WHERE revocation_key = ANY($1::text[]) LIMIT 1`,[keys]);
    if (r.rows[0]) return true;
  }
  // Backward compatibility for the 4.5.1 account-level revocation table.
  const legacy=await pool.query(`SELECT 1 FROM wpgo_license_revocations WHERE license_id=$1 LIMIT 1`,[String(record.license_id)]);
  return Boolean(legacy.rows[0]);
}
async function writeRevocation({record,tokenId,licenseId,reason=''}) {
  if (!pool) throw new Error('database_not_configured');
  const resolvedToken=cleanId(record?.token_id || tokenId,100);
  const resolvedLicense=cleanId(record?.license_id || licenseId,80);
  const revocationKey=resolvedToken ? `token:${resolvedToken}` : (resolvedLicense ? `account:${resolvedLicense}` : '');
  if (!revocationKey) throw new Error('revocation_target_required');
  await pool.query(`INSERT INTO wpgo_license_revocations_v2(revocation_key,license_id,token_id,reason) VALUES($1,$2,$3,$4) ON CONFLICT(revocation_key) DO UPDATE SET reason=EXCLUDED.reason,updated_at=NOW()`,[revocationKey,resolvedLicense,resolvedToken,String(reason||'').slice(0,500)]);
  return { revocationKey, licenseId:resolvedLicense, tokenId:resolvedToken };
}
async function clearRevocation({record,tokenId,licenseId}) {
  if (!pool) throw new Error('database_not_configured');
  const resolvedToken=cleanId(record?.token_id || tokenId,100);
  const resolvedLicense=cleanId(record?.license_id || licenseId,80);
  const revocationKey=resolvedToken ? `token:${resolvedToken}` : (resolvedLicense ? `account:${resolvedLicense}` : '');
  if (!revocationKey) throw new Error('revocation_target_required');
  await pool.query(`DELETE FROM wpgo_license_revocations_v2 WHERE revocation_key=$1`,[revocationKey]);
  return { revocationKey, licenseId:resolvedLicense, tokenId:resolvedToken };
}

async function liveEntitlement(record) {
  if (!requireAccountEntitlement) return { ok:true, current_plan:String(record?.plan||''), subscription_status:'unchecked', refresh_required:false };
  if (!pool || !record?.license_id) return { ok:false, status:'account_not_found' };
  let r;
  try {
    r=await pool.query(`SELECT plan,is_founder,subscription_status FROM wpgo_accounts WHERE id=$1 LIMIT 1`,[String(record.license_id)]);
  } catch (error) {
    if (String(error?.code||'')==='42P01') return { ok:false, status:'account_registry_unavailable' };
    throw error;
  }
  const row=r.rows[0]; if (!row) return { ok:false, status:'account_not_found' };
  const currentPlan=row.is_founder ? 'founder' : String(row.plan || 'free');
  const tokenPlan=String(record.plan || 'free');
  return {
    ok:true,
    current_plan:currentPlan,
    subscription_status:String(row.subscription_status || 'none'),
    refresh_required:tokenPlan !== currentPlan
  };
}
function baseStatus(record,requestedSite='') {
  if (!record) return 'invalid';
  if (record.license_id && staticRevokedIds.has(String(record.license_id))) return 'revoked';
  if (record.status && record.status!=='active') return String(record.status);
  if (record.expires_gmt && Date.parse(record.expires_gmt)<Date.now()) return 'expired';
  const allowed=normalizeHosts(record.site_hosts),host=siteHost(requestedSite);
  if (!allowed.length && !allowUnbound) return 'site_binding_required';
  if (allowed.length) { if (!host) return 'site_required'; if (!allowed.includes(host)) return 'site_mismatch'; }
  return 'active';
}
async function evaluateLicense(record,requestedSite='') {
  const base=baseStatus(record,requestedSite);
  if (base!=='active') return { status:base, refresh_required:false, current_plan:'', subscription_status:'' };
  if (await dbRevocationStatus(record)) return { status:'revoked', refresh_required:false, current_plan:'', subscription_status:'' };
  const live=await liveEntitlement(record);
  if (!live.ok) return { status:live.status, refresh_required:false, current_plan:'', subscription_status:'' };
  return { status:'active', refresh_required:Boolean(live.refresh_required), current_plan:live.current_plan, subscription_status:live.subscription_status };
}

app.use((req,res,next)=>{
  const requestId=req.get('x-request-id')||crypto.randomUUID(); req.wpgoRequestId=requestId;
  res.set('X-Request-Id',requestId); res.set('Cache-Control','no-store'); res.set('X-Content-Type-Options','nosniff'); res.set('Referrer-Policy','no-referrer'); res.set('X-Frame-Options','DENY'); res.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if (limiter.limited(req.ip || req.socket.remoteAddress || 'unknown')) return res.status(429).json({ error:'rate_limited', request_id:requestId });
  next();
});

app.get('/health',async(_req,res)=>{
  let db=false,accountRegistry=false;
  try { if (pool) { await pool.query('SELECT 1'); db=true; const r=await pool.query(`SELECT to_regclass('public.wpgo_accounts') AS table_name`); accountRegistry=Boolean(r.rows[0]?.table_name); } } catch {}
  const ok=Boolean(privateKeyPem)&&Boolean(db);
  res.status(ok?200:503).json({
    ok,service:'wpgo-control-plane',version:VERSION,signing:privateKeyPem?'ed25519':'disabled',database:db?'ready':'unavailable',account_registry:accountRegistry?'ready':'pending',
    persistent_store:Boolean(storePath),stateless_signed_licenses:Boolean(privateKeyPem),token_scoped_revocations:db,account_revocation_fallback:true,
    live_account_entitlement:requireAccountEntitlement,strict_site_binding:!allowUnbound,unbound_licenses_allowed:allowUnbound,release_hash:Boolean(release.sha256)
  });
});
app.get('/v1/capabilities',(_req,res)=>res.json(sign({
  version:VERSION,provider_neutral:true,signing:privateKeyPem?'ed25519':'disabled',license_modes:[...(storePath?['persistent-store']:[]),...(privateKeyPem?['signed-token']:[])],
  site_binding:true,strict_site_binding:!allowUnbound,token_scoped_revocations:Boolean(pool),live_account_entitlement:requireAccountEntitlement,signed_updates:true,package_hash_verification:true
})));
app.get('/v1/public-key',(_req,res)=>{const key=publicKeyBase64();if(!key)return res.status(404).json({error:'signing_not_configured'});res.json({algorithm:'ed25519',public_key:key});});

app.post('/v1/license/validate',async(req,res,next)=>{
  try {
    const key=String(req.body?.license_key||'').trim();
    if (!key || key.length>8192) return res.status(400).json(sign({status:'invalid',message:'Invalid licence token.'}));
    const site=String(req.body?.site_url||''),{record,source}=licenseLookup(key),evaluation=await evaluateLicense(record,site);
    const payload={
      status:evaluation.status,
      plan:record?.plan||'',current_plan:evaluation.current_plan||'',license_refresh_required:Boolean(evaluation.refresh_required),subscription_status:evaluation.subscription_status||'',
      expires_gmt:record?.expires_gmt||'',features:Array.isArray(record?.features)?record.features:[],license_id:record?.license_id||'',token_id:record?.token_id||'',source,site_url:site,checked_gmt:new Date().toISOString()
    };
    audit('license_validate',{key_ref:keyRef(key),license_id:record?.license_id||'',token_id:record?.token_id||'',source,status:evaluation.status,refresh_required:Boolean(evaluation.refresh_required),site_host:siteHost(site)});
    res.status(evaluation.status==='active'?200:403).json(sign(payload));
  } catch (error) { next(error); }
});

app.get('/v1/update/manifest',async(req,res,next)=>{
  try {
    const key=bearer(req),site=String(req.get('X-WPGo-Site')||''),{record,source}=licenseLookup(key),evaluation=await evaluateLicense(record,site);
    if (evaluation.status!=='active') return res.status(403).json(sign({status:evaluation.status,message:'A valid active WPGo licence is required for commercial updates.'}));
    if (evaluation.refresh_required) return res.status(409).json(sign({status:'entitlement_changed',current_plan:evaluation.current_plan,message:'Refresh the WPGo licence before downloading commercial updates.'}));
    if (!release.package || !/^[a-f0-9]{64}$/.test(release.sha256)) return res.status(503).json(sign({status:'unavailable',message:'No release package with SHA-256 is configured.'}));
    audit('update_manifest',{key_ref:keyRef(key),license_id:record?.license_id||'',token_id:record?.token_id||'',source,version:release.version});
    res.json(sign(release));
  } catch (error) { next(error); }
});

app.get('/v1/admin/license-summary',async(req,res,next)=>{
  try {
    if (!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});
    const counts=Object.values(licenses).reduce((acc,r)=>{const s=baseStatus(r);acc[s]=(acc[s]||0)+1;return acc;},{});
    const rev=pool?await pool.query(`SELECT COUNT(*)::int AS count FROM wpgo_license_revocations_v2`):{rows:[{count:0}]};
    res.json({counts,total:Object.keys(licenses).length,persistent_store:Boolean(storePath),stateless_signed_licenses:Boolean(privateKeyPem),persistent_revocations:Number(rev.rows[0]?.count||0),static_revoked_ids:staticRevokedIds.size,unbound_licenses_allowed:allowUnbound,live_account_entitlement:requireAccountEntitlement});
  } catch (error) { next(error); }
});
app.post('/v1/admin/license/issue',async(req,res,next)=>{
  try {
    if (!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});
    if (!privateKeyPem) return res.status(503).json({error:'signing_not_configured'});
    const record=cleanRecord(req.body||{});
    if (!allowUnbound && !record.site_hosts.length) return res.status(400).json({error:'site_binding_required'});
    if (requireAccountEntitlement) {
      const live=await liveEntitlement(record);
      if (!live.ok) return res.status(409).json({error:live.status});
      if (live.current_plan!==record.plan) return res.status(409).json({error:'plan_mismatch',current_plan:live.current_plan});
    }
    const licenseKey=issueToken(record);
    audit('license_issue',{license_id:record.license_id,token_id:record.token_id,plan:record.plan,site_hosts:record.site_hosts});
    res.json({ok:true,license_key:licenseKey,key_ref:keyRef(licenseKey),record});
  } catch (error) { next(error); }
});
app.post('/v1/admin/license/upsert',async(req,res,next)=>{
  try {
    if (!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});
    if (!storePath) return res.status(409).json({error:'persistent_store_not_configured',message:'Use /v1/admin/license/issue for durable signed-token licences.'});
    const key=String(req.body?.license_key||'').trim(); if (key.length<8 || key.length>8192) return res.status(400).json({error:'invalid_license_key'});
    const record=cleanRecord(req.body); if (!allowUnbound && !record.site_hosts.length) return res.status(400).json({error:'site_binding_required'});
    if (requireAccountEntitlement) {
      const live=await liveEntitlement(record); if (!live.ok) return res.status(409).json({error:live.status});
      if (live.current_plan!==record.plan) return res.status(409).json({error:'plan_mismatch',current_plan:live.current_plan});
    }
    licenses[key]=record; saveStore();
    audit('license_upsert',{key_ref:keyRef(key),license_id:record.license_id,token_id:record.token_id,status:record.status,plan:record.plan});
    res.json({ok:true,key_ref:keyRef(key),record,persisted:true});
  } catch (error) { next(error); }
});
app.post('/v1/admin/license/revoke',async(req,res,next)=>{
  try {
    if (!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});
    const key=String(req.body?.license_key||'').trim(),requestedToken=String(req.body?.token_id||''),requestedLicense=String(req.body?.license_id||''),reason=String(req.body?.reason||'').slice(0,500);
    const record=key?licenseLookup(key).record:null;
    const result=await writeRevocation({record,tokenId:requestedToken,licenseId:requestedLicense,reason});
    if (key && licenses[key] && storePath) { licenses[key]={...licenses[key],status:'revoked'}; saveStore(); }
    audit('license_revoke',{key_ref:key?keyRef(key):'',license_id:result.licenseId,token_id:result.tokenId,revocation_key:result.revocationKey,reason});
    res.json({ok:true,license_id:result.licenseId,token_id:result.tokenId,scope:result.tokenId?'token':'account',persisted:true});
  } catch (error) { if (error.message==='revocation_target_required') return res.status(400).json({error:error.message}); next(error); }
});
app.post('/v1/admin/license/unrevoke',async(req,res,next)=>{
  try {
    if (!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});
    const key=String(req.body?.license_key||'').trim(),requestedToken=String(req.body?.token_id||''),requestedLicense=String(req.body?.license_id||'');
    const record=key?licenseLookup(key).record:null;
    const result=await clearRevocation({record,tokenId:requestedToken,licenseId:requestedLicense});
    if (key && licenses[key] && storePath && licenses[key].status==='revoked') { licenses[key]={...licenses[key],status:'active'}; saveStore(); }
    audit('license_unrevoke',{key_ref:key?keyRef(key):'',license_id:result.licenseId,token_id:result.tokenId,revocation_key:result.revocationKey});
    res.json({ok:true,license_id:result.licenseId,token_id:result.tokenId,scope:result.tokenId?'token':'account',persisted:true});
  } catch (error) { if (error.message==='revocation_target_required') return res.status(400).json({error:error.message}); next(error); }
});
app.post('/v1/admin/reload-store',(req,res)=>{if(!adminAuthorized(req))return res.status(401).json({error:'unauthorized'});loadStore();res.json({ok:true,total:Object.keys(licenses).length});});

app.use((err,req,res,next)=>{
  console.error(JSON.stringify({event:'request_error',request_id:req.wpgoRequestId,path:req.path,message:String(err?.message||err)}));
  if (res.headersSent) return next(err);
  if (err?.type==='entity.parse.failed') return res.status(400).json({error:'invalid_json'});
  res.status(500).json({error:'server_error',request_id:req.wpgoRequestId});
});

let server;
async function shutdown(signal) {
  console.log(JSON.stringify({event:'shutdown',signal}));
  server?.close(async()=>{await pool?.end().catch(()=>{});process.exit(0);});
  setTimeout(()=>process.exit(1),10000).unref();
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
initDb().then(()=>{server=app.listen(port,'0.0.0.0',()=>console.log(`WPGo control plane ${VERSION} listening on ${port}`));}).catch(err=>{console.error(JSON.stringify({event:'db_init_failed',message:String(err?.message||err)}));process.exit(1);});
