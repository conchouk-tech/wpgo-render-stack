# WPGo 4.5 commercial release stack

WPGo connects WordPress to AI clients through **MCP (Model Context Protocol)** rather than through a ChatGPT-specific integration. The preferred production path is direct, OAuth-protected remote MCP from the AI client to the customer's WordPress site.

That means ChatGPT is one supported client, not the architecture. Claude and other OAuth-capable remote MCP clients can use the same WPGo endpoint without an OpenAI API key.

## Commercial architecture

### 1. WordPress / WPGo connector — preferred AI path

The WPGo 4.5 connector exposes curated `wpgo/*` abilities through the site's OAuth-protected MCP endpoint:

`https://customer-site.example/wp-json/mcp/mcp-adapter-default-server`

Key properties:

- provider-neutral MCP transport;
- OAuth authorization instead of manually pasting WordPress credentials into an AI client;
- readonly abilities can run immediately when authorised;
- writable/destructive abilities remain behind WPGo's approval system;
- the Agent Connector dependency's own privileged abilities are hidden from MCP;
- only the `wpgo` namespace is public by default; extra namespaces require an explicit WPGo filter;
- the dependency is installed or repaired only after an administrator explicitly approves it;
- the dependency package is pinned and SHA-256 verified.

See `wpgo-plugin-patches/4.5.0/class-wpgo-ai-connector.php`.

### 2. Commercial account API

`wpgo-commercial-api` provides account authentication, real email sign-in codes, site registration, site-bound licences, rolling usage limits, support tickets and Stripe billing.

The 1.4.1 hardening build adds:

- fail-closed production configuration;
- bounded auth/support throttling;
- sign-in-code attempt limits;
- real email delivery hooks (Resend or a controlled HTTPS webhook);
- atomic and idempotent usage metering;
- Stripe webhook deduplication;
- site-bound licence issuance and refresh;
- automatic migration of legacy `www.` site-host records;
- request IDs, timeouts, security headers and graceful shutdown;
- a provider-neutral connection manifest and connection profile.

### 3. Control plane

`wpgo-control-plane-ga` signs licences and commercial update metadata with Ed25519. Production refuses to start without a strong admin token and signing identity.

A licence can be bound to one or more site hosts. The installed WordPress runtime is not remotely disabled when the licence service is unavailable; licensing controls commercial entitlement, updates and hosted services.

### 4. Renderer

`wpgo-renderer-ga` supports arbitrary **licensed** customer sites rather than a hard-coded WPGo test hostname. It validates public network targets, blocks private-address targets, locks main-frame navigation to the requested origin and validates subresource URLs.

The previous static renderer bearer token remains only as an internal/backward-compatible path. It is not the normal customer authorization model.

### 5. Optional hosted MCP gateway

`mcp-gateway/` is a compatibility path for clients that need a single hosted MCP endpoint. It is **not the default commercial connection path** because its Application Password bridge necessarily handles a WordPress application credential centrally.

The gateway has been hardened with a fixed production issuer, public-network-only outbound requests, PKCE, persisted single-use auth codes, request throttling, bounded caches, key rotation support and strict `wpgo/*` ability curation. Keep it preview/compatibility-only until central credential custody is removed or replaced with a stronger delegated OAuth design.

## Render Blueprint

`render.yaml` configures the GA renderer, control plane, commercial portal and commercial API. It deliberately does not promote the optional MCP gateway to GA.

Production settings include:

- `NODE_ENV=production` on all relevant services;
- a shared control-plane admin secret;
- generated session/signing secrets;
- no hard-coded customer/test hostname;
- no HTTP/no-token renderer escape hatch;
- real email and billing required by default;
- Stripe/email secrets represented as manually supplied secret values, never committed to GitHub.

**Important for existing Render services:** values declared with `sync: false` must be populated in Render before the 4.5 deployment. Do not deploy the commercial API until email, Stripe and price IDs are present, because the hardened API intentionally fails closed rather than presenting a half-working product.

## Release process

Use `docs/COMMERCIAL_RELEASE.md` as the go/no-go checklist. The release is not ready to merge/deploy merely because it builds; direct MCP/OAuth client testing, approval-flow testing, billing/email tests, licence isolation, renderer isolation and rollback checks are mandatory.

Run the static checks with:

```bash
bash scripts/release-check.sh
```

## Current release target

- WPGo plugin connector: **4.5.0**
- Commercial API: **1.4.1**
- Control plane: **4.5.0**
- Renderer: **4.5.0**
- Optional MCP gateway: **1.1.0**

This branch is a commercial hardening candidate. It should be reviewed and tested before it replaces the currently deployed `main` release.
