# WPGo MCP Gateway

Optional compatibility gateway for AI clients that need a single hosted remote-MCP endpoint.

## Default commercial connection

WPGo 4.5 uses the WordPress site's own OAuth-protected MCP endpoint as the preferred connection path. That keeps WordPress credentials and authorization on the customer's site and works with ChatGPT, Claude, and other OAuth-capable remote MCP clients.

The hosted gateway is **not required** for normal WPGo use. It exists for compatibility and controlled fallback scenarios.

## Security properties in 1.1

- MCP-first and provider-neutral; no OpenAI/ChatGPT API key dependency.
- Fixed public issuer (`WPGO_MCP_PUBLIC_BASE`) in production; forwarded Host headers cannot redefine the OAuth issuer.
- Public-HTTPS-only outbound networking with DNS/IP validation and address pinning to reduce SSRF and DNS-rebinding risk.
- OAuth authorization codes are single-use and persisted in Postgres, so restarts or multiple instances do not break the code exchange.
- PKCE S256 is required and verifier format is validated.
- OAuth issuer (`iss`) is returned on authorization responses.
- Registration, authorization, token, and general request throttling are bounded and periodically cleaned.
- Access/refresh tokens are AES-256-GCM sealed. `WPGO_MCP_SECRET_PREVIOUS` permits controlled key rotation.
- Only `wpgo/*` abilities are exposed. Fleet/controller abilities stay blocked.
- Response bodies and request sizes are bounded.
- Structured request IDs and graceful shutdown are included.

## Required environment

- `DATABASE_URL` — Postgres connection used for single-use authorization codes.
- `WPGO_MCP_SECRET` — current high-entropy token-sealing secret, minimum 32 characters.
- `WPGO_MCP_PUBLIC_BASE` — canonical HTTPS origin, for example `https://mcp.example.com`.
- `WPGO_MCP_SECRET_PREVIOUS` — optional previous sealing secret during key rotation.
- `PORT` — supplied by the hosting platform.

## Release note

The direct site OAuth/MCP connector remains the recommended end-user path. Do not market the hosted gateway as a credential vault or use it to bypass WPGo's site-side approval controls.
