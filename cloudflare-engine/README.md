# WP Virtuoso Cloudflare Engine

This directory replaces the retired Render account/commercial stack with one Cloudflare Worker backed by D1.

## What it owns

- Passwordless account creation/sign-in
- Authoritative plan and rolling-24-hour successful-action usage
- Connected WordPress sites
- Site-bound WP Virtuoso licence issue/validate/refresh
- Usage check/consume endpoints used by the software
- Stripe Checkout for paid subscriptions
- Stripe Customer Portal
- Stripe webhook-driven entitlement updates
- Billing summary/invoice history
- Support tickets and audit events

The WordPress marketing site remains the public UI. `/account/` embeds `site/account-dashboard.html` and calls this Worker.

## Cloudflare resources

Cloudflare Workers supports Node compatibility by default for compatibility dates on or after 2026-08-04, and D1 is bound directly to Workers. This project uses a 2026-10-30 compatibility date.

Create an EU-jurisdiction D1 database:

```bash
cd cloudflare-engine
npm install
npx wrangler d1 create wp-virtuoso-production --jurisdiction eu
```

Copy the returned database ID into `wrangler.jsonc`, then apply migrations:

```bash
npm run db:migrate:remote
```

## Required secrets

Set these with `npx wrangler secret put NAME`:

- `SESSION_SECRET` — at least 32 random bytes
- `LICENSE_SIGNING_SECRET` — at least 32 random bytes, different from SESSION_SECRET
- `ADMIN_TOKEN` — random bearer token for guarded admin licence issuance
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `LOGIN_FROM_EMAIL` — e.g. `WP Virtuoso <login@wp-virtuoso.com>`
- `FOUNDER_EMAILS` — comma-separated private founder/admin email list; never display this publicly

For local-only authentication testing you may set `DEV_AUTH=1`; production must use `DEV_AUTH=0`.

## Stripe price secrets

The Worker expects these secrets/vars:

- `STRIPE_PRICE_SOLO`
- `STRIPE_PRICE_SOLO_YEARLY`
- `STRIPE_PRICE_PRO`
- `STRIPE_PRICE_PRO_YEARLY`
- `STRIPE_PRICE_AGENCY`
- `STRIPE_PRICE_AGENCY_YEARLY`
- `STRIPE_PRICE_SCALE`
- `STRIPE_PRICE_SCALE_YEARLY`

Current **sandbox** price IDs already present in the connected Stripe sandbox are:

```text
STRIPE_PRICE_SOLO=price_1UUCnlJGSALvghDB9pvixrRo
STRIPE_PRICE_SOLO_YEARLY=price_1UVwRsJGSALvghDBaFDyijUq
STRIPE_PRICE_PRO=price_1UUCnqJGSALvghDB0JAuWpp4
STRIPE_PRICE_PRO_YEARLY=price_1UVwRzJGSALvghDBYR4bhwUy
STRIPE_PRICE_AGENCY=price_1UUCnwJGSALvghDBKRA9RWRp
STRIPE_PRICE_AGENCY_YEARLY=price_1UVwS3JGSALvghDBrdzjyMmv
STRIPE_PRICE_SCALE=price_1UUCo0JGSALvghDB56vP9syI
STRIPE_PRICE_SCALE_YEARLY=price_1UVwS8JGSALvghDBT5JbfclU
```

Do not reuse test IDs in live mode. Create/connect the live Stripe account and set live product/price IDs before enabling real charging.

## Stripe webhook

Create a Stripe webhook endpoint pointing to:

```text
https://api.wp-virtuoso.com/v1/billing/webhook
```

Subscribe at minimum to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Store the signing secret as `STRIPE_WEBHOOK_SECRET`.

Recommended billing architecture: Stripe-hosted Checkout, flat-rate recurring prices, Free as freemium, Stripe Customer Portal for self-service lifecycle management, and Stripe Smart Retries/automated recovery.

## Public URLs and CORS

Set `PUBLIC_SITE_URL` to the marketing site base URL. During the current transition that can remain:

```text
https://wpgo.vivaforte.es
```

The target production API hostname is:

```text
https://api.wp-virtuoso.com
```

Add the Worker custom domain in Cloudflare only after the Worker and D1 migration are healthy.

`ALLOWED_ORIGINS` should include only the marketing/account site origins that need browser API access.

## Deploy

```bash
npm run deploy
```

Then verify:

```text
GET /health
GET /v1/plans
```

Only after those are healthy should the WordPress account page be switched to `https://api.wp-virtuoso.com` and all old `*.onrender.com` links be removed.

## Account dashboard

`site/account-dashboard.html` is the production account UI template. It supports:

- Sign in / account creation by email code
- Current plan and subscription status
- Rolling 24-hour usage meter
- Connected sites
- Site-bound licence generation
- Paid plan Checkout
- Stripe Customer Portal
- Invoice history
- Logout

The template currently points to `https://api.wp-virtuoso.com` through its `data-api-base` attribute.

## Software compatibility

The Worker deliberately preserves the commercial API contract used by WP Virtuoso:

- `/v1/license/validate`
- `/v1/admin/license/issue`
- `/v1/license/refresh`
- `/v1/meter/check`
- `/v1/meter/record`
- `/v1/meter/consume`

Licence tokens are opaque to WordPress clients. The Worker validates them and always returns the **authoritative current account plan**, so a Stripe upgrade/downgrade is reflected without maintaining a second public entitlement database.

## Cutover order

1. Deploy Worker + D1 in Cloudflare.
2. Configure secrets and sandbox Stripe IDs.
3. Configure transactional email and verify OTP sign-in.
4. Configure Stripe sandbox webhook and complete an end-to-end test subscription.
5. Point WP Virtuoso software commercial/licence/meter endpoints at the Worker.
6. Install the account dashboard on WordPress.
7. Replace all Render URLs on all language pages with local account/pricing URLs.
8. Connect a live Stripe account, create live prices, configure live webhook and Stripe Customer Portal.
9. Run a real low-value subscription test, then enable public paid signup.
10. Remove/retire the Render services only after logs show no traffic.
