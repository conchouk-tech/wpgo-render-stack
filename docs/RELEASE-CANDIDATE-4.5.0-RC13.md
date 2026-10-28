# WPGo 4.5.0 RC13

Release date: 28 October 2026

## Purpose
RC13 is a focused Polylang translation-link verification hotfix discovered during the live English↔Spanish rollout on the WPGo site.

## Fixed
- Separate singleton language groups can no longer be merged in memory and mistaken for an already-linked translation group.
- The no-op path now requires every member post to independently report the complete requested translation map.
- `pll_save_post_translations()` is followed by authoritative readback from every requested member.
- Failed persisted relationships now return the specific post ID plus requested and observed mappings.

## Validation
- 138/138 release gates passed.
- 31/31 connection regressions passed.
- Full PHP lint passed.
- Plugin ZIP and release bundle integrity checks passed.

## Deployment
- WordPress plugin: 4.5.0-rc.13
- Fleet Controller: unchanged at 0.13.0

## Live acceptance target
Retry the 17 English↔Spanish WPGo page translation groups. RC13 is accepted only when independent Polylang readback shows each English and Spanish page in the same two-language translation group.
