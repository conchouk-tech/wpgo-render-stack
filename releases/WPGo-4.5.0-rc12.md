# WPGo 4.5.0 RC12

Date: 28 October 2026

## Purpose
RC12 adds guarded Polylang Free content automation so WPGo can assign languages to real posts/pages and link translation groups without manipulating Polylang's internal taxonomy or metadata storage.

## New abilities
- `wpgo/polylang-post-status` — read-only language/translation-group readback.
- `wpgo/polylang-set-post-languages` — approval-gated bulk post/page language assignment using `pll_set_post_language()`.
- `wpgo/polylang-link-post-translations` — approval-gated translation-group linking using `pll_save_post_translations()`.

## Safety
- validates configured language slugs and post existence/capability before writes;
- requires all posts in one translation group to share a post type;
- requires each post to already have the declared language;
- preserves existing translation relationships by default;
- conflicting relinks are refused unless `allow_relink` is explicitly enabled;
- no direct Polylang taxonomy/meta manipulation.

## Validation
- 136/136 RC12 release gates passed;
- 31/31 connection regression checks passed;
- full PHP lint passed;
- ZIP integrity passed.

## Packaging
WPGo plugin SHA-256: `d36cc90986b2530c39ed87c5bef25fd8605bf651d26b60f9997927667dcb4d96`

Fleet Controller remains 0.13.0; no controller restart is required.

## Live acceptance still required
1. Install RC12 across the four connected WPGo sites.
2. Confirm fleet metadata reports RC12.
3. Read Polylang status for an existing English page.
4. Assign existing source pages to English in a guarded bulk operation.
5. Clone one Spanish draft, assign Spanish, link the English/Spanish pair, and independently read back the shared translation group.
6. Verify no unrelated page content changed.
