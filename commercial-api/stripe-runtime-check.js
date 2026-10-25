import Stripe from 'stripe';

const secret = String(process.env.STRIPE_SECRET_KEY || '').trim();
const specs = [
  ['STRIPE_PRICE_SOLO', 595, 'month'],
  ['STRIPE_PRICE_SOLO_YEARLY', 6069, 'year'],
  ['STRIPE_PRICE_PRO', 1295, 'month'],
  ['STRIPE_PRICE_PRO_YEARLY', 13209, 'year'],
  ['STRIPE_PRICE_AGENCY', 2495, 'month'],
  ['STRIPE_PRICE_AGENCY_YEARLY', 25449, 'year'],
  ['STRIPE_PRICE_SCALE', 3995, 'month'],
  ['STRIPE_PRICE_SCALE_YEARLY', 40749, 'year']
];

const mode = /^(?:sk|rk)_live_/.test(secret)
  ? 'live'
  : /^(?:sk|rk)_test_/.test(secret)
    ? 'test'
    : secret ? 'unknown' : 'none';

const result = {
  event: 'stripe_runtime_validation',
  mode,
  configured: 0,
  validated: 0,
  all_valid: false,
  failures: []
};

if (secret) {
  const stripe = new Stripe(secret);
  for (const [envName, amount, interval] of specs) {
    const id = String(process.env[envName] || '').trim();
    if (!id) {
      result.failures.push(`${envName}:missing`);
      continue;
    }
    result.configured += 1;
    try {
      const price = await stripe.prices.retrieve(id);
      const valid =
        price?.active === true &&
        price?.currency === 'eur' &&
        Number(price?.unit_amount) === amount &&
        price?.recurring?.interval === interval;
      if (valid) result.validated += 1;
      else result.failures.push(`${envName}:mismatch`);
    } catch (error) {
      result.failures.push(`${envName}:${String(error?.code || error?.type || 'lookup_failed').slice(0, 60)}`);
    }
  }
}

result.all_valid = result.validated === specs.length;
console.log(JSON.stringify(result));
export default result;
