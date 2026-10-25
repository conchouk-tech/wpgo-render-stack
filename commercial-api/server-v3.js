import express from 'express';
import crypto from 'node:crypto';
import pg from 'pg';
import Stripe from 'stripe';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 8081);
const VERSION = '1.4.0';
const NODE_ENV = String(process.env.NODE_ENV || 'production').toLowerCase();
const devAuth = process.env.WPGO_DEV_AUTH === '1' && NODE_ENV !== 'production';
const databaseUrl = process.env.DATABASE_URL || '';
const sessionSecret = process.env.WPGO_SESSION_SECRET || '';
const founderEmails = new Set(String(process.env.WPGO_FOUNDER_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean));
const licenseValidateUrl = process.env.WPGO_LICENSE_VALIDATE_URL || 'https://wpgo-control-plane-ga.onrender.com/v1/license/validate';
const licenseIssueUrl = process.env.WPGO_LICENSE_ISSUE_URL || 'https://wpgo-control-plane-ga.onrender.com/v1/admin/license/issue';
const controlAdminToken = process.env.WPGO_CONTROL_ADMIN_TOKEN || '';
const portalBase = String(process.env.WPGO_PORTAL_URL || 'https://wpgo-commercial-web.onrender.com').replace(/\/$/, '');
const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;
const emailProvider = String(process.env.WPGO_EMAIL_PROVIDER || '').trim().toLowerCase();
const emailApiKey = process.env.WPGO_EMAIL_API_KEY || '';
const emailFrom = process.env.WPGO_EMAIL_FROM || '';
const emailWebhookUrl = process.env.WPGO_EMAIL_WEBHOOK_URL || '';
const fetchTimeoutMs = Math.max(2000, Math.min(30000, Number(process.env.WPGO_FETCH_TIMEOUT_MS || 8000)));

const PLANS = {
  free:   {id:'free', name:'Free', monthly_eur:0, yearly_eur:0, daily_actions:100, client_controls:false},
  solo:   {id:'solo', name:'Solo', monthly_eur:5.95, yearly_eur:60.69, daily_actions:750, client_controls:false},
  pro:    {id:'pro', name:'Pro', monthly_eur:12.95, yearly_eur:132.09, daily_actions:2500, client_controls:false},
  agency: {id:'agency', name:'Agency', monthly_eur:24.95, yearly_eur:254.49, daily_actions:7500, client_controls:true},
  scale:  {id:'scale', name:'Scale', monthly_eur:39.95, yearly_eur:407.49, daily_actions:15000, client_controls:true},
  founder:{id:'founder', name:'Founder', monthly_eur:0, yearly_eur:0, daily_actions:null, client_controls:true, unlimited:true}
};
const PRICE_ENV = {
  solo:{monthly:'STRIPE_PRICE_SOLO',yearly:'STRIPE_PRICE_SOLO_YEARLY'},
  pro:{monthly:'STRIPE_PRICE_PRO',yearly:'STRIPE_PRICE_PRO_YEARLY'},
  agency:{monthly:'STRIPE_PRICE_AGENCY',yearly:'STRIPE_PRICE_AGENCY_YEARLY'},
  scale:{monthly:'STRIPE_PRICE_SCALE',yearly:'STRIPE_PRICE_SCALE_YEARLY'}
};

function requireProductionConfig(){
  const missing=[];
  if(!databaseUrl) missing.push('DATABASE_URL');
  if(sessionSecret.length < 32) missing.push('WPGO_SESSION_SECRET>=32chars');
  if(!controlAdminToken) missing.push('WPGO_CONTROL_ADMIN_TOKEN');
  for (const [name,value] of [['WPGO_LICENSE_VALIDATE_URL',licenseValidateUrl],['WPGO_LICENSE_ISSUE_URL',licenseIssueUrl]]) {
    try { if(new URL(value).protocol !== 'https:') missing.push(`${name}=https`); } catch { missing.push(name); }
  }
  if(stripeSecret && !stripeWebhookSecret) missing.push('STRIPE_WEBHOOK_SECRET');
  if(NODE_ENV === 'production' && process.env.WPGO_DEV_AUTH === '1') missing.push('WPGO_DEV_AUTH must be disabled in production');
  if(missing.length){
    console.error(JSON.stringify({event:'startup_config_invalid',missing}));
    process.exit(1);
  }
}
requireProductionConfig();

app.disable('x-powered-by');
app.set('trust proxy',1);
app.use((req,res,next)=>{
  const requestId = req.get('x-request-id') || crypto.randomUUID();
  req.wpgoRequestId=requestId;
  res.set('X-Request-Id',requestId);
  res.set('X-Content-Type-Options','nosniff');
  res.set('Referrer-Policy','no-referrer');
  res.set('X-Frame-Options','DENY');
  res.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.set('Cache-Control','no-store');
  next();
});
app.use((req,res,next)=>{
  if(req.path === '/v1/billing/webhook') return next();
  express.json({limit:'96kb'})(req,res,next);
});

const pool = new Pool({connectionString:databaseUrl, ssl: databaseUrl.includes('localhost') ? false : {rejectUnauthorized:false}, max:10, idleTimeoutMillis:30000, connectionTimeoutMillis:8000});
function q(text,params=[]){return pool.query(text,params);}
function normalizeEmail(v){return String(v||'').trim().toLowerCase();}
function validEmail(v){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 320;}
function cleanText(v,max=500){return String(v||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);}
function normalizeHost(v){return String(v||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*$/,'').replace(/^www\./,'');}
function normalizeSiteUrl(value){try{const u=new URL(String(value||'').trim());if(u.protocol!=='https:'||!u.hostname||u.username||u.password||u.port)return'';u.pathname='/';u.search='';u.hash='';return u.toString();}catch{return'';}}
function hostFromSiteUrl(value){try{return normalizeHost(new URL(value).hostname);}catch{return'';}}
function accountPlan(row){if(row?.is_founder||founderEmails.has(normalizeEmail(row?.email)))return PLANS.founder;return PLANS[row?.plan]||PLANS.free;}
function bearer(req){const v=req.get('authorization')||'';return v.startsWith('Bearer ')?v.slice(7).trim():'';}
function secureEqual(a,b){const aa=Buffer.from(String(a));const bb=Buffer.from(String(b));return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);}
function hmac(value){return crypto.createHmac('sha256',sessionSecret).update(value).digest('base64url');}
function makeSession(account){const payload=Buffer.from(JSON.stringify({id:account.id,email:account.email,iat:Date.now(),exp:Date.now()+1000*60*60*24*30})).toString('base64url');return `wpgosess1.${payload}.${hmac(payload)}`;}
function readSession(token){if(!token||!token.startsWith('wpgosess1.'))return null;const p=token.split('.');if(p.length!==3||!secureEqual(hmac(p[1]),p[2]))return null;try{const v=JSON.parse(Buffer.from(p[1],'base64url').toString('utf8'));return v.exp&&v.exp>=Date.now()?v:null;}catch{return null;}}
function codeHash(email,code){return crypto.createHmac('sha256',sessionSecret).update(`${email}|${code}`).digest('hex');}
function ipHash(req){return crypto.createHmac('sha256',sessionSecret).update(String(req.ip||'unknown')).digest('hex').slice(0,24);}

class FixedWindowLimiter {
  constructor({limit,windowMs,maxKeys=10000}){this.limit=limit;this.windowMs=windowMs;this.maxKeys=maxKeys;this.rows=new Map();}
  hit(key){const now=Date.now();let row=this.rows.get(key);if(!row||now-row.start>=this.windowMs)row={start:now,count:0};row.count++;this.rows.set(key,row);if(this.rows.size>this.maxKeys)this.sweep(now);return row.count>this.limit;}
  sweep(now=Date.now()){for(const [k,v] of this.rows){if(now-v.start>=this.windowMs)this.rows.delete(k);}if(this.rows.size>this.maxKeys){for(const k of this.rows.keys()){this.rows.delete(k);if(this.rows.size<=this.maxKeys)break;}}}
}
const authIpLimiter=new FixedWindowLimiter({limit:20,windowMs:10*60*1000});
const authEmailLimiter=new FixedWindowLimiter({limit:6,windowMs:10*60*1000});
const verifyLimiter=new FixedWindowLimiter({limit:30,windowMs:10*60*1000});
const supportLimiter=new FixedWindowLimiter({limit:8,windowMs:60*60*1000});
setInterval(()=>{authIpLimiter.sweep();authEmailLimiter.sweep();verifyLimiter.sweep();supportLimiter.sweep();},5*60*1000).unref();

async function fetchJson(url,options={}){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),fetchTimeoutMs);
  try{
    const r=await fetch(url,{...options,signal:controller.signal});
    const data=await r.json().catch(()=>({}));
    return{ok:r.ok,status:r.status,data};
  } finally { clearTimeout(timeout); }
}

async function initDb(){
  await q(`CREATE TABLE IF NOT EXISTS wpgo_accounts (
    id UUID PRIMARY KEY,email TEXT UNIQUE NOT NULL,plan TEXT NOT NULL DEFAULT 'free',is_founder BOOLEAN NOT NULL DEFAULT FALSE,
    stripe_customer_id TEXT,stripe_subscription_id TEXT,subscription_status TEXT NOT NULL DEFAULT 'none',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS wpgo_login_codes (id UUID PRIMARY KEY,email TEXT NOT NULL,code_hash TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,used_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`ALTER TABLE wpgo_login_codes ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`);
  await q(`CREATE INDEX IF NOT EXISTS wpgo_login_codes_email_idx ON wpgo_login_codes(email, created_at DESC)`);
  await q(`CREATE TABLE IF NOT EXISTS wpgo_usage_events (id UUID PRIMARY KEY,account_id UUID NOT NULL REFERENCES wpgo_accounts(id) ON DELETE CASCADE,site_host TEXT NOT NULL DEFAULT '',operation TEXT NOT NULL DEFAULT '',units INTEGER NOT NULL DEFAULT 1,success BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`ALTER TABLE wpgo_usage_events ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
  await q(`CREATE INDEX IF NOT EXISTS wpgo_usage_window_idx ON wpgo_usage_events(account_id, created_at DESC)`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS wpgo_usage_idempotency_idx ON wpgo_usage_events(account_id,idempotency_key) WHERE idempotency_key IS NOT NULL`);
  await q(`CREATE TABLE IF NOT EXISTS wpgo_sites (id UUID PRIMARY KEY,account_id UUID NOT NULL REFERENCES wpgo_accounts(id) ON DELETE CASCADE,site_url TEXT NOT NULL,site_host TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(account_id, site_host))`);
  await q(`CREATE TABLE IF NOT EXISTS wpgo_support_tickets (id UUID PRIMARY KEY,type TEXT NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',subject TEXT NOT NULL DEFAULT '',message TEXT NOT NULL,site_url TEXT NOT NULL DEFAULT '',wp_version TEXT NOT NULL DEFAULT '',wpgo_version TEXT NOT NULL DEFAULT '',browser TEXT NOT NULL DEFAULT '',severity TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'open',source_ip_hash TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE INDEX IF NOT EXISTS wpgo_support_email_idx ON wpgo_support_tickets(email, created_at DESC)`);
  await q(`CREATE TABLE IF NOT EXISTS wpgo_webhook_events (id TEXT PRIMARY KEY,type TEXT NOT NULL,processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}
async function getOrCreateAccount(email){const isFounder=founderEmails.has(email);const id=crypto.randomUUID();const r=await q(`INSERT INTO wpgo_accounts(id,email,plan,is_founder) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET is_founder=wpgo_accounts.is_founder OR EXCLUDED.is_founder,updated_at=NOW() RETURNING *`,[id,email,isFounder?'founder':'free',isFounder]);return r.rows[0];}
async function usageFor(account,client=pool){const plan=accountPlan(account);if(plan.unlimited)return{plan:plan.id,unlimited:true,used:0,allowance:null,remaining:null,window_hours:24,percent:0};const r=await client.query(`SELECT COALESCE(SUM(units),0)::int AS used FROM wpgo_usage_events WHERE account_id=$1 AND success=TRUE AND created_at>NOW()-INTERVAL '24 hours'`,[account.id]);const used=Number(r.rows[0]?.used||0),allowance=plan.daily_actions,remaining=Math.max(0,allowance-used);return{plan:plan.id,unlimited:false,used,allowance,remaining,window_hours:24,percent:Math.min(100,Math.round((used/allowance)*1000)/10)};}
async function authAccount(req,res,next){const s=readSession(bearer(req));if(!s)return res.status(401).json({error:'authentication_required'});try{const r=await q(`SELECT * FROM wpgo_accounts WHERE id=$1`,[s.id]);if(!r.rows[0])return res.status(401).json({error:'account_not_found'});req.account=r.rows[0];next();}catch(e){next(e);}}

async function sendLoginCode(email,code){
  if(devAuth){console.log(JSON.stringify({event:'login_code_created',email,code}));return{delivery:'development'};}
  if(emailProvider==='resend'){
    if(!emailApiKey||!emailFrom)throw new Error('email_not_configured');
    const r=await fetchJson('https://api.resend.com/emails',{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${emailApiKey}`},body:JSON.stringify({from:emailFrom,to:[email],subject:'Your WPGo sign-in code',html:`<p>Your WPGo sign-in code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>This code expires in 10 minutes.</p>`})});
    if(!r.ok)throw new Error('email_delivery_failed');
    return{delivery:'email'};
  }
  if(emailProvider==='webhook'){
    if(!emailWebhookUrl)throw new Error('email_not_configured');
    const r=await fetchJson(emailWebhookUrl,{method:'POST',headers:{'content-type':'application/json',...(emailApiKey?{'authorization':`Bearer ${emailApiKey}`}:{})},body:JSON.stringify({type:'wpgo_login_code',to:email,code,expires_minutes:10})});
    if(!r.ok)throw new Error('email_delivery_failed');
    return{delivery:'email'};
  }
  throw new Error('email_not_configured');
}

async function validateCommercialLicense(req){
  const token=bearer(req);if(!token||token.length>4096)return{ok:false,status:401,error:'license_required'};
  const siteUrl=normalizeSiteUrl(req.body?.site_url||req.get('x-wpgo-site')||'');if(!siteUrl)return{ok:false,status:400,error:'site_required'};
  try{
    const r=await fetchJson(licenseValidateUrl,{method:'POST',headers:{'content-type':'application/json','accept':'application/json','user-agent':`WPGo-Commercial-API/${VERSION}`},body:JSON.stringify({license_key:token,site_url:siteUrl})});
    const raw=r.data||{},data=raw?.payload&&typeof raw.payload==='object'?raw.payload:raw;
    if(!r.ok||data?.status!=='active'||!data?.license_id)return{ok:false,status:r.status||403,error:data?.status||'invalid_license'};
    return{ok:true,license:data,token,siteUrl,siteHost:hostFromSiteUrl(siteUrl)};
  }catch{return{ok:false,status:502,error:'license_service_unavailable'};}
}
async function accountFromLicense(req){const v=await validateCommercialLicense(req);if(!v.ok)return v;const r=await q(`SELECT * FROM wpgo_accounts WHERE id=$1`,[v.license.license_id]);if(!r.rows[0])return{ok:false,status:404,error:'account_not_found'};return{...v,account:r.rows[0]};}
async function issueLicenseForAccount(account,siteHosts=[]){if(!controlAdminToken)throw new Error('control_plane_admin_not_configured');const plan=accountPlan(account);const body={license_id:account.id,status:'active',plan:plan.id,features:['updates','support','metering','account-connect','mcp-connect','provider-neutral'],site_hosts:[...new Set(siteHosts.map(normalizeHost).filter(Boolean))].slice(0,25)};const r=await fetchJson(licenseIssueUrl,{method:'POST',headers:{'content-type':'application/json','accept':'application/json','authorization':`Bearer ${controlAdminToken}`},body:JSON.stringify(body)});if(!r.ok||!r.data?.license_key)throw new Error(r.data?.error||'license_issue_failed');return r.data;}
function planState(v){const authoritative=accountPlan(v.account);const tokenPlan=String(v.license?.plan||'');return{plan:authoritative,token_plan:tokenPlan,license_refresh_required:tokenPlan!==authoritative.id};}

app.get('/health',async(_req,res)=>{let db=false;try{await q('SELECT 1');db=true;}catch{}res.status(db?200:503).json({ok:db,service:'wpgo-commercial-api',version:VERSION,database:db?'ready':'unavailable',stripe:Boolean(stripe),email:devAuth?'development':(emailProvider||'not_configured'),provider_neutral_mcp:true,protocol:'MCP',preferred_protocol_version:'2026-07-28',strict_site_binding:true,license_refresh:true,metering_idempotency:true,plans:Object.keys(PLANS).filter(x=>x!=='founder')});});
app.get('/v1/plans',(_req,res)=>res.json({currency:'EUR',billing:['monthly','yearly'],yearly_discount_percent:15,usage_window_hours:24,failed_actions_count:false,plans:Object.values(PLANS).filter(p=>p.id!=='founder')}));
app.get('/v1/connect/manifest',(_req,res)=>res.json({product:'WPGo',vendor_neutral:true,protocol:'mcp',transport:'streamable-http',preferred_protocol_version:'2026-07-28',compatible_protocol_versions:['2026-07-28','2025-11-25','2025-06-18'],authentication:'OAuth 2.1 bearer at the WordPress MCP resource',client_requirement:'Remote MCP over HTTPS',clients:[{id:'chatgpt',label:'ChatGPT',mode:'remote-mcp'},{id:'claude',label:'Claude',mode:'remote-mcp'},{id:'generic',label:'Any MCP-compatible AI or agent',mode:'remote-mcp'}],notes:['WPGo does not require an OpenAI API key.','AI-client credentials are never stored by WPGo.','The same WordPress MCP endpoint is used by every compatible AI client.']}));
app.post('/v1/connect/profile',authAccount,async(req,res,next)=>{try{const host=normalizeHost(req.body?.site_host);if(!host)return res.status(400).json({error:'site_required'});const r=await q(`SELECT site_url,site_host,label FROM wpgo_sites WHERE account_id=$1 AND site_host=$2 LIMIT 1`,[req.account.id,host]);if(!r.rows[0])return res.status(404).json({error:'site_not_registered'});const siteUrl=normalizeSiteUrl(r.rows[0].site_url);const endpoint=new URL('/wp-json/mcp/mcp-adapter-default-server',siteUrl).toString();res.json({profile:{site_host:host,label:r.rows[0].label||host,protocol:'mcp',transport:'streamable-http',mcp_url:endpoint,oauth:'discover-from-resource',vendor_neutral:true,compatible_clients:['ChatGPT','Claude','other MCP-compatible clients']}});}catch(e){next(e);}});

app.post('/v1/auth/request-code',async(req,res,next)=>{try{const email=normalizeEmail(req.body?.email);if(!validEmail(email))return res.status(400).json({error:'invalid_email'});if(authIpLimiter.hit(`ip:${req.ip}`)||authEmailLimiter.hit(`email:${email}`))return res.status(429).json({error:'rate_limited'});await q(`UPDATE wpgo_login_codes SET used_at=NOW() WHERE email=$1 AND used_at IS NULL`,[email]);const code=String(crypto.randomInt(100000,1000000)),id=crypto.randomUUID();await q(`INSERT INTO wpgo_login_codes(id,email,code_hash,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')`,[id,email,codeHash(email,code)]);try{const delivery=await sendLoginCode(email,code);res.json({ok:true,delivery:delivery.delivery,expires_minutes:10,...(devAuth?{dev_code:code}:{})});}catch(e){await q(`UPDATE wpgo_login_codes SET used_at=NOW() WHERE id=$1`,[id]);if(e.message==='email_not_configured')return res.status(503).json({error:'email_not_configured'});throw e;}}catch(e){next(e);}});
app.post('/v1/auth/verify-code',async(req,res,next)=>{try{const email=normalizeEmail(req.body?.email),code=String(req.body?.code||'').trim();if(!validEmail(email)||!/^[0-9]{6}$/.test(code))return res.status(400).json({error:'invalid_code'});if(verifyLimiter.hit(`verify:${req.ip}`))return res.status(429).json({error:'rate_limited'});const r=await q(`SELECT * FROM wpgo_login_codes WHERE email=$1 AND used_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`,[email]);const row=r.rows[0];if(!row)return res.status(401).json({error:'invalid_or_expired_code'});const good=secureEqual(row.code_hash,codeHash(email,code));if(!good){await q(`UPDATE wpgo_login_codes SET attempts=attempts+1,used_at=CASE WHEN attempts+1>=5 THEN NOW() ELSE used_at END WHERE id=$1`,[row.id]);return res.status(401).json({error:'invalid_or_expired_code'});}await q(`UPDATE wpgo_login_codes SET used_at=NOW() WHERE id=$1`,[row.id]);const acct=await getOrCreateAccount(email),token=makeSession(acct),usage=await usageFor(acct);res.json({ok:true,token,account:{id:acct.id,email:acct.email,plan:accountPlan(acct),usage}});}catch(e){next(e);}});
app.get('/v1/account',authAccount,async(req,res,next)=>{try{res.json({account:{id:req.account.id,email:req.account.email,plan:accountPlan(req.account),subscription_status:req.account.subscription_status,usage:await usageFor(req.account)}});}catch(e){next(e);}});
app.get('/v1/account/sites',authAccount,async(req,res,next)=>{try{const r=await q(`SELECT id,site_url,site_host,label,connected_at FROM wpgo_sites WHERE account_id=$1 ORDER BY connected_at DESC`,[req.account.id]);res.json({sites:r.rows});}catch(e){next(e);}});
app.post('/v1/account/license',authAccount,async(req,res,next)=>{try{const hosts=Array.isArray(req.body?.site_hosts)?req.body.site_hosts.map(normalizeHost).filter(Boolean).slice(0,25):[];const issued=await issueLicenseForAccount(req.account,hosts);res.json({ok:true,license_key:issued.license_key,record:issued.record});}catch(e){next(e);}});
app.post('/v1/sites/register',authAccount,async(req,res,next)=>{try{const siteUrl=normalizeSiteUrl(req.body?.site_url);if(!siteUrl)return res.status(400).json({error:'invalid_site_url'});const host=hostFromSiteUrl(siteUrl),label=cleanText(req.body?.label||host,100),id=crypto.randomUUID();await q(`INSERT INTO wpgo_sites(id,account_id,site_url,site_host,label) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,site_host) DO UPDATE SET site_url=EXCLUDED.site_url,label=EXCLUDED.label`,[id,req.account.id,siteUrl,host,label]);const issued=await issueLicenseForAccount(req.account,[host]);res.json({ok:true,site:{site_url:siteUrl,site_host:host,label},license_key:issued.license_key,plan:accountPlan(req.account)});}catch(e){next(e);}});
app.post('/v1/license/refresh',async(req,res,next)=>{try{const v=await accountFromLicense(req);if(!v.ok)return res.status(v.status).json({ok:false,error:v.error});const issued=await issueLicenseForAccount(v.account,[v.siteHost]);const authoritative=accountPlan(v.account);res.json({ok:true,site_url:v.siteUrl,site_host:v.siteHost,plan:authoritative,previous_token_plan:String(v.license?.plan||''),license_key:issued.license_key,record:issued.record});}catch(e){next(e);}});
app.post('/v1/meter/check',async(req,res,next)=>{try{const v=await accountFromLicense(req);if(!v.ok)return res.status(v.status).json({allowed:false,error:v.error});const usage=await usageFor(v.account),state=planState(v);res.status(!usage.unlimited&&usage.remaining<1?429:200).json({allowed:usage.unlimited||usage.remaining>=1,plan:state.plan,token_plan:state.token_plan,license_refresh_required:state.license_refresh_required,site_host:v.siteHost,usage});}catch(e){next(e);}});
async function meter(req,res,next){let client;try{const v=await accountFromLicense(req);if(!v.ok)return res.status(v.status).json({error:v.error});const rawUnits=Number(req.body?.units??1);const units=Number.isFinite(rawUnits)?Math.max(1,Math.min(100,Math.floor(rawUnits))):1;const op=cleanText(req.body?.operation,120),success=req.body?.success!==false,idempotencyKey=cleanText(req.body?.idempotency_key,160)||null;const requestedHost=normalizeHost(req.body?.site_host||'');if(requestedHost&&requestedHost!==v.siteHost)return res.status(409).json({error:'site_host_mismatch',expected_site_host:v.siteHost});client=await pool.connect();await client.query('BEGIN');await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[v.account.id]);if(idempotencyKey){const d=await client.query(`SELECT 1 FROM wpgo_usage_events WHERE account_id=$1 AND idempotency_key=$2 LIMIT 1`,[v.account.id,idempotencyKey]);if(d.rows[0]){await client.query('COMMIT');return res.json({ok:true,counted:false,duplicate:true,site_host:v.siteHost,usage:await usageFor(v.account)});}}const before=await usageFor(v.account,client),state=planState(v);if(success&&!before.unlimited&&before.remaining<units){await client.query('ROLLBACK');return res.status(429).json({error:'usage_limit_reached',plan:state.plan,token_plan:state.token_plan,license_refresh_required:state.license_refresh_required,usage:before});}if(success)await client.query(`INSERT INTO wpgo_usage_events(id,account_id,site_host,operation,units,success,idempotency_key) VALUES($1,$2,$3,$4,$5,TRUE,$6)`,[crypto.randomUUID(),v.account.id,v.siteHost,op,units,idempotencyKey]);await client.query('COMMIT');res.json({ok:true,counted:success,plan:state.plan,token_plan:state.token_plan,license_refresh_required:state.license_refresh_required,site_host:v.siteHost,usage:await usageFor(v.account)});}catch(e){if(client){try{await client.query('ROLLBACK');}catch{}}next(e);}finally{client?.release();}}
app.post('/v1/meter/record',meter);app.post('/v1/meter/consume',meter);

app.post('/v1/support/ticket',async(req,res,next)=>{try{if(supportLimiter.hit(`support:${req.ip}`))return res.status(429).json({error:'rate_limited'});const type=String(req.body?.type||'contact').toLowerCase();if(!['contact','bug','feedback'].includes(type))return res.status(400).json({error:'invalid_type'});const email=normalizeEmail(req.body?.email);if(!validEmail(email))return res.status(400).json({error:'invalid_email'});const name=cleanText(req.body?.name,120),subject=cleanText(req.body?.subject,180),message=cleanText(req.body?.message,8000);if(message.length<10)return res.status(400).json({error:'message_too_short'});const id=crypto.randomUUID();await q(`INSERT INTO wpgo_support_tickets(id,type,email,name,subject,message,site_url,wp_version,wpgo_version,browser,severity,source_ip_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,type,email,name,subject,message,cleanText(req.body?.site_url,500),cleanText(req.body?.wp_version,40),cleanText(req.body?.wpgo_version,40),cleanText(req.body?.browser,500),cleanText(req.body?.severity,40),ipHash(req)]);res.status(201).json({ok:true,ticket_id:id});}catch(e){next(e);}});
app.get('/v1/support/tickets',authAccount,async(req,res,next)=>{try{const founder=accountPlan(req.account).id==='founder';const r=founder?await q(`SELECT id,type,email,name,subject,message,site_url,wp_version,wpgo_version,browser,severity,status,created_at FROM wpgo_support_tickets ORDER BY created_at DESC LIMIT 100`):await q(`SELECT id,type,email,name,subject,message,site_url,wp_version,wpgo_version,browser,severity,status,created_at FROM wpgo_support_tickets WHERE email=$1 ORDER BY created_at DESC LIMIT 50`,[normalizeEmail(req.account.email)]);res.json({tickets:r.rows});}catch(e){next(e);}});

app.post('/v1/billing/checkout',authAccount,async(req,res,next)=>{try{if(!stripe)return res.status(503).json({error:'stripe_not_configured'});const planId=String(req.body?.plan||'');if(!['solo','pro','agency','scale'].includes(planId))return res.status(400).json({error:'invalid_plan'});if(accountPlan(req.account).id==='founder')return res.status(409).json({error:'founder_is_unlimited'});const billing=String(req.body?.billing||'monthly')==='yearly'?'yearly':'monthly';const envName=PRICE_ENV[planId]?.[billing],price=envName?process.env[envName]:'';if(!price)return res.status(503).json({error:'stripe_price_not_configured',plan:planId,billing});let customer=req.account.stripe_customer_id;if(!customer){const c=await stripe.customers.create({email:req.account.email,metadata:{wpgo_account_id:req.account.id}});customer=c.id;await q(`UPDATE wpgo_accounts SET stripe_customer_id=$1,updated_at=NOW() WHERE id=$2`,[customer,req.account.id]);}const session=await stripe.checkout.sessions.create({mode:'subscription',customer,line_items:[{price,quantity:1}],success_url:`${portalBase}/account?checkout=success`,cancel_url:`${portalBase}/pricing?checkout=cancelled`,client_reference_id:req.account.id,metadata:{wpgo_account_id:req.account.id,wpgo_plan:planId,wpgo_billing:billing},subscription_data:{metadata:{wpgo_account_id:req.account.id,wpgo_plan:planId,wpgo_billing:billing}}});res.json({url:session.url,plan:planId,billing});}catch(e){next(e);}});
app.post('/v1/billing/portal',authAccount,async(req,res,next)=>{try{if(!stripe)return res.status(503).json({error:'stripe_not_configured'});if(!req.account.stripe_customer_id)return res.status(409).json({error:'no_billing_account'});const s=await stripe.billingPortal.sessions.create({customer:req.account.stripe_customer_id,return_url:`${portalBase}/account`});res.json({url:s.url});}catch(e){next(e);}});
app.post('/v1/billing/webhook',express.raw({type:'application/json'}),async(req,res)=>{if(!stripe||!stripeWebhookSecret)return res.status(503).send('stripe_not_configured');let event;try{event=stripe.webhooks.constructEvent(req.body,req.get('stripe-signature')||'',stripeWebhookSecret);}catch{return res.status(400).send('invalid_signature');}let claimed=false;try{const c=await q(`INSERT INTO wpgo_webhook_events(id,type) VALUES($1,$2) ON CONFLICT(id) DO NOTHING RETURNING id`,[event.id,event.type]);claimed=Boolean(c.rows[0]);if(!claimed)return res.json({received:true,duplicate:true});const obj=event.data.object;if(event.type==='checkout.session.completed'){const accountId=obj.metadata?.wpgo_account_id||obj.client_reference_id||'',plan=obj.metadata?.wpgo_plan||'';if(accountId&&PLANS[plan]&&plan!=='founder')await q(`UPDATE wpgo_accounts SET plan=$1,stripe_subscription_id=$2,subscription_status='active',updated_at=NOW() WHERE id=$3`,[plan,String(obj.subscription||''),accountId]);}if(['customer.subscription.created','customer.subscription.updated'].includes(event.type)){const accountId=obj.metadata?.wpgo_account_id||'',plan=obj.metadata?.wpgo_plan||'',status=cleanText(obj.status||'active',40);if(accountId&&PLANS[plan]&&plan!=='founder')await q(`UPDATE wpgo_accounts SET plan=$1,stripe_subscription_id=$2,subscription_status=$3,updated_at=NOW() WHERE id=$4`,[plan,String(obj.id||''),status,accountId]);}if(event.type==='customer.subscription.deleted'){const accountId=obj.metadata?.wpgo_account_id||'';if(accountId)await q(`UPDATE wpgo_accounts SET plan='free',stripe_subscription_id=NULL,subscription_status='cancelled',updated_at=NOW() WHERE id=$1 AND is_founder=FALSE`,[accountId]);}if(event.type==='invoice.payment_failed'){const sub=String(obj.subscription||'');if(sub)await q(`UPDATE wpgo_accounts SET subscription_status='past_due',updated_at=NOW() WHERE stripe_subscription_id=$1 AND is_founder=FALSE`,[sub]);}if(event.type==='invoice.paid'){const sub=String(obj.subscription||'');if(sub)await q(`UPDATE wpgo_accounts SET subscription_status='active',updated_at=NOW() WHERE stripe_subscription_id=$1 AND is_founder=FALSE`,[sub]);}res.json({received:true});}catch(e){if(claimed){try{await q(`DELETE FROM wpgo_webhook_events WHERE id=$1`,[event.id]);}catch{}}console.error(JSON.stringify({event:'stripe_webhook_error',request_id:req.wpgoRequestId,error:String(e?.message||e)}));res.status(500).send('webhook_processing_failed');}});

app.use((err,req,res,next)=>{console.error(JSON.stringify({event:'request_error',request_id:req.wpgoRequestId,path:req.path,error:String(err?.message||err)}));if(res.headersSent)return next(err);if(err?.type==='entity.parse.failed')return res.status(400).json({error:'invalid_json'});res.status(500).json({error:'server_error',request_id:req.wpgoRequestId,...(devAuth?{message:String(err?.message||err)}:{})});});

let server;
async function shutdown(signal){console.log(JSON.stringify({event:'shutdown',signal}));server?.close(async()=>{await pool.end().catch(()=>{});process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));

initDb().then(()=>{server=app.listen(port,'0.0.0.0',()=>console.log(`WPGo commercial API ${VERSION} listening on ${port}`));}).catch(err=>{console.error('DB init failed',err);process.exit(1);});
