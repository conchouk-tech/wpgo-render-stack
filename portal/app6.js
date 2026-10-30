import fs from 'node:fs/promises';
import { WPGoPricing, yearlySavingCopy, yearlySavingShortCopy } from '../pricing-config.js';

await import('./fetch-hardening.js');

const sourceUrl = new URL('./app5.js', import.meta.url);
const runtimeUrl = new URL('./.wpgo-app5-runtime.mjs', import.meta.url);
let source = await fs.readFile(sourceUrl, 'utf8');

const replacements = [
  ['yearly:60.69', `yearly:${WPGoPricing.solo.yearly}`],
  ['yearly:132.09', `yearly:${WPGoPricing.pro.yearly}`],
  ['yearly:254.49', `yearly:${WPGoPricing.agency.yearly}`],
  ['yearly:407.49', `yearly:${WPGoPricing.scale.yearly}`],
  ['save 15%', yearlySavingCopy],
  ['15% off yearly.', `${yearlySavingShortCopy.charAt(0).toUpperCase()}${yearlySavingShortCopy.slice(1)} yearly.`],
  ["<div class=\"stat\">${esc(p.name)}</div>", "<div class=\"stat\">${esc(p.id==='founder'?'Active':p.name)}</div>"],
  ["u.unlimited?'Unlimited founder usage':", "u.unlimited?'Account active':"],
  ["p.id==='founder'?'Founder account · permanently unlimited · no billing required.':'Stripe manages paid subscriptions securely.'", "p.id==='founder'?'Your WP Virtuoso account is active.':'Stripe manages paid subscriptions securely.'"],
  ["<p class=\"small\">Founder view of recent contact, bug and feedback submissions.</p>", "<p class=\"small\">Recent contact, bug and feedback submissions.</p>"]
];
for (const [from, to] of replacements) source = source.split(from).join(to);

await fs.writeFile(runtimeUrl, source, 'utf8');
await import(`${runtimeUrl.href}?v=${Date.now()}`);
