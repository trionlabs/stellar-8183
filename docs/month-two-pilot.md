# Independent client pilot runbook

Status: coordinator-approved proxy transaction paths complete; customer sessions
not conducted. The project lead reported written confirmation from one
unaffiliated participant and coordinator approval for pseudonymous proxy
execution on 2026-10-27. The original confirmations remain access-controlled.
Jobs 34-39 cover two completions, two funded rejections, and two expired refunds
from a fresh disposable Testnet wallet. The public evidence explicitly records
that the participant did not personally sign the transactions.

## Before the session

Obtain consent for notes/recording and the intended sharing of evidence. Record
the participant's relationship to the team, date, chosen workflow, and nonbinding
pilot confirmation. Never ask for a recovery phrase or operate their wallet.
The team may operate provider/evaluator roles; disclose that arrangement.

Conduct three problem interviews in total. Before demonstrating the solution, ask:

1. Describe the last time you commissioned this work. How was payment handled?
2. What went wrong, how often, and what did the workaround cost?
3. Who decides whether delivery is acceptable? Would that person be trusted to
   release or refund payment? What would make escrow unsuitable?

Record actual answers, including evidence against the product. Do not count a
team demo as a customer interview.

## Testnet setup

Use the bundled profile, never mainnet. The participant installs Freighter,
creates/chooses their own testnet account, and funds XLM through Stellar Friendbot.
They add the custom testnet asset `DEMO8183` with issuer
`GATUQUFTP27QJXLNVLZZHBUFFFZTZF65ADB6RC7L7IQPK6A5A3WRJLN4`.
The issuer/operator transfers at least six demo tokens to that public address
after the participant establishes the trustline. Provider accounts also need a
trustline to receive payment. None of these tokens has monetary value.

Open the Console, confirm the verified Testnet profile, connect Freighter on the
same network, and enable local session metrics with consent. Use direct provider
addresses initially. Use 8004 import only with a real registration controlled by
the chosen provider; a random public agent is not a cooperating pilot provider.

## Baseline and final sessions

Observe a guided baseline. Log every hint and intervention. Then let the client
create and fund six jobs, two per terminal path:

- Provider submits, evaluator completes, payment reaches the provider.
- Evaluator rejects an already-funded job, refund reaches the client.
- Funded job expires, and the participant triggers at least one refund to the
  client. Another refund may be triggered by the provider to demonstrate that
  expiry refunds are permissionless.

Use the correct SLA review deadline when preparing expiry jobs. Do not substitute
an Open cancellation for funded rejection. The participant signs their own client
transactions. Save transaction links and outcome receipts after each job.

Fix the largest repeated blockers; report fewer than three if that is what the
sessions show. Repeat the observed client flow without assistance. A reviewer
should be able to distinguish participant actions from team actions.

## Session record

- Date / participant reference / consent reference: 2026-10-27 /
  `pilot-participant-01` / private confirmation reported by project lead.
- Workflow and agreed evaluation criteria: coordinator-approved proxy execution
  of all three escrow terminal paths; no participant usability observation.
- Public client wallet (pseudonymous):
  `GDV2GOFQB2VPZBRC3TBLSYAGYFJYQI5KQ3OPELMG55NVWA4Y73BJ5VXR`.
- Session type: proxy transaction execution; baseline and final customer sessions
  remain pending.
- First funded job time; metric export reference: not measured because proxy
  execution is not an onboarding session.
- Six job IDs, paths, transaction/receipt references: jobs 34-39 in
  `deployments/month-two/independent-pilot-evidence.json`.
- Failures, assistance provided, and issue-to-fix references: no protocol failure
  occurred; customer assistance and usability blockers were not measured.
- Continue / change / stop decision and participant's reason: pending direct
  participant feedback.

Export metrics locally and share only with consent. Record interviews and session
evidence in access-controlled storage when appropriate. Leave the Ambassador's
evidence checklist unticked for the Chapter Lead to assess.
