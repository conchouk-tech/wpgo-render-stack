const PAID_PLANS = new Set(['solo', 'pro', 'agency', 'scale']);
const ACTIVE_STATUSES = new Set(['active', 'trialing']);

function clean(value, max = 160) {
  return String(value || '').trim().slice(0, max);
}

function paidPlan(value) {
  const plan = clean(value, 40).toLowerCase();
  return PAID_PLANS.has(plan) ? plan : '';
}

export function billingMutationForEvent(event) {
  const type = clean(event?.type, 120);
  const object = event?.data?.object || {};
  const metadata = object.metadata || {};
  const accountId = clean(metadata.wpgo_account_id || object.client_reference_id, 100);
  const plan = paidPlan(metadata.wpgo_plan);
  const subscriptionId = clean(object.subscription || object.id, 180);
  const status = clean(object.status, 40).toLowerCase();

  if (type === 'checkout.session.completed') {
    if (!accountId || !plan || !subscriptionId) return { kind: 'ignore', reason: 'missing_checkout_binding' };
    return { kind: 'set_subscription', account_id: accountId, plan, subscription_id: subscriptionId, status: 'active' };
  }

  if (type === 'customer.subscription.created' || type === 'customer.subscription.updated' || type === 'customer.subscription.resumed') {
    if (!accountId || !plan || !subscriptionId) return { kind: 'ignore', reason: 'missing_subscription_binding' };
    return {
      kind: 'set_subscription',
      account_id: accountId,
      plan,
      subscription_id: subscriptionId,
      status: status || 'active'
    };
  }

  if (type === 'customer.subscription.deleted') {
    if (!accountId && !subscriptionId) return { kind: 'ignore', reason: 'missing_subscription_identity' };
    return {
      kind: 'cancel_subscription',
      account_id: accountId,
      subscription_id: subscriptionId,
      status: 'cancelled'
    };
  }

  if (type === 'invoice.payment_failed' || type === 'invoice.payment_action_required') {
    if (!subscriptionId) return { kind: 'ignore', reason: 'missing_invoice_subscription' };
    return { kind: 'set_subscription_status', subscription_id: subscriptionId, status: 'past_due' };
  }

  if (type === 'invoice.paid' || type === 'invoice.payment_succeeded') {
    if (!subscriptionId) return { kind: 'ignore', reason: 'missing_invoice_subscription' };
    return { kind: 'set_subscription_status', subscription_id: subscriptionId, status: 'active' };
  }

  if (type === 'customer.subscription.paused') {
    if (!subscriptionId) return { kind: 'ignore', reason: 'missing_subscription_identity' };
    return { kind: 'set_subscription_status', subscription_id: subscriptionId, status: 'paused' };
  }

  return { kind: 'ignore', reason: 'unsupported_event' };
}

export function entitlementForAccount({ plan = 'free', subscription_status = 'none', is_founder = false } = {}) {
  if (is_founder || plan === 'founder') return { entitled: true, plan: 'founder', reason: 'founder' };
  const normalizedPlan = paidPlan(plan);
  if (!normalizedPlan) return { entitled: true, plan: 'free', reason: 'free' };
  const status = clean(subscription_status, 40).toLowerCase();
  if (ACTIVE_STATUSES.has(status)) return { entitled: true, plan: normalizedPlan, reason: status };
  if (status === 'past_due') return { entitled: true, plan: normalizedPlan, reason: 'grace_period' };
  return { entitled: false, plan: 'free', reason: status || 'inactive' };
}
