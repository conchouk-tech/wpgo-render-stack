import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteToken, readSiteToken, resourceForSite, siteTokenFromResource } from './site-link.js';

const secret = 'rc-test-secret-0123456789abcdef-0123456789abcdef';

test('site tokens round trip and preserve WordPress subdirectory installs', () => {
  const token = createSiteToken('https://example.com/blog', secret);
  assert.equal(readSiteToken(token, secret), 'https://example.com/blog/');
});

test('site tokens are stable for the same normalized site', () => {
  assert.equal(
    createSiteToken('https://example.com/blog/', secret),
    createSiteToken('https://example.com/blog?x=1#frag', secret)
  );
});

test('tampered site tokens are rejected', () => {
  const token = createSiteToken('https://example.com/', secret);
  const parts = token.split('.');
  const tampered = `${parts[0]}.${Buffer.from('https://attacker.example/', 'utf8').toString('base64url')}.${parts[2]}`;
  assert.equal(readSiteToken(tampered, secret), '');
});

test('site resource URL carries and recovers the bound site', () => {
  const resource = resourceForSite('https://mcp.wpgo.example', 'https://example.com/blog/', secret);
  assert.match(resource, /^https:\/\/mcp\.wpgo\.example\/mcp\/s\/wpgosite1\./);
  assert.equal(
    siteTokenFromResource(resource, 'https://mcp.wpgo.example', secret),
    'https://example.com/blog/'
  );
});

test('resource tokens cannot be replayed on a different gateway origin', () => {
  const resource = resourceForSite('https://mcp.wpgo.example', 'https://example.com/', secret);
  assert.equal(siteTokenFromResource(resource, 'https://other.example', secret), '');
});
