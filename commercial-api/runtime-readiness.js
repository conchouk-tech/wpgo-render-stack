const readiness = {
  event: 'commercial_runtime_readiness',
  dev_auth_enabled: process.env.WPGO_DEV_AUTH === '1',
  transactional_email_configured: Boolean(String(process.env.RESEND_API_KEY || '').trim() && String(process.env.WPGO_LOGIN_FROM_EMAIL || '').trim()),
  stripe_secret_configured: Boolean(String(process.env.STRIPE_SECRET_KEY || '').trim()),
  stripe_webhook_configured: Boolean(String(process.env.STRIPE_WEBHOOK_SECRET || '').trim()),
  session_secret_configured: String(process.env.WPGO_SESSION_SECRET || '').length >= 32,
  database_configured: Boolean(String(process.env.DATABASE_URL || '').trim())
};
console.log(JSON.stringify(readiness));
export default readiness;
