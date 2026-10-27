# Independent client pilot runbook

Status: participant confirmed; sessions not conducted. The project lead reported
written confirmation from one unaffiliated participant on 2026-10-27. The
original confirmation remains access-controlled. These instructions and blank
recording fields are not customer evidence. The participant must still complete
the observed sessions and sign the required Testnet transactions using a wallet
they control.

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

- Date / participant reference / consent reference:
- Workflow and agreed evaluation criteria:
- Public client wallet (only with permission):
- Session type: baseline / final:
- First funded job time; metric export reference:
- Six job IDs, paths, transaction/receipt references:
- Failures, assistance provided, and issue-to-fix references:
- Continue / change / stop decision and participant's reason:

Export metrics locally and share only with consent. Record interviews and session
evidence in access-controlled storage when appropriate. Leave the Ambassador's
evidence checklist unticked for the Chapter Lead to assess.
