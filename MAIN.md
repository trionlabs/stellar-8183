
1. Project & Team Information

Project Name: 
Soroban Agentic Commerce, an ERC-8183 (Agentic Commerce Protocol) implementation for Stellar
Builder / Team Name: 
 Deniz Baş
Primary Contact (Name + Email): 
Deniz Baş, deniz@trionlabs.dev
Ambassador Chapter: 
Stellar Türkiye
Ambassador Chapter Lead:
İrem Koçi (Stellar Türkiye)
Date Submitted: 
13.07.2026
Suggested Sprint Start Date:
20.07.2026



2. Instawards Overview & Intent

2.1 Instawards Purpose (for Builder Context)
Instawards are designed to support short, clearly scoped, execution-focused work that helps a project make tangible progress toward building on Stellar. Instawards are meant to fund specific, achievable outcomes that can be completed and demonstrated within 30 days or less.

This SOW represents a shared commitment between the Builder and the Ambassador Chapter Lead on what will be delivered, why it matters, and how success will be verified.

3. Problem Statement & Objective

Problem Being Addressed
What specific problem, gap, or blocker is this Instaward intended to solve?
AI agents can already hold a Stellar keypair and move USDC. What they cannot do is hire each other. There is no primitive on Stellar for one agent to commission work from another and settle it safely: the client either pays upfront and hopes for delivery, or the provider works first and hopes for payment. Both are trust-based, and neither survives contact with autonomous, unaccountable counterparties.Ethereum solved the coordination half of this in February 2026 with ERC-8183 (Agentic Commerce Protocol), co-authored by the Ethereum Foundation, with live implementations on Base, Arbitrum, BNB Chain, and Arc. This matters now because Stellar's actual advantages, native USDC, sub-second finality, and an authorization model where an agent signs an intent and a facilitator submits it (no gas, no XLM balance, no RPC juggling) make it a better settlement layer for agent commerce than the chains currently shipping it.
Objective of This Instaward
In one or two sentences, what will be true at the end of 30 days if this Instaward is successful?
At the end of 30 days, a Soroban implementation of the ERC-8183 job-escrow state machine will be live on Stellar testnet, open-source, and demonstrated end-to-end: two agents transacting a real job  posted, funded in USDC, delivered, evaluated, settled with public transaction hashes anyone can verify on Stellar Expert.
Example prompts for builders: What is currently preventing progress? What is unclear, missing, or unbuilt today? Why is this problem worth solving now?




4. Scope of Work (30-Day Deliverables)

Important guidance: This scope must be achievable within 30 calendar days. If the work feels larger, it should be reduced or split into more achievable phases.


4.1 In-Scope Deliverables

Deliverable
Description (What will be built or produced?)
Why this matters
Deliverable 1
The full ERC-8183 state machine as a Soroban contract: create_job, set_provider, set_budget, fund, submit, complete, reject, claim_refund. States: Open -> Funded -> Submitted -> Completed / Rejected / Expired. Payment in any SEP-41 token (USDC). Only the evaluator may complete or reject; after expiry, anyone may trigger the refund, so escrow can never be stranded. Includes a comprehensive test suite and an explicit TTL / state-archival strategy,  a funded job whose state gets archived before its own expiry would strand user funds, a failure mode with no Ethereum equivalent and the single hardest part of this port. Deployed and verified on testnet.
This is the main primitive. Everything else in agent commerce on Stellar sits on top of it.
Deliverable 2
The before_action / after_action hook trait, an admin allowlist for hook contracts, dispatch wired into every state transition except claim_refund, deliberately non-hookable, so a malicious hook can never block a refund. Plus one working reference hook (deadline/SLA enforcement) to prove the extension path.
The hook layer is what makes ERC-8183 a standard rather than one more escrow contract: reputation gating, SLAs, and bidding plug in without touching the escrow kernel. Shipping the interface plus one real hook proves it works and gives the next builder a template.
Deliverable 3 (optional)
An npm-installable client SDK wrapping every contract call, and a runnable demo in which a client agent posts a job and escrows USDC, a provider agent submits a deliverable hash, and an evaluator releases payment, all on testnet, with published tx hashes. Plus an ERC-8183 -> Soroban mapping document (require_auth vs msg.sender, SEP-41 vs ERC-20, native signed auth entries vs ERC-2771 meta-transactions, TTL vs "storage is forever").
Contracts nobody can call are dead code. The SDK plus a working demo is what turns this from a repo into something the next team actually builds on and it's the deliverable a non-technical reviewer can verify in three minutes.
Out-of-Scope (Explicitly Not Included)
List anything that might be assumed but is not included in this Instaward scope.


Mainnet deployment, testnet only. Mainnet is irresponsible without an audit.
Security audit.
Trust-minimized / threshold evaluator. ERC-8183 leaves the evaluator as an open design space: one key holds unilateral power to approve bad work or reject good work. This is the most interesting problem in the standard and it is the intended follow-on, but it is not in this 30-day scope. This Instaward delivers the escrow layer, with the evaluator as a single designated address, exactly as the base spec defines it.
On-chain reputation / identity registry (Stellar has no ERC-8004 equivalent). 
Dispute resolution or arbitration, the base spec deliberately excludes it, and so does this.
Cross-chain jobs, front-end UI, token, or economic design.
A formal SEP (Stellar Ecosystem Proposal) submission. Standardization is a follow-on conversation with the ecosystem, not a 30-day deliverable.




4.2 Deliverable-Aligned Budget Request

Requested Budget Amount 
Rationale for Budget Request
5000$
The entire request is engineering time, there are no infrastructure costs (testnet is free) and no third-party spend. Roughly: ~50% to D1 (the core contract and the archival/TTL work, which is where the real risk sits), ~25% to D2, ~25% to D3.
Being straightforward about this: I'm asking for it because the scope above is genuinely deliverable in the time, because Stellar is missing a primitive that other chains already shipped, and because I'd rather have the artifact and the ecosystem relationship than the rate. 




5. 30-Day Execution Plan & Timeline

5.1 Weekly Breakdown
Week
Planned Work
Expected Output
Week 1
Soroban toolchain setup. Design the job storage model and the persistent-storage TTL/rent strategy (funded jobs must outlive their own expiry). Implement the state machine: create_job, set_provider, set_budget, fund, submit. SEP-41 escrow integration.
Contract compiles; unit tests passing for the Open -> Funded -> Submitted path; TTL/archival design note published in the repo.
Week 2
Complete the terminal paths: complete, reject, permissionless claim_refund, optional platform/evaluator fees. Adversarial tests: wrong-caller auth, double-fund, expiry races, archival edge cases. Deploy to testnet.
Live testnet contract ID, verifiable on Stellar Expert. Green CI. Full test suite public.
Week 3
Hook layer: trait, admin allowlist, before_action/after_action dispatch on all transitions except claim_refund. Build and test one reference hook (deadline/SLA). Deploy hooks to testnet.
Hook contracts live on testnet; test proving a reverting hook cannot block claim_refund.
Week 4
TypeScript SDK. End-to-end two-agent demo script. ERC-8183 -> Soroban mapping doc + README. Record demo video. Buffer for slippage.
SDK published; demo executes a full job lifecycle on testnet; tx hashes + demo video published.


6. Evidence of Completion (Required)

Important guidance: Evidence should be clear, verifiable, and easy to review by the Ambassador Chapter Lead with minimal technical expertise.

6.1 Planned Evidence to Be Submitted
Deliverable
Evidence Type 
(link, repo, demo, screenshot, doc, tx hash, etc.)
Description
Deliverable 1
Public GitHub repo (MIT) + Stellar Expert link to the deployed testnet contract + CI badge showing tests passing
Click the Stellar Expert link: the contract exists on Stellar testnet. Click the CI badge: the test suite is green. No Rust knowledge required to verify either.
Deliverable 2
Repo directory + testnet contract ID for the reference hook + a named test (refund_cannot_be_blocked_by_hook) visible in CI output
Demonstrates the extension mechanism works and that the critical safety property, refunds can never be blocked, is tested, not just asserted.
Deliverable 3
Demo video + a list of testnet transaction hashes covering one full job lifecycle (create -> fund -> submit -> complete), each linked to Stellar Expert + published SDK package + README/mapping doc
This is the primary evidence. The video shows two agents transacting; the tx hashes let anyone independently confirm on-chain that it actually happened. Verifiable with no technical expertise at all.


6.2 Evidence Verification Checklist (For Ambassador Use)

For each deliverable, the Ambassador Chapter Lead will assess whether evidence is present and sufficient.


Deliverable
Evidence Present
Evidence 
Partial
Evidence Missing
Comments
Deliverable 1
☐
☐
☐


Deliverable 2
☐
☐
☐


Deliverable 3
☐
☐
☐





7. Next-Step Alignment

7.1 Anticipated Next Step After Completion

After this Instaward, the most likely next step is:
[x] Apply to SCF Build Award
[x] Continue development independently
[x] Apply for a follow-on Instaward (if eligible)
[x] Seek other ecosystem support
[x] Other: 
The base standard leaves the evaluator as its unsolved problem, a single address with unilateral power to steal from the client (approve bad work) or grief the provider (reject good work). No implementation on any chain has fixed this. The natural follow-on, and the basis of an SCF Build application, is replacing the single evaluator with a threshold-signature committee, building directly on my Ethereum Foundation Synthesis Hackathon-winning work (Agent Committees, FROST threshold signatures for agentic finance). Stellar would be the first chain where the judgment layer of agent commerce is not a single point of trust. The 30-day Instaward is the escrow foundation that work requires. github.com/trionlabs/chorus
8. Instawards Constraints Acknowledgement

By submitting this SOW, the Builder acknowledges:
[x] This scope will be completed within 30 days or less.
[x] Instawards support execution, not open-ended exploration.
[x] A project may receive no more than two follow-on Instawards.
[x] Each Instaward is capped at $5,000.
[x]Total Instawards funding may not exceed $15,000.

9. Submission Confirmation
Once finalized, this Statement of Work will be submitted by the Ambassador Chapter Lead via the Instawards Airtable submission form for review and approval.

