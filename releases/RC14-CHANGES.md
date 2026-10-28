# WPGo 4.5.0-rc.14

## Quoted HTML batch-write integrity hotfix

RC14 fixes a content-integrity bug found during the live Spanish translation rollout. `post.create` and `post.update` payloads executed through the guarded Ability/job layer were being pre-slashed and then slashed again by the structured WordPress command executor. Quoted HTML attributes could therefore be stored with literal backslashes such as `class=\"wg-page\"`.

### Changes
- Removed Ability-layer pre-slashing for generic `post.create` and `post.update` commands.
- Kept the canonical WordPress save-boundary `wp_slash()` inside the structured command executor, so post content is escaped exactly once before `wp_insert_post()` / `wp_update_post()`.
- Preserved the separate slashing path for the legacy `wpgo/create-categorized-post` integration.
- Added behavioral regressions proving quoted HTML is unchanged by `normalize_write_input()` for direct command writes and batch jobs.
- Added release-gate checks preventing the double-slash path from returning.

### Validation
- 140/140 release gates passed.
- 33/33 connection regressions passed.
- Full PHP lint clean.
- Plugin and release-bundle ZIP integrity clean.
- Plugin SHA-256: `41fc9afafe6e17f94d26ddc67d0855c0a3a07e92acadfdcf7519a2b0344b823e`.
- Fleet Controller 0.13.0 unchanged.

### Live acceptance target
1. Install RC14 on all four WPGo fleet sites.
2. Repair Spanish draft pages 84, 85 and 86 with normal quoted HTML.
3. Verify raw content has no literal backslash-quote sequences.
4. Execute another quoted-HTML batch update and verify content integrity end-to-end before continuing the multilingual rollout.
