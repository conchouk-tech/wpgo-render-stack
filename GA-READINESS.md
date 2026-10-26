# WPGo General Availability Readiness

This document is the release decision gate for WPGo 4.5 commercial general availability. A green automated build is necessary but not sufficient: WPGo must also prove production infrastructure, real-client onboarding, billing, support and update delivery.

## Release decision

Current target: **private commercial beta after RC2 acceptance; GA after production infrastructure and external acceptance gates pass.**

Do not merge or deploy a release candidate as GA while any **GA BLOCKER** below remains open.

## A. Core product — engineering controlled

- [x] Provider-neutral remote MCP architecture.
- [x] OAuth Authorization Code + mandatory PKCE S256.
- [x] Client ID Metadata Document support.
- [x] Dynamic Client Registration compatibility fallback.
- [x] Site-specific signed MCP resources.
- [x] Site/resource binding for OAuth access and refresh tokens.
- [x] WordPress subdirectory installation support.
- [x] Encrypted flow/code/access/refresh payloads.
- [x] WordPress Application Password authorization flow.
- [x] Approval-gated non-read-only WordPress abilities.
- [x] Approval status exposed as a safe read-only MCP tool.
- [x] Refresh-token rotation and public-client-compatible refresh.
- [x] Connection state based on successful OAuth token exchange, not WordPress approval alone.
- [x] Connection history / last-seen / last-refresh telemetry.
- [x] WordPress-first Connect AI experience.
- [x] Account-portal Connect AI route.
- [x] Human-readable error codes and request IDs.
- [x] Admin/recovery-email warning for likely placeholder addresses.
- [x] Dependency lockfiles and high/critical security audit.
- [x] Renderer public-network SSRF controls.
- [x] Rendered site-audit and optional screenshot API.

## B. Commercial platform — engineering controlled

- [x] Account/session system.
- [x] Registered site ownership and pairing confirmation.
- [x] Plan/quota model.
- [x] Founder-account protection.
- [x] Site-bound signed licences.
- [x] Licence validation and revocation model.
- [x] Signed update manifest.
- [x] Automated Ed25519 update-manifest verification.
- [x] Stripe webhook signature verification.
- [x] Stripe event idempotency ledger.
- [x] Deterministic billing lifecycle reducer and tests.
- [x] Payment-failure/grace-state representation.
- [x] Customer support-ticket API/UI foundation.
- [x] CSRF-protected account portal.

## C. Automated release gates — engineering controlled

- [x] MCP syntax/security/unit tests.
- [x] Full isolated HTTPS WordPress OAuth/MCP E2E.
- [x] Refresh without optional `client_id`/`resource` regression test.
- [x] CIMD client discovery regression.
- [x] Site-token tamper rejection.
- [x] Connection telemetry/history assertions.
- [x] PHP 8.0 lint.
- [x] Installable WordPress RC artifact + SHA-256.
- [x] PostgreSQL/commercial API smoke test.
- [x] Billing lifecycle tests without live charges.
- [x] Signed licence smoke test.
- [x] Signed update-manifest verification test.
- [x] Portal production-mode smoke test.
- [x] Renderer release check.
- [x] Dependency audit for gateway/API/portal/control-plane/renderer.
- [x] WordPress static secret/debug-pattern gate.
- [x] CI guard that rejects free/ephemeral production connection infrastructure.

## D. Production infrastructure — GA BLOCKER / requires cost approval

- [ ] **GA BLOCKER:** deploy MCP gateway on always-on compute.
- [ ] **GA BLOCKER:** configure one persistent managed `WPGO_MCP_SECRET`; never generate it at process start.
- [ ] **GA BLOCKER:** deploy persistent shared Key Value/Redis for OAuth codes, connection state and secret-continuity protection.
- [ ] **GA BLOCKER:** deploy persistent production PostgreSQL for commercial accounts/billing/site registrations.
- [ ] **GA BLOCKER:** move customer-facing portal/API/control-plane onto production-suitable always-on services or explicitly document acceptable cold-start behavior for any non-critical component.
- [ ] Configure production backup/restore policy and perform one restore test.
- [ ] Configure service health alerts and failure notifications.
- [ ] Configure production custom domains/TLS and sender email.
- [ ] Store production secrets only in managed environment/secret storage.
- [ ] Record infrastructure ownership, renewal and emergency-access procedure.

No paid infrastructure is to be activated without explicit user approval.

## E. Real-client acceptance — GA BLOCKER

- [ ] **GA BLOCKER:** clean WordPress installation from a customer perspective.
- [ ] **GA BLOCKER:** WordPress-first connection to Claude with no developer/manual OAuth intervention.
- [ ] **GA BLOCKER:** connection to a second independent standards-compatible MCP client.
- [ ] Verify logged-in WordPress admin goes directly to application approval.
- [ ] Verify logged-out user can log in and return to the intended approval flow.
- [ ] Verify cancel/reject returns a clear recoverable state.
- [ ] Verify expired authorization flow can be restarted cleanly.
- [ ] Verify OAuth access token expiry refreshes invisibly to the user.
- [ ] Verify service restart does not invalidate existing site links or refresh tokens on production-like infrastructure.
- [ ] Verify original/legacy `/mcp` compatibility for existing customers.
- [ ] Verify a read operation, an approval-gated write, approval-status check and successful retry.
- [ ] Verify disconnect/revoke procedure from both WordPress and customer-account perspectives.

## F. Billing acceptance — GA BLOCKER

- [x] Deterministic lifecycle reducer unit tested.
- [x] Duplicate webhook delivery handled idempotently in code.
- [ ] **GA BLOCKER:** Stripe test-mode checkout creates the correct plan/account entitlement.
- [ ] Upgrade test.
- [ ] Downgrade test.
- [ ] Monthly/yearly price mapping test.
- [ ] Payment failure / action-required test.
- [ ] Payment recovery test.
- [ ] Cancellation-at-period-end test.
- [ ] Immediate cancellation test if supported.
- [ ] Renewal webhook test.
- [ ] Duplicate/reordered Stripe event test against Stripe test mode.
- [ ] Customer portal/billing-management route acceptance.
- [ ] Verify Founder account cannot be downgraded or overwritten by Stripe lifecycle events.

Stripe test mode does not require a real charge, but production Stripe credentials/prices and final live-mode smoke testing are deferred until launch approval.

## G. Plugin packaging and updates — GA BLOCKER

- [x] RC companion package built and checksummed automatically.
- [x] Signed update-manifest chain automatically verified.
- [ ] **GA BLOCKER:** obtain/bring the complete main WPGo WordPress plugin source into the release repository/workstream.
- [ ] **GA BLOCKER:** fold Connect AI into the single main WPGo plugin; customers must not install two WPGo plugins for GA.
- [ ] Produce final GA ZIP from CI only.
- [ ] Host final package at controlled HTTPS download location.
- [ ] Verify published SHA-256 against downloaded bytes.
- [ ] Verify WordPress update check → download → integrity validation → update → activation.
- [ ] Verify rollback/previous-version procedure.
- [ ] Verify upgrade from the latest supported pre-4.5 WPGo plugin.

## H. Privacy, legal and support — GA BLOCKER

- [x] Security model documented.
- [x] Incident-response draft documented.
- [x] Support policy draft documented.
- [x] Privacy-policy draft prepared.
- [x] Terms draft prepared.
- [x] Data-processing/GDPR draft prepared.
- [ ] **GA BLOCKER:** professional legal review and company/controller details inserted into customer-facing privacy/terms/DPA.
- [ ] Publish customer-facing privacy policy and terms at stable URLs.
- [ ] Publish subprocessors list.
- [ ] Publish security-contact route.
- [ ] Confirm data-retention periods match actual production configuration.
- [ ] Confirm DSAR/deletion/export operational procedure.
- [ ] Confirm breach-notification contact chain.

## I. Reliability and launch operations

- [ ] Minimum 72-hour production-like soak with at least one connected AI client and no forced reconnect.
- [ ] Restart/redeploy test during active but idle connection.
- [ ] Database restart/recovery test.
- [ ] Key Value restart/recovery test.
- [ ] Controlled MCP secret-continuity failure test.
- [ ] Load test representative read/write/approval mix.
- [ ] Rate-limit behavior verified from the customer perspective.
- [ ] Support runbook exercised with a simulated connection failure.
- [ ] Incident runbook tabletop exercise.
- [ ] Metrics/log retention and privacy review.

## J. Competitive feature follow-up — not required to block 4.5 GA

These are valuable post-GA parity/advantage items rather than launch blockers:

- deeper Elementor/Bricks/Breakdance/Beaver Builder/Divi workflows;
- theme change draft → rendered preview → publish workflow;
- PHP syntax validation integrated into theme/file-write approvals;
- Lighthouse/performance scoring on top of the RC2 renderer;
- stock-image provider integration;
- richer WooCommerce bulk-operation playbooks;
- fleet/batch jobs with progress UI and retry controls;
- customer-visible immutable approval/audit history;
- packaged task/skill library for repeatable WordPress work;
- background/long-running job orchestration.

## Release states

**RC:** automated gates pass; not for paying public customers.

**Private beta:** production-like persistent infrastructure is live; selected testers can connect; Stripe may remain test-mode or beta-entitlement based.

**Commercial beta:** billing and support are live for a limited customer cohort; rollback/support coverage is active.

**GA:** all GA BLOCKER items above are complete, the 72-hour soak passes, the single-plugin package/update path is verified, and legal/customer documents are published.
