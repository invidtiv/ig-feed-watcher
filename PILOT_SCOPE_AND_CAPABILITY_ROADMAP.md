# Pilot Scope, Capability Roadmap, and Research Capture Extension

**Project:** IG Feed Watcher pilot

**Status:** Draft for commercial review

**Client:** Innpact

**Provider:** Tiago Santos

**Effective date:** 28/08/2026

This document defines the IG Feed Watcher pilot and identifies capabilities that may be commissioned separately in the future.

Only the work expressly listed in Part I is included in the pilot. Parts II and III are separate options for discussion and do not create a delivery commitment, entitlement, or obligation.

---

## Part I — Pilot Scope of Work and Commercial Terms

### 1. Purpose and deployment boundary

The pilot provides one operational deployment configured exclusively for:

- one designated user;
- one designated workstation; and
- one agreed single-account workflow.

The pilot is intended to validate a focused local workflow. It is not a multi-user, multi-account, regional, or centrally hosted deployment.

### 2. Included deliverables

The pilot includes:

1. Installation and initial environment configuration on the designated workstation.
2. The core workflow established during the original $150 technical spike.
3. A concise operating guide covering the end-user workflow and basic operations.
4. An initial post-installation support and verification window of **7 days** to confirm operational stability.

The original $150 spike is referenced only as the technical baseline. It is the price of this pilot.

### 3. Acceptance and verification

Delivery is accepted when the following checks succeed on the designated workstation:

- the agreed single-account workflow starts and operates in the configured environment;
- the operating guide has been provided.

Issues reported during the support window are covered only when they prevent the included workflow from operating as specified.

New features, changed requirements, third-party platform changes, and work outside the configured environment are not defect corrections and require separate scoping.

### 4. Explicit exclusions

The pilot does not include:

- source-code delivery, repository access, intellectual-property assignment, or IP transfer;
- use on additional workstations or by additional users;
- multi-account or regional operation;
- API posting, messaging, or agent-controlled write actions;
- central Supabase integration, remote synchronization, or distributed staff access;
- the Research Capture Extension described in Part III;
- enhanced retention policies or automated compliance lifecycles;
- automated crawling, simulated interactions, or platform-control bypasses;
- ongoing support beyond the agreed support window; or
- capabilities or feature requests discussed in brainstorming but not expressly included in this document.

### 5. Commercial boundary

Payment covers only the pilot deployment described in Part I. The pilot fee, payment schedule, and applicable taxes must be recorded separately in writing before delivery.

Any enhancement, additional seat, backend integration, platform expansion, or structural modification requires a separate written scope, price, and delivery agreement.

No roadmap item is included by implication, prior discussion, demonstration, or technical feasibility.

### 6. Licence grant and permitted use

Subject to payment and compliance with this agreement, the client receives a non-exclusive, non-transferable, revocable licence to run the pilot software locally on the designated workstation.

The licence is limited to the designated user, workstation, and workflow. It does not permit sublicensing, redistribution, copying for other deployments, or making the software available to third parties.

### 7. Duration

The licence has an indefinite operational term for local execution on the authorized workstation, subject to the licence conditions and any termination or revocation terms in the final signed agreement.

Replacement hardware, workstation migration, account changes, or material environment changes may require separately scoped installation or support.

### 8. Dependencies and client responsibilities

The client is responsible for:

- providing access to the designated workstation and supported Chromium browser profile;
- maintaining lawful access to relevant third-party accounts and content;
- using the workflow in accordance with applicable platform terms, law, and internal policy;
- protecting workstation credentials, browser sessions, and locally stored data; and
- promptly reporting operational issues during the support window.

Third-party websites, browser behavior, platform interfaces, and account restrictions are outside the provider's control. Material changes to them may require separately scoped remediation.

---

## Part II — Capability Roadmap and Separately Scoped Options

The following capabilities are possible future work. Each option requires technical validation and a separate written agreement covering scope, price, schedule, dependencies, and acceptance criteria.

The sequence below reflects a practical progression from distributed collection to governed automation. It is not a guaranteed delivery order.

### 1. Multi-account and regional operation

Operate several Instagram accounts through isolated browser profiles and, where appropriate, machines located in the relevant country or region.

Potential scope:

- one isolated browser session and profile per account;
- explicit account-to-machine assignment;
- regional collectors for accounts that must remain in a specific region;
- central visibility of collected metadata without sharing cookies or credentials; and
- per-account status, error reporting, and retention settings.

This model does not mean that one machine logs into every account from every location.

### 2. Retention and evidence controls

Preserve useful intelligence without turning the system into an unrestricted image archive.

Potential scope:

- long-term metadata retention for source links, text, dates, tags, accounts, groups, regions, and opportunity classifications;
- configurable deletion rules for older raw records;
- thumbnails or original images retained only for selected groups, flagged items, or short review periods; and
- an audit trail recording what was retained and the applicable reason or policy.

The intended outcome is a searchable intelligence database, not a complete copy of Instagram.

### 3. Controlled AI workspace

Allow a local AI assistant to help manage research while keeping sensitive capabilities governed.

Potential scope:

- create and maintain research groups;
- add tracked accounts, watchlists, keywords, locations, and topic definitions;
- suggest classifications, summaries, duplicate matches, and relevant opportunities;
- prepare proposed posts or API actions for human review; and
- keep direct write or post actions disabled until they are expressly enabled and approved.

The intended role is a controlled research assistant, not an unrestricted administrator.

### 4. Approval-based API actions

Require explicit human approval before posting or carrying out another sensitive API action.

Potential scope:

- the AI proposes a named action with a reason and defined scope;
- an authorized person approves or denies it through the local dashboard or a dedicated Telegram approvals group;
- approval creates a short-lived permission limited by action, account, and time;
- every request, decision, attempted action, and result is logged; and
- a global environment setting acts as an emergency off switch.

The approval framework may be implemented before customer-facing write actions are enabled.

### 5. Central Supabase integration and local synchronization

Create a shared intelligence store while preserving the project owner's private local working environment.

Potential scope:

- authenticated regional collectors upload structured metadata to Supabase;
- staff-submitted research enters the same central system;
- Supabase acts as the shared source of truth;
- the owner's local database pulls only new or changed records incrementally; and
- the local AI analyzes a private local copy without exposing the workstation publicly.

The recommended initial synchronization direction is one-way from Supabase to the local database. This reduces conflict risk before any bidirectional workflow is considered.

### 6. Roadmap status and change control

Parts II and III record possible future work only. These options are not included in the pilot fee, licensed for use, scheduled for delivery, or guaranteed to be technically or commercially available.

A future option becomes committed work only when both parties approve a separate written scope that defines:

- deliverables and exclusions;
- commercial terms and payment schedule;
- delivery milestones;
- technical and third-party dependencies;
- security and approval boundaries;
- acceptance criteria; and
- support and maintenance terms.

Until then, the pilot remains limited to the single-user, single-workstation, single-account deployment defined in Part I.

---

## Part III — Separate Project Option: Research Capture Extension

### 1. Project status and purpose

The Research Capture Extension is a distinct project option. It is not part of the IG Feed Watcher pilot and requires its own scope, price, schedule, technical design, and acceptance process.

The proposed extension gives staff a deliberate way to save selected LinkedIn posts to Supabase while they browse normally.

It is a human-guided capture tool, not an automated collector and not a replacement for the Instagram watcher.

### 2. User workflow

1. An authorized staff member browses LinkedIn normally.
2. The staff member chooses a specific post and selects **Save to Research**.
3. The extension extracts the supported details visible for that selected post.
4. The staff member reviews the capture and may add notes or classifications.
5. The extension submits the approved record to Supabase through an authenticated, controlled connection.
6. The system records who submitted the item and when.

### 3. Proposed functional capabilities

#### 3.1 Human-selected post capture

The extension captures one post only after an explicit user action. Supported data may include:

- visible post text;
- post URL;
- visible author and profile details;
- visible company or organization context;
- visible publication date or time;
- optional staff notes; and
- selected tags or classifications.

Capture is limited to information visible to the authorized user and available in the current page structure. It does not provide access to hidden, restricted, or unavailable fields.

#### 3.2 Review before submission

The staff member can review the extracted record before upload and add approved tags such as region, company, topic, research group, or opportunity type.

No record is submitted solely because a page was viewed.

#### 3.3 Authenticated Supabase submission

Approved records are uploaded to a controlled Supabase project using company authentication and defined authorization rules.

The submission record is attributed to the staff member who saved it and includes the source URL and submission time.

#### 3.4 Submission history

Authorized users may view a history of their submitted items, subject to the access rules defined for the separate project.

### 4. Technical boundaries

| Attribute                  | Proposed specification                                                 |
| -------------------------- | ---------------------------------------------------------------------- |
| Runtime environment        | Supported Chromium-based browser                                       |
| Activation                 | Explicit user action on one selected post                              |
| Data source                | Information visible in the selected post's page DOM                    |
| Data flow                  | LinkedIn page DOM → user review → authenticated Supabase submission    |
| LinkedIn write permissions | None; no messaging, posting, reacting, or account changes              |
| External destination       | The designated company Supabase project only                           |
| Automation                 | No background crawling, bulk extraction, or simulated user interaction |
| Attribution                | Each submission is tied to the authenticated staff member              |

### 5. Explicit exclusions

Unless separately agreed, the extension does not include:

- automated or background collection;
- bulk profile or post extraction;
- rate-limit, access-control, or platform-restriction bypassing;
- messaging, posting, reacting, following, or other LinkedIn write actions;
- collection of information not visible to the authorized user;
- general web browsing telemetry; or
- integration with destinations other than the designated Supabase project.

### 6. Proposed acceptance criteria

The separate project may be accepted when:

- an authenticated staff member can deliberately select one supported LinkedIn post;
- the supported visible fields appear in a review step;
- the user can add agreed notes and classifications;
- confirmation submits one record to the designated Supabase project;
- the stored record includes its source URL, submitter, and submission time; and
- viewing a post without selecting **Save to Research** sends no research record.

Changes to LinkedIn's page structure, browser extension policies, or Supabase requirements may affect the final technical design and maintenance scope.

---

## Sign-off

| Party    | Name | Signature | Date |
| -------- | ---- | --------- | ---- |
| Client   |      |           |      |
| Provider |      |           |      |

> **Drafting note:** This document is a commercial and functional draft. The parties should review the licence, revocation, liability, privacy, platform-compliance, and governing-law terms before signature.
