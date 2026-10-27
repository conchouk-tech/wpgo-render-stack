# WPGo 4.5 RC3 cross-client acceptance matrix

Use the same disposable/test WordPress site and the same WPGo RC3 build wherever possible. The purpose is capability parity and standards compatibility, not simply whether a connector displays a green status.

## Baseline clients

The final client list must be checked against each provider's current MCP/OAuth documentation immediately before testing. The intended diversity is:

1. Claude web/desktop — baseline from the Beneath Trilogy acceptance build.
2. Google/Gemini client — use the current Gemini surface that supports remote MCP and the required OAuth flow.
3. ChatGPT remote/custom MCP — validates OpenAI client behavior independently of Claude.
4. One IDE client — Cursor or VS Code/GitHub Copilot, whichever currently exposes the relevant remote MCP/OAuth support most cleanly.
5. One open-source MCP client — validates that WPGo has not accidentally optimized only for the major hosted clients.

Claude Code may be included separately from Claude web because it is a different client implementation and is useful for developer/agency workflows.

## Test A — discovery and schemas

- Add the site-specific WPGo MCP URL.
- Complete OAuth without manually entering the WordPress site URL again.
- Confirm the client loads the complete WPGo tool list without silently excluding malformed tools.
- Confirm `structured-builder-node-edit`, `structured-builder-batch-edit` and Elementor editing are visible when the site supports them.
- Confirm `command-write` and `create-job` expose valid WPGo commands rather than an unconstrained free-text command field where the client UI supports schema enums.
- Record tool count and any client-side schema warnings.

Pass: no WPGo tool is dropped because of an invalid WPGo schema.

## Test B — invalid-command preflight

Ask the agent to submit a deliberately invalid command such as `menu.item.add`.

Expected:
- WPGo rejects it before creating an approval;
- the error is a 400-style validation problem, not a permissions/403 problem;
- the response suggests `menu.add-post` when appropriate;
- the WordPress approval screen remains empty for that request.

Pass: zero user approval clicks are wasted.

## Test C — exact plan approval

Ask the agent for a small related plan, for example:

- create a draft page;
- add that page to a menu.

Expected:
- agent prefers `wpgo/create-job`;
- WPGo preflights all steps;
- one approval represents the exact multi-step payload;
- approval text describes the plan in human terms;
- approval retains expiry, payload binding and single-use behavior.

Pass: one useful approval, two completed steps, complete audit receipt.

## Test D — content round trip

Create/update a draft containing:

- a class such as `bn-shelf--tight`;
- a literal backslash;
- escaped quotes;
- Gutenberg/Kadence JSON block attributes;
- Unicode text;
- JSON or a code sample containing backslashes.

Read the content back through WPGo and WordPress.

Pass: values survive without `u002d` corruption, missing slashes or double escaping.

## Test E — generic media

1. Upload an image from a public HTTPS URL through `wpgo/upload-media-from-url`.
2. Confirm the write is approval-gated and produces a media ID/URL.
3. Try an HTTP/private/localhost URL and confirm WPGo rejects it before approval.
4. Test `wpgo/request-media-upload` + `wpgo/check-media-upload` for local-device files where the client can open the returned page.

Pass: the same generic media abilities are visible across standards-compatible clients.

## Test F — theme settings

On a Kadence test site:

- read `wpgo/theme-settings-catalog`;
- update the footer HTML content through `wpgo/theme-setting-update`;
- confirm one approval is required;
- confirm an unlisted setting is refused;
- restore the original value.

Pass: legitimate reviewed theme configuration can be changed without arbitrary option access or CSS workarounds.

## Test G — visual verification

Run the renderer/site audit at:

- desktop 1440 × 900;
- tablet 820 × 1180;
- mobile 390 × 844.

After a visual content/design change, ask the agent to inspect the rendered result and identify obvious responsive problems.

Pass: all three presets render; mobile screenshot is available; console/audit data is returned; agent can use the result to correct a deliberately introduced low-risk layout issue.

## Test H — approval failure/status behavior

- Attempt a CSS change containing a deliberately blocked construct such as an invalid `@import` if the relevant managed-CSS policy applies.
- Confirm validation/preflight blocks predictable failures before approval where possible.
- For execution-time failures that cannot be predicted, confirm approval status returns a structured failure reason rather than HTTP 500.

Pass: failure is understandable and no approval appears successful when execution failed.

## Test I — OAuth lifecycle

- Connect from a clean client session.
- Use WPGo after the initial access-token lifetime.
- Confirm refresh works when the client omits optional `client_id` or `resource` fields.
- Reopen/restart the client and confirm the connection remains usable where the current free staging infrastructure has not slept/restarted.
- Distinguish client/OAuth failures from known free-Render cold-start limitations.

Pass for software: refresh/reconnect protocol succeeds without unnecessary reauthorization.

Full overnight reliability is a GA infrastructure test and must be repeated on always-on/persistent production-like infrastructure.

## Test J — capability parity scorecard

For each client record:

| Capability | Visible | Executes | Approval correct | Notes |
| --- | --- | --- | --- | --- |
| Site info/read | | | n/a | |
| Posts/pages | | | | |
| Create-job plan | | | | |
| Media from URL | | | | |
| Device media session | | | | |
| WooCommerce (if enabled) | | | | |
| SEO | | | | |
| Builder inspection/edit | | | | |
| Kadence safe settings | | | | |
| Managed CSS/revisions | | | | |
| Renderer/audit | | | n/a | |
| Approval status | | | n/a | |

A client does not pass merely because it can connect. Core WPGo capabilities must be discoverable and behave consistently.

## Evidence to retain

For every client test retain:

- client name/version and date;
- connection method and OAuth registration mode (CIMD, DCR or other standards-compliant path);
- WPGo product/gateway/plugin versions;
- tool count and schema warnings;
- screenshots of approval UX;
- audit IDs/approval IDs with secrets removed;
- failures and exact client error text;
- whether the client automatically recovered after token refresh/restart.
