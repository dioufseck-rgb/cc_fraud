# CLAUDE.md — Cognitive Core

## What This Is

Cognitive Core is an enterprise AI agent orchestration framework. It decomposes any workflow into sequences of eight reusable cognitive primitives, configured entirely in YAML. A new use case requires only workflow config, domain config, case data, and an MCP data spec — zero application code.

Built by Mamadou Dioufseck, AVP of AI Engineering at Navy Federal Credit Union. The framework powers the fraud operations demo and is designed for production financial services deployment.

## Core Principle

**A use case is a framework configuration, not an application.** If building a new use case requires writing Python, the framework has a gap that should be fixed.

## Architecture

### Three-Layer Configuration

Every workflow execution merges three layers:

1. **Workflow** (`workflows/*.yaml`) — primitive sequence, transitions, loop controls
2. **Domain** (`domains/*.yaml`) — domain expertise injected into prompts via `${domain.*}` references
3. **Runtime data** (`cases/*.json`) — case-specific data available as tool calls

The `engine/composer.py` `load_three_layer()` function merges workflow + domain. Runtime data becomes the tool registry.

### Eight Cognitive Primitives

| Primitive | Purpose | Key Output Fields |
|-----------|---------|-------------------|
| **Classify** | Categorize input | `category`, `confidence`, `reasoning` |
| **Retrieve** | Gather data from tools | `data`, `sources`, `record_count` |
| **Investigate** | Deep analysis with evidence | `finding`, `confidence`, `evidence_flags` |
| **Think** | Reason and decide | `decision`, `confidence`, `reasoning`, `resource_requests` |
| **Verify** | Check against rules | `conforms`, `rules_checked`, `findings` |
| **Challenge** | Adversarial review | `survives`, `strengths`, `vulnerabilities` |
| **Generate** | Produce artifacts | `content`, `format` |
| **Act** | Execute actions | `action_taken`, `result` |

Prompts live in `registry/prompts/<primitive>.txt`. Schemas in `registry/schemas.py`.

### Coordinator (`coordinator/runtime.py`)

The coordinator is the state machine that manages workflow lifecycle:

- **start()** — creates instance, assigns governance tier, executes workflow
- **resume()** — resumes suspended instance with external input
- **approve()/reject()** — governance decisions on suspended instances

Key internal methods:
- `_on_completed()` — evaluates delegation policies after workflow completion
- `_on_interrupted()` — handles DDD resource_requests (backward chaining)
- `_execute_delegation()` — dispatches child workflows
- `_resume_after_delegation()` — injects delegation results, resumes parent
- `_build_tool_registry()` — resolves tools from MCP, case JSON, or fixtures

### Two Delegation Mechanisms

**1. Delegation Policies (deterministic, post-completion)**
- Configured in `coordinator_config.yaml` under `delegations:`
- Evaluated after a workflow completes
- Conditions match on step outputs using selectors
- Two modes: `fire_and_forget` (source stays completed) and `wait_for_result` (source suspends, resumes when child completes)
- **This is the primary routing mechanism.** Use for any routing that should always happen.

**2. Demand-Driven Delegation / DDD (LLM-driven, mid-execution)**
- The `think` primitive can emit `resource_requests` in its output
- Stepper's `resource_request_callback` catches them and creates a `StepInterrupt`
- Coordinator matches needs to capabilities via `policy.match_needs()`
- **Use as fallback only.** LLM may not emit resource_requests reliably.

### Delegation Policy Configuration

```yaml
delegations:
  - name: policy_name
    mode: fire_and_forget | wait_for_result
    resume_at_step: step_name          # for wait_for_result only
    governance_tier: auto              # override child's domain tier
    conditions:
      - domain: source_domain
        selector: "step:step_name"     # or last_<prim>, any_<prim>, final_output
        field: output_field
        operator: eq | exists | gte | contains_any
        value: expected_value
    target_workflow: child_workflow
    target_domain: child_domain
    sla: 3600
    inputs:
      key: "${source.step:step_name.field}"   # or ${source.last_<prim>.field}, ${source.input.field}
```

**Selectors:**
- `step:<name>` — match a specific step by name (added to fix multi-classify ambiguity)
- `last_<primitive>` — last step of that primitive type
- `any_<primitive>` — any step of that primitive type (returns first match)
- `all_<primitive>` — all steps of that primitive type must match
- `final_output` — the last step regardless of type

**Input resolution:** `${source.step:classify_fraud_type.category}` resolves the `category` field from the output of the step named `classify_fraud_type`.

### Governance Tiers

```yaml
governance_tiers:
  auto:    { hitl: none }                          # no human review
  spot_check: { hitl: post_completion, sample_rate: 0.10 }  # random QA
  gate:    { hitl: before_act, queue: review_queue }        # must approve before completing
  hold:    { hitl: before_finalize, queue: compliance_queue } # compliance hold
```

Tier is determined by: domain config `governance:` field, OR `governance_tier:` override on delegation policy.

### Delegation Result Injection

When a `wait_for_result` child completes, its results are injected into the parent's state under `input.delegation.<handler_workflow_type>`. The parent workflow template references them as:

```yaml
params:
  requirements: |
    Regulatory results: ${input.delegation.fraud_regulatory_review}
    Resolution results: ${input.delegation.fraud_case_resolution}
```

Results are keyed by the child's workflow type name (e.g., `fraud_regulatory_review`), not by opaque work order IDs.

### Tool Registry

Three-tier resolution (in priority order):

1. **MCP server** — if `DATA_MCP_URL` or `DATA_MCP_CMD` env vars set
2. **Case JSON tools** — if case_input has `get_*` keys with embedded data
3. **Fixture files** — scans `<case_dir>/fixtures/*_tools.json` matching by `_case_id` or `_claim_id`

The coordinator passes its configured `case_dir` to `create_case_registry()`. Child workflows dispatched via delegation get lean inputs (just identifiers) and resolve tools from fixtures.

## Project Structure

```
cc_fraud/
├── engine/                    # Workflow execution engine
│   ├── composer.py            # Three-layer merge, LangGraph compilation
│   ├── stepper.py             # Step-by-step execution with interrupts
│   ├── nodes.py               # LangGraph node functions per primitive
│   ├── resume.py              # Mid-graph resume state preparation
│   ├── tools.py               # Tool registry, fixture loading
│   ├── llm.py                 # LLM provider abstraction
│   └── ...
├── coordinator/               # Orchestration state machine
│   ├── runtime.py             # Core coordinator (3200+ lines)
│   ├── policy.py              # Delegation policies, governance, capabilities
│   ├── types.py               # InstanceState, WorkOrder, Suspension, etc.
│   ├── store.py               # SQLite persistence
│   ├── cli.py                 # CLI entry point
│   └── ...
├── registry/                  # Primitive definitions
│   ├── primitives.py          # Config specs per primitive
│   ├── schemas.py             # Output schemas (Pydantic)
│   └── prompts/               # Base prompt templates per primitive
├── fraud_demo/                # Fraud operations demo (pure config)
│   ├── coordinator_config.yaml
│   ├── workflows/             # 4 workflow YAMLs
│   ├── domains/               # 6 domain YAMLs
│   ├── cases/                 # 3 case JSONs + fixtures/
│   └── test_mechanisms.py     # 38-assertion framework validation (no LLM)
├── domains/                   # Framework-level domain configs (insurance)
├── workflows/                 # Framework-level workflows (insurance)
└── cases/                     # Framework-level case data (insurance)
```

## Fraud Demo

### Running

```bash
# Full chain with LLM
export GOOGLE_API_KEY=your-key
export LLM_PROVIDER=google
python -m coordinator.cli \
  --config fraud_demo/coordinator_config.yaml \
  run -w fraud_triage -d fraud_triage \
  -c fraud_demo/cases/app_scam_romance.json -v

# Approve governance gates
python -m coordinator.cli \
  --config fraud_demo/coordinator_config.yaml \
  approve <instance_id> --approver "analyst"

# Framework mechanism tests (no LLM needed)
python3 fraud_demo/test_mechanisms.py
```

### Delegation Chain

```
fraud_triage (auto) → classify → classify → COMPLETES
  ↓ delegation policy: triage_to_app_scam (fire_and_forget)
fraud_specialty_investigation/app_scam_fraud (gate)
  → retrieve → investigate → think → COMPLETES
  ↓ delegation policies (wait_for_result, governance_tier: auto):
  ├── fraud_regulatory_review (auto) → retrieve → verify → generate → COMPLETES
  └── fraud_case_resolution (auto) → retrieve → challenge → generate ×3 → COMPLETES
  ↑ specialist RESUMES at generate_final_report
    ${input.delegation.fraud_regulatory_review} = regulatory results
    ${input.delegation.fraud_case_resolution} = resolution results
  → generate_final_report → COMPLETES → GATE (one analyst approval)
```

### Three Cases

| Case | File | Type | Key Challenge |
|------|------|------|--------------|
| Card fraud CNP | `card_fraud_cnp.json` | Card fraud | Unauthorized transactions, Reg E applies |
| Check fraud duplicate | `check_fraud_duplicate.json` | Check fraud | Mobile deposit duplicate, Reg CC holds |
| Romance scam | `app_scam_romance.json` | APP scam | Elder victim, Reg E does NOT apply (authorized payments) |

## Framework Fixes Applied (This Session)

These are recent changes that made the framework generic enough for config-only use cases:

1. **`engine/tools.py`** — Fixture lookup uses `case_id` or `claim_id` (was hardcoded to insurance's `claim_id`)
2. **`engine/tools.py`** — `create_case_registry()` accepts `fixtures_dir` parameter; `_load_fixtures_for_case()` scans configured case_dir
3. **`coordinator/policy.py`** — Empty contract name skips validation (contracts are optional)
4. **`coordinator/policy.py`** — `step:<name>` selector for conditions and input mappings
5. **`coordinator/runtime.py`** — Delegation results keyed by `handler_workflow_type` not work_order_id
6. **`coordinator/types.py` + `policy.py` + `runtime.py`** — `governance_tier` field on DelegationPolicy, flows through to `start(governance_tier_override=)`

## LLM Configuration

```bash
# Google Gemini (current)
export GOOGLE_API_KEY=your-key
export LLM_PROVIDER=google

# Azure OpenAI
export AZURE_OPENAI_API_KEY=your-key
export AZURE_OPENAI_ENDPOINT=https://your-endpoint.openai.azure.com
export LLM_PROVIDER=azure
```

The LLM abstraction is in `engine/llm.py`. Model selection controlled by `model` parameter (default: provider's default model).

## Key Conventions

- **Workflows end with `__end__`** — use `transitions: [{default: __end__}]` for terminal steps
- **Domain references use `${domain.section.field}`** — resolved at merge time from domain YAML
- **Step output references use `${step_name.field}`** — resolved at runtime from prior step outputs
- **Input references use `${input.field}`** — resolved from case_input
- **Delegation results use `${input.delegation.workflow_type}`** — injected on resume
- **Temperature 0.0 for classify steps** — deterministic classification
- **`max_loops` on investigate/challenge** — prevents infinite re-investigation; `loop_fallback` names the escape step
- **Governance defaults to `gate`** — always specify `governance: auto` in domain config if no HITL needed

## What NOT to Do

- **Don't write test harnesses that bypass the coordinator.** The coordinator IS the execution engine. Use `coordinator.cli` to run workflows.
- **Don't use the `think` primitive for deterministic routing.** The LLM may not emit `resource_requests`. Use delegation policies instead.
- **Don't put use-case data in the framework directories.** Cases, fixtures, and domain configs belong in the use-case directory (e.g., `fraud_demo/`).
- **Don't hardcode use-case-specific logic in framework code.** If a framework function assumes insurance (e.g., `claim_id`), make it generic.

## Next Steps

- Run full LLM chain with governance tier overrides and verify single-gate approval flow
- Validate delegation results appear in the generate_final_report step's actual LLM prompt
- Build UI for analyst review (HITL gate visualization, approval workflow)
- Improve simulated execution mode to produce realistic outputs per primitive (currently insurance-biased)
- Add MCP data server spec for production tool resolution

## Advanced Framework Capabilities

Beyond the core workflow engine, the framework includes production-hardening modules. These are implemented but not all wired into the fraud demo yet. Understanding them matters for production deployment planning.

### Dispatch Optimizer (`coordinator/optimizer.py`, `physics.py`, `archetypes.py`)

Mathematical optimization for work order → resource assignment. The pipeline:
1. **Eligibility filtering** (`ddd.py`) — hard boolean predicates
2. **Physics binding** (`physics.py`) — domain reality → cost matrix
3. **Archetype solving** (`archetypes.py`) — Hungarian algorithm or greedy best-fit
4. **Exploration policy** — bootstrapping new resources

The optimizer is pure logic, no I/O. Ships with a Python solver; production swaps to Pyomo + CBC/Gurobi. Six archetype templates defined: Assignment, VRP, Job Shop, Flow Network, Knapsack, Coverage.

### DDD State Machines (`coordinator/ddd.py`)

Formal state machines from the DDD Unified Specification v1.1:
- Work Order Lifecycle (8-state machine with failure semantics)
- Capacity Models (Slot, Volume, Batch)
- Capacity Reservation Protocol (reserve/commit/release with TTL)
- Eligibility vs. Ranking separation
- Circuit Breaker, Batch Reaper

### Resilience Layer (`coordinator/resilience.py`)

Addresses four production failure modes:
1. **Observer-State Divergence** — revalidate assumptions on resume (world changes while agent sleeps)
2. **Semantic Oscillation Detection** — detect unachievable quality bars causing infinite re-issue
3. **Graceful Revocation** — checkpoint-and-exit when reservation TTL expires mid-work
4. **Cross-Workflow Compensation** — compensating transactions across delegation boundaries

### Federation (`coordinator/federation.py`)

Hierarchical coordinator federation for multi-department enterprises:
- Child coordinators own their workflows, domains, resources, policies
- Unresolvable needs escalate to parent coordinator
- Parent routes cross-department work to the right child
- Global policies enforced at parent level

### Escalation Brief Builder (`coordinator/escalation.py`)

When a workflow hits a governance gate, this module builds a structured brief for the human reviewer:
- What the case is about (from retrieve data)
- What automation determined (classifications, findings)
- What automation was unsure about (low confidence, conflicts)
- Specific questions for the human
- Evidence gathered, recommended priority, deadlines

Design principle: human decides in minutes, not hours.

### Production Safety

| Module | Purpose |
|--------|---------|
| `engine/kill_switch.py` | Runtime-toggleable: disable Act, delegation, specific domains/workflows/policies |
| `engine/guardrails.py` | Prompt injection defense — regex patterns + optional LLM classifier |
| `engine/pii.py` | PII redaction/de-redaction at the LLM call chokepoint |
| `engine/shadow.py` | Shadow mode — run full pipeline, skip Act, log what it would have done |
| `engine/compensation.py` | Compensation ledger — register Act side effects, reverse on failure |

### Observability & Cost

| Module | Purpose |
|--------|---------|
| `engine/cost.py` | Token and cost tracking per LLM call, per step, per workflow |
| `engine/semantic_cache.py` | Two-layer cache (exact hash + vector similarity) to avoid redundant LLM calls |
| `engine/replay.py` | Checkpoint snapshots per step; replay/override from any point |
| `engine/eval_gate.py` | Model versioning — gates model changes behind eval pack results + regression checks |
| `engine/trace.py` | Distributed tracing integration |

### SAR Integration (`coordinator/sar_integration.py`, `coordinator/evidence.py`)

Bridges between SQLite evidence store and workflow execution:
- `build_case_input()` — constructs rich case_input from evidence tables
- `capture_workflow_outputs()` — writes step outputs back to evidence store
- Used by BSA/AML SAR investigation workflows
