import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeScope,
  normalizeSite,
  scopesAreSupported,
  validClientMetadataUrl,
  validPkceChallenge,
  validPkceVerifier,
  validRedirectUri
} from './security.js';

test('normalizeSite preserves WordPress subdirectory installs', () => {
  assert.equal(normalizeSite('https://example.com/blog'), 'https://example.com/blog/');
  assert.equal(normalizeSite('https://example.com/blog/?x=1#frag'), 'https://example.com/blog/');
  assert.equal(normalizeSite('https://example.com'), 'https://example.com/');
});

test('normalizeSite rejects insecure and credential-bearing URLs', () => {
  assert.equal(normalizeSite('http://example.com'), '');
  assert.equal(normalizeSite('https://user:pass@example.com'), '');
});

test('redirect URI validation permits HTTPS and native loopback HTTP only', () => {
  assert.equal(validRedirectUri('https://client.example/callback'), true);
  assert.equal(validRedirectUri('http://127.0.0.1:49152/callback'), true);
  assert.equal(validRedirectUri('http://127.0.0.42:49152/callback'), true);
  assert.equal(validRedirectUri('http://localhost:49152/callback'), true);
  assert.equal(validRedirectUri('http://[::1]:49152/callback'), true);
  assert.equal(validRedirectUri('http://example.com/callback'), false);
  assert.equal(validRedirectUri('https://client.example/callback#fragment'), false);
  assert.equal(validRedirectUri('https://user:pass@client.example/callback'), false);
});

test('CIMD client IDs require a stable HTTPS document URL', () => {
  assert.equal(validClientMetadataUrl('https://client.example/.well-known/oauth-client.json'), true);
  assert.equal(validClientMetadataUrl('https://client.example/'), false);
  assert.equal(validClientMetadataUrl('https://client.example/client.json?x=1'), false);
  assert.equal(validClientMetadataUrl('https://client.example/a/../client.json'), false);
  assert.equal(validClientMetadataUrl('http://client.example/client.json'), false);
});

test('PKCE validation enforces S256-compatible verifier and challenge shapes', () => {
  assert.equal(validPkceVerifier('a'.repeat(43)), true);
  assert.equal(validPkceVerifier('a'.repeat(42)), false);
  assert.equal(validPkceVerifier('!'.repeat(43)), false);
  assert.equal(validPkceChallenge('A'.repeat(43)), true);
  assert.equal(validPkceChallenge('A'.repeat(42)), false);
  assert.equal(validPkceChallenge('+'.repeat(43)), false);
});

test('scope normalization accepts only the WPGo MCP scope', () => {
  assert.deepEqual(normalizeScope(''), ['mcp']);
  assert.deepEqual(normalizeScope('mcp mcp'), ['mcp']);
  assert.equal(scopesAreSupported(normalizeScope('mcp')), true);
  assert.equal(scopesAreSupported(normalizeScope('mcp admin')), false);
});
