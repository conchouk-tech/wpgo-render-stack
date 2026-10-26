# WPGo 4.5.0-rc.2

WPGo 4.5.0-rc.2 is the commercial-readiness release candidate. It builds on RC1's provider-neutral MCP/OAuth architecture and focuses on connection reliability, observability, account-side onboarding, billing lifecycle safety, signed update verification and rendered site auditing.

RC2 is intentionally pre-GA. It does not activate paid infrastructure and must not be treated as the production commercial release until the remaining infrastructure and real-world acceptance gates in `GA-READINESS.md` are complete.

## Headline changes

### Connection reliability and observability

- OAuth refresh accepts public-client refresh requests that omit `client_id` and/or `resource` when those bindings are already carried securely by the refresh token.
- Refresh credentials rotate and are renewed for a long-lived connection window.
- AI connection state is recorded only after the OAuth token exchange succeeds.
- MCP activity records `last_seen_at`; refreshes record `last_refresh_at`.
- Connection state includes the client name, connection time and refresh expiry.
- Recent connection events are retained as a bounded history so support can distinguish connection, refresh and status changes.
- The WordPress Connect AI page shows actual gateway state instead of assuming that WordPress Application Password approval means the AI client completed OAuth.
- The account portal shows the same gateway-backed connection state for each registered site.

### Account-side Connect AI

- Registered sites in the WPGo account portal now receive a **Connect AI** action.
- Portal requests the site's signed MCP link from the gateway and redirects to the guided connection page.
- Site ownership is checked before the portal exposes a connection path.
- Portal production configuration now requires an HTTPS MCP gateway.
- Portal health advertises Connect AI and connection telemetry support.

### WordPress-side Connect AI

- Connect AI now attempts to live under the existing WPGo admin menu when the core plugin is present, with Tools as a fallback.
- The page distinguishes WordPress readiness from an actually completed AI connection.
- It displays last AI activity, last OAuth refresh, refresh credential expiry and recent connection events.
- Existing admin-email/recovery-email checks and site-specific MCP onboarding remain in place.

### Billing lifecycle hardening

- Added a deterministic Stripe event reducer with unit tests.
- Covers checkout completion, subscription create/update/resume/delete, invoice success/failure/action-required and paused subscriptions.
- Added a Stripe webhook event ledger so repeated webhook delivery is idempotent.
- A failed webhook processing attempt releases its unprocessed claim so Stripe can retry safely.
- Founder accounts remain protected from paid-plan webhook mutations.
- Payment failure changes subscription status without prematurely deleting the selected paid plan; cancellation returns non-founder accounts to free.
- Billing lifecycle behavior is testable without creating a live Stripe charge.

### Signed commercial updates

- The RC gate now issues a signed site-bound licence, validates it, fetches a signed update manifest, retrieves the public Ed25519 key and cryptographically verifies the manifest signature.
- The manifest gate checks release version, package name and SHA-256.
- No paid download hosting is required to test the signing and validation chain.

### Multi-client OAuth regression coverage

- The integration mock exposes a Client ID Metadata Document (CIMD).
- E2E tests cover CIMD client discovery in addition to Dynamic Client Registration.
- The test verifies site-specific onboarding skips manual site selection and reaches WordPress authorization.
- The test then verifies token exchange, MCP tools, refresh without optional public-client fields, connection telemetry/history and tamper rejection.

### Renderer / site audit

- Renderer version `4.4.0-rc.2` adds a protected `/v1/site-audit` endpoint.
- The audit uses the existing public-network/SSRF policy and browser isolation.
- It can return rendered-page title, meta description, canonical URL, H1/H2/H3 outline, H1 count, image count, missing-alt count, link count, form count, document language, body text length, browser console errors, final HTTP status, timing and an optional PNG screenshot.
- This establishes a no-cost foundation for visual QA, SEO checks and future Lighthouse-style workflows.

## RC2 component versions

| Component | Version |
| --- | --- |
| WPGo product | `4.5.0-rc.2` |
| MCP gateway | `1.4.1-rc.2` |
| WordPress Connect AI companion | `4.5.0-rc.2` |
| Commercial API | `1.5.0-rc.2` |
| Commercial portal | `1.7.0-rc.2` |
| Renderer | `4.4.0-rc.2` |
| Control plane | `4.3.0` |

## Automated release gates

RC2 must pass:

- provider-neutral MCP/OAuth syntax and unit checks;
- site-token tamper and site-binding tests;
- full WordPress-first OAuth/MCP E2E;
- refresh-token compatibility regression without optional `client_id`/`resource`;
- CIMD client-metadata discovery;
- connection-state/history assertions;
- PHP 8.0 lint for the WordPress module;
- RC2 ZIP + SHA-256 artifact creation;
- Stripe billing lifecycle unit tests;
- PostgreSQL/commercial API startup;
- signed licence validation;
- signed update-manifest verification;
- portal production startup with Connect AI/telemetry capability checks;
- renderer syntax/release checks;
- high/critical dependency audits across all Node services;
- static WordPress secret/debug-pattern checks;
- production blueprint guard rejecting free/ephemeral connection-critical infrastructure.

## Deliberately not activated yet

RC2 does not change the user's current Render services to paid plans and does not create paid resources. The repository's production blueprint describes the minimum always-on/persistent target architecture, but deployment of that architecture requires explicit approval because it incurs cost.

The current free RC service also must not be used as evidence of overnight connection reliability: free compute may sleep and the existing staging launch configuration is intentionally disposable.

## Remaining GA gates

The remaining blockers are intentionally narrow:

- deploy the production-like always-on/persistent infrastructure after cost approval;
- use one persistent managed MCP secret across restarts;
- use persistent shared OAuth/connection state and persistent Postgres;
- perform a clean install from a new WordPress site/customer perspective;
- complete real-browser WordPress-first connection tests with Claude and at least one second independent MCP client;
- test cancel, reject, expired, logged-out/login-return and reconnect flows;
- exercise Stripe test-mode checkout/webhook flows against Stripe itself, including upgrade, downgrade, payment failure, cancellation and renewal;
- host a real RC update ZIP and verify its production download/hash/update flow;
- merge the Connect AI companion into the main WPGo plugin source once that source is available in this repository/workstream;
- complete legal review of the draft customer terms/privacy/DPA documents.

See `GA-READINESS.md` for the release decision checklist.