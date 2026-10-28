# WPGo 4.5.0 RC9 — Multisite Routing & Write Reliability

RC9 is built from RC8 after live WPGo/Polylang acceptance testing exposed fleet target-binding, plugin REST routing, approval-status, and content-write reliability defects.

## Fixed in this build

### Multisite / fleet routing
- Controller approvals now bind both the exact registered `site_id` and normalized `site_origin`.
- A changed/mismatched target origin fails closed before delegated execution.
- Fleet controller 0.13.0 retains the 0.12.2 registry-envelope fix and refreshes remote WordPress/WPGo version metadata through fleet snapshots.
- Remote approval lookup checks the hub first for controller-owned approvals, then falls back to target-owned approvals.
- Unknown remote sites continue to fail closed; there is no intentional hub fallback.

### Remote plugin operations
- Added guarded `wpgo/plugin-install` Ability so remote `install_plugin` can execute on the selected target through one payload-bound controller approval.
- Delegated plugin install returns `executed_site` evidence and logs the execution site.

### Third-party REST safety / Polylang
- Generic plugin REST writes remain blocked by default.
- Added a route-specific safe allowlist for Polylang language/settings writes only:
  - `/pll/v1/languages`
  - `/pll/v1/languages/<term_id>`
  - `/pll/v1/settings`
- This deliberately does not open arbitrary `pll/v1` or arbitrary third-party plugin REST writes.

### Approval truth / execution state
- Approval status now exposes a normalized execution state (`requested`, `approved_not_executed`, `executed`, `execution_failed`) and a separate verification state.
- Completed background jobs report `executed_not_verified` until an external/live assertion is performed.

### Content and batch write hardening
- `post.update` rejects unknown arguments and requests with no writable fields.
- `post.update` returns `changed`, `no_change`, exact changed fields, and before/after hashes.
- Authorized administrators retain valid HTML such as existing `<style>` blocks instead of forcing `wp_kses_post()` stripping.
- WordPress post saves use `wp_slash()` at the save boundary to preserve escaping/backslashes.
- Exact-content edits return changed/no-change plus before/after hashes.
- Builder/block text saves also use save-boundary slashing.

### Approval-friction reduction
- `cache.purge` and `rewrite.flush` are treated as low-risk finalization operations and can execute without a second approval.
- Jobs containing only those finalization steps are also approval-exempt.

## Still tracked after RC9
- #8: automatic live/front-end verification is improved at the state-model level but is not yet universal for every UI mutation.
- #9: broader conversation/task-scoped consent for all routine reversible writes still needs product-level work; RC9 removes redundant cache/rewrite follow-up approvals.
- #10: markup/no-op/field-validation defects are addressed; automatic CSS visibility/conflict detection remains open.
- #11: master tracker remains open for P1 consistency and regression work.
- #12: multisite release blocker should only be closed after live hub→remote regression tests pass on RC9 + controller 0.13.0.

## Automated validation
- 129/129 PHP/static release gates pass.
- 31/31 existing connection behavioral regressions pass.
- Fleet controller 0.13.0 Python compilation passes.
- New controller static checks pass for exact origin binding, hub-first approval status, remote plugin-install routing, version refresh, and fail-closed site resolution.

## Build artifacts
- `wpgo-4.5.0-rc.9.zip`
  - SHA-256 `20709c97203f121261b7dc21ac5c968dc120273edba59e2d4568617d013e5c90`
- `wpgo-mcp-fleet-controller-0.13.0.zip`
  - SHA-256 `652d546dc641b817eda9ff4474bc47b6af847cc1d9b09a00033c084ab8875c9b`
- `wpgo-4.5.0-rc.9-release-bundle.zip`
  - SHA-256 `76bd6a48e913fd8d975f8e0098c539f4833353573a4a19bf30202060f1e99808`

## Release status

Automated build gates are green. RC9 is **not yet live-verified**. Before #12 is closed or RC9 is described as a verified multisite fix, install the RC9 WordPress plugin on the hub and WPGo test site, deploy controller 0.13.0, and run the live regression checklist — including Polylang remote writes, remote plugin installation, exact approval-status scope, fail-closed unknown target behavior, no-op/markup-preservation checks, and public front-end verification.