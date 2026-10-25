# WPGo commercial stack

WPGo connects standards-compatible AI clients to WordPress through MCP while keeping WordPress credentials, licensing, billing and privileged infrastructure behind WPGo-owned services.

The commercial stack is deliberately **AI-provider neutral**. The MCP gateway implements the current MCP authorization model and does not require ChatGPT- or OpenAI-specific credentials or code paths.

## Services

The Render blueprint contains:

- `wpgo-mcp-ga` — public MCP/OAuth gateway. Supports Client ID Metadata Documents (CIMD) and Dynamic Client Registration fallback, PKCE S256, protected-resource metadata and stateless MCP transport.
- `wpgo-mcp-state` — shared short-lived OAuth authorization-code state. Production MCP instances fail closed if this store is unavailable rather than silently falling back to process memory.
- `wpgo-commercial-api` — accounts, email sign-in, plans, usage metering, site registration, Stripe integration, support and licence issuance orchestration.
- `wpgo-commercial-web` — end-user account, billing, support and secure WordPress pairing portal.
- `wpgo-control-plane-ga` — Ed25519 licence signing, licence validation and signed update manifests.
- `wpgo-renderer-ga` — authenticated Playwright renderer with public-network SSRF preflight controls.
- `wpgo-commercial-db` — account, site, usage, login-code and support persistence.

## Security model

Commercial production defaults are fail-closed:

- MCP OAuth state must use the shared Redis-compatible store.
- MCP access and refresh tokens are encrypted and bound to the authorization-server issuer and exact MCP resource.
- OAuth authorization codes are one-time and the Redis row does not contain plaintext WordPress credentials.
- PKCE S256 is mandatory and redirect URIs are strictly validated.
- WordPress subdirectory installs such as `https://example.com/blog/` remain distinct and supported.
- Site licences are issued only for sites registered to the account. Unbound licences are disabled by default.
- Usage consumption is serialized per account so concurrent requests cannot race past the plan allowance.
- Email login codes are attempt-limited and verified transactionally.
- Account-changing portal forms use CSRF protection. WordPress pairing requires explicit site confirmation.
- The renderer requires authentication in production, blocks private/reserved network ranges and exposes an unauthenticated health endpoint that contains no credential material.
- Production services reject missing critical secrets instead of substituting development defaults.

## Required production configuration

`render.yaml` generates secrets that can safely be independent:

- `WPGO_MCP_SECRET`
- `WPGO_SIGNING_SEED`
- `WPGO_SESSION_SECRET`
- `WPGO_PORTAL_CSRF_SECRET`
- `WPGO_RENDER_TOKEN`

The following values must be supplied before a production release:

- `WPGO_CONTROL_ADMIN_TOKEN` — set the **same strong secret** on both `wpgo-control-plane-ga` and `wpgo-commercial-api`.
- `RESEND_API_KEY`
- `WPGO_LOGIN_FROM_EMAIL`
- Stripe secret, webhook secret and price IDs when paid billing is enabled.
- Final `WPGO_RELEASE_PACKAGE`, `WPGO_RELEASE_SHA256` and `WPGO_RELEASE_URL` before automatic commercial updates are enabled.

Do not expose the control-plane admin token, session secret, MCP secret, renderer token or Stripe secret to WordPress or to an AI client.

## Licence behaviour

The control plane issues Ed25519-signed `wpgo1.*` tokens. Commercially issued tokens are site-bound by default. An account can have multiple registered sites; licence refreshes include the account's current registered host set.

A control-plane or billing outage must not remotely disable an already installed WordPress runtime. Licensing governs commercial entitlements such as account services, metering, support and updates rather than acting as a remote kill switch.

Signed-token revocation is handled through `WPGO_REVOKED_LICENSE_IDS`. Persistent legacy licence records remain supported when `WPGO_LICENSE_STORE` is configured.

## AI client compatibility

WPGo should be configured by giving a compatible AI client the MCP endpoint. The client discovers authorization through standard OAuth protected-resource and authorization-server metadata.

The gateway supports:

- MCP protocol `2026-07-28` through the current MCP server SDK.
- Legacy stateless MCP clients supported by that SDK.
- Client ID Metadata Documents for modern clients.
- Dynamic Client Registration as a compatibility fallback.
- Native loopback redirect URIs where allowed by OAuth client rules.

No AI-provider API key is required by WPGo itself. Provider-specific model authentication remains between the end user and their chosen AI provider.

## Release validation

The `Commercial hardening` GitHub Actions workflow is the minimum merge gate for the commercial branch. It checks:

- MCP gateway syntax and security regression tests.
- Commercial API syntax.
- Control-plane syntax.
- Portal syntax.
- Renderer syntax.

Before promoting a release to production, also complete end-to-end staging tests for:

1. New account email sign-in.
2. WordPress pairing and licence return.
3. MCP authorization from at least two independent standards-compatible AI clients.
4. Read-only and mutating WordPress abilities.
5. Access-token expiry and refresh.
6. Multiple sites on one account, including a WordPress subdirectory install.
7. Plan quota enforcement under concurrent requests.
8. Stripe checkout, portal and webhook lifecycle if billing is enabled.
9. Licence refresh after a plan or registered-site change.
10. Signed update manifest and package SHA-256 verification.

## Production hosting

The blueprint currently uses free Render plans as a staging/candidate configuration. A paid production launch should move latency-sensitive web services, the shared OAuth state store and the database onto production-grade plans with appropriate persistence, backups, monitoring and availability guarantees.
