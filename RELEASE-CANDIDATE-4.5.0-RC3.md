# WPGo 4.5.0-rc.3 — Agent Experience

RC3 is driven by a real acceptance test: Claude used WPGo 4.4.5 to build the ten-page Beneath Trilogy site and then reviewed the experience. The build succeeded, but exposed avoidable approval friction, malformed tool schemas, content round-trip corruption, missing generic-client media exposure, weak theme-setting coverage and lack of responsive visual verification.

RC3 converts those findings into product requirements and automated regressions.

## Release goals

WPGo's commercial position is **safe autonomous WordPress work**. Safety should not mean needless friction. The desired workflow is:

**Plan → Preflight → Preview/Approve → Execute → Verify → Undo**

The AI should be able to discover the correct capability without guessing, impossible requests should fail before the user sees an approval, related low-risk work should be submitted as one exact payload-bound plan, and WPGo should verify the rendered result after changes.

## Claude acceptance-test fixes

### 1. Content integrity at the WordPress save boundary

The 4.4.5 test exposed post content losing escape characters on some direct and job write paths. RC3 adds a WordPress-side compatibility layer that applies `wp_slash()` to the title/content/excerpt fields of the affected `post.create`, `post.update`, categorized-post and batch-job paths before they cross WordPress's unslashing insert/update boundary.

A standalone regression fixture round-trips:

- Kadence/Gutenberg block comments and JSON attributes;
- literal backslashes;
- escaped quotes;
- CSS class names such as `bn-shelf--tight`;
- post titles and excerpts;
- batch-job post writes.

Non-post job arguments are deliberately left untouched.

### 2. MCP tool-schema repair and validation

The 4.4.5 core used PHP `array()` for some arbitrary-value JSON-Schema nodes. PHP serialized these as JSON `[]`, so standards-compliant clients could reject tools such as Elementor/structured-builder editing.

RC3 adds a recursive schema guard that:

- repairs an empty PHP list only when it occurs in a JSON-Schema position where an object/boolean schema is required;
- preserves legitimate arrays such as `enum`, `required`, union `type` and array examples;
- recursively validates the result;
- excludes/logs a tool rather than sending malformed schema to an MCP client if validation still fails.

The test suite includes the exact structured-builder `value: []` regression shape.

### 3. Command discovery instead of guessing

WPGo already exposes an accurate `wpgo/platform-manifest`. RC3 now consumes that live manifest at the gateway and uses it to enrich generic command tools:

- `command-read.command` is constrained to the live read-command enum;
- `command-write.command` is constrained to the live write-command enum;
- every `create-job` step receives the live command enum;
- recipes are constrained to the live recipe list where available;
- tool descriptions explicitly tell agents not to invent command names.

A typo such as `menu.item.add` is rejected as an unknown command with a suggestion such as `menu.add-post`, rather than being misreported as a permissions failure.

### 4. Preflight before approval

RC3 performs predictable validation before a writable request is allowed to create an approval:

- unknown direct commands;
- unknown job-step commands;
- unknown recipes;
- generic option writes outside the safe option allowlist when the core can expose that list;
- invalid/private remote-media URLs.

The E2E mock has an approval counter. The regression sends Claude's invalid `menu.item.add` command and asserts the counter remains **zero**. This means an impossible request cannot waste a user's approval click.

### 5. One exact plan, one useful approval

`wpgo/create-job` is now explicitly presented to AI clients as the preferred tool for two or more related changes. The existing payload hash, expiry and single-use protection remain intact, but an exact multi-step plan can be approved once rather than forcing one click per low-risk step.

Approval responses include a readable summary. The E2E regression submits a two-step plan (`post.create` + `menu.add-post`) and asserts that it creates exactly one approval and that the response includes a human-readable plan summary.

This is not a blanket approval bypass and does not add a dangerous global session grant.

### 6. Generic-client media parity

WPGo 4.4.5 already had hardened media REST routes, including remote-media SSRF protection and a local-device upload session. Generic MCP clients could not see those routes as abilities.

RC3 wraps the existing hardened implementation as standard WordPress Abilities:

- `wpgo/upload-media-from-url` — approval-gated public-HTTPS media sideload;
- `wpgo/request-media-upload` — short-lived local-device upload page;
- `wpgo/check-media-upload` — read uploaded media IDs/URLs.

This is designed to remove the capability difference where ChatGPT had media tooling while Claude's standards-based MCP view did not.

### 7. Safe theme settings — Kadence first

RC3 adds a deliberately narrow reviewed theme-settings adapter rather than arbitrary Customizer/option writes.

For Kadence, the first allowlisted global settings are:

- `footer_html_content`;
- `footer_html_link_style`.

The adapter reads/writes through WordPress theme mods, validates values and remains approval-gated through the normal writable-ability proxy. Unsupported themes/settings fail closed. Astra and GeneratePress are detected but remain unsupported until their own source-reviewed allowlists are added.

### 8. Responsive visual verification

RC2 introduced a protected rendered-site audit. RC3 adds named responsive presets:

| Preset | Viewport |
| --- | --- |
| Desktop | 1440 × 900 |
| Tablet | 820 × 1180 |
| Mobile | 390 × 844 |

The real Chromium integration gate audits all three widths and requires a mobile screenshot. This is intended to catch the class of phone-width layout bug that the Claude build only found in an outside browser.

## Security properties retained

RC3 does **not** weaken WPGo's core trust model:

- writable abilities remain approval-gated;
- approvals remain bound to the exact normalized payload;
- approvals retain expiry and single-use semantics;
- destructive operations remain explicitly marked;
- arbitrary option/theme writes are not introduced;
- remote media remains public-HTTPS only and uses WPGo's existing network validation;
- site-bound OAuth/PKCE/refresh protections from RC2 remain in place;
- production infrastructure remains unactivated until cost approval.

## RC3 automated gates

The release candidate must prove:

- all MCP schemas exposed to clients are valid after repair;
- the known structured-builder malformed-schema fixture becomes usable;
- command schemas expose live manifest enums;
- an invented command creates zero WordPress approvals;
- a valid related two-step plan creates one approval with a readable summary;
- post content survives the simulated WordPress unslash boundary;
- invalid media URLs fail before approval;
- Claude/standard MCP clients receive the generic media abilities;
- OAuth, CIMD, refresh rotation, connection history and site-token tamper rejection continue to pass;
- desktop/tablet/mobile browser audits execute in Chromium;
- billing, signed-update, security-audit and production-blueprint gates remain green.

## Deliberately deferred

The following remain outside this no-cost RC3 build:

- paid/always-on Render infrastructure and persistent production state;
- production Stripe charges;
- legal review of customer documents;
- final merging of the RC companion into a single core plugin distribution once the full plugin source is maintained in the release repository;
- broad Astra/GeneratePress setting adapters;
- arbitrary live theme editing (intentionally not planned);
- production reliability soak testing, which requires production-like persistent infrastructure.

## Cross-client acceptance round after RC3

RC3 is specifically intended to be tested with multiple independent MCP clients. The acceptance matrix should verify capability parity, not merely whether a connector says "connected":

1. load the full tool set without schema exclusions;
2. inspect/read WordPress data;
3. deliberately submit an invalid command and confirm no approval appears;
4. submit a multi-step safe plan and confirm one readable approval;
5. upload media through a generic MCP-visible ability;
6. exercise a builder tool;
7. update an allowlisted Kadence setting;
8. perform desktop/tablet/mobile visual audit;
9. refresh/reconnect after token expiry/restart conditions;
10. verify the same important capabilities are available across clients.

The initial baseline is Claude. After RC3 freezes, the next clients should be selected for protocol diversity (Google/Gemini if its current client supports remote MCP OAuth, ChatGPT, an IDE client such as Cursor or VS Code/Copilot, and an open-source MCP client) and verified against their current public documentation before testing.
