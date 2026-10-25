import express from 'express';
import crypto from 'node:crypto';
import { createMcpHandler, McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

const VERSION = '1.0.0';
const port = Number(process.env.PORT || 8095);
const configuredBase = String(process.env.WPGO_MCP_PUBLIC_BASE || '').replace(/\/$/, '');
const rawSecret = String(process.env.WPGO_MCP_SECRET || '');
if (rawSecret.length < 32) {
  console.error('WPGO_MCP_SECRET must be at least 32 characters.');
  process.exit(1);
}
const key = crypto.createHash('sha256').update(rawSecret).digest();
const authCodes = new Map();
const abilityCache = new Map();

const BLOCKED_ABILITIES = new Set([
  'wpgo/onboarding-link',
  'wpgo/create-fleet-task',
  'wpgo/fleet-task-status',
  'wpgo/controller-onboarding-link',
  'wpgo/controller-register-site',
  'wpgo/controller-list-sites',
  'wpgo/controller-cleanup-local-credentials',
  'wpgo/controller-remove-site',
  'wpgo/controller-site-health',
  'wpgo/controller-command-read',
  'wpgo/controller-read-ability',
  'wpgo/controller-run-ability',
  'wpgo/controller-remote-approval-status',
  'wpgo/controller-fleet-snapshot',
  'wpgo/controller-dispatch',
  'wpgo/controller-run-status',
  'wpgo/controller-list-runs'
]);

function baseUrl(req) {
  if (configuredBase) return configuredBase;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
}
function mcpUrl(req) { return `${baseUrl(req)}/mcp`; }
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function seal(prefix, payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(payload));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${prefix}.${b64url(Buffer.concat([iv, tag, ciphertext]))}`;
}
function unseal(prefix, token) {
  if (typeof token !== 'string' || !token.startsWith(`${prefix}.`)) return null;
  try {
    const raw = Buffer.from(token.slice(prefix.length + 1), 'base64url');
    if (raw.length < 29) return null;
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plain.toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (payload.exp && Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}
function safeUrl(value, { allowLoopback = false } = {}) {
  try {
    const u = new URL(String(value || '').trim());
    if (u.protocol === 'https:') return u;
    if (allowLoopback && u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return u;
  } catch {}
  return null;
}
function normalizeSite(value) {
  const u = safeUrl(value);
  if (!u) return '';
  u.pathname = '/'; u.search = ''; u.hash = '';
  return u.toString();
}
function html(res, body, status = 200) {
  res.status(status).type('html').set({
    'Cache-Control':'no-store', 'Pragma':'no-cache', 'Referrer-Policy':'no-referrer',
    'X-Frame-Options':'DENY', 'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'"
  }).send(body);
}
function esc(v='') { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function oauthErrorRedirect(redirectUri, error, description, state='') {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (description) u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  return u.toString();
}
function appendCode(redirectUri, code, state='') {
  const u = new URL(redirectUri);
  u.searchParams.set('code', code);
  if (state) u.searchParams.set('state', state);
  return u.toString();
}
function validRedirect(uri) { return Boolean(safeUrl(uri, {allowLoopback:true})); }
async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {...options, signal: controller.signal, redirect:'manual'});
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
    return {ok:r.ok, status:r.status, headers:r.headers, data, text};
  } finally { clearTimeout(t); }
}
function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}
async function wordpressIndex(site) {
  return fetchJson(new URL('wp-json/', site).toString(), {headers:{Accept:'application/json','User-Agent':`WPGo-MCP/${VERSION}`}});
}
async function loadClient(clientId, redirectUri) {
  const sealed = unseal('wpgoclient1', clientId);
  if (sealed) {
    if (!Array.isArray(sealed.redirect_uris) || !sealed.redirect_uris.includes(redirectUri)) return null;
    return sealed;
  }
  const clientUrl = safeUrl(clientId);
  if (!clientUrl) return null;
  const r = await fetchJson(clientUrl.toString(), {headers:{Accept:'application/json','User-Agent':`WPGo-MCP/${VERSION}`}}, 8000);
  if (!r.ok || !r.data || !Array.isArray(r.data.redirect_uris) || !r.data.redirect_uris.includes(redirectUri)) return null;
  return {client_id:clientId, client_name:String(r.data.client_name || 'MCP client'), redirect_uris:r.data.redirect_uris};
}
function cleanupCodes() {
  const now = Date.now();
  for (const [code, row] of authCodes) if (row.expiresAt < now) authCodes.delete(code);
}
setInterval(cleanupCodes, 60000).unref();

async function fetchAbilities(auth) {
  const cacheKey = crypto.createHash('sha256').update(`${auth.site_url}|${auth.username}`).digest('hex');
  const cached = abilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.abilities;
  const abilities = [];
  for (let page = 1; page <= 10; page++) {
    const u = new URL('wp-json/wp-abilities/v1/abilities', auth.site_url);
    u.searchParams.set('per_page','100'); u.searchParams.set('page',String(page));
    const r = await fetchJson(u.toString(), {headers:{Accept:'application/json',Authorization:basicAuth(auth.username, auth.password),'User-Agent':`WPGo-MCP/${VERSION}`}});
    if (!r.ok || !Array.isArray(r.data)) throw new Error(`WordPress abilities request failed (${r.status}).`);
    abilities.push(...r.data);
    const totalPages = Number(r.headers.get('x-wp-totalpages') || 1);
    if (page >= totalPages || r.data.length < 100) break;
  }
  const filtered = abilities.filter(a => typeof a?.name === 'string' && a.name.startsWith('wpgo/') && !BLOCKED_ABILITIES.has(a.name) && !a.name.startsWith('wpgo/controller-'));
  abilityCache.set(cacheKey, {abilities:filtered, expiresAt:Date.now()+60000});
  return filtered;
}
function toolName(abilityName) {
  return abilityName.replace(/^wpgo\//,'wpgo__').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,120);
}
function toolSchema(ability) {
  const schema = ability?.input_schema && typeof ability.input_schema === 'object' ? structuredClone(ability.input_schema) : {type:'object',additionalProperties:false};
  if (schema.type === 'object' || !schema.type) return {schema, unwrap:false};
  return {schema:{type:'object',properties:{input:schema},required:['input'],additionalProperties:false},unwrap:true};
}
async function executeAbility(auth, ability, args, unwrap) {
  const ann = ability?.meta?.annotations || {};
  const readonly = ann.readonly === true;
  const destructive = ann.destructive === true && ann.idempotent === true;
  const method = readonly ? 'GET' : destructive ? 'DELETE' : 'POST';
  const actualInput = unwrap ? args?.input : (args ?? {});
  const link = ability?._links?.['wp:action-run']?.[0]?.href;
  const runUrl = link && safeUrl(link) ? new URL(link) : new URL(`wp-json/wp-abilities/v1/abilities/${ability.name}/run`, auth.site_url);
  if (runUrl.origin !== new URL(auth.site_url).origin) throw new Error('Refused cross-origin WordPress ability URL.');
  const headers = {Accept:'application/json',Authorization:basicAuth(auth.username,auth.password),'User-Agent':`WPGo-MCP/${VERSION}`};
  const options = {method, headers};
  if (method === 'POST') { headers['Content-Type']='application/json'; options.body=JSON.stringify({input:actualInput}); }
  else if (actualInput !== undefined && actualInput !== null && !(typeof actualInput === 'object' && !Array.isArray(actualInput) && Object.keys(actualInput).length===0)) runUrl.searchParams.set('input', JSON.stringify(actualInput));
  const r = await fetchJson(runUrl.toString(), options, 30000);
  if (!r.ok) {
    const msg = r.data?.message || r.data?.error || r.text || `WordPress returned ${r.status}`;
    return {content:[{type:'text',text:`WPGo action failed: ${String(msg).slice(0,4000)}`}],isError:true};
  }
  const result = r.data ?? r.text ?? null;
  return {content:[{type:'text',text:typeof result==='string'?result:JSON.stringify(result,null,2)}], ...(result && typeof result==='object' && !Array.isArray(result) ? {structuredContent:result} : {})};
}

async function buildMcpServer(ctx) {
  const token = ctx?.authInfo?.token || '';
  const auth = unseal('wpgoaccess1', token);
  if (!auth) throw new Error('Invalid WPGo access token.');
  const abilities = await fetchAbilities(auth);
  const server = new McpServer({name:'WPGo',version:VERSION},{capabilities:{tools:{}}});
  for (const ability of abilities) {
    const {schema, unwrap} = toolSchema(ability);
    server.registerTool(toolName(ability.name), {
      title: ability.label || ability.name,
      description: `${ability.description || ability.label || ability.name}\nWPGo ability: ${ability.name}`,
      inputSchema: fromJsonSchema(schema)
    }, async (args) => executeAbility(auth, ability, args, unwrap));
  }
  return server;
}
const mcpHandler = createMcpHandler(buildMcpServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);

const app = express();
app.disable('x-powered-by'); app.set('trust proxy',1);
app.use((req,res,next)=>{res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');next();});
app.use(express.urlencoded({extended:false,limit:'32kb'}));
app.use(express.json({limit:'1mb'}));

app.get('/health',(req,res)=>res.json({ok:true,service:'wpgo-mcp-gateway',version:VERSION,mcp_url:mcpUrl(req),oauth:true,protocols:['2026-07-28','legacy-stateless'],wordpress_abilities:true}));
app.get(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'],(req,res)=>res.json({resource:mcpUrl(req),authorization_servers:[baseUrl(req)],scopes_supported:['mcp'],bearer_methods_supported:['header']}));
app.get('/.well-known/oauth-authorization-server',(req,res)=>{const b=baseUrl(req);res.json({issuer:b,authorization_endpoint:`${b}/oauth/authorize`,token_endpoint:`${b}/oauth/token`,registration_endpoint:`${b}/oauth/register`,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:['mcp']});});
app.post('/oauth/register',(req,res)=>{
  const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String).filter(validRedirect).slice(0,10) : [];
  if (!redirectUris.length) return res.status(400).json({error:'invalid_redirect_uri'});
  const client = {client_name:String(req.body?.client_name||'MCP client').slice(0,120),redirect_uris:redirectUris,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+86400*90};
  const clientId = seal('wpgoclient1',client);
  res.status(201).json({client_id:clientId,client_name:client.client_name,redirect_uris:redirectUris,token_endpoint_auth_method:'none'});
});

app.get('/oauth/authorize',async(req,res)=>{
  const responseType=String(req.query.response_type||''),clientId=String(req.query.client_id||''),redirectUri=String(req.query.redirect_uri||''),challenge=String(req.query.code_challenge||''),challengeMethod=String(req.query.code_challenge_method||''),state=String(req.query.state||''),resource=String(req.query.resource||mcpUrl(req)),scope=String(req.query.scope||'mcp');
  if(responseType!=='code'||!clientId||!validRedirect(redirectUri)||!challenge||challengeMethod!=='S256'||resource!==mcpUrl(req)) return res.status(400).json({error:'invalid_request'});
  const client=await loadClient(clientId,redirectUri); if(!client)return res.status(400).json({error:'invalid_client'});
  const flow=seal('wpgoflow1',{client_id:clientId,redirect_uri:redirectUri,code_challenge:challenge,state,resource,scope,client_name:client.client_name||'MCP client',exp:Math.floor(Date.now()/1000)+600});
  html(res,`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect WPGo</title><style>body{font-family:Arial,sans-serif;background:#f5f7fb;color:#172033;margin:0}.card{max-width:560px;margin:8vh auto;background:#fff;padding:32px;border-radius:16px;box-shadow:0 12px 35px #0001}h1{margin-top:0}label{font-weight:700;display:block;margin:22px 0 8px}input{width:100%;box-sizing:border-box;padding:13px;border:1px solid #cbd3df;border-radius:9px;font-size:16px}button{margin-top:18px;background:#1769e0;color:white;border:0;border-radius:9px;padding:13px 20px;font-weight:700;font-size:16px;cursor:pointer}.muted{color:#657083;line-height:1.5}</style></head><body><div class="card"><h1>Connect WPGo</h1><p class="muted">Connect ${esc(client.client_name||'your AI')} to the WordPress site where WPGo is installed. You will be sent to WordPress to approve access.</p><form method="post" action="/oauth/authorize/site"><input type="hidden" name="flow" value="${esc(flow)}"><label>WordPress site</label><input name="site" type="url" placeholder="https://example.com" required autocomplete="url"><button type="submit">Continue to WordPress</button></form><p class="muted">WPGo never asks for your normal WordPress password.</p></div></body></html>`);
});
app.post('/oauth/authorize/site',async(req,res)=>{
  const flow=unseal('wpgoflow1',String(req.body?.flow||'')); if(!flow)return html(res,'<h1>Connection expired</h1><p>Return to your AI client and connect WPGo again.</p>',400);
  const site=normalizeSite(req.body?.site); if(!site)return html(res,'<h1>Invalid site</h1><p>Enter the HTTPS address of your WordPress site.</p>',400);
  const index=await wordpressIndex(site); if(!index.ok||!index.data)return html(res,'<h1>WordPress not detected</h1><p>WPGo could not read the WordPress REST API at that address.</p>',400);
  const routes=index.data.routes||{};
  const hasWpgo=Object.keys(routes).some(k=>k.startsWith('/wpgo/v1')) || Object.keys(routes).some(k=>k.startsWith('/wp-abilities/v1'));
  if(!hasWpgo)return html(res,'<h1>WPGo not detected</h1><p>Install and activate WPGo on this WordPress site, then try again.</p>',400);
  const authEndpoint=index.data?.authentication?.['application-passwords']?.endpoints?.authorization || new URL('wp-admin/authorize-application.php',site).toString();
  const appId=crypto.randomUUID();
  const nextFlow=seal('wpgoflow1',{...flow,site,app_id:appId,exp:Math.floor(Date.now()/1000)+600});
  const success=new URL('/oauth/wp/callback',baseUrl(req)); success.searchParams.set('flow',nextFlow);
  const reject=new URL('/oauth/wp/reject',baseUrl(req)); reject.searchParams.set('flow',nextFlow);
  const u=new URL(authEndpoint); u.searchParams.set('app_name','WPGo AI Connector');u.searchParams.set('app_id',appId);u.searchParams.set('success_url',success.toString());u.searchParams.set('reject_url',reject.toString());
  res.redirect(302,u.toString());
});
app.get('/oauth/wp/reject',(req,res)=>{
  const flow=unseal('wpgoflow1',String(req.query.flow||'')); if(!flow)return html(res,'<h1>Connection cancelled</h1>',400);
  res.redirect(302,oauthErrorRedirect(flow.redirect_uri,'access_denied','WordPress authorization was cancelled.',flow.state));
});
app.get('/oauth/wp/callback',async(req,res)=>{
  const flow=unseal('wpgoflow1',String(req.query.flow||'')); if(!flow)return html(res,'<h1>Connection expired</h1>',400);
  const siteReturned=normalizeSite(req.query.site_url),username=String(req.query.user_login||''),password=String(req.query.password||'');
  if(!siteReturned||siteReturned!==flow.site||!username||password.length<12)return res.redirect(302,oauthErrorRedirect(flow.redirect_uri,'access_denied','WordPress did not return a valid authorization.',flow.state));
  const auth={site_url:flow.site,username,password};
  try { const abilities=await fetchAbilities(auth); if(!abilities.length)throw new Error('No WPGo abilities found.'); }
  catch { return res.redirect(302,oauthErrorRedirect(flow.redirect_uri,'access_denied','WPGo could not verify the WordPress connection.',flow.state)); }
  const code=crypto.randomBytes(32).toString('base64url');
  authCodes.set(code,{...flow,username,password,expiresAt:Date.now()+300000});
  res.set('Cache-Control','no-store');
  res.redirect(302,appendCode(flow.redirect_uri,code,flow.state));
});
app.post('/oauth/token',(req,res)=>{
  const grant=String(req.body?.grant_type||''),clientId=String(req.body?.client_id||'');
  if(grant==='authorization_code'){
    const code=String(req.body?.code||''),verifier=String(req.body?.code_verifier||''),redirectUri=String(req.body?.redirect_uri||'');
    const row=authCodes.get(code); authCodes.delete(code);
    if(!row||row.expiresAt<Date.now()||row.client_id!==clientId||row.redirect_uri!==redirectUri)return res.status(400).json({error:'invalid_grant'});
    const expected=crypto.createHash('sha256').update(verifier).digest('base64url'); if(!verifier||expected!==row.code_challenge)return res.status(400).json({error:'invalid_grant'});
    const now=Math.floor(Date.now()/1000),base={client_id:clientId,site_url:row.site,username:row.username,password:row.password,resource:row.resource,scopes:['mcp']};
    const access=seal('wpgoaccess1',{...base,iat:now,exp:now+3600});
    const refresh=seal('wpgorefresh1',{...base,iat:now,exp:now+86400*30});
    return res.json({access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:'mcp'});
  }
  if(grant==='refresh_token'){
    const row=unseal('wpgorefresh1',String(req.body?.refresh_token||'')); if(!row||row.client_id!==clientId)return res.status(400).json({error:'invalid_grant'});
    const now=Math.floor(Date.now()/1000),access=seal('wpgoaccess1',{...row,iat:now,exp:now+3600});
    return res.json({access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:String(req.body.refresh_token),scope:'mcp'});
  }
  return res.status(400).json({error:'unsupported_grant_type'});
});

async function mcpAuth(req,res,next){
  const header=String(req.get('authorization')||''); const token=header.startsWith('Bearer ')?header.slice(7).trim():''; const row=unseal('wpgoaccess1',token);
  const resource=mcpUrl(req); const metadata=`${baseUrl(req)}/.well-known/oauth-protected-resource/mcp`;
  if(!row||row.resource!==resource){res.set('WWW-Authenticate',`Bearer resource_metadata="${metadata}", error="invalid_token"`);return res.status(401).json({error:'invalid_token'});}
  req.auth={token,clientId:row.client_id,scopes:['mcp'],expiresAt:row.exp,resource:new URL(resource),resourceMetadataUrl:new URL(metadata)};
  next();
}
app.all('/mcp',mcpAuth,(req,res)=>void nodeMcpHandler(req,res,req.body));

app.use((err,req,res,next)=>{console.error(JSON.stringify({event:'gateway_error',path:req.path,message:String(err?.message||err).slice(0,500)}));if(res.headersSent)return next(err);res.status(500).json({error:'server_error'});});
app.listen(port,'0.0.0.0',()=>console.log(`WPGo MCP gateway ${VERSION} listening on ${port}`));
