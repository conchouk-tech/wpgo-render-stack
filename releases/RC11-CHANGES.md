# WPGo 4.5.0 RC11 — Safe REST Batch Hotfix

RC11 is built from RC10 after the live Polylang regression showed that the direct Polylang routes were correctly allowlisted but WordPress's `/batch/v1` wrapper was still blocked.

## Fixed

- **Safe one-approval REST batches.** WPGo now permits `/batch/v1` only after validating every nested request.
- **No blanket batch bypass.** Each nested request must independently pass WPGo's existing safe REST write policy.
- **Write methods only.** Nested requests are restricted to POST, PUT or PATCH.
- **No nested batches.** `/batch/v1` inside another batch is explicitly rejected.
- **No hidden query/header bypass.** Batch items are limited to `method`, `path` and optional object `body`; query-string paths, fragments and extra item fields are rejected.
- **Bounded fan-out.** A generic safe REST batch is limited to 25 nested requests.
- **Validation mode constrained.** Only WordPress `normal` and `require-all-validate` batch validation modes are accepted.

## Carried forward

- RC10 canonical remote target binding and approval replay fix;
- exact multisite fail-closed routing;
- bounded Polylang direct REST routes;
- guarded remote plugin installation;
- approval execution receipts and write hardening.

## Live acceptance target

Use one hub approval to create the six WPGo Polylang languages plus settings via `/batch/v1`, then verify `/pll/v1/languages` and `/pll/v1/settings` directly on `https://wpgo.vivaforte.es/`.
