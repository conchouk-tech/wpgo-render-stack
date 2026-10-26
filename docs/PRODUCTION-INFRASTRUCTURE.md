# WPGo Production Infrastructure Plan

This document defines the production target architecture for WPGo and separates engineering work that can be completed now from infrastructure changes that incur cost.

## Current rule

Do **not** activate paid resources or upgrade existing Render plans without explicit approval from the account owner.

The current free services are suitable for development and short functional tests only. They are not evidence of commercial availability, persistence or overnight connector reliability.

## Production target

The repository's `render.yaml` describes the minimum intended production layout:

| Resource | Purpose | Production requirement |
| --- | --- | --- |
| `wpgo-mcp-ga` | OAuth + remote MCP gateway | Always-on compute, persistent secret, shared state |
| `wpgo-mcp-state` | OAuth codes + connection telemetry | Persistent Key Value/Redis, no eviction of critical state |
| `wpgo-commercial-api` | Accounts, plans, billing, site registration | Always-on compute + persistent PostgreSQL |
| `wpgo-commercial-web` | Customer portal | Reliable customer-facing compute |
| `wpgo-control-plane-ga` | Licence/update signing | Stable signing secret/key + reliable compute |
| `wpgo-renderer-ga` | Rendered HTML/site audit/screenshots | Isolated browser compute |
| `wpgo-commercial-db` | Commercial account/billing database | Persistent PostgreSQL + backup policy |

The blueprint currently targets paid/persistent classes for these resources but has **not** been applied to the user's live Render account as part of RC2.

## Connection-critical requirements

### MCP gateway

Production must not use a compute plan that intentionally sleeps after inactivity.

Requirements:

- one stable public HTTPS origin;
- health check enabled;
- one persistent `WPGO_MCP_SECRET` managed outside source control;
- no shell/start-command generation of a new MCP secret on boot;
- `WPGO_REQUIRE_SHARED_OAUTH_STATE=1`;
- shared Redis/Key Value configured;
- startup fails closed if required shared state is unavailable;
- zero-downtime deploys where supported;
- logs/metrics available for connection incidents.

### Persistent OAuth/connection state

The state store must survive service restart/redeploy. It carries short-lived authorization-code state and longer-lived connection telemetry/secret-continuity metadata.

Requirements:

- persistent managed Key Value/Redis;
- noeviction policy for critical OAuth state;
- persistence enabled;
- restricted network access;
- backup/restore or provider durability understood and documented;
- monitored connection count/memory usage.

### MCP secret continuity

Changing the MCP secret invalidates sealed credentials and signed site links. Production must therefore:

- create the secret once;
- store it in managed secret configuration;
- retain it through deploys/restarts;
- rotate it only through a planned migration/reconnect process;
- treat an unexpected fingerprint mismatch as an incident, not as an opportunity to silently overwrite state.

## Commercial data plane

### PostgreSQL

Persistent storage is required for:

- customer accounts;
- sessions/login state as applicable;
- registered sites;
- plans/subscriptions;
- quotas/usage;
- billing webhook idempotency;
- support tickets;
- commercial metadata.

Before GA:

- configure automated backups or provider snapshots;
- define retention;
- perform at least one restore drill;
- monitor active connections/storage;
- restrict database access to application services;
- confirm region/data-location implications for privacy documents.

### Customer portal/API

Customer-facing account and billing endpoints should be treated as production-critical. Cold starts that merely delay a rarely used support page may be tolerable in beta, but login, billing and site-registration flows should not depend on intentionally sleeping infrastructure for GA.

## Control plane and release signing

The Ed25519 signing key/seed is production security material.

Requirements:

- stable managed signing seed/private key;
- backup/recovery process that does not expose the key in ordinary logs/files;
- separate admin token;
- update manifests signed at the control plane;
- package SHA-256 published and verified;
- release package hosted over HTTPS;
- revocation procedure documented.

## Renderer

Renderer is less connection-critical than MCP but should still be production isolated.

Requirements:

- bearer token required;
- public-network-only outbound policy;
- concurrency limit;
- rate limit;
- browser lifecycle monitoring;
- CPU/memory monitoring;
- screenshot payload limits before broad public use;
- no private-network access.

## Monitoring and alerting

Before GA configure alerts for at least:

- MCP service unavailable / failing health;
- elevated HTTP 5xx rate;
- OAuth token endpoint failures;
- connection refresh rejection spikes;
- Redis/Key Value unavailable;
- PostgreSQL unavailable / connection saturation;
- Stripe webhook processing errors;
- control-plane signing/release errors;
- renderer failure/busy rates;
- unusual memory/CPU pressure.

Connection error pages and logs use request IDs; support procedures should preserve those IDs.

## Backups and recovery

Minimum GA drill:

1. export or snapshot production database;
2. restore into an isolated test database;
3. verify account/site/billing records;
4. verify state-store restart behavior;
5. redeploy MCP without changing `WPGO_MCP_SECRET`;
6. confirm an existing test AI connection refreshes without reauthorization;
7. document recovery time and any manual steps.

## Paid activation boundary

The following changes require explicit user approval because they may incur recurring cost:

- changing Render web services from Free to an always-on paid compute plan;
- provisioning persistent paid Key Value/Redis;
- provisioning/retaining paid persistent PostgreSQL;
- paid monitoring/log-retention services beyond included quotas;
- paid custom email/provider capacity if required;
- paid package/CDN/storage if chosen;
- third-party penetration testing or external compliance services.

All source-code, tests, documentation, configuration templates and staging simulations can continue before that approval.

## Activation sequence when approved

Recommended order:

1. persistent Key Value/Redis;
2. persistent PostgreSQL and backup policy;
3. always-on MCP gateway with stable managed MCP secret;
4. commercial API and portal;
5. control plane/signing service;
6. renderer;
7. domains/email/alerts;
8. 72-hour connected-client soak;
9. limited private beta;
10. billing/live-mode launch after acceptance.

Do not migrate paying users onto a production gateway until secret/state continuity and the restart/redeploy acceptance tests pass.