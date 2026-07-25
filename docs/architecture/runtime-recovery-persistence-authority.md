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

A reconcile result records one bounded observation and whether it proved
`applied`, `not_applied`, `conflict`, or `still_running`.

A recovery decision is either:

- `completed`, which must cite a matching persisted tool outcome; or
- `parked`, whose reason must agree with the non-applied reconcile result.

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

Generic RuntimeEvent append, batch import, terminal durability, and the JSONL
store reject reserved recovery facts. Import or copy support must therefore
provide an identity-rewriting canonical bundle path in a later slice; it may
not bypass this authority.

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

Corruption is monotonic: later facts cannot restore automatic eligibility after
an earlier identity, duplication, or ordering violation.

## Disposable projections

`tool_operations` and `tool_journal_events` are query projections, not a second
ledger. They can be deleted and rebuilt from immutable RuntimeEvents.

Rebuild uses canonical `event_seq`, never timestamps or random event IDs, to
reconstruct the journal tail. It fails closed on:

- orphan, duplicate, or incomplete recovery facts;
- identity or evidence conflicts;
- completed decisions without a matching outcome;
- non-canonical physical event order.

## Schema capability

SQLite runtime schema 5 adds:

```text
runtime_capabilities(tool_recovery_bundle, version=1)
```

The store exposes `tool_recovery_bundle_v1` only after verifying that row.
Missing or incompatible capability data fails store construction. A populated
schema-4 database is migrated in place without rewriting immutable events.

## Explicit exclusions

This PR does not include:

- continuation cursor or replay changes;
- recovery contract registries or automatic reconciliation;
- Write/Edit checkpoints, redo, CAS, or filesystem workers;
- Desktop/CLI resume wiring or owner lifecycle changes;
- Git carriers, restricted verification, retry, or reattach prototypes.

Those capabilities must arrive in later PRs with their own independently
testable invariants.
