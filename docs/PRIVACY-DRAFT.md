# WPGo Privacy Policy — Draft for Legal Review

**Status:** internal draft only. This document is not legal advice and must be reviewed by qualified counsel before it is published or relied upon. Company identity, registered address, privacy contact, exact subprocessors, retention periods and international-transfer mechanisms must be completed before GA.

## 1. Scope

This draft describes how WPGo is intended to handle personal data when providing customer accounts, WordPress site connections, AI/MCP connectivity, billing, support, licence/update delivery and related service operations.

## 2. Roles

Depending on the processing activity, the WPGo operating entity may act as:

- **controller** for customer-account, billing, support, fraud/security and product-administration data; and
- **processor** for data processed from a customer's connected WordPress site solely to perform customer-instructed operations.

The final policy and Data Processing Addendum must state these roles precisely for the final service design and jurisdiction.

## 3. Data WPGo may process

### Account and commercial data

- email address;
- account identifiers;
- plan/subscription status;
- registered WordPress site URLs/hostnames and labels;
- licence identifiers;
- quota/usage counters;
- support communications;
- billing-provider customer/subscription references.

WPGo should not store full payment-card numbers; payment details are intended to be processed by the payment provider.

### WordPress connection data

- site URL/hostname;
- WordPress user login returned during Application Password authorization;
- WordPress Application Password credential required to operate the authorized connection;
- connected AI client name/reference;
- connection timestamps, last activity, token-refresh timestamps and bounded connection history;
- ability/tool request and approval metadata necessary to perform and troubleshoot actions.

WPGo does not require the customer's normal WordPress password.

### OAuth/MCP data

- OAuth client identifiers/metadata;
- authorization codes/state;
- encrypted/sealed access and refresh credentials;
- resource/site bindings;
- request IDs and security/operational events.

### Support/security logs

Operational logs may include timestamp, service/component, request ID, bounded error text, site hostname, event type and non-secret identifiers. Logs must not intentionally contain plaintext passwords, Application Passwords, access/refresh tokens, private signing keys or payment secrets.

### Rendered-site/audit data

If a customer invokes rendered-site audit/screenshot functionality, WPGo may temporarily process the public page URL, rendered HTML-derived metadata, console errors and optionally a screenshot. The final retention policy should minimize storage and avoid retaining screenshots unless required by the requested workflow.

## 4. Purposes

Data is intended to be processed to:

- provide and secure the WPGo service;
- authenticate customers and connected AI clients;
- connect authorized WordPress sites;
- execute customer-requested WordPress operations;
- require and record approvals for write operations;
- administer plans, licences, quotas and billing;
- deliver verified updates;
- provide customer support;
- prevent abuse/fraud and investigate incidents;
- maintain service reliability and security;
- comply with legal obligations.

## 5. Legal bases — to be reviewed

For controller processing under GDPR/UK GDPR, likely bases may include:

- performance of a contract for account/service delivery;
- legitimate interests for proportionate security, abuse prevention and service reliability;
- legal obligation for records required by tax/accounting/law;
- consent where specifically required for optional processing/communications.

Counsel must confirm the final basis for each processing purpose.

## 6. Service providers / subprocessors

The final public subprocessors list should identify actual production providers and purpose. Expected categories include:

- cloud hosting/database/key-value infrastructure;
- payment processing;
- transactional email;
- logging/monitoring if enabled;
- connected AI client/provider selected by the customer where WPGo sends/receives MCP requests as part of that customer's chosen integration.

Do not publish a provider as a production subprocessor until it is actually used and its contractual/privacy terms are reviewed.

## 7. International transfers

Production region, provider entities and transfer mechanisms must be documented before GA. Where personal data is transferred outside the EEA/UK, appropriate safeguards such as adequacy decisions or Standard Contractual Clauses/UK Addendum should be assessed and documented as applicable.

## 8. Retention — draft principles

Exact periods must be confirmed against production configuration and legal/accounting requirements.

Intended principles:

- short-lived OAuth authorization codes/state: minutes, not days;
- access tokens: short lifetime;
- refresh/connection state: only as long as required for active connection/reliability and an appropriate bounded recovery period;
- connection event history: bounded by count and retention TTL;
- operational logs: time-limited and minimized;
- account/billing records: retained for the service relationship plus legally required accounting/tax periods;
- support tickets: retained for a documented support/defence period, then deleted/anonymized;
- deleted accounts: customer-facing access removed promptly, with defined backup/legal-retention exceptions.

## 9. Security

WPGo is designed to use measures including:

- HTTPS in production;
- encrypted/sealed OAuth credential payloads;
- PKCE S256;
- site/resource binding;
- managed production secrets;
- approval-gated writes;
- capability checks;
- public-network/SSRF protections;
- signed licences/update manifests and package hashes;
- rate limiting;
- dependency/security CI gates;
- request IDs and operational telemetry;
- access restrictions for production infrastructure.

No system can guarantee absolute security. The public policy should not make unqualified security guarantees.

## 10. Customer controls

Customers should be able to:

- disconnect/revoke an AI/WordPress connection;
- remove registered sites where contractually permitted;
- update account information;
- cancel subscriptions;
- request access, correction, deletion or portability as applicable;
- object/restrict processing where applicable;
- contact the privacy team.

The exact UI/API process must be verified before these statements are published.

## 11. WordPress site content

Customers are responsible for ensuring they have authority to connect a WordPress site and instruct WPGo/AI clients to process its content. Customers acting as controllers remain responsible for providing their own end users with legally required notices and instructions where WPGo processes personal data on their behalf.

## 12. AI clients

WPGo is provider-neutral and can connect to compatible AI/MCP clients selected by the customer. Those clients/providers may independently process data under their own terms and privacy policies. WPGo's final customer documentation should clearly distinguish WPGo's processing from a customer's chosen AI provider.

## 13. Data-subject rights

The final privacy process should support, as applicable:

- access;
- rectification;
- erasure;
- restriction;
- portability;
- objection;
- withdrawal of consent;
- complaint to a supervisory authority.

Identity/authority should be verified proportionately before fulfilling requests.

## 14. Security incidents

WPGo maintains an incident-response process. If a personal-data breach requires notification under applicable law or the DPA, the operating entity will follow the legally required controller/processor notification procedure.

## 15. Children

The commercial service should not be marketed as a service for children. Final terms/privacy language and age threshold must be reviewed for the intended markets.

## 16. Changes

Material privacy-policy changes should be dated/versioned and, where legally required, communicated before they take effect.

## 17. Details required before publication

Insert and legally review:

- legal entity/trading name;
- registered/business address;
- privacy email/contact form;
- DPO/representative details if required;
- ICO/AEPD/other registration details if applicable;
- actual subprocessors;
- production data regions;
- exact retention periods;
- international-transfer safeguards;
- cookie/analytics details;
- jurisdiction-specific consumer/privacy rights.
