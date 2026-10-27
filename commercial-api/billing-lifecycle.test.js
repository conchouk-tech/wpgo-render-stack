import test from 'node:test';
import assert from 'node:assert/strict';
import { billingMutationForEvent, entitlementForAccount } from './billing-lifecycle.js';

function event(type, object) {
  return { type, data: { object } };
}

test('checkout completes a bound paid subscription', () => {
  assert.deepEqual(
    billingMutationForEvent(event('checkout.session.completed', {
      subscription: 'sub_123',
      client_reference_id: 'acct_1',
      metadata: { wpgo_account_id: 'acct_1', wpgo_plan: 'pro' }
    })),
    { kind: 'set_subscription', account_id: 'acct_1', plan: 'pro', subscription_id: 'sub_123', status: 'active' }
  );
});

test('subscription update changes plan and status', () => {
  assert.deepEqual(
    billingMutationForEvent(event('customer.subscription.updated', {
      id: 'sub_123',
      status: 'trialing',
      metadata: { wpgo_account_id: 'acct_1', wpgo_plan: 'agency' }
    })),
    { kind: 'set_subscription', account_id: 'acct_1', plan: 'agency', subscription_id: 'sub_123', status: 'trialing' }
  );
});

test('payment failures move the subscription to past due without deleting the plan', () => {
  assert.deepEqual(
    billingMutationForEvent(event('invoice.payment_failed', { subscription: 'sub_123' })),
    { kind: 'set_subscription_status', subscription_id: 'sub_123', status: 'past_due' }
  );
});

test('successful payment restores active status', () => {
  assert.deepEqual(
    billingMutationForEvent(event('invoice.paid', { subscription: 'sub_123' })),
    { kind: 'set_subscription_status', subscription_id: 'sub_123', status: 'active' }
  );
});

test('subscription deletion drops the customer back to free', () => {
  assert.deepEqual(
    billingMutationForEvent(event('customer.subscription.deleted', {
      id: 'sub_123',
      metadata: { wpgo_account_id: 'acct_1' }
    })),
    { kind: 'cancel_subscription', account_id: 'acct_1', subscription_id: 'sub_123', status: 'cancelled' }
  );
});

test('unknown and unbound events are ignored safely', () => {
  assert.equal(billingMutationForEvent(event('charge.refunded', {})).kind, 'ignore');
  assert.equal(billingMutationForEvent(event('checkout.session.completed', { metadata: {} })).kind, 'ignore');
});

test('entitlement reducer handles free, founder, active, grace and cancelled accounts', () => {
  assert.deepEqual(entitlementForAccount({ plan: 'free' }), { entitled: true, plan: 'free', reason: 'free' });
  assert.deepEqual(entitlementForAccount({ plan: 'founder', is_founder: true }), { entitled: true, plan: 'founder', reason: 'founder' });
  assert.deepEqual(entitlementForAccount({ plan: 'pro', subscription_status: 'active' }), { entitled: true, plan: 'pro', reason: 'active' });
  assert.deepEqual(entitlementForAccount({ plan: 'pro', subscription_status: 'past_due' }), { entitled: true, plan: 'pro', reason: 'grace_period' });
  assert.deepEqual(entitlementForAccount({ plan: 'pro', subscription_status: 'cancelled' }), { entitled: false, plan: 'free', reason: 'cancelled' });
});
