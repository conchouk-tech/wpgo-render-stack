# WPGo 4.5 Commercial Release Checklist

This document is the release gate for WPGo 4.5. A green build is necessary but not sufficient. **Do not merge/deploy a GA release while any BLOCKER below is unresolved.**

## Target architecture

The normal end-user connection is:

1. Customer installs WPGo on WordPress.
2. WordPress administrator explicitly installs/repairs the pinned Agent Connector dependency when WPGo asks.
3. WPGo exposes curated `wpgo/*` abilities at the site's HTTPS MCP endpoint.
4. The customer adds that MCP URL to ChatGPT, Claude or another OAuth-capable remote MCP client.
5. The browser OAuth flow authorises the AI client directly against the WordPress site.
6. Readonly abilities may run when authorised; writable/destructive abilities still require a WPGo approval ID.

The hosted `mcp-gateway` is compatibility/preview infrastructure, not the normal GA connection path.

---

## 1. Source and packaging

- [ ] **BLOCKER:** Integrate `wpgo-plugin-patches/4.5.0/class-wpgo-ai-connector.php` into the complete current WPGo plugin source.
- [ ] **BLOCKER:** Build a complete WPGo 4.5.0 WordPress ZIP from the real plugin source, not from the patch directory alone.
- [ ] Verify the plugin header reports 4.5.0 and upgrade routines preserve existing settings.
- [ ] PHP lint the complete plugin source.
- [ ] Install the ZIP on a clean WordPress instance and upgrade an existing WPGo install to the same ZIP.
- [ ] Confirm uninstall/deactivation does not remove customer content or secrets unexpectedly.
- [ ] Calculate the final plugin ZIP SHA-256 and configure `WPGO_RELEASE_SHA256` plus the release package URL in the control plane.
- [ ] Confirm the signed update manifest contains the exact package version and SHA-256.

## 2. Direct MCP / OAuth client matrix

Test a clean WordPress install with each supported client independently. No client may rely on credentials/settings left behind by another test.

- [ ] **BLOCKER:** ChatGPT remote MCP connection succeeds through OAuth.
- [ ] **BLOCKER:** Claude remote MCP connection succeeds through OAuth.
- [ ] **BLOCKER:** One generic standards-compatible remote MCP client succeeds through OAuth.
- [ ] Connection uses the same WordPress MCP URL for every client.
- [ ] No OpenAI API key is required by WPGo.
- [ ] No Claude/Anthropic API key is required by WPGo.
- [ ] WPGo does not store AI-provider credentials.
- [ ] OAuth cancellation returns a clean user-facing error and leaves no half-created connection.
- [ ] Revoking the WordPress authorization invalidates subsequent AI actions as expected.
- [ ] Reconnecting after revocation works without reinstalling WPGo.

## 3. Ability exposure and approvals

- [ ] **BLOCKER:** MCP lists only intended public WPGo abilities.
- [ ] `agent-connector-for-wp/*` abilities are not exposed through WPGo.
- [ ] `wpgo/controller-*` / fleet-control abilities are not unintentionally exposed to end-user AI clients.
- [ ] A readonly WPGo ability executes without a write approval prompt.
- [ ] **BLOCKER:** A writable WPGo ability returns a WPGo approval request on its first call.
- [ ] The approved action succeeds when retried with the returned `approval_id`.
- [ ] Reusing/altering an approval cannot authorize a different payload.
- [ ] Destructive actions remain clearly identified and approval-protected.
- [ ] Writable non-object abilities are hidden until their contract can carry approval safely.

## 4. Agent Connector dependency

Pinned release for WPGo 4.5 candidate:

- Version: `1.33.1`
- SHA-256: `ba7313feac5fed09cfec8d97b12bb2c1f6468fe5dd87c811e418b61310318e6b`

Checks:

- [ ] Dependency is never installed or upgraded silently.
- [ ] Administrator action + nonce is required to install/repair it.
- [ ] Download hash mismatch aborts installation.
- [ ] Existing newer compatible version is not downgraded.
- [ ] HTTPS is required for production remote AI connection.

## 5. Accounts and authentication

- [ ] **BLOCKER:** Production email delivery is configured and a real six-digit sign-in code arrives.
- [ ] Development code logging is disabled in production.
- [ ] Login code expires after 10 minutes.
- [ ] Five incorrect attempts invalidate the active code.
- [ ] Per-IP and per-email throttling returns 429 without growing memory indefinitely.
- [ ] Session secret is at least 32 characters and unique to production.
- [ ] Session cookie is Secure, HttpOnly and SameSite=Lax.
- [ ] Logout invalidates the browser cookie.

## 6. Site registration and licences

- [ ] **BLOCKER:** Every customer licence is site-bound; an empty host list cannot create a usable commercial licence.
- [ ] Manual licence issuance accepts only sites registered to the signed-in account.
- [ ] Licence refresh succeeds only for a site still registered to that account.
- [ ] Licence for Site A is rejected when presented as Site B.
- [ ] `www.example.com` and `example.com` migrate/normalize without creating duplicate site records.
- [ ] Revoked/suspended/expired licences fail closed.
- [ ] A control-plane outage does not remotely disable the installed local WPGo runtime.

## 7. Usage metering

- [ ] **BLOCKER:** Concurrent requests cannot exceed the account allowance via a check-then-insert race.
- [ ] Replaying the same `idempotency_key` does not double charge usage.
- [ ] Invalid/huge units are clamped to the supported range.
- [ ] Failed actions do not consume successful-action quota.
- [ ] Rolling 24-hour totals match the database.
- [ ] Founder/unlimited account logic cannot be enabled by customer input.

## 8. Billing

- [ ] **BLOCKER:** Stripe production/test-mode configuration is complete for the intended environment.
- [ ] All monthly and yearly price IDs map to the correct WPGo plans.
- [ ] Checkout success updates the account plan.
- [ ] Cancelled checkout leaves the previous plan unchanged.
- [ ] Billing portal opens only for the authenticated account's Stripe customer.
- [ ] Stripe webhook signature verification rejects invalid signatures.
- [ ] Replaying the same Stripe event is idempotent.
- [ ] Subscription deletion returns non-founder accounts to Free.
- [ ] Payment failure moves subscription status to `past_due` without corrupting licence ownership.

## 9. Renderer isolation

- [ ] **BLOCKER:** A site-bound licence can render its own registered public HTTPS site.
- [ ] The same licence cannot render another customer's site.
- [ ] Private/loopback/link-local/reserved targets are rejected.
- [ ] Plain HTTP is rejected in production.
- [ ] Main-frame cross-origin redirects are blocked.
- [ ] Subresource URLs are checked for public-network eligibility.
- [ ] Legacy renderer token remains limited to explicitly configured internal hosts unless an operator deliberately enables its public compatibility mode.
- [ ] Renderer concurrency and 429 behavior are load-tested at the production plan size.

## 10. Optional hosted MCP gateway

The gateway is **not a GA requirement** for direct site OAuth/MCP.

If offered as preview/compatibility:

- [ ] `WPGO_MCP_PUBLIC_BASE` is a fixed canonical HTTPS origin.
- [ ] `WPGO_MCP_SECRET` is at least 32 characters and rotation is tested with `WPGO_MCP_SECRET_PREVIOUS`.
- [ ] Authorization codes survive restart/multi-instance routing and remain single-use.
- [ ] PKCE S256 is mandatory.
- [ ] Private/reserved outbound targets are rejected and DNS is pinned for gateway-controlled HTTP requests.
- [ ] Gateway exposes only curated `wpgo/*` abilities.
- [ ] Customer documentation clearly states that this compatibility mode uses a WordPress Application Password bridge.
- [ ] **BLOCKER before calling the gateway GA:** replace central Application Password custody with a delegated model that does not require WPGo's central gateway to hold the site's WordPress application credential.

## 11. Render production configuration

- [ ] **BLOCKER:** `NODE_ENV=production` on GA services.
- [ ] Shared `WPGO_CONTROL_ADMIN_TOKEN` is strong and identical where required.
- [ ] Control-plane signing seed/private key is present and backed up securely.
- [ ] `WPGO_SESSION_SECRET` is present and unique.
- [ ] `WPGO_DEV_AUTH=0`.
- [ ] `WPGO_REQUIRE_EMAIL=1` and real email settings are present.
- [ ] `WPGO_REQUIRE_BILLING=1` and Stripe settings are present.
- [ ] Renderer has no customer/test hostname hard-coded in its GA configuration.
- [ ] Renderer no-token and HTTP escape hatches are disabled.
- [ ] Release package URL/version/SHA are configured only after the final ZIP exists.

### Existing Blueprint warning

Render values marked `sync: false` are operator-supplied secrets. For existing services, verify/set these values manually in Render before the first 4.5 deployment. Do not assume changing the Blueprint will populate them retroactively.

## 12. Security / abuse tests

- [ ] Oversized JSON bodies are rejected.
- [ ] Invalid JSON returns 400, not a stack trace.
- [ ] API errors expose request IDs but no secrets in production.
- [ ] Support forms reject trivial spam payloads and throttle repeat submissions.
- [ ] External fetches have bounded timeouts.
- [ ] Secrets/tokens are never logged in normal production logs.
- [ ] Security headers are present on portal/API/renderer responses.
- [ ] Dependency/plugin download integrity is verified before installation.

## 13. Upgrade and rollback

- [ ] Snapshot production database before rollout.
- [ ] Export current Render environment configuration before rollout.
- [ ] Record current `main` commit and deployed service deploy IDs.
- [ ] Deploy control plane first, then commercial API/portal, then renderer, then the WordPress plugin release.
- [ ] Smoke-test health and one real end-to-end connection after every stage.
- [ ] Rollback instructions are tested: previous image/commit, previous plugin ZIP and database recovery if a migration must be reversed.
- [ ] Site-host normalization migration is reviewed against a production database snapshot before rollout.

## 14. Final go/no-go

A GA release is **GO** only when:

- [ ] all BLOCKER items above are checked;
- [ ] `bash scripts/release-check.sh` passes;
- [ ] CI is green on the release PR;
- [ ] the complete WordPress plugin ZIP has been tested on clean install + upgrade;
- [ ] ChatGPT + Claude + generic MCP client tests pass;
- [ ] email + Stripe + licence + renderer production smoke tests pass;
- [ ] final plugin package SHA-256 matches the signed update manifest;
- [ ] rollback material is available.

Until then, label the branch **release candidate / hardening**, not GA.
