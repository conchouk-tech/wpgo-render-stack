import crypto from 'node:crypto';

function privateKeyPemFromSeed(seedText) {
  const seed = crypto.createHash('sha256').update(String(seedText)).digest();
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der = Buffer.concat([prefix, seed]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' }).toString();
}

if (!process.env.WPGO_SIGNING_PRIVATE_KEY_PEM && process.env.WPGO_SIGNING_SEED) {
  process.env.WPGO_SIGNING_PRIVATE_KEY_PEM = privateKeyPemFromSeed(process.env.WPGO_SIGNING_SEED);
}

await import('./server.js');
