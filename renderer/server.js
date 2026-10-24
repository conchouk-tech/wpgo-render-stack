import express from 'express';
import { chromium } from 'playwright';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));

const VERSION = '4.1.1';
const port = Number(process.env.PORT || 8080);
const token = process.env.WPGO_RENDER_TOKEN || '';
const allowInsecureNoToken = process.env.WPGO_RENDER_ALLOW_NO_TOKEN === '1';
const allowAnyPublic = process.env.WPGO_RENDER_ALLOW_ANY_PUBLIC === '1';
const allowedHosts = new Set((process.env.WPGO_RENDER_ALLOWED_HOSTS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean));
const maxConcurrency = Math.max(1, Math.min(12, Number(process.env.WPGO_RENDER_MAX_CONCURRENCY || 3)));
const dnsCache = new Map();
let active = 0;
let browser;

function safeEqual(a,b){const ah=crypto.createHash('sha256').update(String(a)).digest();const bh=crypto.createHash('sha256').update(String(b)).digest();return crypto.timingSafeEqual(ah,bh);}
function authorized(req) { if (!token) return allowInsecureNoToken; return safeEqual(req.get('authorization') || '', `Bearer ${token}`); }
function privateIp(address) {
  if (!net.isIP(address)) return true;
  const a=address.toLowerCase();
  if (['127.0.0.1','0.0.0.0','::1','::'].includes(a)) return true;
  if (a.startsWith('10.') || a.startsWith('192.168.') || a.startsWith('169.254.')) return true;
  const m=a.match(/^172\.(\d+)\./); if(m&&Number(m[1])>=16&&Number(m[1])<=31)return true;
  if(a.startsWith('fc')||a.startsWith('fd')||a.startsWith('fe8')||a.startsWith('fe9')||a.startsWith('fea')||a.startsWith('feb'))return true;
  if(a.startsWith('::ffff:')) return privateIp(a.slice(7));
  return false;
}
async function publicHost(host) {
  const now=Date.now(); const cached=dnsCache.get(host); if(cached&&cached.expires>now)return cached.ok;
  try { const results=await dns.lookup(host,{all:true,verbatim:true}); const ok=Boolean(results.length)&&!results.some(r=>privateIp(r.address)); dnsCache.set(host,{ok,expires:now+60000}); return ok; }
  catch { dnsCache.set(host,{ok:false,expires:now+15000}); return false; }
}
async function validateUrl(value,{main=false}={}) {
  try {
    const url=new URL(value); if(url.protocol!=='https:'&&process.env.WPGO_RENDER_ALLOW_HTTP!=='1')return false;
    const host=url.hostname.toLowerCase(); if(main&&allowedHosts.size&&!allowedHosts.has(host))return false; if(main&&!allowedHosts.size&&!allowAnyPublic)return false;
    if(!await publicHost(host))return false; return url;
  } catch { return false; }
}
async function getBrowser(){if(browser?.isConnected())return browser;browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage','--no-first-run','--disable-background-networking']});return browser;}
function security(res){res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');res.set('Cross-Origin-Resource-Policy','same-origin');}
app.use((_req,res,next)=>{security(res);next();});

app.post('/render', async (req,res)=>{
  const requestId=crypto.randomUUID(); res.set('X-WPGo-Request-ID',requestId);
  if(!authorized(req))return res.status(401).json({error:'unauthorized',request_id:requestId});
  if(active>=maxConcurrency)return res.status(429).json({error:'busy',retry_after_seconds:2,request_id:requestId});
  const url=await validateUrl(req.body?.url,{main:true}); if(!url)return res.status(400).json({error:'invalid_or_disallowed_url',request_id:requestId});
  const waitMs=Math.max(0,Math.min(5000,Number(req.body?.wait_ms||800))); const maxHtml=Math.max(1000,Math.min(100000,Number(req.body?.max_html||20000)));
  const started=Date.now(); active+=1; let context;
  try {
    const b=await getBrowser(); context=await b.newContext({javaScriptEnabled:true,ignoreHTTPSErrors:false,serviceWorkers:'block'}); const page=await context.newPage();
    await page.route('**/*',async route=>{const request=route.request();const type=request.resourceType();if(['media','font'].includes(type))return route.abort();const target=await validateUrl(request.url(),{main:false});if(!target)return route.abort('blockedbyclient');return route.continue();});
    await page.goto(url.href,{waitUntil:'networkidle',timeout:30000}); const finalUrl=page.url(); if(!await validateUrl(finalUrl,{main:true}))throw new Error('Final navigation URL failed WPGo host/public-network policy.');
    if(waitMs)await page.waitForTimeout(waitMs); const html=(await page.content()).slice(0,maxHtml); const title=await page.title();
    res.json({html,title,renderer:'wpgo-playwright',renderer_version:VERSION,javascript_executed:true,final_url:finalUrl,request_id:requestId,timings:{total_ms:Date.now()-started}});
  } catch(error){res.status(502).json({error:'render_failed',message:String(error?.message||error).slice(0,500),request_id:requestId});}
  finally{active-=1;if(context)await context.close();}
});
app.get('/health',async(req,res)=>{if(token&&!authorized(req))return res.status(401).json({error:'unauthorized'});let browserReady=false,error='';try{const b=await getBrowser();browserReady=b.isConnected();}catch(e){error=String(e?.message||e).slice(0,200);}res.status(browserReady?200:503).json({ok:browserReady,service:'wpgo-renderer',version:VERSION,browser_ready:browserReady,active,max_concurrency:maxConcurrency,allowed_hosts:allowedHosts.size,allow_any_public:allowAnyPublic,auth_required:Boolean(token),dns_rebinding_guard:true,subresource_ssrf_guard:true,error});});
app.get('/v1/capabilities',(req,res)=>{if(token&&!authorized(req))return res.status(401).json({error:'unauthorized'});res.json({service:'wpgo-renderer',version:VERSION,javascript:true,network_policy:'public-only',main_host_allowlist:true,subresource_ssrf_guard:true,max_concurrency:maxConcurrency});});
async function shutdown(){try{if(browser)await browser.close();}finally{process.exit(0);}} process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
app.listen(port,'0.0.0.0',()=>console.log(`WPGo renderer ${VERSION} listening on ${port}`));
