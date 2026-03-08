# Cognitive Core — Framework State Document

> **Scope:** Framework internals only. The fraud demo (`fraud_demo/`) is excluded.
> **Date:** 2026-03-06

---

## 1. What the Framework Is

Cognitive Core is a config-driven enterprise AI agent orchestration framework. It decomposes any workflow into sequences of eight reusable **cognitive primitives**, each backed by a prompt template and a Pydantic output schema. A new use case requires only:

- A **workflow YAML** — step sequence, transitions, loop controls
- A **domain YAML** — expertise injected into prompts via `${domain.*}` references
- A **case JSON** — runtime data available as tool calls

No application code is written per use case. The framework's core principle: **a use case is a configuration, not an application**.

---

## 2. Repository Layout

```
cc_fraud/
├── engine/          # Workflow execution engine (LangGraph + LLM)
├── coordinator/     # Orchestration state machine, governance, delegation
├── registry/        # Primitive definitions, prompt templates, output schemas
├── api/             # FastAPI REST server + SPA static files
├── ui/              # Single-page application (vanilla JS)
├── workflows/       # Framework-level example workflows (insurance, disputes)
├── domains/         # Framework-level example domain configs
├── cases/           # Framework-level example case data
└── servers/         # MCP server support (placeholder)
```

---

## 3. Three-Layer Configuration Architecture

Every workflow execution merges three independent layers:

| Layer | Source | Purpose |
|-------|--------|---------|
| Workflow | `workflows/<name>.yaml` | Step sequence, transition logic, loop bounds |
| Domain | `domains/<name>.yaml` | Domain expertise, governance tier, tool specs |
| Runtime data | `cases/<id>.json` | Case-specific data served as tool calls |

**Merge entry point:** `engine/composer.py` → `load_three_layer(workflow_path, domain_path, case_path)` returns a `(merged_config, case_input)` tuple.

Domain references (`${domain.section.field}`) are resolved at merge time. Runtime references (`${step_name.field}`, `${input.field}`, `${input.delegation.workflow_type}`) are resolved at execution time by the engine's state resolver.

---

## 4. Eight Cognitive Primitives

Defined in `registry/primitives.py`. Each has a prompt in `registry/prompts/<name>.txt` and a Pydantic schema in `registry/schemas.py`.

| Primitive | Purpose | Required Params | Key Output Fields |
|-----------|---------|-----------------|-------------------|
| `classify` | Categorize input | `categories`, `criteria` | `category`, `confidence`, `reasoning` |
| `retrieve` | Call data tools and assess results | `specification` | `data`, `sources`, `record_count` |
| `investigate` | Deep analysis with evidence | `question`, `scope` | `finding`, `confidence`, `evidence_flags` |
| `think` | Reason and decide; can emit resource_requests | `instruction` | `decision`, `confidence`, `reasoning`, `resource_requests` |
| `verify` | Check against rules | `rules` | `conforms`, `rules_checked`, `findings` |
| `challenge` | Adversarial review | `perspective`, `threat_model` | `survives`, `strengths`, `vulnerabilities` |
| `generate` | Produce artifacts (reports, letters, actions) | `requirements`, `format`, `constraints` | `content`, `format` |
| `act` | Execute side-effecting actions | `action`, `parameters` | `action_taken`, `result` |

All schemas extend `BaseOutput`, which carries `confidence` (0.0–1.0), `reasoning`, `evidence_used`, and `evidence_missing`.

### Prompt Contract

- Templates use `{param_name}` placeholders; filled at runtime from merged domain + step params.
- All prompts request JSON-only output.
- Every primitive prompt includes an auto-populated `{context}` param built from accumulated workflow state.
- `{additional_instructions}` is an optional override on every primitive for domain-specific injection.

---

## 5. Engine Layer (`engine/`)

The engine translates merged config into executable LangGraph graphs and manages step-by-step execution.

### 5.1 Composer (`engine/composer.py`)

**Responsibilities:**
- `load_three_layer()` — load and merge workflow + domain + case
- `merge_workflow_domain()` — resolve `${domain.*}` refs into step params; handles both sequential and agentic modes
- `validate_use_case()` — check step name uniqueness, transition targets, loop_fallback presence
- `compose_workflow()` — build a LangGraph `StateGraph` from merged config
- `compose_subgraph()` — build a subgraph from a named resume step forward (for mid-graph resume)
- `run_workflow()` / `run_workflow_from_step()` — convenience wrappers

**Routing types supported:**
- Simple linear edges (no `transitions` key or `[{default: X}]`)
- Conditional edges (`when: output.field == value`)
- Agent-decided routing (`agent_decide:` with LLM-selected options)
- Loop with max_loops + loop_fallback escape

### 5.2 Stepper (`engine/stepper.py`)

Replaces single `.invoke()` with step-by-step streaming via LangGraph's `.stream()` API. Enables the coordinator to intercept between steps.

**Key types:**
- `StepInterrupt` — signal to pause execution at a step with optional resource_requests
- `StepResult` — completed or interrupted execution result
- `StepCallback` — callable `(step_name, step_output, state) → StepInterrupt | None`

**Built-in callbacks:**
- `no_interrupt_callback` — forward-only, never pauses
- `resource_request_callback` — pauses if any step output contains `blocking=True` resource_requests; filters already-fulfilled needs to prevent re-dispatch loops
- `combined_callback(*callbacks)` — chains multiple callbacks, returns first interrupt

**Key functions:**
- `step_execute()` — execute a full workflow with interception
- `step_resume()` — resume a suspended workflow from a named step with interception

### 5.3 Nodes (`engine/nodes.py`)

LangGraph node factory. Every step in the graph is a closure returned by one of:

- `create_node(step_name, primitive_name, params, model, temperature)` — for all non-retrieve, non-act primitives
- `create_retrieve_node(step_name, params, tool_registry, ...)` — calls registered tools, assembles results, passes to LLM for quality assessment
- `create_act_node(step_name, params, action_registry, ...)` — executes side-effecting actions via registered action handlers
- `create_agent_router(step_name, agent_config, model)` — LLM-based conditional routing node

Nodes call `engine/llm.py:create_llm()` for all LLM calls. All calls are traced via `engine/trace.py`.

### 5.4 State (`engine/state.py`)

LangGraph `WorkflowState` TypedDict:

```python
class WorkflowState(TypedDict):
    input: dict[str, Any]
    steps: Annotated[list[StepResult], operator.add]   # append reducer
    current_step: str
    metadata: dict[str, Any]
    loop_counts: dict[str, int]
    routing_log: Annotated[list[RoutingDecision], operator.add]  # append reducer
```

Key helpers: `resolve_param()` — resolves `${step_name.field}`, `${input.field}`, `${input.delegation.*}`, `${_loop_count}`, `${_last_primitive.field}` at runtime from state.

### 5.5 Tools (`engine/tools.py`)

Three-tier tool resolution (priority order):

1. **MCP server** — if `DATA_MCP_URL` or `DATA_MCP_CMD` env vars are set
2. **Case JSON tools** — if `case_input` has `get_*` keys with embedded data
3. **Fixture files** — scans `<case_dir>/fixtures/*_tools.json` matching by `_case_id` or `_claim_id`

`create_case_registry(case_input, fixtures_dir)` — builds a `ToolRegistry` from case data. The coordinator passes its configured `case_dir` to this function; child delegation workflows resolve their tools from fixtures by case/claim ID.

### 5.6 LLM Provider (`engine/llm.py`)

Single provider-blind factory. Every module calls `create_llm()` exclusively.

**Supported providers:**
| Provider | Key | Requires |
|----------|-----|---------|
| Google Gemini | `google` | `GOOGLE_API_KEY` |
| Azure OpenAI | `azure` | `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` |
| Azure AI Foundry | `azure_foundry` | `AZURE_AI_FOUNDRY_ENDPOINT` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Amazon Bedrock | `bedrock` | AWS credentials |

Provider selection priority: `LLM_PROVIDER` env var → `default_provider` in `llm_config.yaml` → auto-detect from API key env vars.

Model aliases (`default`, `fast`, `standard`, `strong`) are resolved per-provider from `llm_config.yaml`. Provider-specific model names (e.g., `gpt-4o`, `gemini-2.0-flash`) pass through unchanged.

### 5.7 Agentic Mode (`engine/agentic.py`)

An alternative execution mode where a central orchestrator LLM decides which primitive to invoke next. Hub-and-spoke LangGraph structure:

```
orchestrator → retrieve → orchestrator
             → classify → orchestrator
             → investigate → orchestrator
             → ...
             → END
```

The orchestrator sees accumulated state and selects the next primitive, step name, and params dynamically. Enabled by setting `mode: agentic` in the workflow YAML. Domain config provides available primitive definitions under a `primitives:` key.

### 5.8 Resume (`engine/resume.py`)

`prepare_resume_state()` — reconstructs workflow state for mid-graph re-entry after a `wait_for_result` delegation completes. Prior step outputs are preserved; delegation results are injected under `input.delegation.<workflow_type>`.

`collect_reachable_steps()` + `clamp_transitions()` — support `compose_subgraph()` by identifying which steps are reachable from a resume point.

### 5.9 Database (`engine/db.py`)

`DatabaseBackend` abstract interface with SQLite (dev) and PostgreSQL (prod) implementations. Selected via `CC_DB_BACKEND` env var. Handles:
- Parameter placeholder translation (`?` → `%s` for Postgres)
- `AUTOINCREMENT` → `SERIAL`
- Row factory for dict-like access
- Thread-safe connection via `check_same_thread=False` + `RLock` (SQLite)
- Transaction context manager

### 5.10 Other Engine Modules

| Module | Purpose | Status |
|--------|---------|--------|
| `engine/actions.py` | ActionRegistry for `act` primitive | Implemented |
| `engine/compensation.py` | Compensation ledger — register and reverse Act side effects | Implemented |
| `engine/cost.py` | Token and dollar cost tracking per step/workflow | Implemented |
| `engine/eval_gate.py` | Model versioning gate — eval packs before model changes | Implemented |
| `engine/governance.py` | HITL governance state helpers | Implemented |
| `engine/guardrails.py` | Prompt injection defense (regex + optional LLM classifier) | Implemented |
| `engine/health.py` | Health check endpoint helpers | Implemented |
| `engine/hitl_state.py` / `hitl_routing.py` | HITL gate state and routing | Implemented |
| `engine/kill_switch.py` | Runtime-toggleable: disable Act, delegation, domains/workflows/policies | Implemented |
| `engine/logging.py` | Structured logging setup | Implemented |
| `engine/logic_breaker.py` | Circuit breaker for LLM calls | Implemented |
| `engine/pii.py` | PII redaction/de-redaction at LLM call chokepoint | Implemented |
| `engine/providers.py` | Provider registry helpers | Implemented |
| `engine/rate_limit.py` | Token/request rate limiting | Implemented |
| `engine/replay.py` | Checkpoint snapshots per step; replay from any point | Implemented |
| `engine/retry.py` | Retry logic for LLM calls | Implemented |
| `engine/secrets.py` | Secret resolution (env, vault) | Implemented |
| `engine/semantic_cache.py` | Two-layer cache: exact hash + vector similarity | Implemented |
| `engine/settlement.py` | Financial settlement helpers | Implemented |
| `engine/shadow.py` | Shadow mode — run pipeline, skip Act, log what it would have done | Implemented |
| `engine/spec_lock.py` | Spec/schema lock for breaking-change detection | Implemented |
| `engine/tier.py` | Governance tier resolution helpers | Implemented |
| `engine/trace.py` | Distributed tracing integration | Implemented |
| `engine/validate.py` | Config validation helpers | Implemented |
| `engine/webhooks.py` | Webhook dispatch for external integrations | Implemented |

> **Note:** Many of these modules are implemented but not yet wired into the main execution path. They are designed as opt-in production hardening layers.

---

## 6. Coordinator Layer (`coordinator/`)

The coordinator is the fourth architectural layer — a DEVS-style state machine managing workflow instance lifecycle across governance tiers, delegation chains, and suspension/resumption.

### 6.1 Runtime (`coordinator/runtime.py`)

The `Coordinator` class (~3,200 lines). Manages multi-workflow execution through four operations:

```python
coordinator.start(workflow_type, domain, case_input,
                  lineage=[], correlation_id="",
                  governance_tier_override="") → instance_id

coordinator.resume(instance_id, resume_token, external_input) → result | suspended

coordinator.approve(instance_id, approver, notes) → instance_id

coordinator.reject(instance_id, rejector, reason) → instance_id
```

**Internal lifecycle:**
- `_on_completed()` — evaluates all delegation policies after workflow completion; fires matching delegations
- `_on_interrupted()` — handles DDD `resource_requests` (backward chaining); creates work orders, suspends parent
- `_execute_delegation()` — dispatches child workflows (fire_and_forget or wait_for_result)
- `_resume_after_delegation()` — injects delegation results, resumes suspended parent at `resume_at_step`
- `_build_tool_registry()` — resolves tools via three-tier lookup (MCP → case JSON → fixtures)

**Safety features wired in:**
- `MAX_DELEGATION_DEPTH = 20` — prevents policy loops
- Governance tier locking — tier set by delegation policy `governance_tier_override` cannot be escalated
- Stale instance cleanup on coordinator startup
- Optional: optimizer, resilience layer, hardening layer, federation spoke (all gracefully degrade if deps missing)

### 6.2 Policy Engine (`coordinator/policy.py`)

Purely deterministic — no LLM calls. Evaluates governance tiers and delegation conditions.

**Governance tiers:**

| Tier | HITL | Sample Rate | Queue | SLA |
|------|------|-------------|-------|-----|
| `auto` | none | 0% | — | — |
| `spot_check` | post_completion | 10% | qa_review | 2h |
| `gate` | before_act | 100% | specialist_review | 4h |
| `hold` | before_finalize | 100% | compliance_review | 48h |

**Delegation policy evaluation:**

Selectors for matching step output:
- `step:<name>` — specific named step
- `last_<primitive>` — most recent step of that type
- `any_<primitive>` — any step of that type (first match)
- `all_<primitive>` — all steps of that type must match
- `final_output` — last step regardless of type

Operators: `eq`, `exists`, `gte`, `contains_any`

Input resolution: `${source.step:step_name.field}`, `${source.last_<prim>.field}`, `${source.input.field}`

### 6.3 Types (`coordinator/types.py`)

Core data structures:

- `InstanceState` — registry entry per workflow instance (`instance_id`, `workflow_type`, `domain`, `status`, `lineage`, `correlation_id`, `governance_tier`, `governance_tier_locked`, `result`)
- `InstanceStatus` — `CREATED | RUNNING | SUSPENDED | COMPLETED | FAILED | TERMINATED`
- `WorkOrder` — a delegation request (`work_order_id`, `requester_instance_id`, `contract_name`, `inputs`, `handler_workflow_type`, `status`, `result`)
- `WorkOrderStatus` — `CREATED | QUEUED | DISPATCHED | RUNNING | COMPLETED | FAILED | EXPIRED | CANCELLED`
- `Suspension` — everything needed to resume a paused instance (`state_snapshot`, `unresolved_needs`, `work_order_ids`, `resume_nonce`)
- `GovernanceTier` / `GovernanceTierConfig` — enum + config for the four tiers
- `DelegationPolicy` / `DelegationCondition` — config-driven delegation rules
- `Contract` / `ContractField` — versioned interface schema for cross-workflow delegation
- `Capability` — maps a need type to a provider (workflow, human queue, or external service)

### 6.4 Store (`coordinator/store.py`)

`CoordinatorStore` — database-backed persistence for all coordinator state. Tables:

- `instances` — workflow instance registry
- `suspensions` — suspended instance state snapshots (JSON-serialized)
- `work_orders` — delegation work orders
- `action_ledger` — audit trail of all coordinator actions
- `task_queue` — human task records (governance approvals, spot checks)

Uses `engine/db.py` backend (SQLite dev, Postgres prod). Supports explicit transaction context managers.

### 6.5 Task Queue (`coordinator/tasks.py`)

Abstract `TaskQueue` interface for routing governance approvals and work orders to external consumers.

**Implementations:**
- `InMemoryTaskQueue` — dev/test, same process
- `SQLiteTaskQueue` — Phase 2, polling from DB (current production mode)
- `ServiceBusAdapter` / `WebhookAdapter` — Phase 4 (not yet implemented)

**Task types:** `GOVERNANCE_APPROVAL`, `SPOT_CHECK_REVIEW`, `HUMAN_DECISION`, `WORK_ORDER`, `ESCALATION`, `NOTIFICATION`, `RESOURCE_REQUEST`

### 6.6 CLI (`coordinator/cli.py`)

`python -m coordinator.cli [--config path] <command>`:

```
run     --workflow <type> --domain <name> --case <path> [-v]
approve <instance_id> --approver <name> [--notes <text>]
reject  <instance_id> --rejector <name> --reason <text>
stats                      # coordinator statistics
chain   <instance_id>      # correlation chain
ledger  [--instance | --correlation <id>]  # audit log
```

### 6.7 Other Coordinator Modules

| Module | Description |
|--------|-------------|
| `coordinator/contracts.py` | Contract validation helpers |
| `coordinator/evidence.py` | Evidence store bridge for SAR workflows |
| `coordinator/sar_integration.py` | BSA/AML SAR investigation integration — `build_case_input()` constructs rich case_input from evidence tables; `capture_workflow_outputs()` writes step outputs back |
| `coordinator/escalation.py` | Builds structured escalation briefs for HITL gates: what the case is about, what automation determined, what it was unsure of, and specific questions for the reviewer |
| `coordinator/federation.py` | Hierarchical coordinator federation — child coordinators own their workflows/domains/resources; unresolvable needs escalate to parent; global policies enforced at parent level |

---

## 7. Resource Management and Dispatch Optimization

The coordinator ships a full resource management stack implementing the **DDD Unified Specification v1.1**. It is pure logic — no I/O — and is an optional layer that the coordinator runtime instantiates if its dependencies are present.

### 7.1 Work Order Lifecycle (`coordinator/ddd.py` — Section 3)

`DDDWorkOrder` extends the basic `WorkOrder` with a formal 8-state machine and typed errors.

**States:**
```
CREATED → DISPATCHED → CLAIMED → IN_PROGRESS → COMPLETED
                   ↘ EXPIRED                ↘ FAILED
               (any non-terminal) → CANCELED
```

Transitions are enforced; invalid transitions raise `InvalidTransition`. Key fields beyond the basic work order:
- `priority` — `critical | high | routine`
- `depends_on` — list of prerequisite work_order_ids
- `claim_ttl_seconds` — if dispatched but not claimed within TTL, becomes eligible for reaper
- `attempt` / `max_attempts` — retry tracking
- `quality_flag` — `normal | degraded` (for graceful degradation)

**Error classification:**
- `RETRYABLE` — transient failures (timeout, stale data)
- `PERMANENT` — schema violations, authorization denied
- `DEGRADED` — partial results accepted

**Retry policy** — configurable per capability: `constant | linear | exponential` backoff with `base_delay`, `max_delay`, retryable/non-retryable error code lists.

**Resume policy** on parent workflow when multiple work orders are pending:
- `ALL_OR_ABORT` — all must complete
- `BEST_EFFORT` — resume with whatever completed
- `QUORUM` — configurable majority threshold

### 7.2 Capacity Models (`coordinator/ddd.py` — Section 6)

Three models, unified in `CapacityState`. The optimizer queries `can_accept()` before assigning; `on_assign()` / `on_release()` maintain live state.

| Model | Use Case | Key Fields |
|-------|----------|------------|
| `SLOT` | Concurrent execution limit (e.g., analyst handles 5 cases at once) | `max_concurrent`, `current_load` |
| `VOLUME` | Throughput ceiling (e.g., 1000 API calls/hour) | `max_volume`, `current_volume`, `unit` |
| `BATCH` | Group-and-fire execution (e.g., SAR batch filing) | `batch_threshold`, `batch_timeout_seconds`, `batch_items` |

**Batch model triggers (OR logic):**
1. Item count reaches `batch_threshold`
2. Time since first item reaches `batch_timeout_seconds` (with at least 1 item)

`utilization_pct` is available on all models for monitoring.

### 7.3 Capacity Reservation Protocol (`coordinator/ddd.py` — Section 8)

Prevents double-assignment between eligibility check and dispatch confirmation. Lifecycle:

```
HELD → COMMITTED  (dispatch confirmed)
HELD → RELEASED   (dispatch failed or cancelled)
HELD → EXPIRED    (TTL exceeded, capacity returned)
```

`CapacityReservation` fields: `reservation_id`, `resource_id`, `work_order_id`, `amount`, `ttl_seconds` (default 30s). Commit and release are both idempotent.

### 7.4 Resource Registry and Eligibility (`coordinator/ddd.py` — Section 5/9)

`ResourceRegistry` manages resource registrations and enforces hard eligibility predicates before ranking.

**Separation of concerns (Spec Section 9):**
- **Eligibility** — hard boolean predicates (`EligibilityConstraint`): licensing, conflict-of-interest, geographic restrictions. A resource that fails any predicate is excluded entirely and an audit reason is recorded.
- **Ranking** — soft scoring (`RankingScore`): feature scores aggregated into a total score for the optimizer cost matrix.

### 7.5 Circuit Breaker (`coordinator/ddd.py` — Section 17.3)

Per-resource `CircuitBreakerState` with three states: `closed | open | half_open`.

| State | Behavior |
|-------|---------|
| `closed` | Normal operation; outcomes recorded into sliding window |
| `open` | No new work dispatched; cooldown timer running |
| `half_open` | One probe allowed; success → `closed`, failure → `open` |

Configuration: `window_size` (default 20), `open_threshold` (default 50% failure rate), `cooldown_seconds` (default 15 min), `backoff_multiplier` with `max_cooldown_seconds` (default 4h).

### 7.6 Batch Reaper (`coordinator/ddd.py` — Section 17.1)

When a batch enters `EXECUTING` and exceeds `max_execution_duration_seconds` (default 4h), the reaper fires. Configurable `reaper_action`:
- `FAIL` — mark batch failed, release work orders
- `RETRY_ONCE` — single retry attempt
- `REDISTRIBUTE` — return items to collecting pool

`check_reaper()` returns `True` when the timeout is exceeded; the coordinator polls this on a schedule.

### 7.7 Dispatch Optimizer (`coordinator/optimizer.py` — Sections 9, 14, 17.2, 17.4)

`DispatchOptimizer` is the main pipeline entry point. It wires eligibility → physics → solver → exploration → reservation into a single `dispatch(work_orders, workflow, domain, config)` call.

**Five-stage pipeline:**

```
Stage 0: Eligibility filter
         ResourceRegistry.filter_eligible() → eligible set + exclusion audit trail

Stage 1: Physics binding
         PhysicsClass.extract_parameters(work_orders, eligible, config)
         → AssignmentParams (cost matrix, capacity vector)

Stage 2: Solve
         ArchetypeSolver.solve(params, time_budget) → ArchetypeSolution
         Falls back to greedy_solve() if solver times out or errors

Stage 3: Interpret + build decisions
         PhysicsClass.interpret_solution(solution, work_orders, eligible, costs)
         → Assignment list (work_order_id → resource_id + scores)

Stage 4: Exploration overlay
         Epsilon-greedy: new resources get a chance beyond their cost score
         Gates: only for routine/high SLA; never critical

Stage 5: Reserve capacity + audit
         ResourceRegistry.reserve() → CapacityReservation
         commit_reservation() on success; release on failure
         Returns list[DispatchDecision] with full audit trail
```

Every `DispatchDecision` carries: `selected_resource_id`, `reservation_id`, `tier` (`optimal | fallback | no_eligible_resources | no_solution`), `eligibility_results`, `ranking_scores`.

### 7.8 Domain Physics (`coordinator/physics.py` — Sections 11, 13)

Physics classes are the **only** place domain knowledge enters the optimization pipeline. The archetype solver is domain-agnostic.

**Boundary Rule (Section 11):** Physics classes live in Python, not YAML. YAML carries only objective weights and governance thresholds.

`OptimizationConfig` — parsed from domain YAML `optimization:` section:
```yaml
optimization:
  archetype: assignment
  physics: default
  objectives:
    minimize_cost: 0.3
    minimize_wait_time: 0.5
    minimize_sla_risk: 0.2
  solver_time_budget_seconds: 5.0
  greedy_fallback: true
  exploration_enabled: true
  maturity_threshold: 10      # dispatches before exploration kicks in
  base_epsilon: 0.10
  max_exploration_pct: 0.15
  exploration_sla_gate: [routine, high]
```

`DefaultAssignmentPhysics` — ships with the framework. Custom physics classes registered in `PHYSICS_REGISTRY`.

**Adaptive bounds (Section 15):** `cfa_bounds` cap how much the learning layer can adjust objective weights (30% cost, 25% wait, 20% SLA) to prevent runaway adaptation.

### 7.9 Optimization Archetypes (`coordinator/archetypes.py` — Sections 12, 14)

Each archetype is a mathematical model template — domain-agnostic, operating on abstract cost matrices and constraint vectors.

| Archetype | Problem | Solver |
|-----------|---------|--------|
| `assignment` | Bipartite W×R assignment, capacity constraints | Hungarian (≤50×50) / greedy fallback — **pure Python, ships today** |
| `vrp` | Vehicle Routing Problem | Requires Pyomo + CBC/Gurobi |
| `job_shop` | Job Shop Scheduling | Requires Pyomo |
| `flow_network` | Flow Network optimization | Requires Pyomo |
| `knapsack` | Knapsack / packing | Requires Pyomo |
| `coverage` | Set Coverage | Requires Pyomo |

**Assignment solver details:**
- Small instances (W×R ≤ 2,500, W ≤ 50): modified Jonker-Volgenant algorithm (O(n³))
- Large instances: greedy best-fit (O(W×R log R))
- Capacity expansion: resource j with capacity 3 is expanded into 3 virtual columns so the standard square assignment algorithm applies
- Production swap: solver method replaced by Pyomo model dispatch to CBC or Gurobi via configuration; interface is identical

`ArchetypeSolution` output: `assignments` (list of (work_order_idx, resource_idx) tuples), `unassigned`, `objective_value`, `solver_status` (`optimal | feasible | infeasible | timeout`), `solve_time_ms`, `solver_name`.

### 7.10 Production Hardening (`coordinator/hardening.py`)

| Component | Purpose |
|-----------|---------|
| `DDREligibilityEntry` / `DDRCandidateScore` | DDR audit trail entries for eligibility and ranking decisions |
| `build_ddr()` | Constructs a DDR (Dispatch Decision Record) combining eligibility + ranking into a single audit artifact |
| `PartialFailureHandler` | Evaluates `ResumePolicy` when some work orders in a batch complete and others fail; determines whether to resume parent with partial results or abort |
| `PartialFailurePolicy` | `ABORT_ON_ANY | PROCEED_WITH_AVAILABLE | WAIT_FOR_QUORUM` |
| `FailureAction` | `ABORT | PROCEED | WAIT` — returned to coordinator runtime |
| `ReservationEventLog` | Append-only log of reservation lifecycle events (acquire, commit, release, expire) for capacity audit |
| `LearningScopeEnforcer` | Enforces CFA bounds on objective weight adjustments; rejects proposed weights that exceed `cfa_bounds` thresholds |

---

## 8. Governance Pipeline (`engine/governance.py`)

The governance pipeline is the production safety and compliance layer. It is a **singleton** (`get_governance()`) that wires fourteen specialized modules into seven **chokepoints** called from `nodes.py` and `runtime.py`. Every module is optional — initialization failures produce warnings and disable the module gracefully; the pipeline never blocks execution due to a module failure.

### 8.1 Architecture

```
GovernancePipeline (singleton)
  ├── InputGuardrail          — prompt injection detection on case_input
  ├── PiiRedactor             — PII masking before LLM call, de-masking after
  ├── SemanticCache           — LLM response dedup (exact hash + vector similarity)
  ├── ProviderRateLimiter     — per-provider concurrency + RPM control
  ├── CostTracker             — token + dollar cost accounting per step/workflow
  ├── LogicCircuitBreaker     — confidence monitoring → automatic tier escalation
  ├── KillSwitchManager       — runtime emergency stop on domains/workflows/act/delegation
  ├── ShadowMode              — dark launch (run full pipeline, skip Act, log intent)
  ├── CompensationLedger      — register Act side effects; reverse on failure
  ├── WebhookNotifier         — notify external systems on governance suspension
  ├── ReplayManager           — checkpoint state after every step
  ├── SpecManifest            — config hash captured at instance start
  ├── RoutingManager          — capability-based HITL task routing
  └── HITLStateMachine        — review lifecycle state machine with SLA enforcement
```

**Proof ledger** — every governance decision is appended to a thread-safe in-memory `_proof_ledger` with timestamp, event type, and decision details. `gov.proof()` returns the full audit artifact for any run: which modules were active, what was checked, what was decided.

### 8.2 Seven Chokepoints

| Chokepoint | Caller | What it does |
|-----------|--------|-------------|
| `protected_llm_call()` | `engine/nodes.py` at every `llm.invoke()` | PII redact → cache check → rate limit → invoke → PII de-redact → cache store → cost track |
| `check_start_gates()` | `coordinator/runtime.py` → `start()` | Kill switch check → guardrail scan → PII entity registration |
| `resolve_tier()` | `coordinator/runtime.py` → `_resolve_governance_tier()` | Declared tier + circuit breaker override → upward-only effective tier |
| `record_step_result()` | `nodes.py` / stepper callback | Circuit breaker record + replay checkpoint after each step |
| `on_governance_suspension()` | `coordinator/runtime.py` → `_suspend_for_governance()` | Webhook notify + HITL state machine initialize |
| `should_skip_act()` / `record_shadow_act()` | `engine/nodes.py` → `create_act_node()` | Shadow mode check; if active, log intent and return simulated result |
| `check_delegation_allowed()` / `check_act_allowed()` | Coordinator before dispatch | Kill switch guard for delegation and act |

### 8.3 Module Details

#### InputGuardrail (`engine/guardrails.py`)

Scans `case_input` for prompt injection before the workflow starts.

- Regex pattern matching against known injection signatures
- Optional LLM classifier for ambiguous inputs
- Risk levels: `NORMAL` (pass), `AMBIGUOUS` (escalate to `gate`), `HIGH` (escalate to `hold`)
- Tier escalation result fed back into `check_start_gates()` and applied before domain tier is evaluated

#### PII Redactor (`engine/pii.py`)

Operates at the LLM call chokepoint to prevent PII from reaching the LLM or appearing in logs.

- `register_entities_from_case(case_input)` — extracts PII entities from case input at workflow start
- `redact(prompt)` — replaces PII with stable tokens (e.g., `<NAME_0>`, `<ACCOUNT_1>`) before LLM call
- `deredact(response)` — restores original values in LLM response before returning to engine
- `audit_summary()` — count of redacted entity types for compliance reporting

Controlled by `CC_PII_ENABLED` env var (default: `true`).

#### Semantic Cache (`engine/semantic_cache.py`)

Two-layer LLM response dedup to avoid redundant and costly LLM calls.

- **Layer 1:** Exact prompt hash match (zero-cost lookup)
- **Layer 2:** Vector similarity match (configurable threshold)
- Cache keyed by `(prompt_hash, domain, model)`. TTL configurable via `CC_CACHE_TTL` (default 3600s).
- Enabled via `CC_CACHE_ENABLED=true` (default: off)

#### Provider Rate Limiter (`engine/rate_limit.py`)

Per-provider concurrency and RPM control. Loaded from `llm_config.yaml` `rate_limits:` section.

- `max_concurrent` — semaphore-based concurrency limit
- `requests_per_minute` — token bucket RPM limit
- `limiter.acquire(timeout=30)` — context manager; blocks until slot available or timeout
- `limiter.metrics()` — current concurrency, RPM stats

#### Cost Tracker (`engine/cost.py`)

Token and dollar cost accounting at every LLM call.

- `record_call(model, input_tokens, output_tokens, step_name)` — appends to in-memory ledger
- `total_cost` — running USD total (using per-model price table)
- `summary()` — breakdown by model, by step, by workflow

Token counts extracted from LangChain response `response_metadata.usage`.

#### Logic Circuit Breaker (`engine/logic_breaker.py`)

Sliding-window quality monitor that automatically escalates governance tier when a domain's primitives produce too many low-confidence outputs.

- Tracks last N results (default 20) per `(domain, primitive)` pair in a sliding deque
- A result is flagged as low-confidence when `confidence < floor` (default floor 0.5)
- **Escalation thresholds:**
  - Low-confidence rate > 50% → override tier to `spot_check`
  - Low-confidence rate > 80% → override tier to `gate`
- Auto-recovers when rate drops below thresholds
- `get_tier_override(domain)` — returns current override or `None`; fed into `resolve_tier()`
- Optional persistence to SQLite for survival across restarts

#### Tier Invariant Enforcer (`engine/tier.py`)

Hard invariant: **the effective governance tier can only move upward**. `auto < spot_check < gate < hold`.

`resolve_effective_tier(declared_tier, *override_candidates)`:
- Takes the domain's declared tier plus any number of override candidates (circuit breaker, guardrails, kill switch)
- Returns `max()` of all — the strictest tier wins
- Raises `TierInvariantViolation` if the result would be lower than declared (mathematical defense-in-depth)
- Returns `(effective_tier, override_source)` for audit logging

#### Kill Switch Manager (`engine/kill_switch.py`)

Runtime-toggleable emergency stops. Thread-safe in-memory store with optional SQLite persistence.

| Switch | Scope | Method |
|--------|-------|--------|
| `disable_act` | All Act executions | `ks.disable_act(reason)` |
| `disable_delegation` | All cross-workflow delegation | `ks.disable_delegation(reason)` |
| `disabled_domains` | Set of domain names | `ks.disable_domain(name, reason)` |
| `disabled_workflows` | Set of workflow names | `ks.disable_workflow(name, reason)` |
| `disabled_policies` | Set of delegation policy names | `ks.disable_policy(name, reason)` |

`ks.status()` returns all active switches and reasons. All checks raise `KillSwitchTripped` when a switch is active.

#### Shadow Mode (`engine/shadow.py`)

Dark launch: runs the full pipeline including Act planning, but skips actual Act execution. Records what Act would have done.

- `should_skip_act("act")` — returns `True` when `CC_SHADOW_MODE=true`
- `record_shadow_act(instance_id, step_name, proposed_actions)` — logs intent
- `get_shadow_result(step_name)` — returns `{"shadow": True, "actions_taken": [...]}` as the simulated result

Enables production validation of Act workflows before enabling write-side operations.

#### Compensation Ledger (`engine/compensation.py`)

Register-and-reverse for Act side effects. Enables rollback when a multi-step Act workflow partially fails.

- `register(instance_id, step_name, idempotency_key, action_description, compensation_data)` — records reversible action before execution
- `confirm(idempotency_key)` — marks action as permanently committed
- `compensate(instance_id)` — fires all unconfirmed compensations for an instance (in reverse order)

#### Webhook Notifier (`engine/webhooks.py`)

HTTP POST notifications on governance events. Configured via `CC_WEBHOOK_URL` and `CC_WEBHOOK_FORMAT` env vars.

- Formats: `generic`, `pagerduty`, `slack`, `teams`
- `notify_suspension(instance_id, workflow, domain, tier, step, reason, approve_url)` — fires on `gate`/`hold` suspension
- Retry with exponential backoff on delivery failure

#### Replay Manager (`engine/replay.py`)

Checkpoint state after every step. Enables replay and override from any point in a workflow.

- `save_checkpoint(trace_id, step_name, step_index, state_snapshot)` — called from `record_step_result()`
- State snapshots stored per step; can be loaded to re-run from step N with modified inputs
- Enabled by default (`CC_REPLAY_ENABLED=true`); disable with `CC_REPLAY_ENABLED=false`

#### Spec Lock Manifest (`engine/spec_lock.py`)

Regulatory reconstruction support: captures the exact config in effect when a decision was made.

- `create_manifest(workflow_path, domain_path, coordinator_config_path)` — SHA-256 hashes all config files and all prompt templates; optionally captures full YAML content (gzip-compressed)
- `manifest_hash` — single combined hash for equality checking
- Stored in audit trail alongside the first event for each instance
- Config: `CC_SPEC_LOCK_ENABLED` (default: `true`), `CC_SPEC_LOCK_SNAPSHOTS` (default: `true`)

### 8.4 HITL State Machine (`engine/hitl_state.py`)

Formal 9-state machine for the human-in-the-loop review lifecycle. Every transition is validated, logged, and optionally written to the audit trail.

**States and transitions:**

```
SUSPENDED → PENDING_REVIEW → ASSIGNED → UNDER_REVIEW → APPROVED → RESUMED (terminal)
                          ↘ TIMED_OUT ↗               ↘ REJECTED → TERMINATED (terminal)
                                      ↘ PENDING_REVIEW (reassign)
```

Key operations:
- `suspend(instance_id, reason)` — initialize + move to `PENDING_REVIEW`
- `assign(instance_id, reviewer, sla_seconds, escalation_target)` — move to `ASSIGNED`, start SLA timer
- `start_review(instance_id, reviewer)` — move to `UNDER_REVIEW`
- `approve(instance_id, reviewer, rationale)` / `reject(...)` — terminal decisions
- `sweep_expired_slas(on_timeout="reassign"|"terminate")` — scans all active SLAs; expired ones transition to `TIMED_OUT` then either back to `PENDING_REVIEW` (reassign) or `TERMINATED`

`ReviewSLA` tracks `assigned_to`, `assigned_at`, `sla_seconds`, `escalation_target`, and exposes `is_expired` / `remaining_seconds`.

### 8.5 HITL Capability-Based Routing (`engine/hitl_routing.py`)

Routes governance approval tasks to qualified reviewers based on declared capabilities. Prevents wrong-queue assignment (e.g., a fraud L1 analyst approving a compliance hold).

**Core types:**
- `CapabilityRoute(domain, tier, capability)` — maps `(domain, tier)` to a required capability; `"*"` wildcards supported
- `Reviewer(id, name, capabilities, max_concurrent)` — human reviewer with capacity tracking
- `RoutedTask` — task record with `qualified_reviewers` list, `assigned_to`, `status`

**Routing logic:** exact `(domain, tier)` match → domain wildcard → tier wildcard → full wildcard.

**Reviewer lifecycle:**
- `register_reviewer(reviewer)` / `deactivate_reviewer(id)` / `activate_reviewer(id)`
- `route_task(instance_id, domain, tier)` → `RoutedTask` with all qualified, available reviewers
- `assign_task(task_id, reviewer_id)` — validates capability + availability, increments `current_load`
- `complete_task(task_id)` — releases reviewer capacity

### 8.6 Governance Wiring Status

| Module | Initialized | Call Site Wired |
|--------|-------------|----------------|
| InputGuardrail | ✅ at `check_start_gates()` | ✅ `runtime.start()` |
| PiiRedactor | ✅ at `check_start_gates()` | ⚠ registered but `protected_llm_call()` not yet called from `nodes.py` |
| SemanticCache | ✅ lazy | ⚠ `protected_llm_call()` not yet called from `nodes.py` |
| ProviderRateLimiter | ✅ lazy per provider | ⚠ same as above |
| CostTracker | ✅ lazy | ⚠ same as above |
| LogicCircuitBreaker | ✅ at `record_step_result()` | ✅ `record_step_result()` called from governance pipeline |
| KillSwitchManager | ✅ lazy | ✅ `check_start_gates()`, `check_act_allowed()`, `check_delegation_allowed()` |
| ShadowMode | ✅ at `should_skip_act()` | ⚠ `create_act_node()` does not yet call `should_skip_act()` |
| CompensationLedger | ✅ lazy | ⚠ act nodes do not yet call `register_compensation()` |
| WebhookNotifier | ✅ if `CC_WEBHOOK_URL` set | ✅ `on_governance_suspension()` called from `runtime.py` |
| ReplayManager | ✅ if enabled | ✅ `record_step_result()` saves checkpoints |
| SpecManifest | ✅ via `capture_spec_manifest()` | ⚠ not yet called from `runtime.start()` |
| RoutingManager | ✅ lazy | ⚠ routes not populated without explicit `add_route()` calls |
| HITLStateMachine | ✅ lazy | ✅ `on_governance_suspension()` initializes + suspends |

The pipeline infrastructure is fully built. The main gap is that `nodes.py` does not yet route all LLM calls through `protected_llm_call()`, so PII, cache, rate limiting, and cost tracking are not active end-to-end.

---

## 9. Registry (`registry/`)

### `registry/primitives.py`
Central registry mapping primitive names to their prompt files, schemas, and param requirements. Provides:
- `validate_use_case_step()` — validates a workflow step config at load time
- `render_prompt(primitive_name, params)` — renders the prompt template
- `get_schema_class(primitive_name)` — returns the Pydantic output schema

### `registry/schemas.py`
Pydantic output contracts. Inheritance: `BaseOutput → <Primitive>Output`.

Key fields per primitive (beyond base `confidence`, `reasoning`, `evidence_used`, `evidence_missing`):

| Schema | Additional Fields |
|--------|------------------|
| `ClassifyOutput` | `category`, `alternative_categories` |
| `InvestigateOutput` | `finding`, `hypotheses_tested`, `recommended_actions`, `evidence_flags` |
| `ThinkOutput` | `thought`, `conclusions`, `decision`, `resource_requests` |
| `VerifyOutput` | `conforms`, `violations`, `rules_checked` |
| `GenerateOutput` | `artifact`, `format`, `constraints_checked` |
| `ChallengeOutput` | `survives`, `vulnerabilities`, `strengths`, `overall_assessment` |
| `RetrieveOutput` | `data`, `sources_queried`, `sources_skipped`, `retrieval_plan` |
| `ActOutput` | `action_taken`, `result`, `side_effects` |

### `registry/prompts/`
Prompt templates for each primitive (`.txt` files). Also includes `orchestrator.txt` for agentic mode. These are the primary tuning surface for accuracy.

---

## 10. Web API Layer (`api/`)

FastAPI server exposing the coordinator to a browser-based analyst UI.

### `api/main.py`

Startup (lifespan):
1. Seed fraud data DB from fixture files
2. Initialize `Coordinator` singleton
3. Terminate stale "running" instances from previous process
4. Start `ThreadPoolExecutor(max_workers=4)` for sync workflow execution

Middleware: CORS (all origins). SPA mount at `/` (after API routes).

### `api/routers/cases.py`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/backlog` | GET | Root instances with stage computation for kanban |
| `/api/cases` | GET | All case metadata |
| `/api/run` | POST | Pre-allocate correlation_id, submit to thread pool, poll DB for instance_id |
| `/api/reset` | POST | Clear all DB state (dev/demo use) |

Stage computation (`_compute_stage`):
- `needs_review` — suspended + pending governance gate task
- `investigation` — suspended waiting for delegations (no pending gate)
- `investigation` — running specialty/regulatory/resolution workflows
- `triage` — running triage workflow
- `completed` — all terminal, root completed
- `failed` — all terminal, root not completed

### `api/routers/instances.py`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/instances/{id}/chain` | GET | Look up by instance_id → correlation_id → full chain |

### `api/routers/tasks.py`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/tasks/pending` | GET | All pending governance approval tasks |
| `/api/tasks/{id}/approve` | POST | Approve governance gate |
| `/api/tasks/{id}/reject` | POST | Reject governance gate |
| `/api/tasks/{id}/terminate` | POST | Terminate instance |

### `api/deps.py`

Module-level singletons for coordinator and thread pool executor. Set at startup via `set_coordinator()` / `set_executor()`.

---

## 11. Example Use Case Configurations (Non-Demo)

The `workflows/` and `domains/` directories contain framework-level example configurations across multiple domains:

**Workflows (26 files):**
```
claim_adjudication, claim_intake, complaint_resolution_act,
damage_assessment, dispute_resolution, eligibility_constraints_assessment,
equipment_schedule_lookup, field_scheduling_optimizer, fraud_review,
fraud_screening, fraud_triage, hardship_intake_packet,
hardship_path_recommendation, loan_hardship, loan_hardship_agentic,
member_contact_strategy, nurse_triage, product_return,
recovery_optimizer, regulatory_impact, sar_investigation,
scaffold_workflow, spending_advisor, spending_advisor_agentic,
vendor_coi_lookup, vendor_notification,
action_execution_orchestration
```

**Domains (27 files):**
```
ach_dispute, avm_regulation, cardiac_triage, card_dispute,
check_clearing_complaint, claims_processing, debit_spending,
debit_spending_agentic, electronics_return, field_operations,
fraud_triage, hardship_action, hardship_contact, hardship_eligibility,
hardship_path, member_hardship, military_hardship, military_hardship_agentic,
return_fraud, scaffold_domain, structuring_sar, subrogation,
synthetic_claim, synthetic_damage, synthetic_fraud, underwriting_records,
vendor_management, vendor_ops
```

These serve as reference implementations and stress tests for the framework's config-only principle.

---

## 12. Delegation Mechanism

Two delegation mechanisms are supported:

### 12.1 Delegation Policies (deterministic, post-completion)

Configured in `coordinator_config.yaml` under `delegations:`. Evaluated after a workflow completes. Two modes:

- **`fire_and_forget`** — source completes immediately, delegated workflow runs independently
- **`wait_for_result`** — source suspends; when child completes, delegation result is injected into `input.delegation.<workflow_type>` and parent resumes at `resume_at_step`

This is the primary and reliable routing mechanism.

### 12.2 Demand-Driven Delegation / DDD (LLM-driven, mid-execution)

The `think` primitive can emit `resource_requests` in its output. The stepper's `resource_request_callback` catches them and creates a `StepInterrupt`. The coordinator matches needs to capabilities via `policy.match_needs()` and dispatches child workflows.

**This is a fallback mechanism.** LLM emission of `resource_requests` is not guaranteed. Use delegation policies for any routing that must always happen.

---

## 13. Governance Flow

```
workflow.start()
  ↓
Execute steps (stepper.step_execute)
  ↓
Workflow completes
  ↓
policy.evaluate_governance(domain, result)
  ├─ auto:        proceed → _on_completed()
  ├─ spot_check:  10% sampled → queue SPOT_CHECK_REVIEW task → complete
  ├─ gate:        suspend → queue GOVERNANCE_APPROVAL task
  │                  ↓ human approves/rejects
  │               coordinator.approve() → _on_completed()
  └─ hold:        suspend → queue compliance task → similar to gate
```

`governance_tier_locked=True` on an instance means the tier was set by a delegation policy `governance_tier:` override and must not be escalated by quality gate logic.

---

## 14. Key Configuration Reference

### Coordinator Config (`coordinator_config.yaml`)
```yaml
workflow_dir: workflows/
domain_dir: domains/
case_dir: cases/

governance_tiers:
  auto:    { hitl: none }
  gate:    { hitl: before_act, queue: review_queue }
  # ...

delegations:
  - name: policy_name
    mode: fire_and_forget | wait_for_result
    resume_at_step: step_name       # wait_for_result only
    governance_tier: auto           # override child tier
    conditions:
      - domain: source_domain
        selector: "step:step_name"
        field: output_field
        operator: eq | exists | gte | contains_any
        value: expected_value
    target_workflow: child_workflow
    target_domain: child_domain
    inputs:
      key: "${source.step:classify.category}"

capabilities:
  - need_type: specialist_review
    provider_type: workflow
    workflow_type: specialty_investigation
    domain: specialist
```

### Domain Config
```yaml
domain_name: example_domain
description: What this domain does
governance: gate   # auto | spot_check | gate | hold

step_name_here:
  categories: "cat1, cat2, cat3"
  criteria: "Classify by X"
  additional_instructions: "Domain-specific note"
```

### Workflow Config
```yaml
name: example_workflow
description: What this workflow does
steps:
  - name: step_one
    primitive: classify
    temperature: 0.0
    params:
      categories: "${domain.step_one.categories}"
      criteria: "${domain.step_one.criteria}"
    transitions:
      - { default: __end__ }

  - name: step_two
    primitive: investigate
    max_loops: 3
    loop_fallback: step_three
    params:
      question: "Analyze ${step_one.category}"
      scope: "..."
    transitions:
      - { when: "output.confidence >= 0.9", goto: step_three }
      - { default: step_two }

  - name: step_three
    primitive: generate
    params:
      requirements: "..."
      format: text
      constraints: "..."
    transitions:
      - { default: __end__ }
```

---

## 15. Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `LLM_PROVIDER` | Force LLM provider | Auto-detect |
| `LLM_DEFAULT_MODEL` | Override default model alias | Provider default |
| `LLM_CONFIG_PATH` | Path to llm_config.yaml | `./llm_config.yaml` |
| `GOOGLE_API_KEY` | Google Gemini API key | — |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint | — |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key | — |
| `AZURE_AI_FOUNDRY_ENDPOINT` | Azure AI Foundry endpoint | — |
| `AZURE_AI_FOUNDRY_API_KEY` | Foundry API key (or use identity) | — |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `AWS_DEFAULT_REGION` | AWS region for Bedrock | — |
| `CC_DB_BACKEND` | Database backend | `sqlite` |
| `DATA_MCP_URL` | MCP data server URL | — |
| `DATA_MCP_CMD` | MCP data server command | — |
| `CC_PII_ENABLED` | Enable PII redaction | `true` |
| `CC_CACHE_ENABLED` | Enable semantic LLM cache | `false` |
| `CC_CACHE_TTL` | Cache TTL in seconds | `3600` |
| `CC_SHADOW_MODE` | Enable shadow mode (skip Act) | `false` |
| `CC_REPLAY_ENABLED` | Enable step checkpointing | `true` |
| `CC_SPEC_LOCK_ENABLED` | Enable config manifest capture | `true` |
| `CC_SPEC_LOCK_SNAPSHOTS` | Store full YAML in manifest | `true` |
| `CC_WEBHOOK_URL` | Webhook URL for governance events | — |
| `CC_WEBHOOK_FORMAT` | Webhook payload format | `generic` |

---

## 16. What Is Implemented vs. Wired

| Component | Implemented | Wired Into Main Path |
|-----------|-------------|---------------------|
| Sequential workflow execution | ✅ | ✅ |
| Agentic mode | ✅ | ✅ (opt-in via `mode: agentic`) |
| All 8 primitives | ✅ | ✅ |
| Three-layer merge | ✅ | ✅ |
| Governance tiers (auto, spot_check, gate, hold) | ✅ | ✅ |
| Delegation policies (fire_and_forget) | ✅ | ✅ |
| Delegation policies (wait_for_result) | ✅ | ✅ |
| DDD / resource_requests (backward chaining) | ✅ | ✅ |
| SQLite persistence | ✅ | ✅ |
| PostgreSQL backend | ✅ | ✅ (via `CC_DB_BACKEND=postgres`) |
| Task queue (SQLite) | ✅ | ✅ |
| Coordinator CLI | ✅ | ✅ |
| FastAPI REST layer | ✅ | ✅ |
| MCP tool server | ✅ | ✅ (via env vars) |
| Governance pipeline (singleton) | ✅ | ✅ initialized, 7 chokepoints defined |
| Guardrails (prompt injection) | ✅ | ✅ `check_start_gates()` called from `runtime.start()` |
| Tier invariant enforcer | ✅ | ✅ `resolve_tier()` called from `runtime.py` |
| Kill switches | ✅ | ✅ domain, act, delegation checks wired |
| Logic circuit breaker | ✅ | ✅ `record_step_result()` updates sliding window |
| HITL state machine | ✅ | ✅ `on_governance_suspension()` initializes it |
| Webhook notifier | ✅ | ✅ fires on governance suspension (if `CC_WEBHOOK_URL` set) |
| Replay/checkpointing | ✅ | ✅ `record_step_result()` saves checkpoint per step |
| PII redaction | ✅ | ⚠ registered at start, but `protected_llm_call()` not called from `nodes.py` |
| Semantic cache | ✅ | ⚠ `protected_llm_call()` not called from `nodes.py` |
| Provider rate limiter | ✅ | ⚠ same |
| Cost tracker | ✅ | ⚠ same |
| Shadow mode | ✅ | ⚠ `create_act_node()` does not call `should_skip_act()` |
| Compensation ledger | ✅ | ⚠ act nodes do not call `register_compensation()` |
| Spec lock manifest | ✅ | ⚠ `capture_spec_manifest()` not called from `runtime.start()` |
| HITL capability routing | ✅ | ⚠ routes not populated without explicit `add_route()` calls |
| Dispatch optimizer | ✅ | ✅ optional; instantiated if deps present, graceful degrade |
| DDD state machines (formal) | ✅ | ✅ optional; graceful degrade |
| Resilience layer | ✅ | ✅ optional; graceful degrade |
| Production hardening | ✅ | ✅ optional; graceful degrade |
| Federation | ✅ | ⚠ spoke instantiated; parent escalation not exercised |
| Escalation brief builder | ✅ | ⚠ not invoked when governance gates fire |
| SAR/BSA integration | ✅ | Standalone module |
| Eval gate | ✅ | ⚠ not enforced at coordinator startup |

---

## 17. Known Gaps / Next Steps

1. **Production hardening wiring** — kill switches, PII redaction, guardrails, semantic cache, compensation ledger, shadow mode are implemented but not guarding the main execution path.
2. **Eval gate** — model change gating is implemented but not enforced at coordinator startup.
3. **Federation** — federation spoke is instantiated but escalation to a parent coordinator is not exercised.
4. **Escalation brief** — the brief builder module exists but is not invoked when governance gates fire.
5. **Service Bus / Webhook task queue** — SQLiteTaskQueue is the current production implementation; Phase 4 adapters are not yet implemented.
6. **Simulated execution mode** — outputs are biased toward insurance domain; should be made generic across domains.
