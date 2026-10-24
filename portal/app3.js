import fs from 'node:fs';

const sourceUrl = new URL('./app2.js', import.meta.url);
const runtimeUrl = new URL('./.app3-runtime.js', import.meta.url);
let source = fs.readFileSync(sourceUrl, 'utf8');

const connectedMarker = '<span class="small">connected</span></div>';
const connectedReplacement = '<form method="post" action="/account/license"><input type="hidden" name="site_host" value="${esc(s.site_host)}"><button class="btn secondary small" type="submit">Generate licence</button></form></div>';
if (!source.includes(connectedMarker)) {
  throw new Error('WPGo portal patch failed: connected-site marker not found');
}
source = source.replace(connectedMarker, connectedReplacement);

const copyMarker = 'Register a WordPress site below to create its signed WPGo licence.';
const copyReplacement = 'Connect a WordPress site below, or generate a fresh signed licence for any site already connected.';
if (source.includes(copyMarker)) source = source.replace(copyMarker, copyReplacement);

const billingAnchor = "app.post('/account/billing',async(req,res)=>{";
if (!source.includes(billingAnchor)) {
  throw new Error('WPGo portal patch failed: billing route anchor not found');
}
const licenceRoute = `app.post('/account/license',async(req,res)=>{\n  const token=cookieValue(req,'wpgo_session'); if(!token) return res.redirect(303,'/start');\n  const host=String(req.body.site_host||'').trim().toLowerCase();\n  const body={site_hosts:host?[host]:[]};\n  const r=await api('/v1/account/license',{method:'POST',body,token});\n  const page=await accountPage(req,{notice:r.ok?'Fresh signed licence generated. Copy it into WPGo on this WordPress site.':(r.data.error||'Could not generate a licence.'),bad:!r.ok,licenseKey:r.ok?r.data.license_key:''});\n  if(!page) return res.redirect(303,'/start');\n  res.status(r.ok?200:r.status).send(page);\n});\n\n`;
source = source.replace(billingAnchor, licenceRoute + billingAnchor);

fs.writeFileSync(runtimeUrl, source, 'utf8');
await import(runtimeUrl.href + `?v=${Date.now()}`);
