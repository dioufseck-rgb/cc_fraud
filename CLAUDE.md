# CLAUDE.md — Cognitive Core Framework

## Identity

Cognitive Core is a config-driven enterprise AI agent orchestration framework governed by two principles:

1. **A use case is a configuration, not an application.** Any workflow decomposable into the eight cognitive primitives deploys via YAML — no per-use-case application code.
2. **An LLM judgment is strongest when grounded in formal structure.** The analytics layer provides formal artifacts that primitives reason within, not just report from.

This file is the complete operating contract for autonomous development on this codebase. Read it fully before writing any code. Every section contains decisions already made — do not re-open them.

---

## Task Queue

Work through these in order. Do not skip ahead. Mark each complete only when all completion criteria pass. When a task is done, run the full test suite before moving to the next.

### TASK 1 — Wire PII redaction and cost tracking through protected_llm_call()
**Current state:** `PiiRedactor`, `SemanticCache`, `ProviderRateLimiter`, and `CostTracker` modules are implemented and tested in isolation. `protected_llm_call()` in `nodes.py` exists but does not call them.

**Target state:** Every LLM invocation in the framework passes through `protected_llm_call()` in this sequence:
1. PII entity scan → redact if entities found → cache lookup → rate limit check → invoke LLM → de-redact → cache store → cost record

**Completion criteria:**
- `protected_llm_call()` calls all four modules in the correct sequence
- A test confirms that a prompt containing a PII pattern (SSN, account number) is redacted before the LLM call and de-redacted in the response
- A test confirms that a cache hit bypasses the LLM call entirely
- A test confirms that a rate limit breach raises the correct exception without calling the LLM
- The proof ledger records a `pii_redaction_applied` event when redaction fires
- The proof ledger records a `cost_tracked` event after every successful LLM call
- No existing tests break

**Constraints:**
- Do not modify the PiiRedactor, SemanticCache, ProviderRateLimiter, or CostTracker module internals — wire them, do not change them
- De-redaction must happen before the result is written to workflow state — never store redacted text in step output
- If PII redaction fails, the call must not proceed — fail closed, not open

---

### TASK 2 — Wire shadow mode and kill switch to Act node
**Current state:** `ShadowModeManager` and `KillSwitchManager` are implemented. The Act node in `nodes.py` does not call either before execution.

**Target state:** Before every Act node execution:
1. Kill switch check fires — domain kill switch, Act kill switch, delegation kill switch all checked
2. Shadow mode check fires — if active, log intent and skip execution

**Completion criteria:**
- `should_skip_act()` is called before every Act node execution
- `check_delegation_allowed()` is called before every delegation dispatch
- A test confirms that an active Act kill switch prevents execution and records a `kill_switch_blocked` event in the proof ledger
- A test confirms that shadow mode logs the intended action with full parameters and returns without executing
- A test confirms that shadow mode does not affect workflow state — the step result is marked `shadow_skipped`, not failed
- The proof ledger records the correct event in both cases
- No existing tests break

**Constraints:**
- Kill switch check failure must suspend the workflow, not fail it — the instance moves to SUSPENDED with reason `kill_switch_active`, not FAILED
- Shadow mode must be transparent to downstream steps — they receive a structured placeholder result, not an error
- Do not modify KillSwitchManager or ShadowModeManager internals

---

### TASK 3 — Enforce eval gate at coordinator startup
**Current state:** `EvalGateModule` is implemented. The coordinator does not consult it at startup or when a new model configuration is detected.

**Target state:** At coordinator startup, and whenever the LLM provider configuration changes, the eval gate checks whether the active model has a passing evaluation pack registered. If not, the coordinator refuses to start in production mode.

**Completion criteria:**
- `check_start_gates()` in the coordinator calls the eval gate module
- A test confirms that a coordinator started with an unregistered model raises `EvalGateNotPassedError`
- A test confirms that a coordinator started with a registered, passing model starts normally
- A test confirms that `CC_EVAL_GATE_ENFORCED=false` bypasses the check with a warning logged (never silently)
- The proof ledger records an `eval_gate_checked` event at every startup
- No existing tests break

**Constraints:**
- The eval gate check is a startup invariant — it must fire before any workflow instance is accepted
- `CC_EVAL_GATE_ENFORCED=false` is a development override only — log a prominent warning when it is used
- Do not create a path where the gate is bypassed without an explicit environment variable

---

### TASK 4 — Implement analytics artifact registry
**Current state:** The analytics layer is designed in the spec but not implemented. No registry exists.

**Target state:** A runtime registry that:
- Loads artifact configurations from `config/analytics/registry.yaml` at startup
- Validates each artifact has required fields: `artifact_name`, `artifact_type`, `version`, `authored_by`, `eval_gate_passed`
- Supports artifact lookup by name
- Enforces eligibility predicates against case input at selection time
- Returns a typed selection result: `selected`, `abstained` (confidence below threshold), or `no_eligible_artifact`
- Records incompatibility declarations and rejects incompatible combinations at workflow start

**Completion criteria:**
- `AnalyticsRegistry` class loads and validates on startup
- A test confirms that an artifact missing required fields raises `InvalidArtifactError` at load time, not runtime
- A test confirms that eligibility predicates are evaluated correctly against case input
- A test confirms that a selection confidence below 0.75 (default) returns `abstained`, not a forced match
- A test confirms that an incompatible artifact pair registered in the registry raises `IncompatibleArtifactError` at workflow start
- A test confirms that `abstained` triggers the fallback sequence per `CC_ANALYTICS_FALLBACK`
- The proof ledger records `analytics_artifact_loaded` at workflow start for every registered artifact
- No existing tests break

**Constraints:**
- The registry is read-only at runtime — no runtime registration
- Eligibility predicates are boolean expressions over case fields — do not allow arbitrary code execution in predicates
- Selection confidence scoring is an LLM call scoped to artifact matching — it uses the `fast` model alias, not `strong`
- Abstention at `hold` tier escalates to human — never degrades silently at hold tier regardless of `CC_ANALYTICS_FALLBACK` setting

---

### TASK 5 — Wire investigate primitive to causal DAG artifacts
**Current state:** The `investigate` primitive executes as an LLM call with structured output. No causal DAG integration exists.

**Target state:** When a causal DAG artifact is registered for the `investigate` primitive in the domain YAML:
1. The artifact is loaded from the registry
2. The DAG structure is serialized and included in the LLM prompt alongside case facts
3. The LLM reasons within the DAG structure — identifying activated paths, alternative paths, unobserved nodes
4. The output schema carries the extended causal fields
5. If both pre-existing and data-derived DAGs are registered, both are included and the LLM performs integration reasoning

**Completion criteria:**
- When a causal artifact is registered, the investigate prompt includes the DAG structure in a structured `causal_context` block
- The primitive output schema includes: `causal_templates_invoked`, `dag_version`, `activated_paths`, `alternative_paths_considered`, `unobserved_nodes`, `evidential_gaps`, `dag_divergence_flag`, `integration_reasoning`
- A test confirms that without a registered artifact, investigate runs identically to v1 behavior
- A test confirms that with a registered artifact, the output schema includes all causal fields
- A test with a fixture DAG and fixture case confirms that activated paths are non-empty and reference valid DAG nodes
- The proof ledger records `dag_traversal_completed` after every investigate step with a causal artifact
- No existing tests break

**Constraints:**
- DAG structure passed to the LLM is read-only — the LLM cannot modify the DAG
- The DAG is serialized as structured JSON in the prompt, not as prose description
- If the DAG artifact fails to load, investigate falls back to v1 behavior and records a `analytics_fallback_applied` event — it does not fail the workflow
- Do not implement causal discovery pipeline in this task — that is a separate work area

---

### TASK 6 — Wire think primitive to SDA policy artifacts
**Current state:** The `think` primitive executes as an LLM call. No SDA policy integration exists.

**Target state:** When an SDA policy artifact is registered for the `think` primitive:
1. The policy configuration is loaded — policy class, horizon, reward specification
2. For `direct_lookahead` policy class: the decision tree structure is serialized and included in the LLM prompt
3. The LLM evaluates the policy recommendation against the causal finding from the preceding investigate step
4. The output schema carries the extended SDA fields including tension flags
5. If the policy recommendation and causal finding are in tension, the tension is flagged explicitly — not smoothed over

**Completion criteria:**
- When an SDA artifact is registered, the think prompt includes the policy structure and reward specification
- The primitive output schema includes: `policy_class`, `policy_version`, `reward_specification_version`, `decision_horizon`, `expected_value_by_horizon`, `policy_recommendation`, `causal_consistency_check`, `tension_flags`
- A test confirms that without a registered artifact, think runs identically to v1 behavior
- A test confirms that with a registered artifact, the output schema includes all SDA fields
- A test confirms that a policy recommendation that contradicts the causal finding produces a non-empty `tension_flags` field
- The proof ledger records `sda_policy_invoked` and — when tension exists — `causal_tension_flagged`
- No existing tests break

**Constraints:**
- The reward specification is read-only — the LLM cannot modify it
- Tension detection is mandatory when both investigate and think have registered artifacts — it cannot be configured off
- If the preceding investigate step did not run a causal artifact, `causal_consistency_check` is `not_applicable`, not an error

---

### TASK 7 — Restructure verify primitive to two-stage execution
**Current state:** The `verify` primitive executes as a single LLM call checking output against rules.

**Target state:** Verify runs in two explicit, sequentially recorded stages:

**Stage 1 — Evidence mapping (LLM):** The LLM reads case evidence and rule specification and produces structured characterizations of what the evidence shows about each rule variable. Output includes per-variable: `characterization`, `evidence_basis`, `confidence`, `ambiguity_flags`.

**Stage 2 — Rule evaluation (constraint checker):** Given the Stage 1 characterizations, the formal constraint checker evaluates each rule deterministically. PASS or FAIL per rule. No LLM involved in Stage 2.

**Completion criteria:**
- Verify execution produces two distinct recorded stages in the proof ledger
- Stage 1 output is a structured evidence characterization, not a compliance verdict
- Stage 2 output is a deterministic rule evaluation using only the Stage 1 characterizations as input
- The proof ledger records `evidence_mapping_recorded` after Stage 1 and `constraint_check_completed` after Stage 2 — as separate events with separate timestamps
- A test confirms that Stage 2 produces the same result given the same Stage 1 characterizations regardless of the LLM used
- A test confirms that `ambiguity_flags` in Stage 1 output triggers escalation when `ambiguity_escalation: gate` is configured in the domain YAML
- The proof ledger entry for Stage 1 includes the LLM version; Stage 2 includes the constraint checker version — these are kept distinct
- Without a registered constraint checker artifact, verify falls back to v1 single-stage behavior and records `analytics_fallback_applied`
- No existing tests break

**Constraints:**
- Stage 1 and Stage 2 must be recorded as separate proof ledger events — never merged into a single event
- The LLM is not consulted in Stage 2 under any circumstances
- Stage 1 characterizations are immutable once recorded — Stage 2 evaluates against the recorded characterizations, not a re-run

---

### TASK 8 — Implement Service Bus task queue adapter
**Current state:** Task queue is SQLite-backed polling. Governance tasks (human review requests, work orders, escalations) are not durable across coordinator restarts.

**Target state:** An Azure Service Bus adapter that:
- Sends governance tasks to a configured Service Bus queue on suspension
- Receives task completions and routes them to coordinator.resume()
- Guarantees at-least-once delivery with idempotency handling
- Falls back to SQLite polling when `DATA_SERVICE_BUS_URL` is not set

**Completion criteria:**
- `ServiceBusTaskQueueAdapter` implements the same interface as the SQLite adapter
- A test confirms that a suspended workflow's governance task appears in the Service Bus queue
- A test confirms that a duplicate task delivery does not double-process a completion
- A test confirms that when `DATA_SERVICE_BUS_URL` is unset, the system falls back to SQLite without error
- The proof ledger records which queue backend handled each governance task
- No existing tests break

**Constraints:**
- The Service Bus adapter and SQLite adapter must implement the same abstract interface — no caller code changes when switching backends
- Idempotency key is the `instance_id` + `resume_token` combination — never process the same combination twice
- Do not remove the SQLite adapter — it is the development and testing backend

---

## Repository Structure

```
cognitive_core/
├── config/
│   ├── analytics/
│   │   └── registry.yaml          # Analytics artifact registry — source of truth
│   ├── causal/                    # DAG structure files referenced by artifacts
│   ├── models.yaml                # Model aliases per provider
│   └── physics/                   # Physics class registry for dispatch optimizer
├── workflows/                     # Workflow YAML — step sequences and routing
├── domains/                       # Domain YAML — expertise, governance, analytics bindings
├── cases/                         # Case JSON — runtime data fixtures
├── src/
│   ├── engine/
│   │   ├── composer.py            # Merges three config layers, builds LangGraph graph
│   │   ├── stepper.py             # Step-by-step execution with callback interception
│   │   ├── nodes.py               # Primitive execution — ALL LLM calls go through here
│   │   ├── state.py               # Workflow state schema and resolver
│   │   └── llm_factory.py         # Provider-agnostic LLM factory
│   ├── coordinator/
│   │   ├── coordinator.py         # Lifecycle manager — start/resume/approve/reject
│   │   ├── delegation.py          # Delegation policy evaluation and child dispatch
│   │   ├── dispatch_optimizer.py  # OR-based resource assignment
│   │   └── hitl.py                # HITL state machine and SLA enforcement
│   ├── governance/
│   │   ├── pipeline.py            # Governance pipeline — 14 modules, 7 chokepoints
│   │   ├── proof_ledger.py        # Append-only execution record — never modify existing entries
│   │   ├── pii_redactor.py        # PII detection and redaction — TASK 1
│   │   ├── semantic_cache.py      # LLM response cache — TASK 1
│   │   ├── rate_limiter.py        # Provider rate limiting — TASK 1
│   │   ├── cost_tracker.py        # Per-call cost recording — TASK 1
│   │   ├── kill_switch.py         # Runtime toggleable stops — TASK 2
│   │   ├── shadow_mode.py         # Act node dry-run — TASK 2
│   │   ├── eval_gate.py           # Model change validation — TASK 3
│   │   ├── circuit_breaker.py     # Confidence-based tier escalation
│   │   ├── spec_lock.py           # Configuration manifest at instance start
│   │   └── compensation.py        # Act rollback registration
│   ├── analytics/
│   │   ├── registry.py            # Artifact registry — TASK 4
│   │   ├── selector.py            # Artifact selection with confidence scoring — TASK 4
│   │   ├── causal_dag.py          # DAG loader and serializer — TASK 5
│   │   ├── sda_policy.py          # SDA policy loader — TASK 6
│   │   └── constraint_checker.py  # Deterministic rule evaluation — TASK 7
│   └── persistence/
│       ├── store.py               # Coordinator persistence — SQLite/PostgreSQL
│       └── task_queue.py          # Task queue interface and adapters — TASK 8
└── tests/
    ├── unit/                      # Per-module unit tests
    ├── integration/               # Cross-module integration tests
    └── fixtures/                  # Case fixtures, DAG fixtures, domain/workflow YAML fixtures
```

---

## Invariants — Never Break These

These are structural properties of the platform enforced by the coordinator, governance pipeline, and execution engine. No change may violate them.

1. **No Act step executes without explicit policy clearance.** The kill switch manager is consulted before every Act node. If any kill switch is active, the step does not execute. There is no override path.

2. **Governance tiers move upward only.** Effective tier may be escalated by circuit breaker or input guardrail. It may never be de-escalated at runtime. A delegation policy that sets a child workflow's tier locks that tier.

3. **No gate-tier workflow finalizes without a recorded human decision.** A workflow at gate or hold suspends before Act and waits for `coordinator.approve()` or `coordinator.reject()`. Timeout is not approval.

4. **Every workflow instance starts with a locked configuration state.** The spec lock captures workflow YAML, domain YAML, schema versions, and analytics artifact versions at instance creation. Running instances are not affected by subsequent configuration changes.

5. **Every suspension preserves complete state.** The coordinator stores a complete state snapshot on suspension. Resumption reconstructs from the exact suspension point. No context is lost.

6. **Every formal analytics artifact invoked at runtime must have registered provenance.** Unregistered artifacts do not exist to the framework. There is no runtime registration path.

7. **No generated output with unattributed claims finalizes in a regulated workflow.** At gate or hold tier with a grounding artifact registered, unattributed claims block finalization until resolved or explicitly accepted by a human reviewer.

8. **Child workflow governance tiers may not be lower than the parent's effective tier.** A gate-tier parent cannot delegate to an auto-tier child. This invariant prevents governance weakening through the delegation chain.

---

## Coding Rules

**Architecture boundaries — never cross these:**
- All LLM calls go through `protected_llm_call()` in `nodes.py` — never call the LLM factory directly from outside the engine
- The proof ledger is append-only — never modify, delete, or reorder existing entries
- The spec lock is written once at instance creation — never updated after that point
- The coordinator is the only entry point for workflow lifecycle changes — never modify workflow state directly from outside the coordinator
- Analytics artifacts are read-only at runtime — no runtime modification of registered artifacts

**Schema rules:**
- Every primitive output must include the base fields: `confidence` (0.0–1.0), `reasoning`, `evidence_used`, `evidence_missing`
- New primitive output fields are always additive — never remove or rename existing fields
- Analytics layer fields are present when an artifact is registered, absent when not — never use sentinel values to indicate absence

**Testing rules:**
- Every wired module must have a test that confirms it fires in the correct sequence
- Every new proof ledger event type must have a test that confirms it is recorded with correct fields
- Every fallback path must have a test — do not assume the happy path covers it
- Fixture DAGs and fixture case data live in `tests/fixtures/` — never hardcode case data in tests
- Tests that require LLM calls use the `fast` model alias with a fixture response — never make live LLM calls in unit tests

**Default behaviors when uncertain:**
- When in doubt about a schema addition — add it, additive is always safe
- When in doubt about a governance module wiring order — wire more conservatively, earlier in the sequence
- When in doubt about fallback behavior — escalate, never degrade silently
- When in doubt about a test — write it, coverage is always better
- When in doubt about a proof ledger event — record it, the ledger is append-only so there is no cost to an extra event

**What never to do:**
- Never add a configuration option that bypasses an invariant — invariants are not configurable
- Never catch and swallow a governance exception — surface it, log it, let the coordinator handle it
- Never write to workflow state from outside the state resolver
- Never generate or evaluate a formal analytics artifact at runtime — load from registry only
- Never make a live LLM call in a test

---

## Primitive Execution Contract

Each primitive is a typed LLM call with a defined prompt template, Pydantic output schema, and analytics binding. The execution sequence for any primitive with a registered artifact is:

1. Load artifact from registry (fail → fallback sequence)
2. Build prompt — case context + artifact structure + primitive instruction
3. Call LLM via `protected_llm_call()`
4. Validate output against Pydantic schema
5. Record step result and proof ledger event
6. Return typed output to workflow state

Without a registered artifact, steps 1 and the artifact structure in step 2 are skipped. Everything else is identical.

| Primitive | Analytics Artifact | Key Output Fields Added in V2 |
|---|---|---|
| classify | Calibrated classifier | `classifier_score`, `confidence_interval`, `boundary_distance`, `override_flag` |
| retrieve | Entity resolution + analytical artifacts | `coverage_score`, `source_conflicts`, `artifact_provenance` |
| investigate | Causal DAG template | `activated_paths`, `alternative_paths_considered`, `unobserved_nodes`, `dag_divergence_flag`, `integration_reasoning` |
| think | SDA policy model | `policy_recommendation`, `expected_value_by_horizon`, `causal_consistency_check`, `tension_flags` |
| verify | Formal constraint checker | `rules_evaluated`, `evidence_characterizations`, `stage1_llm_version`, `stage2_checker_version` |
| challenge | Counterfactual engine | `fragility_score`, `flip_conditions`, `operational_significance_assessment` |
| generate | Fact grounding + language validator | `grounding_report`, `unattributed_claims`, `regulatory_language_compliance` |
| act | Policy engine + idempotency ledger | `authorization_check`, `idempotency_token`, `compensation_registered` |

---

## Proof Ledger Event Reference

The proof ledger is append-only. Record these events at the correct points. Never merge events that should be separate.

**Existing events (do not modify):**
- `workflow_started`, `step_completed`, `workflow_suspended`, `workflow_resumed`
- `governance_gate_fired`, `human_decision_recorded`, `kill_switch_checked`
- `delegation_dispatched`, `delegation_result_injected`
- `spec_lock_captured`, `circuit_breaker_escalation`

**V2 events (wire as tasks complete):**
- `pii_redaction_applied` — fires in TASK 1 when PII is detected and redacted
- `cost_tracked` — fires in TASK 1 after every successful LLM call
- `kill_switch_blocked` — fires in TASK 2 when kill switch prevents Act execution
- `shadow_mode_skipped` — fires in TASK 2 when shadow mode intercepts Act
- `eval_gate_checked` — fires in TASK 3 at coordinator startup
- `analytics_artifact_loaded` — fires in TASK 4 at workflow start per registered artifact
- `analytics_fallback_applied` — fires in TASKS 4-7 when artifact unavailable and primitive degrades
- `dag_traversal_completed` — fires in TASK 5 after investigate with causal artifact
- `sda_policy_invoked` — fires in TASK 6 during think with SDA artifact
- `causal_tension_flagged` — fires in TASK 6 when policy recommendation and causal finding conflict
- `evidence_mapping_recorded` — fires in TASK 7 after verify Stage 1
- `constraint_check_completed` — fires in TASK 7 after verify Stage 2

---

## Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `LLM_PROVIDER` | Force LLM provider | Auto-detect |
| `CC_DB_BACKEND` | Database backend | `sqlite` |
| `DATA_MCP_URL` | MCP data server URL | — |
| `CC_PII_ENABLED` | Enable PII redaction | `true` |
| `CC_SHADOW_MODE` | Skip Act steps, log intent | `false` |
| `CC_REPLAY_ENABLED` | Per-step checkpoint snapshots | `true` |
| `CC_SPEC_LOCK_ENABLED` | Capture config manifest at start | `true` |
| `CC_WEBHOOK_URL` | Webhook for governance suspension | — |
| `CC_ANALYTICS_REGISTRY_PATH` | Analytics artifact registry path | `config/analytics/registry.yaml` |
| `CC_CAUSAL_DISCOVERY_ENABLED` | Enable continuous causal discovery | `false` |
| `CC_EVAL_GATE_ENFORCED` | Require eval gate at startup | `true` |
| `CC_ANALYTICS_FALLBACK` | Behavior on artifact unavailable: `skip` \| `escalate` \| `fail` | `escalate` |
| `CC_DAG_DIVERGENCE_THRESHOLD` | DAG structural divergence fraction that triggers review flag | `0.15` |
| `CC_ANALYTICS_SELECTION_THRESHOLD` | Minimum confidence for artifact selection | `0.75` |
| `DATA_SERVICE_BUS_URL` | Azure Service Bus connection string | — |

---

## Known Gaps — Do Not Work Around

These are documented incomplete items. Implement them in task order. Do not build workarounds that would need to be removed later.

| Gap | Status | Task |
|---|---|---|
| PII redactor not wired to `protected_llm_call()` | Implemented, not wired | TASK 1 |
| Cost tracker not wired to `protected_llm_call()` | Implemented, not wired | TASK 1 |
| Shadow mode not wired to Act node | Implemented, not wired | TASK 2 |
| Kill switch not wired to Act node | Implemented, not wired | TASK 2 |
| Eval gate not enforced at coordinator startup | Implemented, not wired | TASK 3 |
| Analytics artifact registry does not exist | Not implemented | TASK 4 |
| Investigate primitive has no DAG integration | Not implemented | TASK 5 |
| Think primitive has no SDA integration | Not implemented | TASK 6 |
| Verify primitive is single-stage | Not restructured | TASK 7 |
| Service Bus task queue adapter does not exist | Not implemented | TASK 8 |
| Federation parent escalation path not exercised | Partially implemented | Post-TASK 8 |
| Causal discovery pipeline not implemented | Not implemented | Post-TASK 8 |

---

## Artifact Template Reference

### Causal DAG artifact (minimum required fields)

```yaml
artifact_name: causal.<name>_v<n>
artifact_type: causal_dag
version: "1.0"
authored_by: <team>
last_reviewed: "YYYY-MM-DD"
eval_gate_passed: "YYYY-MM-DD"
eligibility_predicates:
  - field: domain
    operator: eq
    value: <domain_name>
dag_config:
  structure_file: config/causal/<name>.json
  variable_scope: []
  adjustment_set: []
  primary_outcome: <outcome_variable>
data_derived:
  enabled: false
```

### SDA policy artifact (minimum required fields)

```yaml
artifact_name: sda.<name>_v<n>
artifact_type: sequential_decision
version: "1.0"
authored_by: <team>
eval_gate_passed: "YYYY-MM-DD"
eligibility_predicates:
  - field: domain
    operator: eq
    value: <domain_name>
sda_config:
  policy_class: direct_lookahead
  horizon: 3
  reward_specification:
    correct_decision: 1.0
    incorrect_decision: -1.0
    regulatory_violation: -5.0
```

### Constraint checker artifact (minimum required fields)

```yaml
artifact_name: constraints.<name>_v<n>
artifact_type: constraint_checker
version: "1.0"
authored_by: <team>
eval_gate_passed: "YYYY-MM-DD"
eligibility_predicates:
  - field: domain
    operator: eq
    value: <domain_name>
rules: []
mapping_guidance:
  variables: []
ambiguity_escalation: gate
```

---

## Domain YAML — Analytics Block

Optional. When absent, all primitives run as v1. When present, named artifacts are loaded at workflow start and their versions are captured in the spec lock.

```yaml
analytics:
  investigate:
    artifact: causal.<name>_v<n>
    dag_origin: pre_existing        # pre_existing | data_derived | both
    divergence_threshold: 0.15
  think:
    artifact: sda.<name>_v<n>
    policy_class: direct_lookahead  # direct_lookahead | cfa | vfa | pfa
    horizon: 3
    reward_spec: <reward_artifact_name>
  verify:
    artifact: constraints.<name>_v<n>
    mapping_guidance: <mapping_artifact_name>
    ambiguity_escalation: gate      # gate | hold | escalate
  generate:
    artifact: grounding.<name>_v<n>
```

---

## When You Are Done With All Tasks

Run the full test suite. Confirm all proof ledger event types from the V2 event list above are covered by at least one test. Run a complete fraud investigation workflow end-to-end using the fixture case and confirm the proof ledger contains: `spec_lock_captured`, `analytics_artifact_loaded`, `dag_traversal_completed`, `sda_policy_invoked`, `evidence_mapping_recorded`, `constraint_check_completed`, `governance_gate_fired`, and `human_decision_recorded` — in that order for a gate-tier workflow.

If any event is missing from the end-to-end proof ledger, trace the gap and fix it before declaring the work complete.
