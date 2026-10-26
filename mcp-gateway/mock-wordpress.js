import https from 'node:https';
import fs from 'node:fs';

const port = Number(process.env.WPGO_MOCK_WP_PORT || 9443);
const keyPath = String(process.env.WPGO_MOCK_WP_KEY || '/tmp/wpgo-mock-key.pem');
const certPath = String(process.env.WPGO_MOCK_WP_CERT || '/tmp/wpgo-mock-cert.pem');
const origin = `https://127.0.0.1:${port}`;
const site = `${origin}/`;

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const abilities = [
  {
    name: 'wpgo/site-info',
    label: 'Site information',
    description: 'Read safe WordPress site information.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    meta: { annotations: { readonly: true, destructive: false, idempotent: true } }
  },
  {
    name: 'wpgo/create-draft-post',
    label: 'Create draft post',
    description: 'Create a draft WordPress post after WPGo approval.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false
    },
    meta: { annotations: { readonly: false, destructive: false, idempotent: true } }
  }
];

const server = https.createServer(
  { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
  async (req, res) => {
    const url = new URL(req.url || '/', site);

    if (req.method === 'GET' && (url.pathname === '/wp-json/' || url.pathname === '/wp-json')) {
      return json(res, 200, {
        name: 'WPGo RC Mock Site',
        url: site,
        home: site,
        routes: {
          '/wpgo/v1': {},
          '/wpgo/v1/abilities/run': {},
          '/wpgo/v1/approvals/(?P<id>[\\w-]+)': {},
          '/wp-abilities/v1/abilities': {}
        },
        authentication: {
          'application-passwords': {
            endpoints: {
              authorization: `${origin}/wp-admin/authorize-application.php`
            }
          }
        }
      });
    }

    if (req.method === 'GET' && url.pathname === '/wp-json/wp-abilities/v1/abilities') {
      if (!String(req.headers.authorization || '').startsWith('Basic ')) {
        return json(res, 401, { code: 'rest_not_logged_in', message: 'Authentication required.' });
      }
      return json(res, 200, abilities, {
        'x-wp-total': String(abilities.length),
        'x-wp-totalpages': '1'
      });
    }

    if (req.method === 'POST' && url.pathname === '/wp-json/wpgo/v1/abilities/run') {
      if (!String(req.headers.authorization || '').startsWith('Basic ')) {
        return json(res, 401, { code: 'rest_not_logged_in', message: 'Authentication required.' });
      }
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch {}
      if (body.ability === 'wpgo/site-info') {
        return json(res, 200, { name: 'WPGo RC Mock Site', wpgo_version: '4.5.0-rc.1', wordpress_version: '6.9-test' });
      }
      if (body.ability === 'wpgo/create-draft-post' && !body.approval_id) {
        return json(res, 200, {
          status: 'approval_required',
          approval_id: 'approval-rc-123456',
          approval_url: `${origin}/wp-admin/admin.php?page=wpgo-approval&id=approval-rc-123456`
        });
      }
      return json(res, 200, { status: 'completed', ability: body.ability || '', input: body.input || {} });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/wp-json/wpgo/v1/approvals/')) {
      return json(res, 200, { status: 'approved', approval_id: url.pathname.split('/').pop() });
    }

    if (req.method === 'GET' && url.pathname === '/wp-admin/authorize-application.php') {
      const success = url.searchParams.get('success_url') || '';
      const reject = url.searchParams.get('reject_url') || '';
      const body = `<!doctype html><html><body><h1>Mock WordPress application approval</h1><p>WPGo AI Connector</p><p data-success="${success.replaceAll('"', '&quot;')}"></p><p data-reject="${reject.replaceAll('"', '&quot;')}"></p></body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(body);
    }

    return json(res, 404, { error: 'not_found', path: url.pathname });
  }
);

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'mock_wordpress_ready', site }));
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
