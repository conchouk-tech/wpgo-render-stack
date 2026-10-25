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

const VERSION = '4.5.1';
const nodeEnv = String(process.env.NODE_ENV || 'production').toLowerCase();
const port = Number(process.env.PORT || 8090);
const adminToken = process.env.WPGO_CONTROL_ADMIN_TOKEN || '';
const signingKeyPath = process.env.WPGO_SIGNING_KEY_PATH || '';
const storePath = process.env.WPGO_LICENSE_STORE || '';
const auditPath = process.env.WPGO_CONTROL_AUDIT_LOG || '';
const databaseUrl = String(process.env.DATABASE_URL || '');
const allowUnbound = process.env.WPGO_ALLOW_UNBOUND_LICENSES === '1';
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
    console.error(JSON.stringify({event:'signing_key_error',message:String(error?.message||error)}));
    return '';
  }
}
const privateKeyPem = loadOrCreateSigningKey();
const publicKey = privateKeyPem ? crypto.createPublicKey(privateKeyPem) : null;
if (nodeEnv === 'production') {
  const missing=[];
  if (adminToken.length < 32) missing.push('WPGO_CONTROL_ADMIN_TOKEN>=32chars');
  if (!privateKeyPem) missing.push('WPGO_SIGNING_SEED or WPGO_SIGNING_PRIVATE_KEY_PEM');
  if (!databaseUrl) missing.push('DATABASE_URL');
  if (missing.length) {
    console.error(JSON.stringify({event:'startup_config_invalid',missing}));
    process.exit(1);
  }
}

const pool = databaseUrl ? new Pool({connectionString:databaseUrl, ssl:databaseUrl.includes('localhost')?false:{rejectUnauthorized:false}, max:5, idleTimeoutMillis:30000, connectionTimeoutMillis:8000}) : null;
async function initDb(){
  if(!pool)return;
  await pool.query(`CREATE TABLE IF NOT EXISTS wpgo_license_revocations (
    license_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT '',
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
async function dbRevoked(licenseId){
  if(!pool||!licenseId)return false;
  const r=await pool.query(`SELECT 1 FROM wpgo_license_revocations WHERE license_id=$1 LIMIT 1`,[String(licenseId)]);
  return Boolean(r.rows[0]);
}
async function setRevoked(licenseId,reason=''){
  if(!pool)throw new Error('database_not_configured');
  await pool.query(`INSERT INTO wpgo_license_revocations(license_id,reason) VALUES($1,$2) ON CONFLICT(license_id) DO UPDATE SET reason=EXCLUDED.reason,updated_at=NOW()`,[String(licenseId),String(reason||'').slice(0,500)]);
}
async function clearRevoked(licenseId){
  if(!pool)throw new Error('database_not_configured');
  await pool.query(`DELETE FROM wpgo_license_revocations WHERE license_id=$1`,[String(licenseId)]);
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
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(licenses, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath);
  return true;
}
function audit(event, details = {}) {
  const record={ time:new Date().toISOString(), event, ...details };
  console.log(JSON.stringify({event:'control_audit',...record}));
  if (!auditPath) return;
  try { fs.mkdirSync(path.dirname(auditPath), { recursive: true }); fs.appendFileSync(auditPath, JSON.stringify(record) + '\n', { mode: 0o600 }); } catch {}
}
loadStore();

class FixedWindowLimiter {
  constructor(limit=120,windowMs=60000,maxKeys=10000){this.limit=limit;this.windowMs=windowMs;this.maxKeys=maxKeys;this.hits=new Map();}
  limited(key){const now=Date.now();let s=this.hits.get(key);if(!s||now-s.start>this.windowMs)s={start:now,count:0};s.count++;this.hits.set(key,s);if(this.hits.size>this.maxKeys)this.sweep(now);return s.count>this.limit;}
  sweep(now=Date.now()){for(const[k,v]of this.hits)if(now-v.start>this.windowMs)this.hits.delete(k);while(this.hits.size>this.maxKeys)this.hits.delete(this.hits.keys().next().value);}
}
const limiter = new FixedWindowLimiter();
setInterval(()=>limiter.sweep(),5*60000).unref();

function sortDeep(value) { if (Array.isArray(value)) return value.map(sortDeep); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortDeep(value[k])])); return value; }
function canonical(value) { return JSON.stringify(sortDeep(value)); }
function sign(payload) { if (!privateKeyPem) return { payload, signature: '', signing: 'disabled' }; return { payload, signature: crypto.sign(null, Buffer.from(canonical(payload)), privateKeyPem).toString('base64'), signing: 'ed25519' }; }
function publicKeyBase64() { if (!publicKey) return ''; const pub = publicKey.export({ type: 'spki', format: 'der' }); return Buffer.from(pub).subarray(-32).toString('base64'); }
function bearer(req) { const v = req.get('authorization') || ''; return v.startsWith('Bearer ') ? v.slice(7).trim() : ''; }
function safeEqual(a,b){const aa=Buffer.from(String(a)),bb=Buffer.from(String(b));return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);}
function adminAuthorized(req) { return adminToken.length>=32 && safeEqual(bearer(req),adminToken); }
function keyRef(key) { return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16); }
function siteHost(siteUrl) { try { const u=new URL(String(siteUrl || '')); if(!['http:','https:'].includes(u.protocol))return''; return u.hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } }
function validHost(host){return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);}
function normalizeHosts(values) { return [...new Set((Array.isArray(values) ? values : []).map(v => String(v).trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*$/,'').replace(/^www\./,'')).filter(validHost))].slice(0, 25); }
function cleanRecord(body = {}) {
  const expires = body.expires_gmt ? new Date(body.expires_gmt) : null;
  return {
    license_id: String(body.license_id || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
    status: ['active','revoked','suspended'].includes(String(body.status || 'active')) ? String(body.status || 'active') : 'active',
    plan: String(body.plan || 'free').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
    expires_gmt: expires && !Number.isNaN(expires.getTime()) ? expires.toISOString() : '',
    features: Array.isArray(body.features) ? [...new Set(body.features.map(v => String(v).toLowerCase().replace(/[^a-z0-9_-]/g,'')).filter(Boolean))].slice(0,100) : [],
    site_hosts: normalizeHosts(body.site_hosts),
    issued_gmt: new Date().toISOString()
  };
}
function b64urlEncode(value) { return Buffer.from(value).toString('base64url'); }
function issueToken(record) { if (!privateKeyPem) throw new Error('signing_not_configured'); const payload = b64urlEncode(canonical(record)); const signingInput = `wpgo1.${payload}`; const signature = crypto.sign(null, Buffer.from(signingInput), privateKeyPem).toString('base64url'); return `${signingInput}.${signature}`; }
function parseToken(token) {
  if (!publicKey || typeof token !== 'string' || !token.startsWith('wpgo1.') || token.length>8192) return null;
  const parts = token.split('.'); if (parts.length !== 3 || parts[0] !== 'wpgo1') return null;
  try { const signingInput = `${parts[0]}.${parts[1]}`; const signature = Buffer.from(parts[2], 'base64url'); if (!crypto.verify(null, Buffer.from(signingInput), publicKey, signature)) return null; const record = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); return record && typeof record === 'object' ? record : null; } catch { return null; }
}
function licenseLookup(key) { const stored = licenses[key]; if (stored && typeof stored === 'object') return { record: stored, source: 'store' }; const token = parseToken(key); if (token) return { record: token, source: 'signed-token' }; return { record: null, source: 'none' }; }
function baseStatus(record, requestedSite = '') {
  if (!record) return 'invalid';
  if (record.license_id && staticRevokedIds.has(String(record.license_id))) return 'revoked';
  if (record.status && record.status !== 'active') return String(record.status);
  if (record.expires_gmt && Date.parse(record.expires_gmt) < Date.now()) return 'expired';
  const allowed = normalizeHosts(record.site_hosts), host = siteHost(requestedSite);
  if (!allowed.length && !allowUnbound) return 'site_binding_required';
  if (allowed.length) { if (!host) return 'site_required'; if (!allowed.includes(host)) return 'site_mismatch'; }
  return 'active';
}
async function activeStatus(record,requestedSite=''){
  const preliminary=baseStatus(record,requestedSite);
  if(preliminary!=='active')return preliminary;
  if(record?.license_id&&await dbRevoked(record.license_id))return'revoked';
  return'active';
}

app.use((req, res, next) => {
  const requestId=req.get('x-request-id')||crypto.randomUUID(); req.wpgoRequestId=requestId;
  res.set('X-Request-Id',requestId); res.set('Cache-Control','no-store'); res.set('X-Content-Type-Options','nosniff'); res.set('Referrer-Policy','no-referrer'); res.set('X-Frame-Options','DENY'); res.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if (limiter.limited(req.ip || req.socket.remoteAddress || 'unknown')) return res.status(429).json({ error:'rate_limited',request_id:requestId }); next();
});
app.get('/health', async(_req,res) => {let db=false;try{if(pool){await pool.query('SELECT 1');db=true;}}catch{}const ok=Boolean(privateKeyPem)&&Boolean(db);res.status(ok?200:503).json({ok,service:'wpgo-control-plane',version:VERSION,signing:privateKeyPem?'ed25519':'disabled',database:db?'ready':'unavailable',persistent_store:Boolean(storePath),stateless_signed_licenses:Boolean(privateKeyPem),persistent_revocations:db,static_revocation_fallback:true,strict_site_binding:!allowUnbound,unbound_licenses_allowed:allowUnbound,release_hash:Boolean(release.sha256)});});
app.get('/v1/capabilities', (_req,res) => res.json(sign({version:VERSION,provider_neutral:true,signing:privateKeyPem?'ed25519':'disabled',license_modes:[...(storePath?['persistent-store']:[]), ...(privateKeyPem?['signed-token']:[])],site_binding:true,strict_site_binding:!allowUnbound,persistent_revocations:Boolean(pool),signed_updates:true,package_hash_verification:true})));
app.get('/v1/public-key', (_req,res) => { const key=publicKeyBase64(); if(!key)return res.status(404).json({error:'signing_not_configured'}); res.json({algorithm:'ed25519',public_key:key}); });
app.post('/v1/license/validate', async(req,res,next) => {
  try{
    const key=String(req.body?.license_key || '').trim(); if(!key||key.length>8192)return res.status(400).json(sign({status:'invalid',message:'Invalid licence token.'}));
    const site=String(req.body?.site_url || ''); const { record, source }=licenseLookup(key); const status=await activeStatus(record, site);
    const payload={status,plan:record?.plan || '',expires_gmt:record?.expires_gmt || '',features:Array.isArray(record?.features)?record.features:[],license_id:record?.license_id || '',source,site_url:site,checked_gmt:new Date().toISOString()};
    audit('license_validate',{ key_ref:keyRef(key), license_id:record?.license_id || '', source, status, site_host:siteHost(site) }); res.status(status==='active'?200:403).json(sign(payload));
  }catch(e){next(e);}
});
app.get('/v1/update/manifest', async(req,res,next) => {
  try{
    const key=bearer(req),site=String(req.get('X-WPGo-Site') || ''); const { record, source }=licenseLookup(key),status=await activeStatus(record, site);
    if(status!=='active') return res.status(403).json(sign({ status, message:'A valid active WPGo licence is required for commercial updates.' }));
    if(!release.package || !/^[a-f0-9]{64}$/.test(release.sha256)) return res.status(503).json(sign({ status:'unavailable', message:'No release package with SHA-256 is configured.' }));
    audit('update_manifest',{ key_ref:keyRef(key), license_id:record?.license_id || '', source, version:release.version }); res.json(sign(release));
  }catch(e){next(e);}
});
app.get('/v1/admin/license-summary', async(req,res,next) => {try{if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});const rows=Object.values(licenses).reduce((acc,r)=>{const s=baseStatus(r);acc[s]=(acc[s]||0)+1;return acc;},{});const rev=pool?await pool.query(`SELECT COUNT(*)::int AS count FROM wpgo_license_revocations`):{rows:[{count:0}]};res.json({counts:rows,total:Object.keys(licenses).length,persistent_store:Boolean(storePath),stateless_signed_licenses:Boolean(privateKeyPem),persistent_revocations:Number(rev.rows[0]?.count||0),static_revoked_ids:staticRevokedIds.size,unbound_licenses_allowed:allowUnbound});}catch(e){next(e);}});
app.post('/v1/admin/license/issue', (req,res) => { if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'}); if(!privateKeyPem) return res.status(503).json({error:'signing_not_configured'}); const record=cleanRecord(req.body || {});if(!allowUnbound&&!record.site_hosts.length)return res.status(400).json({error:'site_binding_required'}); const licenseKey=issueToken(record); audit('license_issue',{license_id:record.license_id,plan:record.plan,site_hosts:record.site_hosts}); res.json({ok:true,license_key:licenseKey,key_ref:keyRef(licenseKey),record}); });
app.post('/v1/admin/license/upsert', (req,res) => { if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'}); if(!storePath) return res.status(409).json({error:'persistent_store_not_configured',message:'Use /v1/admin/license/issue for durable signed-token licences.'}); const key=String(req.body?.license_key||'').trim(); if(key.length<8||key.length>8192)return res.status(400).json({error:'invalid_license_key'}); const record=cleanRecord(req.body);if(!allowUnbound&&!record.site_hosts.length)return res.status(400).json({error:'site_binding_required'}); licenses[key]=record; saveStore(); audit('license_upsert',{key_ref:keyRef(key),license_id:licenses[key].license_id,status:licenses[key].status,plan:licenses[key].plan}); res.json({ok:true,key_ref:keyRef(key),record:licenses[key],persisted:true}); });
app.post('/v1/admin/license/revoke', async(req,res,next) => {try{if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});const key=String(req.body?.license_key||'').trim(),requestedId=String(req.body?.license_id||'').trim(),reason=String(req.body?.reason||'').slice(0,500);const parsed=key?licenseLookup(key).record:null;const id=String(parsed?.license_id||licenses[key]?.license_id||requestedId||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);if(!id)return res.status(404).json({error:'license_id_not_found'});await setRevoked(id,reason);if(key&&licenses[key]&&storePath){licenses[key]={...licenses[key],status:'revoked'};saveStore();}audit('license_revoke',{key_ref:key?keyRef(key):'',license_id:id,reason});res.json({ok:true,license_id:id,persisted:true});}catch(e){next(e);}});
app.post('/v1/admin/license/unrevoke', async(req,res,next) => {try{if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'});const key=String(req.body?.license_key||'').trim(),requestedId=String(req.body?.license_id||'').trim();const parsed=key?licenseLookup(key).record:null;const id=String(parsed?.license_id||licenses[key]?.license_id||requestedId||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);if(!id)return res.status(404).json({error:'license_id_not_found'});await clearRevoked(id);if(key&&licenses[key]&&storePath&&licenses[key].status==='revoked'){licenses[key]={...licenses[key],status:'active'};saveStore();}audit('license_unrevoke',{key_ref:key?keyRef(key):'',license_id:id});res.json({ok:true,license_id:id,persisted:true});}catch(e){next(e);}});
app.post('/v1/admin/reload-store', (req,res) => { if(!adminAuthorized(req)) return res.status(401).json({error:'unauthorized'}); loadStore(); res.json({ok:true,total:Object.keys(licenses).length}); });
app.use((err,req,res,next)=>{console.error(JSON.stringify({event:'request_error',request_id:req.wpgoRequestId,path:req.path,message:String(err?.message||err)}));if(res.headersSent)return next(err);if(err?.type==='entity.parse.failed')return res.status(400).json({error:'invalid_json'});res.status(500).json({error:'server_error',request_id:req.wpgoRequestId});});
let server;async function shutdown(signal){console.log(JSON.stringify({event:'shutdown',signal}));server?.close(async()=>{await pool?.end().catch(()=>{});process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));
initDb().then(()=>{server=app.listen(port,'0.0.0.0',()=>console.log(`WPGo control plane ${VERSION} listening on ${port}`));}).catch(err=>{console.error(JSON.stringify({event:'db_init_failed',message:String(err?.message||err)}));process.exit(1);});
