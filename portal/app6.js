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
  ['15% off yearly.', `${yearlySavingShortCopy.charAt(0).toUpperCase()}${yearlySavingShortCopy.slice(1)} yearly.`]
];
for (const [from, to] of replacements) source = source.split(from).join(to);

await fs.writeFile(runtimeUrl, source, 'utf8');
await import(`${runtimeUrl.href}?v=${Date.now()}`);
