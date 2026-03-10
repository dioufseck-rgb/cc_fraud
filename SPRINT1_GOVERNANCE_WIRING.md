# SPRINT 1 — Governance Wiring
## Claude Code Instruction File
### Cognitive Core · Supply Chain Commercial Product Preparation

---

## Context

Cognitive Core has a fully implemented governance pipeline (`engine/governance.py`) with
14 modules and 7 defined chokepoints. The modules are built and tested in isolation. The
gap is that several chokepoints are not yet called from the main execution path.

This sprint wires those 4 gaps. No new functionality. No architecture changes. Precise,
surgical insertions at exact call sites. Every change is additive — existing behavior is
preserved when governance modules are absent or disabled.

**After this sprint:**
- PII is redacted before every LLM call and de-redacted after
- Semantic cache, rate limiting, and cost tracking are active end-to-end
- Shadow mode intercepts Act nodes (respects `CC_SHADOW_MODE=true`)
- Compensation is registered before every real Act execution
- Spec manifest is captured at every workflow start (config hash for audit)
- Escalation brief is already wired (confirmed in `_suspend_for_governance`)

---

## Pre-Flight Checks

Before making any changes:

```bash
# Verify framework tests still pass (no LLM required)
python3 fraud_demo/test_mechanisms.py

# Confirm you can read the governance pipeline
python3 -c "from engine.governance import get_governance; g = get_governance(); g.initialize(); print('governance ok')"

# Confirm the four target files exist
ls engine/nodes.py coordinator/runtime.py engine/governance.py coordinator/escalation.py
```

If `test_mechanisms.py` fails before you touch anything, stop and report. Do not proceed.

---

## Gap 1 — `protected_llm_call()` in `engine/nodes.py`

### What to wire

Every direct `llm.invoke()` call in `nodes.py` must be routed through
`gov.protected_llm_call()`. This single change activates PII redaction, semantic cache,
rate limiting, and cost tracking simultaneously.

There are **3 call sites** in `nodes.py`:

1. `create_node()` — line ~405: `response = llm.invoke(messages)`
2. `create_act_node()` — line ~928: `response = llm.invoke([HumanMessage(content=rendered_prompt)])`
3. `create_retrieve_node()` — line ~784: `response = llm.invoke([HumanMessage(content=rendered_prompt)])`

There is also an internal helper `_run_retrieval_planner()` at line ~1115 that calls
`response = llm.invoke(...)` — wire this one too.

### How to wire

Add this import block near the top of `nodes.py` (after existing imports):

```python
from engine.governance import get_governance
```

Then at **each** of the 4 call sites, replace the pattern:

```python
# BEFORE
response = llm.invoke([HumanMessage(content=rendered_prompt)])
raw_response = response.content
```

with:

```python
# AFTER
gov = get_governance()
_gov_result = gov.protected_llm_call(
    llm=llm,
    prompt=rendered_prompt,
    step_name=step_name,
    domain=state.get("metadata", {}).get("domain", ""),
    model=model,
    case_input=state.get("input", {}),
)
raw_response = _gov_result.raw_response
```

### Notes

- `protected_llm_call()` returns an `LLMCallResult` with `.raw_response` as a string —
  the rest of the parse logic is unchanged.
- The governance pipeline never raises — all modules degrade gracefully. If
  `get_governance()` fails for any reason, the call falls through as a no-op.
- For `create_node()`, `step_name` is already in scope as a closure variable.
- For `_run_retrieval_planner()`, `step_name` is a parameter — use it directly.
- The `domain` is carried in `state["metadata"]["domain"]` — use `.get()` with `""` as
  default so it degrades gracefully for workflows that don't set it.
- Do **not** change the `messages` variable or anything before the invoke call. The only
  change is replacing the `llm.invoke(...)` call itself with the governance wrapper.

### Verification

After wiring, run this smoke test (no LLM, no API key needed):

```python
# tests/test_governance_wiring.py
from engine.governance import get_governance

gov = get_governance()
gov.initialize()

# Confirm protected_llm_call is callable with correct signature
import inspect
sig = inspect.signature(gov.protected_llm_call)
assert "llm" in sig.parameters
assert "prompt" in sig.parameters
assert "step_name" in sig.parameters
assert "domain" in sig.parameters
assert "model" in sig.parameters
print("Gap 1 signature check: PASS")
```

---

## Gap 2 — Shadow Mode + Compensation in `create_act_node()`

### What to wire

`create_act_node()` in `engine/nodes.py` needs two additions inside `node_fn`:

**Addition A — Shadow mode check (before action execution):**
If `CC_SHADOW_MODE=true`, skip real execution and return the shadow result.

**Addition B — Compensation registration (before real execution):**
Before executing a non-dry-run action, register it with the compensation ledger so it
can be reversed on failure.

### Where exactly

In `create_act_node()`, locate the action execution section at approximately line 1000.
The structure is:

```python
if not authorized:
    ...
elif mode == "dry_run":
    result = action_registry.execute(action_name, exec_params, dry_run=True)
    ...
else:
    result = action_registry.execute(action_name, exec_params, dry_run=False)
    ...
```

### Addition A — Shadow mode (add BEFORE the authorization check loop)

At the top of `node_fn`, before the param resolution block, add:

```python
# ── Shadow mode check ──
gov = get_governance()
if gov.should_skip_act(step_name):
    shadow_result = gov.record_shadow_act(
        instance_id=state.get("metadata", {}).get("instance_id", ""),
        step_name=step_name,
        proposed_actions=[],  # empty at this point; shadow fires before execution
    )
    step_result: StepResult = {
        "step_name": step_name,
        "primitive": "act",
        "output": {
            "shadow": True,
            "mode": "shadow",
            "actions_taken": [],
            "confidence": 1.0,
            "reasoning": "Shadow mode active — Act skipped, intent logged.",
            "evidence_used": [],
            "evidence_missing": [],
        },
        "raw_response": "",
        "prompt_used": "",
    }
    return {
        "steps": [step_result],
        "current_step": step_name,
        "loop_counts": current_counts,
    }
```

### Addition B — Compensation registration (inside the `else` real-execution branch)

Inside the `else` block (real execution, not dry_run), add the compensation registration
call **before** `action_registry.execute(...)`:

```python
else:
    # Register compensation before execution so it can be reversed on failure
    gov.register_compensation(
        instance_id=state.get("metadata", {}).get("instance_id", ""),
        step_name=step_name,
        action_description=f"{action_name} on {exec_params}",
        compensation_data={"action": action_name, "params": exec_params},
        idempotency_key=f"{state.get('metadata', {}).get('instance_id', '')}:{step_name}:{action_name}",
    )
    result = action_registry.execute(action_name, exec_params, dry_run=False)
    ...
```

After successful execution, confirm the compensation so it is not reversed on cleanup:

```python
    result = action_registry.execute(action_name, exec_params, dry_run=False)
    if result.status == "success":
        gov.confirm_compensation(
            idempotency_key=f"{state.get('metadata', {}).get('instance_id', '')}:{step_name}:{action_name}"
        )
    ...
```

### Verification

```bash
# Set shadow mode and verify Act returns shadow result
CC_SHADOW_MODE=true python3 -c "
import os
os.environ['CC_SHADOW_MODE'] = 'true'
from engine.governance import get_governance
gov = get_governance()
gov.initialize()
result = gov.should_skip_act('test_act_step')
print('Shadow mode active:', result)
assert result == True, 'Shadow mode should be active'
print('Gap 2 shadow check: PASS')
"
```

---

## Gap 3 — `capture_spec_manifest()` in `coordinator/runtime.py`

### What to wire

At the end of `coordinator.start()`, after the instance is saved and before
`_execute_workflow()` is called, capture the spec manifest.

The manifest records the SHA-256 hash of the workflow YAML, domain YAML, and coordinator
config at the moment the instance starts. This is the regulatory reconstruction artifact.

### Where exactly

In `coordinator/runtime.py`, in the `start()` method, locate the section after
`self.store.save_instance(instance)` and the action ledger log call. Find where
`_execute_workflow()` is called (approximately line 350 in `start()`).

Add the following block **after** the action ledger log, **before** `_execute_workflow()`:

```python
# ── Spec manifest — capture config hashes at instance start ──
try:
    from engine.governance import get_governance
    _gov = get_governance()
    _manifest = _gov.capture_spec_manifest(
        workflow_path=str(self._workflow_path(workflow_type)),
        domain_path=str(self._domain_path(domain)),
        coordinator_path=str(self._config_path),
    )
    if _manifest:
        self.store.log_action(
            instance_id=instance.instance_id,
            correlation_id=instance.correlation_id,
            action_type="spec_manifest",
            details=_manifest,
            idempotency_key=f"manifest:{instance.instance_id}",
        )
except Exception as _e:
    self._log(f"  ⚠ Spec manifest capture failed (non-blocking): {_e}")
```

### Finding the path helpers

Before adding the call, check how `runtime.py` resolves workflow and domain paths.
Search for `_workflow_path` or how `workflow_dir` / `domain_dir` are used in
`_execute_workflow()`. Adapt the path resolution to use whatever method already exists.

If no helper method exists, construct the paths directly:

```python
import pathlib
_wf_path = pathlib.Path(self.workflow_dir) / f"{workflow_type}.yaml"
_dom_path = pathlib.Path(self.domain_dir) / f"{domain}.yaml"
```

### Notes

- `capture_spec_manifest()` is fully safe to call — it returns `None` if
  `CC_SPEC_LOCK_ENABLED=false` or if any file is missing. It never raises.
- The manifest is stored in the action ledger alongside the `start` event.
- `self._config_path` — find how the coordinator stores its own config path. It is
  passed in at construction. If not stored, pass `""` as the coordinator path.

### Verification

```bash
python3 -c "
from engine.governance import get_governance
gov = get_governance()
gov.initialize()
# Test with the fraud demo config files
m = gov.capture_spec_manifest(
    workflow_path='fraud_demo/workflows/fraud_triage.yaml',
    domain_path='fraud_demo/domains/fraud_triage.yaml',
    coordinator_path='fraud_demo/coordinator_config.yaml',
)
if m:
    print('Manifest hash:', m.get('manifest_hash', 'n/a'))
    print('Gap 3 spec manifest: PASS')
else:
    print('Gap 3: spec lock disabled (expected if CC_SPEC_LOCK_ENABLED=false)')
"
```

---

## Gap 4 — Escalation Brief (Confirm Already Wired)

### Status: ALREADY WIRED — Verify Only

Review confirmed that `_suspend_for_governance()` in `coordinator/runtime.py` already
calls `build_escalation_brief()` from `coordinator/escalation.py`. The code at
approximately line 1029 does:

```python
from coordinator.escalation import build_escalation_brief
escalation_brief = build_escalation_brief(
    workflow_type=instance.workflow_type,
    domain=instance.domain,
    final_state=final_state,
    escalation_reason=gov_decision.reason,
    quality_gate=getattr(instance, '_quality_gate', None),
)
```

**Your task:** Run the fraud demo through a gate-tier suspension and verify the
escalation brief appears in the task payload.

```bash
# Run fraud demo to gate suspension
export GOOGLE_API_KEY=your-key
export LLM_PROVIDER=google

python -m coordinator.cli \
  --config fraud_demo/coordinator_config.yaml \
  run -w fraud_triage -d fraud_triage \
  -c fraud_demo/cases/app_scam_romance.json -v

# Check pending tasks — escalation_brief should be in payload
python -m coordinator.cli \
  --config fraud_demo/coordinator_config.yaml \
  stats
```

If `escalation_brief` is missing from the task payload, check `coordinator/escalation.py`
— the `build_escalation_brief()` function may return `None` if it cannot find step data.
Inspect the function and ensure it handles missing steps gracefully.

---

## Post-Wiring Validation

Run the full mechanism test suite after all gaps are wired:

```bash
python3 fraud_demo/test_mechanisms.py
```

All 38 assertions must still pass. This test runs without LLM calls — it validates
coordinator mechanics, delegation wiring, and governance tier behavior.

Then run a full governance proof check:

```bash
python3 -c "
from engine.governance import get_governance
gov = get_governance()
gov.initialize()
proof = gov.proof()
print('Active modules:')
for event in proof[:5]:
    print(' ', event)
stats = gov.stats()
print('Governance stats:', list(stats.keys()))
print('Post-wiring governance check: PASS')
"
```

---

## What NOT to Change

- Do not modify the governance pipeline itself (`engine/governance.py`). It is complete.
- Do not change any YAML configs — this is framework wiring only.
- Do not modify `fraud_demo/` — the demo configs are untouched.
- Do not add new tests to `test_mechanisms.py` — that suite validates framework mechanics.
  Add new governance-specific tests in a separate `tests/test_governance_wiring.py` file.
- Do not wire `RoutingManager` routes — this requires explicit `add_route()` configuration
  that is deployment-specific. Leave it for the supply chain scenario config.

---

## Definition of Done

- [ ] `python3 fraud_demo/test_mechanisms.py` — all 38 assertions pass
- [ ] `CC_PII_ENABLED=true` — PII redaction confirmed active (check governance proof log)
- [ ] `CC_SHADOW_MODE=true` — Act node returns shadow result without executing
- [ ] Spec manifest appears in action ledger on `coordinator.start()`
- [ ] Compensation is registered before real Act execution
- [ ] `gov.stats()` returns `cost`, `cache` keys (confirms modules initialized)

---

## Sequence

Do gaps in this order. Each is independently testable before moving to the next.

```
Gap 1 → Gap 2 → Gap 3 → Gap 4 (verify) → Post-wiring validation
```

Total estimated effort: 3–5 hours for a focused session.
This is the compliance floor. Nothing goes in front of a customer until this is done.
