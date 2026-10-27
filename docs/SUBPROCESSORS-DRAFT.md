# WPGo Subprocessors — Draft Register

**Status:** pre-GA working document. Verify the actual contracting entity, production region, provider legal entity, transfer terms and live usage before publishing. A provider should not be represented as an active production subprocessor solely because code supports it.

## Intended production service providers

| Provider / category | Intended purpose | Data categories potentially involved | Pre-GA action |
| --- | --- | --- | --- |
| Render / cloud infrastructure | Web services, MCP gateway, database, Key Value/Redis, renderer/control plane hosting | account/site metadata, encrypted connection state, billing/support records, operational logs | Confirm final regions, paid production services, DPA and transfer terms |
| Stripe / payments | Subscription checkout, billing, invoices, payment lifecycle | customer contact/billing identifiers, subscription/customer references; card data handled by Stripe | Confirm merchant entity, live products/prices, privacy/DPA terms |
| Transactional email provider (currently code supports Resend) | Login codes and service email | email address, message metadata/content required for delivery | Confirm final provider/account/domain, DPA, region and retention |
| Customer-selected AI/MCP provider | Receives requests/results as selected and authorized by customer | WordPress content/data involved in the customer's requested AI workflow | Clarify whether provider is independently selected by customer and contractual role in final DPA/privacy text |
| DNS/domain/TLS provider | Public domains and certificate/DNS management | domain/connection metadata, typically limited customer personal data | Identify actual production provider if relevant |
| Monitoring/logging provider, if enabled | Availability/error/security telemetry | request IDs, service metadata, IP/security metadata, bounded error details | Do not add to public list until actually enabled; minimize/define retention |
| Package/CDN/storage provider, if used | Commercial plugin update downloads | licence/download request metadata, IP/network logs at provider | Identify only if external package hosting is selected |

## Change management

Before adding a production subprocessor that processes Customer Personal Data:

1. identify the processing purpose and data types;
2. review security/privacy terms and DPA;
3. determine processing region and international-transfer mechanism;
4. update the internal processing inventory;
5. update the public subprocessor list/notification process where contractually required;
6. ensure application configuration and retention match the documentation.

## Customer-selected AI providers

WPGo is designed to be provider-neutral. The customer chooses which compatible AI/MCP client/provider to connect. Final legal wording should avoid incorrectly presenting every possible AI provider as a WPGo-controlled subprocessor where the provider is independently selected, contracted and instructed by the customer.

The final DPA/privacy review should explicitly determine the roles for:

- AI requests initiated by the customer;
- content sent to/returned by the customer's AI provider;
- any future WPGo-operated AI inference service, if one is ever introduced.

## Required publication fields

For each active published subprocessor include, as appropriate:

- legal/provider name;
- service purpose;
- processing location/region;
- privacy/DPA link;
- transfer safeguard where relevant;
- effective/addition date.
