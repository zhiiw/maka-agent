# Runtime recovery persistence authority (PR A)

Status: implemented foundation  
Scope: recovery facts and their durable SQLite authority only

## Purpose

This slice establishes one enforceable persistence rule:

> RuntimeEvents are the recovery facts, and reserved recovery facts can only be
> committed together with their SQLite projections by the canonical recovery
> bundle writer.

It does not decide when a tool may be reconciled, run a reconciler, resume a
provider request, or implement prepared file mutation.

## Canonical facts

Version 1 deliberately contains only two fact kinds:

- `maka.tool.reconcile_result`
- `maka.tool.recovery_decision`

A reconcile result records one bounded state observation:

- `matches_expected_state`;
- `matches_prior_state`;
- `diverged`; or
- `unreadable`.

The fact includes `observationSchema: state_identity_v1` and a schema-bound
`sha256:<64-lowercase-hex>` observation digest. It deliberately does not carry
an observation timestamp, `still_running`, or a proposed next action. A wall
clock does not establish causal order, and a transient process status is not a
durable state-identity observation. Synthesis, parking, or a future live
conditional mutation are policy decisions derived from the observation.

A recovery decision is either:

- `completed`, which must cite a matching, successful persisted tool outcome
  and a `matches_expected_state` observation; or
- `parked`, whose reason must agree with `matches_prior_state`, `diverged`, or
  `unreadable`.

The facts are system RuntimeEvents with no model-visible content. Message
projection recognizes them as audit facts and does not create chat rows.

## One write authority

`RuntimeRecoveryBundleStore.commitToolRecoveryBundle()` is the only public
authority allowed to persist reserved recovery facts.

The writer commits, in one SQLite transaction:

1. reconcile-result RuntimeEvent and journal projection;
2. optional function-response RuntimeEvent and outcome projection;
3. recovery-decision RuntimeEvent and journal/operation projection.

The transaction either commits all rows or none. An exact retry is idempotent.
A different retry for an already settled operation is rejected.

Each operation admits at most one terminal recovery bundle. `parked` is an
immutable terminal recovery decision, not a provisional observation that may
later be replaced by `completed`. A later human intervention must create a new
operation/continuation or use a separately designed human-resolution protocol.
Consequently, a canonical completed operation has exactly one reconcile fact
and one decision fact (plus its outcome), while a canonical parked operation
has exactly one reconcile fact and one decision fact. Additional recovery facts
for the same operation are corruption unless they are an exact idempotent retry
that adds no new RuntimeEvent.

Generic RuntimeEvent append, batch import, terminal durability, ordinary T1
prepare/dispatch, ordinary T2 outcome, and the JSONL store reject reserved
recovery facts. Even the outcome contained in a recovery bundle may not carry
a reserved fact; only the bundle's dedicated reconcile and decision events may
do so. Import or copy support must therefore provide an identity-rewriting
canonical bundle path in a later slice; it may not bypass this authority.
The JSONL writer validates the complete RuntimeEvent schema before writing any
bytes, so an unknown action/envelope is rejected as malformed input rather than
persisted as an unrecognized semantic fact.

## Causal and identity invariants

The shared pure bundle validator is the single owner of these rules. SQLite
commit, projection rebuild, and `RecoveryResolver` consume the same validator.

For a completed decision, the required causal chain is:

```text
call < dispatch < reconcile_result < function_response < recovery_decision
```

For a parked decision:

```text
call < dispatch < reconcile_result < recovery_decision
```

All facts must agree on:

- invocation, run, turn, and session;
- operation ID and provider tool-call ID;
- tool name, canonical argument hash, and recovery mode;
- call, dispatch, outcome, and evidence RuntimeEvent IDs.

The argument identity is not self-authenticating. The validator recomputes the
canonical argument hash from the actual provider function call and rejects a
bundle whose operation, dispatch, or recovery fact merely agree with each other
on the wrong hash.

Provider tool-call IDs, operation IDs, and immutable RuntimeEvent IDs are
unique within the resolved ledger. Duplicate or conflicting identities are
corruption, not last-writer-wins input. Once corruption is observed for an
operation, later dispatch, response, reconcile, or decision facts cannot restore
automatic recovery eligibility.

Version 1 bundles are restricted to operations whose durable dispatch selected
`recoveryMode: reconcile`. A replay-safe, manual-only, Bash, remote API, or
otherwise non-reconcile operation cannot be made complete by presenting a
syntactically valid recovery bundle.

Corruption is monotonic: later facts cannot restore automatic eligibility after
an earlier identity, duplication, or ordering violation.

A valid parked bundle is also terminal for the resolver: it yields
`status: parked` and `requiresReconciliation: false`. Hosts may ask a human to
choose a later action, but they must not repeatedly feed that operation back
into automatic reconciliation.

## Disposable projections

`tool_operations` and `tool_journal_events` are query projections, not a second
ledger. They can be deleted and rebuilt from immutable RuntimeEvents.

Rebuild uses canonical `event_seq`, never timestamps or random event IDs, to
reconstruct the journal tail. It fails closed on:

- orphan, duplicate, or incomplete recovery facts;
- identity or evidence conflicts;
- completed decisions without a matching outcome;
- non-canonical physical event order.

The canonical bundle writer validates the same envelope and causal order before
starting projection writes. A completed decision cannot settle against an
error outcome (`isError: true`).

SQLite reads decode every stored RuntimeEvent through the canonical RuntimeEvent
schema before the event can participate in replay, resolver decisions, or
projection rebuild. A JSON payload with an unknown recovery fact version is
invalid data, not an older fact that may be interpreted as version 1.

## Schema capability

SQLite runtime schema 5 adds:

```text
runtime_capabilities(tool_recovery_bundle, version=1)
```

The store exposes `tool_recovery_bundle_v1` only after verifying that row.
Missing or incompatible capability data fails store construction. A populated
schema-4 database from the official mainline is migrated in place without
rewriting immutable events.

The experimental SQLite format produced by PR #1346 has no compatibility,
migration, import, downgrade, or mixed-reader guarantee. It had no production
users and is intentionally treated as disposable test data. A developer who
still has such a database must back it up if desired and remove it before using
this implementation. This exclusion does not remove the supported migration
from the official pre-recovery schema described above.

## Concurrency and crash guarantee

SQLite is the serialization authority for the bundle, not a process-local
mutex. Two connections or two OS processes may race to submit the same exact
bundle; they converge idempotently on one canonical ledger. If they race with
different terminal decisions, only one transaction wins and the loser fails
closed.

Failpoint and real-process tests cover interruption:

- after reconcile insertion;
- after optional outcome insertion;
- after decision insertion;
- after transaction commit.

Every pre-commit interruption reopens as the original prepared T1 operation;
the complete bundle appears only after commit.

This is a **process-crash** guarantee. It does not claim that every acknowledged
commit survives sudden power loss or storage-controller failure. That stronger
durability claim would require an explicit SQLite synchronous policy, filesystem
contract, and platform crash matrix in a separate slice.

## Acceptance tests

PR A is complete only when production-shaped tests prove:

- all non-bundle writers reject reserved recovery facts;
- `completed` and `parked` converge identically in resolver, SQLite projection,
  reopen, and projection rebuild;
- kind, version, execution identity, canonical call-argument hash, causal order,
  successful outcome, and evidence references are validated;
- duplicate call, operation, and immutable event identities fail closed;
- exact multi-process retries converge and conflicting multi-process decisions
  produce a single winner;
- transaction failure at each bundle insertion boundary leaves no partial
  recovery fact or projection.

## Explicit exclusions

This PR does not include:

- continuation cursor or replay changes;
- recovery contract registries or automatic reconciliation;
- Write/Edit checkpoints, redo, CAS, or filesystem workers;
- Desktop/CLI resume wiring or owner lifecycle changes;
- Git carriers, restricted verification, retry, or reattach prototypes.

Those capabilities must arrive in later PRs with their own independently
testable invariants.
