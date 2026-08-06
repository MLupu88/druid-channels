# DRUID Partner Radar Lite
## Replit Mockup, Integration and Fluent 2 UX Specification

**Purpose:** Build a simple, usable partner lead-generation and visibility layer for the Head of Channels and regional PAMs—without creating another heavy channel-management platform.

**Primary users**

| User | Territory / role |
|---|---|
| Irina Dochitu | Global Head of Channels |
| James Bradley | UK & Ireland |
| Denny Morais | Portugal, Canada and South America |
| Elena Panait | Central and Eastern Europe |
| Vlad Greavu | DACH |
| Chase Baylor | United States |

---

# 1. Executive intent

DRUID needs fewer low-value partner names and more **enterprise-capable partner prospects with a credible reason to engage now**.

The system should help the team find organizations that:

- Already sell into enterprise accounts.
- Have a relevant AI, automation, contact-center, cloud, managed-service or vertical-industry focus.
- Are visibly open to alliances, technology partnerships, OEM relationships, marketplace relationships or co-selling.
- Have a recent trigger that makes outreach timely.
- Can introduce DRUID into customers able to support DRUID's higher-value commercial model.

The system must remain lightweight because the PAM is the salesperson. It should help the PAM identify, understand and approach a prospective partner. It should not create a separate project lifecycle, presales allocation process or delivery-management workflow.

---

# 2. What is being built

## Product name

**Partner Radar Lite**

## One-sentence description

A lightweight Replit application that scans selected public sources for high-value partner signals, turns those signals into evidence-backed partner prospect cards, lets the regional PAM accept or reject them, and sends accepted prospects to HubSpot.

## What the first useful version does

1. Runs a targeted search for partner signals by territory.
2. Finds companies with enterprise access and a relevant AI or transformation focus.
3. Extracts evidence from public pages.
4. Removes duplicates.
5. Applies a simple, explainable qualification check.
6. Produces a short prospect card with:
   - Why the company fits.
   - Why now.
   - Evidence links.
   - Suggested outreach angle.
7. Assigns the prospect to the correct PAM.
8. Allows the PAM to accept, reject or defer the prospect.
9. Pushes accepted prospects to HubSpot.
10. Feeds the **New Partner Prospects** number in Irina's existing table.

---

# 3. What is deliberately not being built

The first version should not include:

- A new CRM.
- A partner portal.
- A full partner lifecycle application.
- Opportunity or delivery-project management.
- Presales or implementation-resource assignment.
- Automated mass LinkedIn outreach.
- Automated email sequences.
- A black-box AI score.
- Ten enrichment providers.
- Complex permissions.
- A data warehouse.
- A second executive dashboard.
- A full marketing-automation replacement.
- Scraping of hundreds of thousands of companies.
- Autonomous partner qualification without human review.

The first release succeeds only when it consistently gives each PAM a small number of partner prospects they would genuinely contact.

---

# 4. Commercial targeting logic

DRUID's current commercial direction favors higher-value opportunities. The partner radar should therefore avoid small agencies that can only introduce isolated chatbot projects.

## Priority partner profile

A qualified partner prospect should normally demonstrate at least three of the following:

1. **Enterprise customer access**
   - Public enterprise customer references.
   - Work with banks, insurers, healthcare groups, universities, large retailers, telecom operators or public-sector organizations.
   - Multi-country or regulated-industry engagements.

2. **Relevant capability**
   - Enterprise AI.
   - Generative AI or agentic AI.
   - Contact-center transformation.
   - Intelligent automation.
   - Cloud transformation.
   - Managed services.
   - CRM, ERP or workflow integration.
   - Vertical-industry transformation.

3. **Technology adjacency**
   - Microsoft.
   - AWS.
   - Google Cloud.
   - UiPath.
   - ServiceNow.
   - Genesys.
   - NiCE.
   - Cisco.
   - Amazon Connect.
   - Salesforce.
   - SAP.
   - Oracle.
   - NVIDIA.

4. **Partnership openness**
   - Technology partner program.
   - Alliance ecosystem.
   - ISV program.
   - OEM or embedded-technology program.
   - Marketplace program.
   - Co-sell program.
   - Public partner application.
   - Active alliance recruitment.

5. **A recent trigger**
   - Launched an AI practice.
   - Appointed an AI or alliances leader.
   - Acquired an AI or automation firm.
   - Announced a major enterprise AI customer win.
   - Opened an innovation center.
   - Added multiple AI or contact-center roles.
   - Won a relevant public contract.
   - Sponsored or spoke at a relevant enterprise event.
   - Announced a new platform alliance.

## Recommended target archetypes

### Enterprise contact-center integrators

Typical adjacencies:

- Genesys
- NiCE
- Cisco
- Amazon Connect
- Five9
- Avaya

DRUID angle:

> Add an enterprise AI-agent and process-completion layer to existing contact-center transformation programs.

### Automation and workflow specialists

Typical adjacencies:

- UiPath
- ServiceNow
- Microsoft Power Platform
- Salesforce
- SAP
- Oracle

DRUID angle:

> Give customers and employees a conversational way to access and orchestrate workflows and enterprise applications.

### AI and data consultancies

Signals:

- New GenAI practice.
- Agentic AI offering.
- AI Center of Excellence.
- AI acquisition.
- Enterprise AI advisory capability.

DRUID angle:

> Move from AI advisory and prototypes to production-grade enterprise AI agents.

### BPOs and managed-service providers

Relevant services:

- Contact-center operations.
- Customer service.
- Employee support.
- Finance operations.
- Healthcare administration.
- Banking operations.

DRUID angle:

> Package AI agents inside a recurring managed-service proposition.

### Telcos and enterprise MSPs

DRUID angle:

> Combine DRUID with cloud, communications, integration and managed services for enterprise customers.

### Vertical specialists

Priority industries:

- Banking.
- Insurance.
- Healthcare.
- Higher education.
- Retail.

DRUID angle:

> Combine DRUID's platform and pre-built AI-agent starting points with the partner's domain expertise and customer access.

---

# 4A. Canonical Head of Channels view — non-negotiable

The following three tables are the primary product requirement and the canonical home-page view. Their metric names and base column structure must be preserved. Partner Radar, HubSpot, campaign workflows and all integrations exist to populate and explain these tables—not to replace them with another dashboard.

## Table 1: Overall channel KPIs

| KPI | Current | Target | Status |
|---|---:|---:|---|
| New Partner Prospects | | | |
| Signed Partners | | | |
| Active Onboarding | | | |
| Certified Partners | | | |
| Partner-Sourced Pipeline | | | |
| Partner-Influenced Pipeline | | | |
| Closed Revenue | | | |
| Renewals | | | |

## Table 2: Weekly commercial performance

| Metric | Current | Last Week | Target | Trend |
|---|---:|---:|---:|---|
| Partner-Sourced Pipeline | | | | |
| Opportunities Created | | | | |
| Closed Revenue | | | | |
| Renewals Due | | | | |
| Renewals Closed | | | | |

## Table 3: Weekly channel marketing activity

| Metric | This Week | Trend |
|---|---:|---|
| Joint Campaigns | | |
| Events | | |
| Webinars | | |
| Marketing Qualified Leads | | |
| Partner Referrals | | |

## Design rule

- These three tables appear first on the Overview page.
- Do not replace them with large KPI cards, charts or a generic dashboard.
- Keep the base columns above visible.
- Additional explanation such as “what changed,” regional contribution, supporting records and required action belongs in a Fluent side panel opened from the selected row.
- The Head of Channels must be able to understand the current position without navigating away from this page.
- Supporting workflows may add data and context but may not introduce extra mandatory fields into the executive table view.

---

# 5. Core user experience

The Replit mockup should have only four core screens.

## Screen 1: Head of Channels View

This preserves Irina's existing table-based view.

### Table A: Partner development

- New Partner Prospects
- Signed Partners
- Active Onboarding
- Certified Partners
- Partner-Sourced Pipeline
- Partner-Influenced Pipeline
- Closed Revenue
- Renewals

### Table B: Commercial performance

- Partner-Sourced Pipeline
- Opportunities Created
- Closed Revenue
- Renewals Due
- Renewals Closed

### Table C: Channel marketing activity

- Joint Campaigns
- Events
- Webinars
- Marketing Qualified Leads
- Partner Referrals

### What changes

The tables remain visually simple. Partner Radar Lite only adds lightweight context:

- Current value.
- Target.
- Status.
- A one-line explanation of the movement.
- Optional click-through to the evidence behind a number.

Example:

> **New Partner Prospects: 12**  
> Four added this week: two AI-practice launches, one open technology-partner program and one contact-center integrator with banking customers.

Irina should not need to see crawling jobs, API logs or scoring logic.

---

## Screen 2: Weekly Prospect Review

This is the PAM's main working screen.

### Filters

- Territory.
- PAM.
- Priority A / B.
- Partner type.
- Signal type.
- Status.
- Date discovered.

### Prospect card

Each card should show:

| Field | Example |
|---|---|
| Company | Example Systems Integrator |
| Territory | DACH |
| PAM | Vlad |
| Partner type | Contact-center integrator |
| Priority | A |
| Why it fits | Enterprise Genesys partner with banking and insurance references |
| Why now | Launched a GenAI customer-service practice last month |
| Partnership evidence | Public technology-alliance program |
| Suggested angle | Add production-grade AI agents to the firm's Genesys transformation portfolio |
| Evidence | Three public links |
| Status | New |

### Actions

- **Accept**
- **Reject**
- **Defer**
- **Open evidence**
- **Copy suggested message**
- **Push to HubSpot** after acceptance

### Rejection reasons

Use a small fixed list:

- Too small.
- No enterprise evidence.
- Capability not relevant.
- No real partnership route.
- Duplicate.
- Existing relationship.
- Wrong territory.
- Weak or outdated evidence.
- Other.

This improves the search rules without creating a complex machine-learning project.

---

## Screen 3: Prospect Detail

The prospect detail page should contain only what helps the PAM decide and act.

### Section A: Company summary

- Company name.
- Website.
- Headquarters.
- Estimated size band.
- Territory.
- Partner archetype.
- Relevant technologies.
- Relevant industries.

### Section B: Evidence

For every signal:

- Evidence type.
- Short extracted statement.
- Source URL.
- Publication or page date where available.
- Confidence: high, medium or low.

### Section C: Qualification

Five visible yes/no checks:

1. Enterprise customer access.
2. Relevant AI, automation, CX or managed-service capability.
3. Relevant technology adjacency.
4. Open to partnerships or alliances.
5. Recent reason to engage.

### Section D: PAM action

- Suggested target role.
- Suggested opening message.
- Accept / reject / defer.
- Add note.
- Push to HubSpot.

---

## Screen 4: Scan Configuration

This is an admin screen, not an engineering console.

### Settings

- Territory.
- Countries.
- Search language.
- Priority industries.
- Priority partner types.
- Technology keywords.
- Signal keywords.
- Excluded companies.
- Excluded domains.
- Maximum results per weekly scan.
- Minimum qualification threshold.

Each regional scan should be configurable without changing code.

---

# 6. Lead-generation sources

The radar should use a controlled source list, not unrestricted internet crawling.

## Source group 1: Company websites

Pages to inspect:

- Partner pages.
- Alliance pages.
- Technology pages.
- AI practice pages.
- Industry pages.
- Customer stories.
- Newsroom.
- Careers.
- Events.
- Leadership pages.

What this provides:

- Partnership openness.
- AI focus.
- Customer access.
- Technology adjacency.
- Target contacts.
- Current business priorities.

---

## Source group 2: Search and news

Search patterns:

```text
"launched an AI practice" + country
"launched a generative AI practice" + country
"agentic AI practice" + country
"AI center of excellence" + systems integrator
"technology partner program" + AI consultancy
"become a technology partner" + managed services
"strategic alliances" + contact center integrator
"AI managed services" + enterprise
"appointed head of AI" + consultancy
"appointed head of alliances" + technology services
"acquired AI consultancy" + region
"contact center transformation" + partner + bank
"Genesys partner" + banking
"UiPath partner" + insurance
"ServiceNow partner" + healthcare
```

The search provider finds candidate pages. The page-extraction service reads the page and produces structured evidence.

---

## Source group 3: Partner ecosystems

Possible ecosystems to check through public directories, licensed datasets or manual imports:

- Microsoft partner ecosystem.
- AWS Partner Network.
- Google Cloud partners.
- UiPath partners.
- ServiceNow partners.
- Genesys partners.
- NiCE partners.
- Cisco partners.
- Salesforce partners.
- SAP partners.
- NVIDIA partners.

The mockup does not need live integration with all of these. It can begin with:

- CSV uploads.
- Curated seed lists.
- Search queries that identify ecosystem participation.
- Public profile URLs.

---

## Source group 4: Job postings

Signals to look for:

- Generative AI architect.
- Agentic AI lead.
- Conversational AI consultant.
- Contact-center architect.
- AI practice director.
- Alliance director.
- Partner manager.
- Managed AI services lead.
- Automation practice lead.

Rules:

- One vacancy is weak evidence.
- Multiple related roles within a recent period are a stronger investment signal.
- Job data should support a recommendation, not qualify a prospect by itself.

---

## Source group 5: Events

Sources:

- Sponsor pages.
- Speaker pages.
- Exhibitor lists.
- Award lists.
- Agenda pages.

Relevant events:

- Enterprise AI.
- Contact center.
- Microsoft, AWS and Google ecosystem events.
- UiPath and ServiceNow events.
- Banking technology.
- Healthcare technology.
- Insurance technology.
- Retail technology.

Example signal:

> Company sponsored a contact-center AI event and presented a banking transformation case study.

---

## Source group 6: Public tenders and contract awards

Look for suppliers, bidders and consortium members involved in:

- AI assistants.
- Contact-center modernization.
- Customer-service automation.
- Employee-service automation.
- Voice automation.
- Digital front doors.
- Intelligent workflow programs.
- Multilingual virtual assistants.
- Hybrid or on-premise AI.

The lead is usually the supplier or consortium member, not the contracting authority.

This source can be added later because tender coverage differs by country and often requires specialized sources.

---

# 7. Integration architecture

## Phase 0: Replit mockup

The mockup should not depend on production APIs.

```text
Seed JSON / CSV
      ↓
Replit database
      ↓
Mock scan button
      ↓
Prospect review cards
      ↓
Accept / reject / defer
      ↓
Mock HubSpot push
      ↓
Head of Channels tables
```

### Mocked integrations

| Integration | Mockup behavior |
|---|---|
| Search provider | Load prebuilt result JSON |
| Web extraction | Load saved page excerpts |
| AI qualification | Use deterministic sample outputs or one model call |
| HubSpot | Display “Ready to push” and save a mock CRM ID |
| Teams/email | Show a preview of the weekly digest |
| Scheduled run | Manual “Run weekly scan” button |

This allows the workflow and value to be validated before investing in production integration.

---

## Phase 1: First real working version

```text
Search API
   ↓
Public result URLs
   ↓
Page extraction API
   ↓
Rule-based parsing + one LLM call
   ↓
Deduplication
   ↓
Replit PostgreSQL
   ↓
PAM review
   ↓
HubSpot API
```

### Minimum live integrations

1. **One search provider**
2. **One web extraction provider**
3. **One LLM provider**
4. **HubSpot**
5. Optional Teams or email digest

No other production integration is required initially.

---

# 8. Recommended integration options

## 8.1 Search provider

Choose one.

### Option A: Tavily

Use for:

- Search queries.
- Relevant result discovery.
- Basic extracted content.

Advantages:

- Fast to prototype.
- Search and content retrieval can be combined.
- Useful for focused web research.

### Option B: Bing Web Search

Use for:

- Broad web and news discovery.
- Region- and language-specific search.
- Stable search results.

Advantages:

- Strong geographic coverage.
- Works well for standard search-query patterns.

### Option C: SerpAPI

Use for:

- Search-engine result retrieval.
- Google-style queries.
- News and other search verticals.

Advantages:

- Flexible search coverage.
- Easy to prototype.

### Recommendation

For the Replit proof of concept, use **Tavily or Bing**. Do not integrate multiple search providers until search quality is tested.

---

## 8.2 Web extraction

Choose one.

### Option A: Firecrawl

Use for:

- Extracting readable page text.
- Crawling a small number of related pages on a company website.
- Returning Markdown or structured content.

### Option B: Apify

Use for:

- Specific site actors.
- Repeatable crawling jobs.
- Job boards, event pages or directories where an actor already exists.

### Option C: Browserless

Use for:

- JavaScript-heavy pages.
- Controlled browser rendering.
- Pages that basic HTTP extraction cannot read.

### Recommendation

Start with **Firecrawl** for ordinary company pages. Add Apify only when there is a specific source that Firecrawl cannot cover well.

---

## 8.3 LLM

The LLM should not invent companies or evidence. It should only structure and summarize collected evidence.

### Required tasks

- Classify partner archetype.
- Identify the recent trigger.
- Summarize enterprise evidence.
- Summarize partnership openness.
- Produce a concise DRUID-fit explanation.
- Draft a short opening message.
- Apply the five qualification checks.

### Output schema

```json
{
  "company_name": "Example Integrator",
  "partner_type": "contact_center_integrator",
  "enterprise_access": true,
  "relevant_capability": true,
  "technology_adjacency": true,
  "partnership_openness": true,
  "recent_trigger": true,
  "priority": "A",
  "why_it_fits": "Enterprise Genesys integrator with banking and insurance customers.",
  "why_now": "Launched a GenAI customer-service practice in July 2026.",
  "suggested_angle": "Position DRUID as the AI-agent layer for its contact-center transformation portfolio.",
  "suggested_target_role": "VP Alliances or Head of AI",
  "suggested_message": "..."
}
```

### Guardrails

- Every claim must reference at least one evidence URL.
- Unknown data remains unknown.
- No company-size claim without a source or enrichment field.
- No automatic acceptance.
- Human review remains mandatory.

---

## 8.4 HubSpot

HubSpot should remain the commercial system of record.

The pricing enablement states that new quotes must be generated in HubSpot. Partner Radar Lite should therefore create accepted prospects in the same environment rather than creating a parallel CRM.

### Objects to use

#### Company

Required or recommended properties:

| Property | Example |
|---|---|
| Company name | Example Integrator |
| Website | example.com |
| Country | Germany |
| Territory | DACH |
| PAM owner | Vlad |
| Partner type | Contact-center integrator |
| Partner prospect status | Accepted |
| Partner radar priority | A |
| Partner radar discovered date | 2026-08-06 |
| Partner radar why fit | Enterprise Genesys partner |
| Partner radar why now | New GenAI practice |
| Partner radar source | Partner Radar Lite |
| Partner radar evidence URLs | URL list |
| Partner radar record ID | PR-000123 |

#### Contact

Contact creation should be optional in the first release.

Only create a contact when:

- A suitable public business contact is available.
- The PAM confirms the role is relevant.
- Contact sourcing complies with internal privacy and outreach policy.

Suggested roles:

- Head of Alliances.
- VP Partnerships.
- Head of AI.
- AI Practice Lead.
- Contact Center Practice Lead.
- Managing Director.
- Head of Managed Services.
- Business Development Director.

#### Activity or note

Create a HubSpot note containing:

- Why it fits.
- Why now.
- Evidence links.
- Suggested opening angle.
- Date accepted.
- PAM notes.

### HubSpot workflow

```text
PAM accepts prospect
      ↓
Check for existing company by domain
      ↓
If found: append note and update properties
      ↓
If not found: create company
      ↓
Assign HubSpot owner
      ↓
Write HubSpot ID back to Partner Radar Lite
```

### Deduplication key

Primary key:

- Normalized company domain.

Fallback:

- Normalized company name + country.

Never create a new HubSpot company based only on a display name without a domain check.

---

## 8.5 Teams or email

Optional but useful.

### Weekly PAM digest

Each PAM receives:

- Number of new prospects.
- Priority-A prospects.
- Deferred prospects requiring review.
- Accepted prospects not yet contacted.
- Top three “why now” triggers.

### Irina's weekly summary

Irina receives:

- New prospects accepted by territory.
- Top signal categories.
- Prospects awaiting PAM review.
- Rejection reasons.
- New Partner Prospects current versus target.
- Two or three notable prospects.

Do not send real-time alerts for every result. A weekly digest is enough.

---

## 8.6 LinkedIn and contact data

Do not build direct LinkedIn scraping into the first version.

### Safe initial approach

- Link to the company LinkedIn page.
- Link to a Sales Navigator search.
- Allow manual entry of the selected contact.
- Optionally import an approved CSV from an existing prospecting provider.

### Later option

Connect an approved contact-data provider only after company-level lead quality is proven.

Potential providers:

- Cognism.
- Apollo.
- People Data Labs.
- Crunchbase or Dealroom for company data.
- BuiltWith or Wappalyzer for technology data.

This is optional and should not block the first release.

---

# 9. Data model

## Table: users

| Field | Type |
|---|---|
| id | UUID |
| name | text |
| email | text |
| role | head_of_channels / pam / admin |
| territory | text |
| active | boolean |

## Table: territories

| Field | Type |
|---|---|
| id | UUID |
| name | text |
| owner_user_id | UUID |
| countries | JSON array |
| languages | JSON array |

## Table: scan_configs

| Field | Type |
|---|---|
| id | UUID |
| territory_id | UUID |
| name | text |
| search_queries | JSON array |
| partner_types | JSON array |
| industries | JSON array |
| technologies | JSON array |
| excluded_domains | JSON array |
| max_results | integer |
| active | boolean |

## Table: scan_runs

| Field | Type |
|---|---|
| id | UUID |
| scan_config_id | UUID |
| started_at | timestamp |
| completed_at | timestamp |
| status | queued / running / completed / failed |
| results_found | integer |
| results_qualified | integer |
| error_message | text |

## Table: companies

| Field | Type |
|---|---|
| id | UUID |
| name | text |
| normalized_name | text |
| domain | text |
| website_url | text |
| country | text |
| headquarters | text |
| employee_band | text |
| description | text |
| linkedin_url | text |
| hubspot_company_id | text |
| created_at | timestamp |
| updated_at | timestamp |

## Table: signals

| Field | Type |
|---|---|
| id | UUID |
| company_id | UUID |
| signal_type | partnership / ai_investment / enterprise_access / technology / hiring / event / tender |
| title | text |
| summary | text |
| source_url | text |
| source_domain | text |
| published_at | date |
| discovered_at | timestamp |
| confidence | high / medium / low |
| raw_excerpt | text |

## Table: prospects

| Field | Type |
|---|---|
| id | UUID |
| company_id | UUID |
| territory_id | UUID |
| assigned_user_id | UUID |
| partner_type | text |
| priority | A / B |
| enterprise_access | boolean |
| relevant_capability | boolean |
| technology_adjacency | boolean |
| partnership_openness | boolean |
| recent_trigger | boolean |
| why_it_fits | text |
| why_now | text |
| suggested_angle | text |
| suggested_target_role | text |
| suggested_message | text |
| status | new / accepted / rejected / deferred / pushed_to_hubspot |
| rejection_reason | text |
| pam_note | text |
| accepted_at | timestamp |
| hubspot_company_id | text |
| created_at | timestamp |
| updated_at | timestamp |

## Table: kpi_snapshots

Used only to populate Irina's tables.

| Field | Type |
|---|---|
| id | UUID |
| period_start | date |
| period_end | date |
| territory_id | UUID nullable |
| metric_name | text |
| current_value | decimal |
| target_value | decimal |
| status | green / amber / red |
| explanation | text |

---

# 10. Qualification logic

Avoid a weighted 100-point model initially.

## Five checks

```text
enterprise_access
relevant_capability
technology_adjacency
partnership_openness
recent_trigger
```

## Priority rules

### Priority A

- Four or five checks are true.
- At least one evidence item confirms enterprise access.
- At least one evidence item confirms relevant capability.
- At least one evidence item provides either partnership openness or a recent trigger.

### Priority B

- Three checks are true.
- Enterprise access and relevant capability must both be true.
- Evidence is credible but the timing or partnership route is weaker.

### Reject before PAM review

- No enterprise-access evidence.
- No relevant capability.
- Company is clearly too small for the intended market.
- Duplicate.
- Existing DRUID partner or active prospect.
- Evidence is stale or unreliable.
- Company operates outside the configured territory with no relevant presence.

The system should still let an admin review auto-rejected results during testing.

---

# 11. Signal-to-outreach playbook

The system should turn a signal into a practical PAM opening angle.

| Signal | Suggested PAM angle |
|---|---|
| New GenAI practice | Use DRUID to move from AI advisory into repeatable production AI-agent deployments |
| New contact-center AI offer | Add enterprise AI agents and process completion around the contact-center platform |
| New UiPath or ServiceNow partnership | Add a conversational interface and agent layer to automation and workflow programs |
| Open technology-partner program | Explore DRUID as a platform partner for enterprise AI-agent solutions |
| New managed AI service | Package DRUID inside a recurring managed-service proposition |
| AI consultancy acquisition | Accelerate the acquired capability with a production-ready AI-agent platform |
| Large banking or insurance win | Extend the partner's vertical offering with DRUID's relevant industry use cases |
| Hiring cluster in conversational AI | Reduce time to market with an existing enterprise AI-agent platform |
| Event speaker on agentic AI | Continue the public point of view through a joint customer proposition |
| Public-sector AI contract | Explore DRUID for multilingual, hybrid or on-premise enterprise requirements |

---

# 12. Marketing and campaign connection

Partner Radar Lite is primarily for partner acquisition, but accepted prospects can also feed focused campaigns.

## Simple campaign mechanism

A PAM can select one or more accepted prospects and create a campaign list.

Campaign types:

- AI Practice Leaders outreach.
- Contact Center Integrators outreach.
- Managed AI Service Providers outreach.
- Vertical Partner Recruitment.
- Open Alliance Program outreach.
- Event follow-up.
- Microsoft / UiPath / ServiceNow ecosystem outreach.

## Campaign record

Keep it simple:

| Field | Description |
|---|---|
| Campaign name | DACH Contact Center Integrators |
| Territory | DACH |
| Owner | Vlad |
| Segment | Genesys and NiCE integrators |
| Prospect count | 12 |
| Message angle | AI-agent layer for contact-center transformation |
| Start date | date |
| Status | planned / active / completed |
| Replies | integer |
| Qualified partner meetings | integer |
| Signed partners | integer |

## What the system should not do initially

- Build email sequences.
- Send LinkedIn messages.
- Replace HubSpot campaigns.
- Manage creative production.
- Automate multi-channel orchestration.

It should create a clean, evidence-backed target list that can be exported to the approved campaign tool.

---

# 13. API contracts for the mockup

## Run scan

```http
POST /api/scans/run
```

Request:

```json
{
  "scan_config_id": "uuid",
  "mode": "mock"
}
```

Response:

```json
{
  "scan_run_id": "uuid",
  "status": "completed",
  "results_found": 25,
  "results_qualified": 8
}
```

## List prospects

```http
GET /api/prospects?territory=DACH&status=new&priority=A
```

## Prospect decision

```http
POST /api/prospects/{id}/decision
```

Request:

```json
{
  "decision": "accepted",
  "note": "Strong Genesys and banking fit."
}
```

## Push to HubSpot

```http
POST /api/prospects/{id}/hubspot
```

Response in mock mode:

```json
{
  "status": "mock_success",
  "hubspot_company_id": "MOCK-12345"
}
```

## KPI summary

```http
GET /api/kpis/head-of-channels
```

Response:

```json
{
  "partner_development": [
    {
      "metric": "New Partner Prospects",
      "current": 12,
      "target": 15,
      "status": "amber",
      "explanation": "Four accepted this week across DACH, US and UK&I."
    }
  ]
}
```

---

# 14. Replit implementation approach

## Suggested stack

### Frontend

- React.
- TypeScript.
- Tailwind CSS.
- A lightweight component library if useful.

### Backend

- Node.js with Express or Fastify.
- TypeScript.

### Database

- Replit PostgreSQL for the mockup.
- Keep the schema portable to standard PostgreSQL.

### Authentication

Mockup:

- Simple user switcher for Irina, James, Denny, Elena, Vlad and Chase.

Later:

- Microsoft Entra ID or the company's existing SSO.

Authentication should not block validation of the concept.

### Background jobs

Mockup:

- Manual scan button.

Later:

- Replit scheduled deployment, n8n or another scheduler runs weekly scans.

### Secrets

Use Replit Secrets for:

- Search API key.
- Firecrawl or Apify key.
- LLM key.
- HubSpot private-app token.
- Email or Teams webhook credentials.

---

# 15. Mock data required

Create at least 30 sample prospects across the territories.

## Suggested distribution

| Territory | Sample prospects |
|---|---:|
| UK&I | 6 |
| DACH | 6 |
| Central and Eastern Europe | 6 |
| United States | 6 |
| Portugal, Canada and South America | 6 |

Each territory should include:

- Two Priority-A prospects.
- Two Priority-B prospects.
- One weak prospect.
- One duplicate or existing relationship.

## Sample signal mix

- New AI practice.
- Open partner program.
- Relevant technology partnership.
- Enterprise customer case study.
- AI hiring cluster.
- Event appearance.
- Recent acquisition.
- Contract award.

This makes the mockup realistic enough to test the review experience.

---

# 16. Build phases

## Phase 0: Clickable mockup

**Goal:** Validate the user experience and decision flow.

Build:

- Four screens.
- Sample data.
- Manual scan button.
- Prospect cards.
- Accept, reject and defer.
- Mock HubSpot push.
- Head of Channels tables populated from mock data.
- Weekly digest preview.

Do not connect live search yet.

## Phase 1: Real search and extraction

**Goal:** Prove that the system can discover useful company-level prospects.

Add:

- One search API.
- One page-extraction API.
- One LLM call using the required JSON schema.
- Deduplication.
- Evidence storage.
- Five-check qualification.

Limit the scan:

- Five to ten accepted prospects per PAM per week.
- A small number of search queries.
- A small number of pages per candidate company.

## Phase 2: HubSpot integration

**Goal:** Remove manual re-entry.

Add:

- Company lookup by domain.
- Company creation.
- Partner Radar properties.
- Note creation.
- Owner assignment.
- HubSpot ID synchronization.

## Phase 3: Weekly schedule and digest

**Goal:** Make the workflow repeatable.

Add:

- Scheduled weekly scans.
- PAM email or Teams digest.
- Irina summary.
- Aging reminder for accepted prospects not yet contacted.

## Phase 4: Optional improvements

Only after the first three phases demonstrate value:

- Approved contact-data provider.
- Event-list imports.
- Job-source connectors.
- Tender feeds.
- Technology enrichment.
- HubSpot campaign export.
- More territories.
- Better source-specific crawlers.

---

# 17. Acceptance criteria

## User-value criteria

The mockup is successful when:

- A PAM understands a prospect card in under one minute.
- The PAM can accept or reject a prospect in one click.
- Every accepted prospect has evidence and a clear why-now trigger.
- Irina sees the New Partner Prospects total without asking the team for manual updates.
- The team prefers the prospect list to manually searching Google.
- At least half of Priority-A mock prospects are judged worthy of real outreach.

## Technical criteria

- No duplicate company is created for the same normalized domain.
- Every claim shown to the PAM has an evidence URL.
- A failed source does not break the whole scan.
- The scan can be rerun without creating duplicate prospects.
- Territory assignment follows configured country rules.
- Accepted prospects can be pushed to a mock HubSpot endpoint.
- The UI distinguishes verified evidence from AI-generated summaries.
- API keys are never exposed in the browser.

---

# 18. The minimum production link map

This is the complete first-production integration footprint.

```text
Tavily or Bing
    └── Finds candidate companies and recent signals

Firecrawl
    └── Extracts readable evidence from company and news pages

One LLM
    └── Structures evidence, applies five checks and drafts PAM angle

Replit PostgreSQL
    └── Stores scans, evidence, prospects and decisions

HubSpot
    └── Stores accepted partner prospects and commercial ownership

Teams or email
    └── Sends one weekly digest
```

Nothing else is required to create value.

---

# 19. Recommended first decision

Before building live integrations, create the Replit mockup with:

- 30 realistic sample prospects.
- The four screens.
- The five qualification checks.
- Mock HubSpot push.
- Irina's existing three tables.
- A weekly prospect digest preview.

Test it with Irina and two PAMs.

Ask only:

1. Are these the right prospects?
2. Is the evidence enough to trust the recommendation?
3. Is the suggested angle useful?
4. Would you contact this company?
5. What information is missing?
6. Does Irina get the visibility she asked for?

Only after those answers are positive should live search, extraction and HubSpot integration be added.

---

# 20. Source basis

This specification reflects DRUID's current commercial direction toward larger ACV opportunities and enterprise customers, including:

- Higher-value Foundation, Scale and Enterprise packages.
- A preference for $100K–$200K starting ACV rather than low-value one-agent pursuits.
- Enterprise value associated with multiple AI agents, multilingual support, broad integrations and hybrid/on-premise deployment.
- Priority industry use cases in healthcare, higher education, retail, banking and insurance.
- HubSpot as the required quoting environment for new prospect quotes.

The Replit mockup should validate the operating concept first. The production version should add only the integrations that demonstrably reduce manual work or improve the quality of partner prospects.

---

# 21. Visual and interaction design: modern Microsoft style

## 21.1 Design direction

The mockup should feel like a focused Microsoft 365 business application: calm, structured, fast and familiar.

Use **Microsoft Fluent 2 as the design reference**, while retaining DRUID identity. The result should not look like a generic startup dashboard, a collection of oversized cards or a pixel-for-pixel copy of a Microsoft product.

The experience should communicate:

- Enterprise credibility.
- Clear information hierarchy.
- High information density without clutter.
- Familiar list, command-bar and detail-panel patterns.
- Minimal learning curve.
- Evidence and status visible at a glance.
- Fast movement from discovery to PAM action.

## 21.2 Core design principles

### Content first

The prospect, the evidence and the required action are more important than decorative graphics.

Avoid:

- Large hero banners.
- Decorative gradients.
- Oversized KPI cards.
- Excessive rounded containers.
- Heavy shadows.
- Multiple competing accent colors.
- Dense engineering terminology.
- Long forms displayed all at once.

Use:

- Clear page titles.
- Compact command bars.
- Structured tables and lists.
- Side panels for detail.
- Progressive disclosure.
- Neutral backgrounds.
- Thin separators.
- Small status badges.
- Consistent action placement.

### List-and-detail over page hopping

The PAM should review prospects without repeatedly opening and closing separate pages.

Preferred pattern:

```text
Prospect list                      Prospect detail
──────────────────────────────     ─────────────────────────────
Company A                          Why it fits
Company B                          Why now
Company C                          Evidence
Company D                          Suggested action
                                   Accept / Reject / Defer
```

On desktop, use a split view or a right-side drawer. On smaller screens, the detail can open as a full page.

### One primary action per state

Examples:

- New prospect: **Review**
- Reviewed prospect: **Accept**
- Accepted prospect: **Push to HubSpot**
- HubSpot-linked prospect: **Open in HubSpot**

Secondary actions should be visually quieter:

- Reject.
- Defer.
- Copy message.
- Open source.
- Add note.

### Evidence must look different from AI interpretation

Use a clear distinction:

- **Verified evidence:** source icon, source domain, date and quoted excerpt.
- **System summary:** neutral summary block.
- **Suggested outreach:** editable draft with an “AI suggested” label.

Never visually present an AI-generated interpretation as a verified fact.

---

## 21.3 Fluent component strategy

Use **Fluent UI React** components rather than assembling the interface primarily from custom Tailwind components.

Recommended package:

```text
@fluentui/react-components
@fluentui/react-icons
```

Tailwind may still be used for limited layout utilities, but Fluent tokens and components should control the visual system.

### Component mapping

| Need | Fluent-style component |
|---|---|
| Application shell | NavDrawer / Drawer + Toolbar |
| Main navigation | Nav or vertical navigation items |
| Page actions | Toolbar / CommandBar-style row |
| Prospect list | DataGrid |
| Compact prospect preview | Card |
| Filters | SearchBox, Dropdown, Combobox, Checkbox |
| Status | Badge |
| User identity | Avatar / Persona-style block |
| Detail view | Drawer or split pane |
| Confirmation | Dialog |
| Tabs | TabList |
| Context actions | Menu |
| Explanations | Tooltip / Popover |
| Notifications | Toast |
| Warnings | MessageBar |
| Loading | Skeleton |
| Empty states | Illustration-free empty-state panel |
| Dates | DatePicker only where editing is required |
| Progress | ProgressBar or compact step indicator |

Use icons only where they improve recognition. Do not place icons beside every label.

---

## 21.4 Application shell

### Desktop shell

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ DRUID Partner Radar                         Search   Help   Avatar       │
├───────────────┬─────────────────────────────────────────────────────────┤
│ Overview      │ Page title                                      Actions │
│ Prospects     │ Page description                                         │
│ Campaigns     ├─────────────────────────────────────────────────────────┤
│ Scan setup    │ Main content                                             │
│               │                                                          │
│               │                                                          │
│               │                                                          │
└───────────────┴─────────────────────────────────────────────────────────┘
```

### Shell rules

- Left navigation width: approximately 220–240 pixels when expanded.
- Collapsible navigation for smaller laptop screens.
- White or very light neutral top bar.
- Light neutral application background.
- Main content max width only where useful; tables may use the full available width.
- Sticky page header for long lists.
- Avoid boxed content inside boxed content.

### Navigation

Primary items:

1. Overview
2. Prospects
3. Campaign lists
4. Scan setup

Admin-only or secondary items can sit at the bottom:

- Data quality
- Integration status
- Settings

Do not expose scan logs, API traces or technical job names in the normal navigation.

---

## 21.5 Typography

Use the Fluent web font stack:

```css
font-family:
  "Segoe UI",
  -apple-system,
  BlinkMacSystemFont,
  "Helvetica Neue",
  Arial,
  sans-serif;
```

### Recommended hierarchy

| Role | Suggested size / weight |
|---|---|
| Page title | 28–32px, semibold |
| Section title | 20–24px, semibold |
| Card or panel title | 16–18px, semibold |
| Body | 14px, regular |
| Data grid | 13–14px |
| Supporting metadata | 12px |
| KPI number | 24–28px, semibold |

Rules:

- Use sentence case.
- Keep labels short.
- Do not use all caps for headings.
- Use bold sparingly.
- Use muted text for metadata, not for important actions.

---

## 21.6 Color system

Use Fluent design tokens rather than hardcoded colors wherever possible.

### Surface hierarchy

| Surface | Use |
|---|---|
| Neutral background | Application canvas |
| White / primary surface | Main content and panels |
| Subtle neutral | Selected rows, filter bars and secondary panels |
| Thin neutral stroke | Table dividers, card borders and input borders |

### Brand and action color

Recommended approach:

- Use a **single DRUID accent** for primary actions and selected states.
- Keep the rest of the interface neutral.
- Use Microsoft-style blue only if it is selected as the product accent during the mockup review.
- Do not use blue and DRUID green as competing primary colors.

### Status colors

| Status | Treatment |
|---|---|
| Priority A | Filled accent or strong outline badge |
| Priority B | Neutral or subtle accent badge |
| Accepted | Success badge |
| New | Informational badge |
| Deferred | Warning badge |
| Rejected | Neutral gray, not aggressive red |
| Failed integration | Error badge |
| Stale evidence | Warning badge |

Do not rely on color alone. Always include a text label or icon.

---

## 21.7 Spacing, corners and elevation

### Spacing

Use a four-pixel base rhythm:

```text
4, 8, 12, 16, 20, 24, 32, 40
```

Recommended defaults:

- Page edge padding: 24px desktop, 16px small screens.
- Section spacing: 24–32px.
- Table cell vertical padding: 10–12px.
- Panel internal padding: 20–24px.
- Toolbar gap: 8px.

### Corners

- Inputs and small controls: 4–6px.
- Cards and panels: 8px.
- Pills only for badges and compact filters.
- Do not make every container a rounded card.

### Elevation

- Default content should be flat.
- Use shadows only for drawers, dialogs, menus and floating panels.
- Use borders and surface contrast for normal grouping.

---

# 22. Screen-level Microsoft-style specification

## 22.1 Overview for Irina

The Overview remains table-led.

### Page header

```text
Partner performance
Current quarter · Updated 18 minutes ago

[Territory: Global ▼] [Period: Q3 2026 ▼]           [Refresh] [Export]
```

### Tables

Use three clean sections rather than a wall of KPI cards.

#### Partner development

| KPI | Current | Target | Status | What changed |
|---|---:|---:|---|---|
| New Partner Prospects | 12 | 15 | Amber | +4 this week |
| Signed Partners | 4 | 5 | Amber | No change |
| Active Onboarding | 6 | 6 | On track | +1 |
| Certified Partners | 11 | 12 | Amber | +2 |

Continue with the remaining table items.

### Interaction

Clicking a row opens a right-side detail panel with:

- Regional contribution.
- Change versus last period.
- Supporting records.
- One concise explanation.
- Items needing Irina's attention.

The user stays on the Overview page.

### Visual treatment

- No giant colored KPI tiles.
- Status shown by compact badges.
- Current values use semibold text.
- The “What changed” column carries the operational meaning.
- Red is reserved for real problems.
- Use subtle row hover and selected states.

---

## 22.2 Prospect Review

This is the most important operating screen.

### Page header

```text
Partner prospects
Evidence-backed companies for PAM review

[Search companies] [Territory ▼] [Priority ▼] [Signal ▼] [Status ▼]
                                                       [Run mock scan]
```

### Main layout

Use a DataGrid on the left or full width:

| Company | Why now | Fit | Territory | Priority | Status |
|---|---|---|---|---|---|

Recommended row content:

- Company name and domain.
- One-line trigger.
- Two or three compact fit tags.
- PAM avatar or initials.
- Priority badge.
- Review state.

### Row interaction

Selecting a row opens a right-side Drawer with the prospect detail.

The drawer should be wide enough to read evidence comfortably—approximately 440–520 pixels.

### Batch actions

Only add batch actions if testing proves they are useful:

- Defer selected.
- Export selected.
- Add to campaign list.

Do not allow batch acceptance in the first version.

---

## 22.3 Prospect Detail Drawer

### Header

```text
Example Integrator
example.com · Germany · Contact-center integrator

Priority A        New
```

Header actions:

- Primary: **Accept prospect**
- Secondary menu: Defer, Reject, Copy link

### Body tabs

1. Summary
2. Evidence
3. Suggested outreach
4. Activity

#### Summary tab

Use compact sections, not nested cards.

```text
Why it fits
Enterprise Genesys integrator with banking and insurance references.

Why now
Launched a GenAI customer-service practice in July 2026.

Qualification
✓ Enterprise customer access
✓ Relevant capability
✓ Technology adjacency
✓ Partnership openness
✓ Recent trigger
```

#### Evidence tab

Each evidence item:

```text
Technology partnership
Company newsroom · 18 July 2026

“Company announced a new strategic alliance focused on...”

[Open source ↗]
```

Show:

- Evidence category.
- Source.
- Date.
- Short excerpt.
- Confidence.
- Open-source action.

#### Suggested outreach tab

```text
Suggested target
Head of Alliances

Opening angle
Position DRUID as the production AI-agent layer for the firm's
contact-center transformation portfolio.

Draft message
[Editable text area]

[Copy message]
```

#### Activity tab

Chronological list:

- Discovered.
- Reviewed.
- Accepted.
- HubSpot push.
- PAM note.

Use a simple vertical activity list rather than a complex timeline graphic.

---

## 22.4 Acceptance Dialog

When the PAM selects **Accept prospect**, display a small Dialog:

```text
Accept Example Integrator?

The company will be marked as a qualified partner prospect
and can be sent to HubSpot.

PAM owner        Vlad Greavu
Territory        DACH
Optional note    [________________________________]

[Cancel]                               [Accept prospect]
```

After acceptance, show a Toast:

> Prospect accepted. Ready to send to HubSpot.

Do not push automatically without the PAM's explicit action in the mockup.

---

## 22.5 HubSpot Push

After acceptance, replace the primary action with:

**Send to HubSpot**

Show a confirmation Dialog with:

- Existing-company check.
- Fields to be sent.
- PAM owner.
- Note preview.

Success state:

```text
✓ Added to HubSpot
Company ID 1234567

[Open in HubSpot]
```

Failure state:

Use a MessageBar:

> HubSpot could not be reached. The prospect remains accepted and can be retried.

No data should be lost because an integration fails.

---

## 22.6 Scan Setup

Use a settings layout, not an engineering form.

### Territory selector

Left-side list:

- UK & Ireland
- DACH
- Central and Eastern Europe
- United States
- Portugal, Canada and South America

### Configuration form

Group settings into sections:

#### Market focus

- Countries.
- Languages.
- Industries.
- Partner types.

#### Signals

- AI investment.
- Partnership openness.
- Enterprise customer access.
- Technology adjacency.
- Hiring.
- Events.
- Tenders.

#### Limits

- Maximum candidates.
- Minimum checks required.
- Excluded domains.
- Recency window.

#### Search preview

Show the generated search themes as readable chips or lines, not raw JSON.

Actions:

- Save configuration.
- Run test scan.
- Reset changes.

Advanced implementation details should be hidden in an “Advanced” accordion.

---

# 23. Empty, loading and error states

## Empty prospect list

```text
No prospects match the current filters

Clear one or more filters, or run a new scan.

[Clear filters]   [Run scan]
```

Avoid decorative illustrations unless they serve a clear purpose.

## No evidence

```text
Evidence could not be verified

The company is not eligible for Priority A until at least one
enterprise-access source and one capability source are available.
```

## Loading

Use Skeleton rows matching the final DataGrid structure. Do not use a full-screen spinner.

## Scan running

Show a non-blocking progress strip:

> Scanning DACH sources… You can continue reviewing existing prospects.

## Integration error

Explain:

- What failed.
- What was preserved.
- What the user can do next.

---

# 24. Responsive behavior

## Large desktop

- Expanded left navigation.
- Full DataGrid.
- Right-side detail Drawer.
- Persistent filter bar.

## Laptop

- Collapsible navigation.
- Fewer visible DataGrid columns.
- Detail Drawer overlays part of the list.
- Hide lower-priority metadata behind tooltips or detail view.

## Tablet

- Compact navigation.
- Prospect list becomes a structured card list.
- Detail opens full screen.

## Mobile

Mobile is not a primary use case for the mockup.

Support:

- Viewing the Overview.
- Reviewing one prospect.
- Accepting, rejecting or deferring.

Do not attempt to reproduce the complete desktop data grid on a phone.

---

# 25. Accessibility and usability

Requirements:

- Keyboard navigation across navigation, DataGrid and Drawer.
- Visible focus state.
- Minimum WCAG AA contrast.
- Text alternatives for icons.
- Status text in addition to color.
- Buttons labeled with actions, not vague labels such as “Submit”.
- Dialog focus trapping.
- Escape closes non-destructive Drawers and Dialogs.
- Tables retain logical reading order.
- Evidence links have descriptive accessible names.
- Touch targets remain usable on tablet.

Use sentence case throughout.

---

# 26. Updated frontend recommendation

Replace the earlier generic component recommendation with:

```text
React
TypeScript
@fluentui/react-components
@fluentui/react-icons
React Router
TanStack Query
Replit PostgreSQL
Node.js / Fastify or Express
```

Optional:

```text
Tailwind CSS only for limited page-layout utilities
```

Do not mix three different component systems.

The preferred hierarchy is:

1. Fluent UI components.
2. Fluent design tokens.
3. Small custom components built from Fluent primitives.
4. Minimal layout utility classes.

---

# 27. Design acceptance criteria

The Microsoft-style mockup is ready for review when:

- It feels like one coherent business application, not a set of web cards.
- Irina can understand the three tables in under two minutes.
- A PAM can review a prospect without leaving the list.
- Evidence, AI summary and suggested outreach are visually distinct.
- The primary action is obvious in every state.
- The interface remains calm with 30–50 prospects.
- The DataGrid works with keyboard navigation.
- No normal screen contains more than one dominant accent color.
- No page uses unnecessary gradients, oversized hero blocks or decorative analytics.
- The UI uses Fluent tokens and components consistently.
- A failed HubSpot or search integration is visible without blocking the rest of the application.

---

# 28. Suggested visual prototype order

Build the screens in this order:

1. Prospect Review with detail Drawer.
2. Irina's Overview tables.
3. Prospect acceptance and mock HubSpot Dialog.
4. Scan Setup.
5. Campaign list creation.
6. Responsive and accessibility polish.

The Prospect Review screen should receive most of the design attention because it is where the system proves its day-to-day value.
