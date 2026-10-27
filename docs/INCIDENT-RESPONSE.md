# WPGo Incident Response Runbook

This runbook is the operational draft for security, availability, billing and data incidents. Before GA, named company contacts, notification channels and legal escalation contacts must be inserted.

## Severity levels

**SEV-1 — Critical:** confirmed credential/signing-key compromise, cross-customer data access, destructive cross-site action, widespread inability to authenticate/connect, billing corruption affecting many customers, or loss of production database integrity.

**SEV-2 — High:** major service degradation, repeated OAuth refresh failure, approval bypass suspicion, single-customer data exposure, persistent billing/webhook failure, update-signing or package-integrity failure.

**SEV-3 — Moderate:** isolated customer connection failures, renderer degradation, delayed billing event, incorrect status/telemetry with no authorization impact, support-impacting bug with workaround.

**SEV-4 — Low:** cosmetic defects, documentation problems, non-sensitive observability gaps.

## First 15 minutes

1. Create an incident record with UTC start time, reporter, affected component and observed symptoms.
2. Preserve request IDs, relevant log ranges and deploy/event identifiers. Do not paste credentials/tokens into the incident record.
3. Determine whether the issue is security, availability, billing, data integrity or release/update related.
4. Stop risky automated deployments if a recent release may be involved.
5. For suspected credential compromise, revoke/rotate the affected credential following the component procedure rather than performing broad unplanned rotations.
6. For suspected cross-site authorization failure or approval bypass, disable the affected write path or gateway release before continuing normal operation.
7. Assign an incident lead and one communication owner.

## Containment playbooks

### MCP/OAuth connection incident

Check in order:

- gateway health;
- current deploy/restart events;
- `WPGO_MCP_SECRET` continuity;
- shared state availability;
- OAuth token rejection event/reason;
- connection history for the affected site;
- client resource URL/site binding;
- WordPress REST/API availability;
- WordPress Application Password validity;
- client refresh behavior.

Do not tell users to repeatedly reconnect until the cause is known; unnecessary reconnects can destroy useful evidence and create extra credentials.

### Signing/update incident

- stop publishing the release manifest/package;
- preserve the suspect package and expected SHA-256;
- verify manifest signature and package digest independently;
- if signing-key compromise is suspected, stop update delivery and follow planned key-rotation/reissue procedure;
- do not overwrite the old artifact until evidence is preserved.

### Billing incident

- keep Stripe event IDs and timestamps;
- verify webhook signatures;
- inspect the idempotency ledger before replaying events;
- avoid manual plan edits until event ordering/current Stripe subscription state is known;
- Founder accounts must never be modified by Stripe lifecycle handlers;
- test a correction in staging/test mode before applying bulk changes.

### Database incident

- stop write-heavy operations if integrity is uncertain;
- capture provider state/metrics;
- use backup/restore procedure rather than ad-hoc table recreation;
- verify account, site registration, subscription and webhook-ledger integrity after recovery.

### Renderer/network incident

- disable renderer endpoint if SSRF/public-network guarantees are in doubt;
- capture requested host/resource type without storing sensitive rendered content unnecessarily;
- verify DNS/IP classification and redirect/subresource validation.

## Eradication and recovery

Recovery is complete only when:

- root cause is understood or the risky path is disabled;
- affected secrets/tokens are revoked or rotated where necessary;
- fixed code/config passes its automated regression test;
- production health is stable;
- affected customer workflow is retested end-to-end;
- monitoring shows no continuing failure pattern;
- data/billing corrections have been reconciled.

## Customer communication

Communications should state:

- what customers are experiencing;
- whether action is required;
- what WPGo has disabled/fixed;
- when the last update was issued;
- where to report an affected site/request ID.

Do not speculate about cause or exposure before evidence supports it. Do not publish secrets, internal tokens or customer data.

For a personal-data breach, follow applicable GDPR/other legal notification obligations and the reviewed customer privacy/DPA terms. Legal deadlines and regulator/customer notification decisions must be handled by qualified counsel/controller staff.

## Post-incident review

Within the internal review record capture:

- timeline;
- customer impact;
- root cause;
- why existing tests/monitoring did or did not catch it;
- remediation;
- permanent regression test;
- documentation/runbook changes;
- follow-up owner and due state.

A SEV-1/SEV-2 incident is not closed until a regression control exists or a documented risk decision explains why one cannot be added.

## Connection reliability regression rule

The overnight Claude disconnect discovered during RC testing is the model for how connection incidents should be handled: distinguish infrastructure sleep/restart, secret continuity and OAuth refresh behavior rather than treating “reconnect” as the solution. Every similar failure should produce a precise telemetry reason and, where practical, an automated regression test.
