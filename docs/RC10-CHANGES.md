# WPGo 4.5.0 RC10 — Approval Target Binding Hotfix

RC10 is built from RC9 after live post-install testing exposed a flaw in the new multisite target-origin binding.

## Fixed

- **Remote approval payloads now seal the canonical target origin before approval creation.** Callers may specify the remote `site_id`; WPGo resolves the registered origin itself and adds `site_origin` to the exact payload that is hashed and approved.
- **Approval replay uses the same canonicalization path.** A replay that omits the implementation-level `site_origin` is normalized to the registered origin before payload comparison, so it matches the approved payload when the registry is unchanged.
- **Origin mismatch still fails closed.** If a caller supplies an origin that does not match the registered site, or if the registered target changes, the operation is rejected rather than redirected.
- **Approval UI/preflight now includes the resolved target origin** alongside the target site ID, making the sealed destination visible in the approval record.
- `site_origin` remains available in the ability schema but is no longer required from external callers; it is an internal safety binding owned by WPGo.

## Carried forward from RC9

- exact multisite target binding and fail-closed routing;
- bounded Polylang REST write allowlist;
- guarded remote plugin installation;
- authoritative approval/execution state;
- write no-op/hash receipts and HTML preservation;
- refreshed fleet version metadata.

## Validation

- 130/130 release gates passed.
- 31/31 connection regression checks passed.
- PHP lint passed for the full plugin tree.
- Plugin and release-bundle ZIP integrity checks passed.

## Controller

Fleet Controller **0.13.0 is unchanged**. The defect was in the WordPress-side approval proxy; no controller restart is required for RC10.

## Live acceptance target

The regression is the WPGo Changelog update that failed on RC9: create a remote `wpgo/controller-run-ability` request with only `site_id`, approve it on the EcoZenia hub, auto-execute it on `wpgo.vivaforte.es`, and verify that the Changelog page changes on WPGo while EcoZenia remains untouched.
