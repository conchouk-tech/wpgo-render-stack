# WPGo Security Model

This document describes the intended security posture for WPGo 4.5 and later. It is an engineering/security reference, not a warranty or certification.

## Security objectives

WPGo is designed to let an AI client operate a WordPress site without giving the AI the user's normal WordPress password and without allowing unrestricted writes by default.

Primary objectives:

- least-privilege access to the connected WordPress site;
- explicit site/resource binding;
- human approval for non-read-only actions;
- no public-network SSRF pivot through WPGo infrastructure;
- short-lived access credentials and renewable refresh credentials;
- safe recovery/revocation;
- auditable connection and approval state;
- reproducible, dependency-audited releases.

## Authentication and authorization

### WordPress

WPGo uses WordPress Application Password authorization for the AI connector. The customer's normal WordPress password is not requested by the WPGo gateway.

Application Password credentials are scoped by the WordPress user that approved them and remain subject to WordPress capability checks.

### AI/MCP clients

WPGo implements OAuth Authorization Code with PKCE S256 for remote MCP clients.

Supported client registration/discovery modes include:

- Client ID Metadata Documents (CIMD);
- Dynamic Client Registration compatibility fallback.

OAuth authorization, access and refresh payloads are cryptographically sealed by the gateway. Site-specific MCP resources bind the client to the intended WordPress installation.

### Site-specific links

Site-specific MCP URLs contain a normalized site identity protected by an HMAC. They do not contain the WordPress password or Application Password.

A token issued for one MCP resource/site must not be accepted against another resource/site.

## Write approvals

Read-only abilities may execute directly after normal authorization.

Non-read-only abilities are routed through WPGo's approval-safe WordPress proxy. The first attempt creates an approval request rather than silently completing the action. Execution requires the corresponding approval ID after the user approves the action in WordPress.

Approval status is exposed as a read-only MCP operation.

GA should additionally expose a customer-visible immutable or append-only approval/audit history.

## Credential handling

- Normal WordPress passwords are not stored by WPGo.
- WordPress Application Password credentials are carried only inside encrypted/sealed OAuth state/tokens required to operate the connection.
- Access tokens are short-lived.
- Refresh tokens are longer-lived and rotate when refreshed.
- Production `WPGO_MCP_SECRET` must be persistent and managed outside source control.
- Production startup must fail rather than silently accepting a changed MCP secret while durable OAuth state exists.
- Production session, control-plane, Stripe, email and rendering tokens must live in managed environment/secret storage.

## Connection state

WPGo records connection metadata required for support and reliability, such as:

- site identity;
- hashed client identity reference;
- client display name;
- status;
- connected timestamp;
- last token refresh;
- last MCP activity;
- refresh credential expiry;
- bounded recent connection events.

Raw WordPress Application Passwords must never be included in connection telemetry or logs.

## Network security and SSRF controls

The renderer and other outbound components enforce public-network policies. Private, loopback, link-local, documentation/test and reserved network ranges are rejected except for tightly scoped automated test allowances.

Production outbound navigation requires HTTPS. Redirects and subresource requests are revalidated to prevent a public URL redirecting into private infrastructure.

Renderer browser contexts are short-lived and isolated per operation. Service workers are disabled for rendering/audit flows and unnecessary resource types may be blocked.

## Web application controls

- HTTPS is required in production.
- HSTS is emitted by production services.
- CSRF protection is required for account-changing portal actions.
- Session cookies use the `__Host-` prefix and secure cookie attributes.
- Rate limits are applied to OAuth, registration, portal and control-plane operations.
- CSP, frame, referrer and content-type protections are applied to OAuth/customer-facing pages where appropriate.
- Sensitive endpoints use constant-time comparisons or cryptographic hashes where meaningful.

## Commercial licence/update security

Licences and release metadata use Ed25519 signatures.

Commercial update delivery requires:

- active site-bound licence;
- signed update manifest;
- HTTPS package URL;
- SHA-256 package digest;
- client-side signature verification before trusting release metadata;
- package hash verification before installation.

The private signing key/seed must not be stored in source control.

## Dependency and release security

The release branch uses npm lockfiles and `npm ci` for reproducible dependency installation.

CI rejects high/critical npm audit findings across:

- MCP gateway;
- commercial API;
- portal;
- control plane;
- renderer.

WordPress source is statically checked for obvious debug and secret patterns. RC/GA builds are expected to pass syntax/unit/integration/security gates before publication.

## Logging policy

Logs should contain operational metadata such as request IDs, event type, bounded error messages, site host where necessary, and non-secret identifiers.

Never log:

- WordPress passwords;
- Application Password values;
- OAuth access/refresh token contents;
- Stripe secret/webhook keys;
- private signing keys/seeds;
- session secrets.

Request IDs should be surfaced to the customer on recoverable error pages so support can correlate a report without asking for secrets.

## Security reporting

Before GA, publish a dedicated security contact address or form and document:

- what information a reporter should provide;
- safe-harbor expectations where applicable;
- acknowledgement target;
- triage/severity process;
- coordinated disclosure process.

## Known pre-GA limitations

- Current free staging infrastructure is not representative of required GA availability/persistence.
- The Connect AI RC is still a companion module until the full core plugin source is brought into the release workstream.
- Formal penetration testing / third-party security assessment has not yet been recorded in this repository.
- Legal/privacy documents remain drafts pending professional review.
