# WPGo 4.1 Render deployment bundle

Deploys two HTTPS web services:

- `wpgo-renderer`: Playwright/Chromium renderer, authenticated with a generated bearer token.
- `wpgo-control-plane`: licensing/update control plane, persistent `/data` disk, generated admin token, and an Ed25519 signing key automatically generated and persisted on first boot.

## Render Blueprint
Use `render.yaml` at the repository root.

Recommended plans in the blueprint:
- Renderer: `1c-2g` (Chromium reliability)
- Control plane: `0.5c-512mb` plus 1 GB persistent disk

For a cheaper test deployment, the renderer can be changed to `0.5c-512mb`, but 512 MB is not recommended for dependable Chromium operation.

## After deployment
1. Read the generated `WPGO_RENDER_TOKEN` from the renderer service.
2. In WordPress: Tools → WPGo → Services → Discover/configure Renderer.
   - Base URL: the renderer's `https://...onrender.com` URL
   - Token: generated `WPGO_RENDER_TOKEN`
3. In WPGo, discover/configure the Control Plane using its `https://...onrender.com` base URL. WPGo will retrieve the Ed25519 public key automatically.
4. Add a license through the Control Plane admin endpoint when commercial license validation is needed.
5. Release-package URL/SHA can remain empty while testing renderer/licensing discovery. Configure them before using commercial automatic updates.

## Google PageSpeed
WPGo's strict GA gate still requires a dedicated PageSpeed API key. Add it in Tools → WPGo → Services after creating one in Google Cloud.

## Builder fixture gate
The Beaver/Bricks/Breakdance evidence gate is separate. Run the bundled fixture lab from the WPGo release with legitimately obtained builder ZIPs and import the resulting attestation.
