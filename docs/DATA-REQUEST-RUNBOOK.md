# WPGo Data Request Runbook — Draft

This is an internal operational draft for handling privacy/data-subject requests. It is not legal advice. Identity-verification standards, statutory deadlines, exemptions and controller/processor roles must be reviewed for the final legal entity and jurisdictions.

## Request types

The process should support, where applicable:

- access;
- rectification;
- deletion/erasure;
- restriction;
- portability;
- objection;
- withdrawal of consent;
- processor assistance for a customer's own data-subject request.

## Intake

Record:

- request ID;
- received date/time;
- requester's claimed identity/email;
- request type/scope;
- whether WPGo is acting as controller or processor for the data concerned;
- verification state;
- statutory/customer-contract deadline;
- assigned owner.

Do not collect unnecessary identity documents. Use proportionate verification based on account access and risk.

## Data map for searches

Potential WPGo-controlled records include:

- account/email/profile metadata;
- registered site URLs/labels;
- plan/subscription/customer references;
- usage/quota events;
- login-code metadata;
- support tickets;
- licence identifiers/site bindings;
- Stripe webhook/event references;
- connection telemetry/history;
- operational/security logs where reasonably searchable and relevant.

Connected WordPress site content may be controlled by the WPGo customer rather than WPGo. Where WPGo acts only as processor, route/assist according to the DPA and controller instruction.

## Access/export

1. Verify identity/authority.
2. Determine controller vs processor scope.
3. Query relevant account/site/support/billing/connection records.
4. Exclude other customers' data, internal security secrets, privileged/confidential third-party data and legally exempt material as appropriate.
5. Present export in a commonly readable format.
6. Record completion and what sources were searched.

## Rectification

Correct inaccurate controller-held account/contact metadata through supported application/admin processes. Do not directly edit billing/provider data where the authoritative system should be corrected instead.

## Deletion

Before deletion:

- verify identity/authority;
- check legal/accounting retention requirements;
- distinguish customer-account controller data from customer WordPress data processed on instruction;
- identify active subscriptions/licences/connections;
- revoke active connection credentials where appropriate.

Deletion procedure should cover live account records, registered sites, connection metadata and support data subject to the finalized retention schedule. Backups should age out according to documented backup retention rather than being selectively rewritten unless legally required/feasible.

## Processor assistance

If a WPGo customer asks for help responding to a data-subject request involving their WordPress site:

- confirm the requester is authorized for that customer/site;
- identify the WordPress data/operation relevant to the request;
- do not make independent controller decisions for the customer;
- execute only documented customer instructions and retain an appropriate support/audit record.

## Billing records

Accounting/tax/payment records may need retention even after account deletion. Store the minimum legally required information and separate it from active service entitlement/connection state where practical.

## Security logs

Security logs may be subject to legitimate retention for fraud/security/legal defence. Do not promise automatic deletion of security evidence without legal review. Access requests still require a reasoned search/response process where applicable.

## Completion record

Record:

- verification method/result;
- systems searched;
- data exported/corrected/deleted/restricted;
- retained categories and legal reason;
- response date;
- processor/customer coordination if applicable;
- reviewer/owner.

## Pre-GA requirements

Before publishing a customer rights process:

- confirm privacy contact address/form;
- confirm statutory response workflow for Spain/EU and any additional markets served;
- document database/support/log retention periods;
- build/admin-test account export/deletion procedures;
- test deletion on a disposable account/site;
- align privacy policy, DPA and support documentation with the tested process.
