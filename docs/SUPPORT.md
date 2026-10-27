# WPGo Support Policy — Draft

This is the operational support-policy draft for commercial launch. Public commitments, business identity and service-level promises must be reviewed before publication.

## Support principles

WPGo support should solve customer problems without asking customers to expose credentials. Support should prefer request IDs, site URLs, timestamps, WPGo versions and connection telemetry over screenshots containing secrets or copied OAuth/Application Password values.

## Information to request

For connection issues ask for:

- WordPress site URL;
- WPGo/plugin version;
- AI client name;
- approximate failure time/timezone;
- WPGo request ID if shown;
- the status shown in WPGo → Connect AI;
- whether the issue followed a deploy/restart, password/user change or WordPress security-plugin change.

Never request the customer's normal WordPress password, Application Password, OAuth access token, refresh token, Stripe secret or private signing material.

## Support categories

**Connection:** OAuth, MCP discovery, Application Password approval, refresh/reconnect, client compatibility.

**WordPress action:** abilities/tools, permissions, approval required, failed reads/writes, WooCommerce operations.

**Account/billing:** login, registered sites, quotas, subscription state, invoices/payment lifecycle.

**Updates:** licence, manifest, download, integrity verification, plugin upgrade/rollback.

**Security/privacy:** suspected unauthorized action, data request, vulnerability report.

**Platform:** outage, performance, renderer/site-audit failure.

## Triage priority

- **P1:** security issue, destructive incorrect action, widespread outage, billing corruption affecting multiple customers.
- **P2:** customer cannot use connected site and no reasonable workaround; repeated forced reconnect; paid entitlement unavailable.
- **P3:** individual tool/action failure, degraded renderer/audit, account issue with workaround.
- **P4:** feature request, documentation, cosmetic issue.

Public response-time commitments should not be published until staffing/on-call coverage is known.

## Connection support flow

1. Check whether the gateway reports the site as connected.
2. Inspect client name, connected time, last refresh and last seen.
3. Inspect recent connection events.
4. Correlate request ID/timestamp with gateway logs.
5. Check production service/restart events.
6. Check shared state and secret-continuity status.
7. Check WordPress REST readiness and Application Password support.
8. Only then decide whether reauthorization is required.

A reconnect should not be the default first response.

## Billing support flow

1. Locate account/subscription by internal account ID or customer email through authorized tools.
2. Compare WPGo subscription status with the authoritative Stripe subscription state.
3. Inspect Stripe event ID/idempotency ledger.
4. Determine whether an event is delayed, duplicated, out of order or processing-failed.
5. Correct through normal billing lifecycle where possible; avoid direct database edits.
6. Preserve Founder-account protection.

## Update support flow

Verify:

- active site-bound licence;
- update manifest signature;
- expected package version;
- package SHA-256;
- HTTPS download accessibility;
- WordPress/PHP compatibility;
- rollback package availability.

Do not instruct a customer to install a package whose digest/signature cannot be verified.

## Sensitive support tickets

Security/privacy tickets should be restricted to authorized staff. Logs/screenshots must be redacted before being attached to general support systems.

## Self-service content required before GA

Publish customer-facing guides for:

- install WPGo;
- Connect AI from WordPress;
- connect Claude;
- connect ChatGPT/other MCP client;
- approve a write action;
- understand connection status;
- disconnect/revoke access;
- troubleshoot WordPress login/Application Password issues;
- manage plan/quota/billing;
- update WPGo;
- contact security/privacy support.

## Supported environment policy — draft

Initial GA should support current maintained WordPress/PHP versions that pass the release test matrix. The final minimum versions must match the WordPress plugin headers and release manifest.

WPGo should not promise compatibility with abandoned WordPress/PHP versions, modified WordPress REST implementations, or security plugins/hosts that block required Application Password/REST behavior. Where such a restriction exists, diagnostics should explain the missing capability rather than fail silently.
