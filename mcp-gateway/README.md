# WPGo Universal MCP Gateway

Remote MCP + OAuth gateway for WPGo. One endpoint serves modern MCP 2026-07-28 and legacy stateless MCP clients. Authentication uses WordPress's Application Password Authorization Flow so customers never copy credentials manually.

## Customer flow

1. Add `https://<gateway>/mcp` to a remote-MCP compatible AI client.
2. Enter the WordPress site URL in the WPGo authorization page.
3. Approve `WPGo AI Connector` in WordPress.
4. The AI client receives OAuth tokens and discovers the site's safe WPGo abilities.

Only `wpgo/*` abilities are exposed. Fleet/controller abilities are denied at the gateway so one site authorization cannot become lateral access to other sites.

## Environment

- `WPGO_MCP_SECRET` — required, high-entropy secret (32+ chars) used for AES-256-GCM token sealing.
- `WPGO_MCP_PUBLIC_BASE` — optional canonical public base URL.
- `PORT` — injected by the hosting platform.
