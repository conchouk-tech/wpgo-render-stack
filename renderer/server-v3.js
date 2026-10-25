import express from 'express';
import { chromium } from 'playwright';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '128kb' }));

const VERSION = '4.5.0';
const NODE_ENV = String(process.env.NODE_ENV || 'production').toLowerCase();
const port = Number(process.env.PORT || 8080);
const legacyToken = process.env.WPGO_RENDER_TOKEN || '';
const allowInsecureNoToken = process.env.WPGO_RENDER_ALLOW_NO_TOKEN === '1' && NODE_ENV !== 'production';
const allowHttp = process.env.WPGO_RENDER_ALLOW_HTTP === '1' && NODE_ENV !== 'production';
const allowAnyPublicLegacy = process.env.WPGO_RENDER_ALLOW_ANY_PUBLIC === '1';
const allowedHosts = new Set((process.env.WPGO_RENDER_ALLOWED_HOSTS || '').split(',').map(normalizeHost).filter(Boolean));
const licenseValidateUrl = String(process.env.WPGO_LICENSE_VALIDATE_URL || 'https://wpgo-control-plane-ga.onrender.com/v1/license/validate');
const maxConcurrency = Math.max(1, Math.min(12, Number(process.env.WPGO_RENDER_MAX_CONCURRENCY || 3)));
const fetchTimeoutMs = Math.max(2000, Math.min(15000, Number(process.env.WPGO_RENDER_LICENSE_TIMEOUT_MS || 6000)));
const dnsCache = new Map();
let active = 0;
let browser;

function normalizeHost(v){return String(v||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*$/,'').replace(/^www\./,'');}
function safeEqual(a,b){const ah=crypto.createHash('sha256').update(String(a)).digest();const bh=crypto.createHash('sha256').update(String(b)).digest();return crypto.timingSafeEqual(ah,bh);}
function bearer(req){const h=String(req.get('authorization')||'');return h.startsWith('Bearer ')?h.slice(7).trim():'';}
function privateIp(address){
  if(!net.isIP(address))return true;
  const a=address.toLowerCase();
  if(net.isIP(a)===4){const p=a.split('.').map(Number);if(p[0]===0||p[0]===10||p[0]===127||p[0]>=224)return true;if(p[0]===100&&p[1]>=64&&p[1]<=127)return true;if(p[0]===169&&p[1]===254)return true;if(p[0]===172&&p[1]>=16&&p[1]<=31)return true;if(p[0]===192&&p[1]===168)return true;if(p[0]===198&&(p[1]===18||p[1]===19))return true;return false;}
  if(a==='::'||a==='::1')return true;
  if(a.startsWith('::ffff:'))return privateIp(a.slice(7));
  return a.startsWith('fc')||a.startsWith('fd')||a.startsWith('fe8')||a.startsWith('fe9')||a.startsWith('fea')||a.startsWith('feb')||a.startsWith('ff');
}
async function publicHost(host){const now=Date.now(),cached=dnsCache.get(host);if(cached&&cached.expires>now)return cached.ok;try{const results=await dns.lookup(host,{all:true,verbatim:true});const ok=Boolean(results.length)&&!results.some(r=>privateIp(r.address));dnsCache.set(host,{ok,expires:now+60000});return ok;}catch{dnsCache.set(host,{ok:false,expires:now+15000});return false;}}
async function validateUrl(value){try{const url=new URL(value);if(url.protocol!=='https:'&&!(allowHttp&&url.protocol==='http:'))return false;if(url.username||url.password)return false;if(!await publicHost(url.hostname))return false;return url;}catch{return false;}}
async function fetchJson(url,options={}){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),fetchTimeoutMs);try{const r=await fetch(url,{...options,signal:controller.signal,redirect:'manual'});const data=await r.json().catch(()=>({}));return{ok:r.ok,status:r.status,data};}finally{clearTimeout(timer);}}
async function authorize(req,url){
  const token=bearer(req);
  const siteHost=normalizeHost(url.hostname);
  if(legacyToken&&token&&safeEqual(token,legacyToken)){
    if(allowedHosts.size&&allowedHosts.has(siteHost))return{ok:true,mode:'legacy_allowlist'};
    if(!allowedHosts.size&&allowAnyPublicLegacy)return{ok:true,mode:'legacy_any_public'};
    return{ok:false,status:403,error:'legacy_host_not_allowed'};
  }
  if(!token){if(allowInsecureNoToken)return{ok:true,mode:'development_no_token'};return{ok:false,status:401,error:'license_required'};}
  try{
    const siteUrl=`${url.protocol}//${url.host}/`;
    const r=await fetchJson(licenseValidateUrl,{method:'POST',headers:{'content-type':'application/json','accept':'application/json','user-agent':`WPGo-Renderer/${VERSION}`},body:JSON.stringify({license_key:token,site_url:siteUrl})});
    const raw=r.data||{},data=raw?.payload&&typeof raw.payload==='object'?raw.payload:raw;
    if(!r.ok||data?.status!=='active'||!data?.license_id)return{ok:false,status:r.status||403,error:data?.status||'invalid_license'};
    return{ok:true,mode:'site_bound_license',license_id:data.license_id,plan:data.plan||''};
  }catch{return{ok:false,status:502,error:'license_service_unavailable'};}
}
async function getBrowser(){if(browser?.isConnected())return browser;browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage','--no-first-run','--disable-background-networking']});return browser;}
function security(res){res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');res.set('Cross-Origin-Resource-Policy','same-origin');res.set('X-Frame-Options','DENY');res.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');}
app.use((req,res,next)=>{security(res);res.set('X-Request-Id',req.get('x-request-id')||crypto.randomUUID());next();});

app.post('/render',async(req,res)=>{
  const requestId=res.get('X-Request-Id');
  if(active>=maxConcurrency)return res.status(429).json({error:'busy',retry_after_seconds:2,request_id:requestId});
  const url=await validateUrl(req.body?.url);if(!url)return res.status(400).json({error:'invalid_or_non_public_url',request_id:requestId});
  const auth=await authorize(req,url);if(!auth.ok)return res.status(auth.status).json({error:auth.error,request_id:requestId});
  const waitMs=Math.max(0,Math.min(5000,Number(req.body?.wait_ms||800)));
  const maxHtml=Math.max(1000,Math.min(100000,Number(req.body?.max_html||20000)));
  const started=Date.now();active+=1;let context;
  try{
    const b=await getBrowser();
    context=await b.newContext({javaScriptEnabled:true,ignoreHTTPSErrors:false,serviceWorkers:'block'});
    const page=await context.newPage();
    const mainOrigin=url.origin;
    await page.route('**/*',async route=>{const request=route.request(),type=request.resourceType();if(['media','font'].includes(type))return route.abort();const target=await validateUrl(request.url());if(!target)return route.abort('blockedbyclient');if(request.isNavigationRequest()&&request.frame()===page.mainFrame()&&target.origin!==mainOrigin)return route.abort('blockedbyclient');return route.continue();});
    await page.goto(url.href,{waitUntil:'networkidle',timeout:30000});
    const finalUrl=page.url(),finalParsed=await validateUrl(finalUrl);if(!finalParsed||finalParsed.origin!==mainOrigin)throw new Error('Final navigation URL failed WPGo origin/public-network policy.');
    if(waitMs)await page.waitForTimeout(waitMs);
    const html=(await page.content()).slice(0,maxHtml),title=await page.title();
    res.json({html,title,renderer:'wpgo-playwright',renderer_version:VERSION,javascript_executed:true,final_url:finalUrl,request_id:requestId,authorization_mode:auth.mode,timings:{total_ms:Date.now()-started}});
  }catch(error){res.status(502).json({error:'render_failed',message:String(error?.message||error).slice(0,500),request_id:requestId});}
  finally{active-=1;if(context)await context.close();}
});
app.get('/health',async(req,res)=>{let browserReady=false,error='';try{const b=await getBrowser();browserReady=b.isConnected();}catch(e){error=String(e?.message||e).slice(0,200);}res.status(browserReady?200:503).json({ok:browserReady,service:'wpgo-renderer',version:VERSION,browser_ready:browserReady,active,max_concurrency:maxConcurrency,legacy_allowlist_hosts:allowedHosts.size,legacy_any_public:allowAnyPublicLegacy,legacy_token_configured:Boolean(legacyToken),site_bound_license_auth:true,public_dns_validation:true,private_ip_guard:true,subresource_url_guard:true,main_origin_lock:true,http_allowed:allowHttp,error});});
app.get('/v1/capabilities',(req,res)=>res.json({service:'wpgo-renderer',version:VERSION,javascript:true,network_policy:'public-only',authorization:['site-bound-license','legacy-internal-token'],public_dns_validation:true,private_ip_guard:true,subresource_url_guard:true,main_origin_lock:true,max_concurrency:maxConcurrency}));
async function shutdown(signal){console.log(JSON.stringify({event:'shutdown',signal}));try{if(browser)await browser.close();}finally{process.exit(0);}}
process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));
app.listen(port,'0.0.0.0',()=>console.log(`WPGo renderer ${VERSION} listening on ${port}`));
