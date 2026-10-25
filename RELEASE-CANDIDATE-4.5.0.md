# WPGo 4.5.0-rc.1

Release candidate created after end-to-end testing with a non-OpenAI MCP client exposed onboarding and browser-navigation friction in the 4.4.x connection flow.

## Release-candidate goals

WPGo 4.5 moves the product from a technically functional universal MCP gateway to an end-user connection experience that can be understood without knowing OAuth, Application Passwords, MCP resource metadata, or the exact WordPress site URL.

The preferred onboarding starts from WordPress:

1. Install/activate WPGo and sign in to WordPress normally.
2. Open **WPGo / Connect AI**.
3. WPGo identifies the current site automatically and checks that its secure AI capabilities are ready.
4. Choose Claude, ChatGPT, or another standards-compatible MCP client.
5. Copy the site-specific MCP URL into the AI client.
6. The AI discovers WPGo OAuth automatically.
7. WPGo already knows which WordPress site is being connected and takes the user directly to WordPress's Application Password approval screen.
8. Approve access and return to the AI client.

The old universal `/mcp` endpoint remains available as a compatibility/fallback path.

## Major 4.5 RC changes

### WordPress-first onboarding

- Added a self-contained **Connect AI** WordPress admin module.
- Site address is taken from WordPress `home_url()` rather than typed by the customer.
- Provider cards for Claude, ChatGPT, and other MCP clients.
- Guided connection page and site readiness diagnostics.
- Warning when the configured WordPress administrator/recovery email looks like a placeholder `admin@site-domain` address, based on a real onboarding failure observed during RC testing.
- Request IDs are surfaced for support diagnostics.

### Site-specific MCP URLs

- Added stable signed `wpgosite1` site identifiers.
- New MCP resources use `/mcp/s/<signed-site-token>`.
- Site tokens identify the WordPress site but contain no WordPress password or Application Password.
- Tokens are HMAC protected and reject tampering.
- WordPress subdirectory installations remain supported.
- OAuth access/refresh tokens are bound to the exact MCP resource and WordPress site.
- A credential authorized for one site-specific MCP URL cannot be replayed against another site.

### OAuth / MCP onboarding

- Modern OAuth protected-resource metadata is available for both the legacy resource and each site-specific resource path.
- CIMD remains supported for clients such as Claude's published identity.
- Dynamic Client Registration remains available as a compatibility fallback.
- PKCE S256 remains mandatory.
- Site-specific OAuth authorization bypasses the manual WordPress-address form and proceeds directly to WordPress readiness validation and approval.
- The legacy `/mcp` resource keeps the manual-site flow for older/existing connections.

### WordPress write safety

- Non-read-only MCP tools remain routed through WPGo's WordPress approval proxy.
- Write calls still require a WordPress approval ID before execution.
- Approval-status remains exposed as a read-only MCP tool.

### Connection reliability and diagnostics

- Fixed cross-origin WordPress authorization navigation after a WPGo form POST by using a CSP that permits the intended HTTPS form/redirect flow.
- Structured connection-readiness checks distinguish:
  - invalid site URL,
  - unreachable WordPress REST API,
  - WPGo missing,
  - WPGo update required,
  - Application Password authorization unavailable.
- Error screens include stable error codes and request IDs rather than silently appearing to do nothing.

## Automated RC validation

The RC workflow must pass all of the following before the branch is considered testable:

- MCP gateway syntax and security unit tests.
- Signed site-link normalization/tamper tests.
- Full isolated HTTPS WordPress-first OAuth/MCP integration test:
  1. create site-specific MCP URL,
  2. discover protected-resource metadata,
  3. receive the correct unauthenticated MCP challenge,
  4. register a generic OAuth client,
  5. confirm the site-specific authorize flow skips manual site selection,
  6. redirect to WordPress Application Password authorization,
  7. process the WordPress authorization callback,
  8. exchange the OAuth code for site-bound tokens,
  9. list authenticated MCP tools,
  10. refresh the token,
  11. reject a tampered site token.
- WordPress PHP 8.0 syntax checks.
- Build installable `wpgo-connect-ai-4.5.0-rc.1.zip` plus SHA-256.
- Commercial API + PostgreSQL startup test.
- Control-plane signed licence issue/validation test.
- Portal production-mode startup test.
- Renderer release check.

The first RC workflow run passed all six jobs.

## Component versions

| Component | RC version |
| --- | --- |
| WPGo product | `4.5.0-rc.1` |
| MCP gateway | `1.4.0-rc.1` |
| WordPress Connect AI module | `4.5.0-rc.1` |
| Commercial API | `1.4.0` |
| Commercial portal | `1.6.0` (4.5 portal UX integration remains follow-up RC work) |
| Control plane | `4.3.0` |
| Renderer | `4.3.0` |

## RC artifact

GitHub Actions produces an installable WordPress companion artifact named:

`wpgo-connect-ai-4.5.0-rc.1`

This companion module is deliberately separable from the existing WPGo core during RC validation. It allows the new onboarding to be tested without replacing the current WPGo runtime. Before final 4.5 GA, this module should be folded into the main WordPress plugin distribution so customers install one WPGo plugin, not two.

## Remaining release-candidate validation

Before promoting 4.5 to general availability:

- Deploy the RC gateway to an isolated staging endpoint.
- Test the new site-specific connection URL with Claude using published identity/CIMD.
- Test at least one second independent MCP client.
- Install the RC WordPress companion on a disposable/test WordPress site and validate the WordPress-first UX in a real browser.
- Verify connection recovery after cancel/reject/expired OAuth flows.
- Verify a WordPress user already logged in goes directly to application approval.
- Verify a logged-out user returns to the intended approval flow after login.
- Fold Connect AI into the main WPGo plugin and remove the temporary companion-module packaging step.
- Add the same **Connect AI** entry point to the commercial account portal for registered sites.
- Exercise Stripe test checkout/webhooks and signed update package delivery before GA.

## Production status

`4.5.0-rc.1` is a release candidate, not a production release. Production services and existing WordPress installations should remain on the current release until the external staging checks above are complete.
