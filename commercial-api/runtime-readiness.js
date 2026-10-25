const stripePriceEnv = [
  'STRIPE_PRICE_SOLO','STRIPE_PRICE_SOLO_YEARLY',
  'STRIPE_PRICE_PRO','STRIPE_PRICE_PRO_YEARLY',
  'STRIPE_PRICE_AGENCY','STRIPE_PRICE_AGENCY_YEARLY',
  'STRIPE_PRICE_SCALE','STRIPE_PRICE_SCALE_YEARLY'
];
const configuredPrices = stripePriceEnv.filter(key => Boolean(String(process.env[key] || '').trim()));
const readiness = {
  event: 'commercial_runtime_readiness',
  dev_auth_enabled: process.env.WPGO_DEV_AUTH === '1',
  transactional_email_configured: Boolean(String(process.env.RESEND_API_KEY || '').trim() && String(process.env.WPGO_LOGIN_FROM_EMAIL || '').trim()),
  stripe_secret_configured: Boolean(String(process.env.STRIPE_SECRET_KEY || '').trim()),
  stripe_webhook_configured: Boolean(String(process.env.STRIPE_WEBHOOK_SECRET || '').trim()),
  stripe_prices_configured: configuredPrices.length,
  stripe_prices_required: stripePriceEnv.length,
  stripe_checkout_ready: Boolean(String(process.env.STRIPE_SECRET_KEY || '').trim()) && configuredPrices.length === stripePriceEnv.length,
  session_secret_configured: String(process.env.WPGO_SESSION_SECRET || '').length >= 32,
  control_plane_admin_configured: Boolean(String(process.env.WPGO_CONTROL_ADMIN_TOKEN || '').trim()),
  database_configured: Boolean(String(process.env.DATABASE_URL || '').trim())
};
console.log(JSON.stringify(readiness));
export default readiness;
