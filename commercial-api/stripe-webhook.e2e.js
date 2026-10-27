import crypto from 'node:crypto';
import Stripe from 'stripe';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = String(process.env.DATABASE_URL || '');
const api = String(process.env.WPGO_E2E_API || 'http://127.0.0.1:8081').replace(/\/$/, '');
const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '');
if (!databaseUrl || !webhookSecret) throw new Error('DATABASE_URL and STRIPE_WEBHOOK_SECRET are required');

const pool = new Pool({ connectionString: databaseUrl, ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false } });

async function signedEvent(id, type, object) {
  const payload = JSON.stringify({ id, object: 'event', api_version: '2025-08-27.basil', created: Math.floor(Date.now() / 1000), livemode: false, type, data: { object } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
  const response = await fetch(`${api}/v1/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new Error(`${type} webhook failed ${response.status}: ${text}`);
  return data;
}

async function account(id) {
  const result = await pool.query('SELECT id,plan,is_founder,stripe_subscription_id,subscription_status FROM wpgo_accounts WHERE id=$1', [id]);
  if (!result.rows[0]) throw new Error(`Missing account ${id}`);
  return result.rows[0];
}

const paidId = crypto.randomUUID();
const founderId = crypto.randomUUID();
await pool.query(
  `INSERT INTO wpgo_accounts(id,email,plan,is_founder,subscription_status) VALUES
   ($1,$2,'free',FALSE,'none'),($3,$4,'founder',TRUE,'active')`,
  [paidId, `billing-${paidId}@example.test`, founderId, `founder-${founderId}@example.test`]
);

console.log('Stripe E2E: checkout activates Pro');
const checkout = {
  id: 'cs_test_rc2',
  subscription: 'sub_rc2_paid',
  client_reference_id: paidId,
  metadata: { wpgo_account_id: paidId, wpgo_plan: 'pro' }
};
const first = await signedEvent('evt_rc2_checkout', 'checkout.session.completed', checkout);
if (first.duplicate !== false || first.mutation !== 'set_subscription') throw new Error('Checkout mutation contract failed');
let row = await account(paidId);
if (row.plan !== 'pro' || row.subscription_status !== 'active' || row.stripe_subscription_id !== 'sub_rc2_paid') throw new Error('Checkout account state failed');

console.log('Stripe E2E: duplicate delivery is idempotent');
const duplicate = await signedEvent('evt_rc2_checkout', 'checkout.session.completed', checkout);
if (duplicate.duplicate !== true) throw new Error('Duplicate Stripe event was not detected');
const ledgerCount = await pool.query('SELECT COUNT(*)::int AS count FROM wpgo_stripe_events WHERE event_id=$1', ['evt_rc2_checkout']);
if (ledgerCount.rows[0]?.count !== 1) throw new Error('Stripe event ledger is not idempotent');

console.log('Stripe E2E: payment failure enters grace/past-due state');
await signedEvent('evt_rc2_failed', 'invoice.payment_failed', { id: 'in_rc2_failed', subscription: 'sub_rc2_paid' });
row = await account(paidId);
if (row.plan !== 'pro' || row.subscription_status !== 'past_due') throw new Error('Payment-failure state failed');

console.log('Stripe E2E: payment recovery restores active state');
await signedEvent('evt_rc2_paid', 'invoice.paid', { id: 'in_rc2_paid', subscription: 'sub_rc2_paid' });
row = await account(paidId);
if (row.plan !== 'pro' || row.subscription_status !== 'active') throw new Error('Payment recovery failed');

console.log('Stripe E2E: subscription update upgrades plan');
await signedEvent('evt_rc2_upgrade', 'customer.subscription.updated', {
  id: 'sub_rc2_paid',
  status: 'active',
  metadata: { wpgo_account_id: paidId, wpgo_plan: 'agency' }
});
row = await account(paidId);
if (row.plan !== 'agency' || row.subscription_status !== 'active') throw new Error('Plan upgrade failed');

console.log('Stripe E2E: Founder account is protected from Stripe plan mutation');
await signedEvent('evt_rc2_founder', 'customer.subscription.updated', {
  id: 'sub_founder_should_not_apply',
  status: 'active',
  metadata: { wpgo_account_id: founderId, wpgo_plan: 'solo' }
});
const founder = await account(founderId);
if (!founder.is_founder || founder.plan !== 'founder' || founder.stripe_subscription_id) throw new Error('Founder account protection failed');

console.log('Stripe E2E: cancellation returns customer to free');
await signedEvent('evt_rc2_cancel', 'customer.subscription.deleted', {
  id: 'sub_rc2_paid',
  metadata: { wpgo_account_id: paidId }
});
row = await account(paidId);
if (row.plan !== 'free' || row.subscription_status !== 'cancelled' || row.stripe_subscription_id) throw new Error('Cancellation state failed');

console.log('Stripe E2E: invalid signature is rejected');
const bad = await fetch(`${api}/v1/billing/webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 'bad' }, body: '{}'
});
if (bad.status !== 400) throw new Error(`Invalid Stripe signature returned ${bad.status}`);

await pool.end();
console.log(JSON.stringify({ event: 'wpgo_stripe_webhook_e2e', ok: true, checks: ['signature','checkout','idempotency','payment_failure','payment_recovery','upgrade','founder_protection','cancellation','invalid_signature'] }));
