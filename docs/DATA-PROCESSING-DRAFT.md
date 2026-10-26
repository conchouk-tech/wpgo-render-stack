# WPGo Data Processing Addendum — Draft for Legal Review

**Status:** internal draft only. This document is not legal advice and must be reviewed by qualified counsel before use. Controller/processor identities, jurisdiction, subprocessors, transfer mechanisms, security annex and deletion/return rules must be finalized for the actual production service.

## 1. Parties and scope

This draft applies where a WPGo customer (the **Controller**) uses WPGo to process personal data from or in connection with the customer's WordPress site and WPGo acts as a **Processor** on the Controller's documented instructions.

WPGo's independent controller processing for account administration, billing, security, fraud prevention and legal compliance is governed separately by the Privacy Policy and applicable law.

## 2. Processing instructions

The Controller instructs WPGo to process personal data only as necessary to:

- connect the authorized WordPress site to the customer's selected compatible AI/MCP client;
- execute customer/AI-requested WordPress operations within the customer's authorization and WPGo approval controls;
- provide related connection state, support, security, rendering/audit and update functionality;
- perform other documented instructions agreed through the service.

WPGo will not intentionally process Customer Personal Data for unrelated purposes except where required by applicable law, in which case legally permitted notice should be provided.

## 3. Processing details — draft annex

**Subject matter:** operation of WordPress automation/AI connectivity and related support.

**Duration:** subscription/service term plus the defined deletion/backup retention period.

**Nature:** access, retrieval, transmission, transformation, creation, update, deletion where instructed/approved, troubleshooting and security processing.

**Purposes:** provision and security of the WPGo service under customer instruction.

**Categories of data subjects:** may include customer's staff/users, website users/customers, WooCommerce customers and other individuals whose data is present in the connected WordPress installation, depending on customer use.

**Types of personal data:** may include names, contact details, account/profile information, website content, order/customer data and other personal data the customer chooses to process through authorized WordPress abilities. Customers should avoid instructing WPGo to process special-category/high-risk data unless necessary, lawful and appropriate safeguards are in place.

## 4. Confidentiality

WPGo will ensure personnel authorized to process Customer Personal Data are subject to appropriate confidentiality obligations and access is limited to what is required for their role.

## 5. Security measures

The final security annex should reflect actual production controls. Intended measures include:

- HTTPS/TLS for production endpoints;
- OAuth Authorization Code + PKCE S256;
- site/resource-bound credentials;
- encrypted/sealed OAuth credential payloads;
- managed production secrets;
- approval-gated non-read-only WordPress operations;
- WordPress capability enforcement;
- rate limiting and secure headers;
- public-network/SSRF controls for rendering;
- signed licences/update manifests and package integrity checks;
- dependency vulnerability gates and reproducible builds;
- request/event logging without intentional secret logging;
- production access restrictions;
- backups/recovery for persistent production data;
- incident-response procedures.

The final annex should include organizational access-control, staff/device, backup, change-management and vulnerability-management controls actually implemented at launch.

## 6. Subprocessors

WPGo may use subprocessors necessary to provide the service. Before GA, publish an accurate subprocessor list including purpose, processing location and relevant transfer safeguards.

The final DPA must define the subprocessor-notification/objection mechanism appropriate to the service and applicable law.

Potential categories include cloud hosting/database/key-value providers, payment services, transactional email, monitoring/logging and other service infrastructure. A customer's chosen AI provider is generally selected/controlled by that customer and should be addressed carefully in final controller/processor language.

## 7. International transfers

Where Customer Personal Data is transferred outside the EEA/UK or another protected jurisdiction, WPGo will use legally required transfer mechanisms as applicable. Final mechanisms may include adequacy decisions, EU Standard Contractual Clauses and/or the UK Addendum/IDTA depending on the final operating entity, providers and data regions.

## 8. Data-subject requests

Taking into account the nature of processing, WPGo will provide reasonable assistance to the Controller for applicable data-subject rights requests where Customer Personal Data processed by WPGo is relevant.

The Controller remains responsible for determining whether/how a request should be fulfilled and for communicating with the data subject unless applicable law requires otherwise.

Before GA, operational procedures should support locating/exporting/deleting relevant account, registered-site, support and connection metadata without exposing other customers' data.

## 9. Security incidents / personal-data breaches

WPGo will notify the Controller without undue delay after becoming aware of a confirmed Personal Data Breach affecting Customer Personal Data, subject to final legal wording and applicable law.

Notification should, to the extent reasonably available, include:

- nature of the incident;
- affected data/categories/data subjects;
- likely consequences;
- containment/remediation taken or proposed;
- contact for follow-up.

The final DPA must avoid promising information or timelines that conflict with the applicable legal framework or facts available during an investigation.

## 10. Assistance with compliance

Taking into account the nature of processing and information available, WPGo will provide reasonable assistance with applicable security, breach-notification, DPIA and regulator-consultation obligations where the processing performed by WPGo is relevant.

Commercial terms may define reasonable limits/cost allocation for unusually burdensome assistance where legally permitted.

## 11. Audits and information

WPGo should make available information reasonably necessary to demonstrate compliance with processor obligations. The final DPA should define a proportionate audit mechanism, for example current security documentation/certifications first, followed by remote review and on-site audit only where legally necessary and subject to confidentiality/security protections.

## 12. Return and deletion

At the end of processing, WPGo should delete or return Customer Personal Data as instructed, unless applicable law requires retention.

Final retention/deletion details must distinguish:

- live service data;
- OAuth/connection credentials and telemetry;
- support records;
- billing/accounting records for which WPGo may be an independent controller;
- backups and their expiration cycle;
- security records retained for legal/defence purposes.

## 13. Customer responsibilities

The Controller is responsible for:

- having a lawful basis and required notices for Customer Personal Data;
- selecting appropriate AI providers and configuring them lawfully;
- ensuring instructions to WPGo are lawful;
- granting access only to authorized sites/users;
- reviewing high-impact AI-generated actions and approvals;
- limiting data processed through WPGo to what is appropriate for the intended workflow.

## 14. Conflict / precedence

The final DPA should specify precedence over the general Terms where there is a conflict concerning processing of Customer Personal Data.

## 15. Details required before execution/publication

Complete and legally review:

- Controller/Processor legal names and addresses;
- governing law;
- GDPR/UK GDPR applicability;
- SCC/UK transfer modules where required;
- final security measures annex;
- final subprocessors and regions;
- retention/deletion schedule;
- breach/privacy contacts;
- audit procedure;
- signature/electronic acceptance mechanism.
