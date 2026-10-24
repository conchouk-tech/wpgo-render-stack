# WPGo 4.2.0 Render deployment bundle

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/conchouk-tech/wpgo-render-stack)

Deploys two HTTPS web services:

- `wpgo-renderer-ga`: Playwright/Chromium renderer, authenticated with a Render-generated bearer token and restricted to `wpgo.vivaforte.es` for the current validation deployment.
- `wpgo-control-plane-ga`: licensing/update control plane with a Render-generated admin token and stable seed-derived Ed25519 signing identity.

## Render Blueprint
Use `render.yaml` at the repository root. Both services are currently configured for Render's free plan so the commercial release candidate can be validated without upgrading the workspace.

Render generates these secrets server-side:
- `WPGO_RENDER_TOKEN`
- `WPGO_CONTROL_ADMIN_TOKEN`
- `WPGO_SIGNING_SEED`

They are not stored in GitHub.

## WPGo 4.2 licensing
The control plane supports two licence modes:

1. Ed25519-signed `wpgo1.*` licence tokens. These are durable without a database and can carry plan, expiry, features and optional site binding.
2. Optional persistent legacy records when `WPGO_LICENSE_STORE` is configured.

Signed-token licences can be revoked by adding their `license_id` to `WPGO_REVOKED_LICENSE_IDS` and redeploying. This lets the free deployment support a real commercial beta without pretending the ephemeral Render filesystem is persistent.

The WordPress plugin uses an updates-and-support entitlement model: a licence outage never remotely disables the installed WPGo runtime.

## After deployment
1. Open the `wpgo-renderer-ga` service in Render and copy the generated `WPGO_RENDER_TOKEN` value.
2. In WordPress: Tools → WPGo → Services, enroll the renderer using:
   - Base URL: the renderer's `https://...onrender.com` URL
   - Token: generated `WPGO_RENDER_TOKEN`
3. Enroll the Control Plane using its `https://...onrender.com` base URL. WPGo retrieves and stores the Ed25519 public verification key automatically.
4. Issue commercial licence tokens through the authenticated control-plane admin API.
5. Configure the final release package URL and exact SHA-256 before automatic commercial updates are enabled.

## Google PageSpeed
WPGo's production gate uses a dedicated PageSpeed API key for reliable Lighthouse quota. Add it in Tools → WPGo → Services.

## Builder support
The commercial release advertises only validated stable builders. Beaver Builder and Breakdance require fresh real-builder evidence for GA. Bricks remains experimental and is not a commercial-release blocker until it is separately validated.
