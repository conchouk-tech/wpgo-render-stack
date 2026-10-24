# WPGo 4.1.1 Render deployment bundle

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/conchouk-tech/wpgo-render-stack)

Deploys two HTTPS web services:

- `wpgo-renderer-ga`: Playwright/Chromium renderer, authenticated with a Render-generated bearer token and restricted to `wpgo.vivaforte.es` for the current validation deployment.
- `wpgo-control-plane-ga`: licensing/update control plane with a Render-generated admin token and stable seed-derived Ed25519 signing key.

## Render Blueprint
Use `render.yaml` at the repository root. Both services are currently configured for Render's free plan so the GA integration can be validated without upgrading the workspace.

Render generates these secrets server-side:
- `WPGO_RENDER_TOKEN`
- `WPGO_CONTROL_ADMIN_TOKEN`
- `WPGO_SIGNING_SEED`

They are not stored in GitHub.

## After deployment
1. Open the `wpgo-renderer-ga` service in Render and copy the generated `WPGO_RENDER_TOKEN` value.
2. In WordPress: Tools → WPGo → Services, enroll the renderer using:
   - Base URL: the renderer's `https://...onrender.com` URL
   - Token: generated `WPGO_RENDER_TOKEN`
3. Enroll the Control Plane using its `https://...onrender.com` base URL. WPGo retrieves and stores the Ed25519 public verification key automatically.
4. Release-package URL/SHA can remain empty during service integration testing. Configure them before commercial automatic updates are enabled.

## Production note
The free control-plane deployment validates service discovery and signed responses, but does not provide persistent commercial license storage. Before selling WPGo, move the control plane to persistent storage (paid disk or database-backed storage).

## Google PageSpeed
WPGo's strict GA gate still requires a dedicated PageSpeed API key. Add it in Tools → WPGo → Services after creating one in Google Cloud.

## Builder fixture gate
The Beaver/Bricks/Breakdance evidence gate is separate. Run the bundled fixture lab from the WPGo release with legitimately obtained builder ZIPs and import the resulting attestation.
