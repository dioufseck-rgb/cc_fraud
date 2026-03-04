/**
 * NFCU Fraud Operations Center — SPA
 *
 * Vanilla JS, no framework. Polls:
 *   - /api/backlog every 5s
 *   - /api/instances/{id}/chain every 2s while any instance is RUNNING
 */

// ── State ──────────────────────────────────────────────────────────
let selectedInstanceId = null;   // root instance_id of selected case
let backlogData = [];             // last fetched backlog
let chainPollingTimer = null;
let backlogPollingTimer = null;

// Pending confirm-modal action
let pendingConfirmAction = null;  // { type: 'approve'|'reject', taskId, correlationId }

// ── Init ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadCasesForModal();
  await loadBacklog();
  backlogPollingTimer = setInterval(loadBacklog, 5000);
});

// ── Backlog ────────────────────────────────────────────────────────
async function loadBacklog() {
  try {
    const res = await fetch('/api/backlog');
    if (!res.ok) return;
    backlogData = await res.json();
    renderBacklog(backlogData);
    updateHeader(backlogData);
    document.getElementById('last-refresh').textContent =
      'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    console.warn('Backlog fetch failed:', e);
  }
}

function renderBacklog(instances) {
  const el = document.getElementById('backlog-list');
  const count = document.getElementById('backlog-count');
  count.textContent = instances.length + ' case' + (instances.length !== 1 ? 's' : '');

  if (instances.length === 0) {
    el.innerHTML = `<div class="px-4 py-8 text-center text-slate-400 text-sm">No cases yet.<br/>Click + Submit Case to begin.</div>`;
    return;
  }

  el.innerHTML = instances.map(inst => {
    const isActive = inst.instance_id === selectedInstanceId;
    const statusInfo = getStatusInfo(inst.status);
    const timeAgo = formatTimeAgo(inst.created_at);
    const caseLabel = formatCaseId(inst.correlation_id);
    const domainLabel = formatDomain(inst.domain);
    const hasGate = inst.has_pending_gate;

    return `
    <div class="backlog-item border-l-3 border-transparent px-3 py-2.5 ${isActive ? 'active' : ''}"
         onclick="selectCase('${inst.instance_id}')"
         data-instance="${inst.instance_id}">
      <div class="flex items-center justify-between gap-2">
        <span class="font-mono text-xs font-semibold text-slate-700 truncate">${caseLabel}</span>
        ${hasGate
          ? `<span class="flex items-center gap-1 text-xs font-medium text-yellow-700 bg-yellow-50 border border-yellow-200 px-1.5 py-0.5 rounded">
               <span class="pulse-dot w-1.5 h-1.5 rounded-full bg-yellow-500"></span>Gate
             </span>`
          : `<span class="flex items-center gap-1 text-xs font-medium ${statusInfo.textClass} ${statusInfo.bgClass} border ${statusInfo.borderClass} px-1.5 py-0.5 rounded">
               ${statusInfo.icon} ${inst.status}
             </span>`
        }
      </div>
      <div class="mt-0.5 flex items-center justify-between">
        <span class="text-xs text-slate-500 truncate">${domainLabel}</span>
        <span class="text-xs text-slate-400 shrink-0">${timeAgo}</span>
      </div>
    </div>`;
  }).join('');
}

function updateHeader(instances) {
  const pending = instances.filter(i => i.has_pending_gate).length;
  const running = instances.filter(i => i.status === 'running').length;

  const gateBadge = document.getElementById('gate-count-badge');
  const gateText = document.getElementById('gate-count-text');
  const runBadge = document.getElementById('running-badge');
  const runText = document.getElementById('running-count-text');

  if (pending > 0) {
    gateBadge.classList.remove('hidden');
    gateBadge.classList.add('flex');
    gateText.textContent = pending + ' pending gate' + (pending !== 1 ? 's' : '');
  } else {
    gateBadge.classList.add('hidden');
    gateBadge.classList.remove('flex');
  }

  if (running > 0) {
    runBadge.classList.remove('hidden');
    runBadge.classList.add('flex');
    runText.textContent = running + ' running';
  } else {
    runBadge.classList.add('hidden');
    runBadge.classList.remove('flex');
  }
}

// ── Case Selection ─────────────────────────────────────────────────
async function selectCase(instanceId) {
  selectedInstanceId = instanceId;

  // Highlight active item in backlog
  document.querySelectorAll('.backlog-item').forEach(el => {
    el.classList.toggle('active', el.dataset.instance === instanceId);
  });

  // Stop existing chain polling
  if (chainPollingTimer) clearInterval(chainPollingTimer);

  // Load chain immediately
  const chain = await loadChain(instanceId);

  // Poll every 2s while any instance is running/created
  const isLive = chain && chain.some(i => ['running', 'created'].includes(i.status));
  if (isLive) {
    chainPollingTimer = setInterval(async () => {
      const c = await loadChain(instanceId);
      if (!c || c.every(i => isTerminal(i.status))) {
        clearInterval(chainPollingTimer);
        chainPollingTimer = null;
        // Refresh backlog too
        await loadBacklog();
      }
    }, 2000);
  }
}

async function loadChain(instanceId) {
  try {
    const res = await fetch(`/api/instances/${instanceId}/chain`);
    if (!res.ok) return null;
    const chain = await res.json();
    renderChain(chain);
    return chain;
  } catch (e) {
    console.warn('Chain fetch failed:', e);
    return null;
  }
}

// ── Chain View ─────────────────────────────────────────────────────
function renderChain(chain) {
  const panel = document.getElementById('main-panel');
  if (!chain || chain.length === 0) {
    panel.innerHTML = `<div class="p-8 text-slate-400 text-sm">No instances found.</div>`;
    return;
  }

  const root = chain[0];
  const correlationId = root.correlation_id;
  const caseLabel = formatCaseId(correlationId);
  const rootStatus = getStatusInfo(root.status);

  // Find any pending gate
  const suspended = chain.find(i => i.status === 'suspended' && i.pending_task);

  let html = `
  <div class="p-6 max-w-4xl mx-auto space-y-5">

    <!-- Case header -->
    <div class="bg-white rounded-xl border border-slate-200 px-5 py-4">
      <div class="flex items-start justify-between gap-4">
        <div>
          <div class="flex items-center gap-3 mb-1">
            <span class="font-mono font-semibold text-navy text-lg">${caseLabel}</span>
            <span class="flex items-center gap-1.5 text-sm font-medium ${rootStatus.textClass} ${rootStatus.bgClass} border ${rootStatus.borderClass} px-2.5 py-0.5 rounded-full">
              ${rootStatus.icon} ${root.status.toUpperCase()}
            </span>
          </div>
          <div class="text-sm text-slate-500">${formatDomain(root.domain)} · ${root.governance_tier} tier</div>
        </div>
        <div class="text-right text-xs text-slate-400">
          <div>Started ${formatTimeAgo(root.created_at)}</div>
          ${root.elapsed_seconds > 0 ? `<div>${root.elapsed_seconds.toFixed(1)}s total</div>` : ''}
        </div>
      </div>

      <!-- Delegation flow diagram -->
      <div class="mt-4 pt-4 border-t border-slate-100">
        <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Delegation Chain</div>
        ${renderDelegationFlow(chain)}
      </div>
    </div>

    <!-- Gate banner -->
    ${suspended ? renderGateBanner(suspended) : ''}

    <!-- Instance sections (step cards) -->
    ${chain.map(inst => renderInstanceSection(inst, chain)).join('')}
  </div>`;

  panel.innerHTML = html;
}

function renderDelegationFlow(chain) {
  // Group by lineage depth
  const byDepth = {};
  chain.forEach(inst => {
    const depth = inst.lineage.length;
    if (!byDepth[depth]) byDepth[depth] = [];
    byDepth[depth].push(inst);
  });

  const depths = Object.keys(byDepth).map(Number).sort();
  const rows = depths.map(depth => {
    const instances = byDepth[depth];
    return instances.map(inst => {
      const info = getStatusInfo(inst.status);
      const label = formatWorkflowLabel(inst.workflow_type, inst.domain);
      const isRunning = inst.status === 'running' || inst.status === 'created';
      return `<span class="chain-node ${info.textClass} ${info.bgClass} border-${info.borderColor}">
        ${isRunning ? `<span class="pulse-dot w-1.5 h-1.5 rounded-full bg-current"></span>` : info.icon}
        ${label}
      </span>`;
    }).join(`<span class="text-slate-300 mx-1">·</span>`);
  });

  // Join depth levels with arrows
  const flowParts = [];
  for (let i = 0; i < rows.length; i++) {
    flowParts.push(`<span class="flex flex-wrap items-center gap-2">${rows[i]}</span>`);
    if (i < rows.length - 1) {
      const childDepth = depths[i + 1];
      const parentDepth = depths[i];
      const isWait = chain.some(inst =>
        inst.lineage.length === childDepth &&
        byDepth[parentDepth].some(p => inst.lineage.includes(p.instance_id))
      );
      flowParts.push(`
        <span class="flex items-center gap-1 text-slate-400 text-xs my-1 ml-2">
          <span class="text-slate-300">↓</span>
          <span>${isWait ? 'wait_for_result' : 'fire_and_forget'}</span>
        </span>`);
    }
  }
  return `<div class="space-y-1">${flowParts.join('')}</div>`;
}

function renderGateBanner(inst) {
  const task = inst.pending_task;
  if (!task) return '';
  return `
  <div class="gate-pulse bg-yellow-50 border-2 border-yellow-400 rounded-xl p-5">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <div>
        <div class="flex items-center gap-2 mb-1">
          <span class="text-yellow-600 text-lg">⚠</span>
          <span class="font-semibold text-yellow-800">Awaiting Analyst Approval</span>
        </div>
        <div class="text-sm text-yellow-700">
          <span class="font-medium">${formatWorkflowLabel(inst.workflow_type, inst.domain)}</span>
          · Gate tier · Queue: <code class="bg-yellow-100 px-1 rounded text-xs">${task.queue || 'fraud_analyst_review'}</code>
        </div>
        ${task.expires_at ? `<div class="text-xs text-yellow-600 mt-1">Expires ${formatTimeAgo(task.expires_at)}</div>` : ''}
      </div>
      <div class="flex gap-3">
        <button onclick="openApproveModal('${task.task_id}', '${inst.correlation_id}')"
          class="px-5 py-2 bg-green-600 text-white font-medium text-sm rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2">
          ✓ Approve
        </button>
        <button onclick="openRejectModal('${task.task_id}', '${inst.correlation_id}')"
          class="px-5 py-2 bg-red-600 text-white font-medium text-sm rounded-lg hover:bg-red-700 transition-colors flex items-center gap-2">
          ✗ Reject
        </button>
      </div>
    </div>
  </div>`;
}

function renderInstanceSection(inst, allChain) {
  const info = getStatusInfo(inst.status);
  const isRunning = inst.status === 'running' || inst.status === 'created';
  const steps = inst.result?.steps || [];
  const hasError = inst.error;
  const depth = inst.lineage.length;
  const indent = depth > 0 ? `ml-${Math.min(depth * 4, 8)}` : '';

  return `
  <div class="bg-white rounded-xl border border-slate-200 overflow-hidden ${indent}">
    <!-- Instance header -->
    <div class="px-5 py-3 border-b border-slate-100 flex items-center justify-between gap-3">
      <div class="flex items-center gap-3 min-w-0">
        <div class="flex items-center gap-2">
          ${depth > 0 ? `<span class="text-slate-300 text-sm">└</span>` : ''}
          <span class="font-medium text-navy text-sm">${formatWorkflowLabel(inst.workflow_type, inst.domain)}</span>
        </div>
        <span class="flex items-center gap-1.5 text-xs font-medium ${info.textClass} ${info.bgClass} border ${info.borderClass} px-2 py-0.5 rounded-full shrink-0">
          ${isRunning ? `<span class="pulse-dot w-1.5 h-1.5 rounded-full bg-current"></span>` : info.icon}
          ${inst.status}
        </span>
        ${inst.governance_tier !== 'auto' ? `<span class="text-xs text-slate-400 shrink-0">${inst.governance_tier}</span>` : ''}
      </div>
      <div class="flex items-center gap-3 text-xs text-slate-400 shrink-0">
        ${steps.length > 0 ? `<span>${steps.length} step${steps.length !== 1 ? 's' : ''}</span>` : ''}
        ${inst.elapsed_seconds > 0 ? `<span>${inst.elapsed_seconds.toFixed(1)}s</span>` : ''}
        <span class="font-mono text-slate-300">${inst.instance_id.slice(0, 14)}</span>
      </div>
    </div>

    <!-- Error banner -->
    ${hasError ? `
    <div class="px-5 py-3 bg-red-50 border-b border-red-100 text-sm text-red-700">
      <span class="font-medium">Error:</span> ${escapeHtml(inst.error)}
    </div>` : ''}

    <!-- Running placeholder -->
    ${isRunning && steps.length === 0 ? `
    <div class="px-5 py-4 flex items-center gap-3 text-slate-400 text-sm">
      <span class="pulse-dot w-2 h-2 rounded-full bg-blue-400"></span>
      Executing workflow...
    </div>` : ''}

    <!-- Step cards -->
    ${steps.length > 0 ? `
    <div class="divide-y divide-slate-100">
      ${steps.map((step, i) => renderStepCard(step, inst.instance_id, i)).join('')}
    </div>` : ''}

    <!-- Work orders dispatched -->
    ${inst.work_orders && inst.work_orders.length > 0 ? renderWorkOrders(inst.work_orders, allChain) : ''}
  </div>`;
}

function renderWorkOrders(workOrders, allChain) {
  if (!workOrders.length) return '';
  return `
  <div class="px-5 py-3 bg-slate-50 border-t border-slate-100">
    <div class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Delegations Dispatched</div>
    <div class="space-y-1">
      ${workOrders.map(wo => {
        const info = getStatusInfo(wo.status);
        const handler = allChain.find(i => i.instance_id === wo.handler_instance_id);
        return `
        <div class="flex items-center gap-3 text-xs">
          <span class="${info.textClass}">${info.icon}</span>
          <span class="text-slate-600 font-medium">${formatWorkflowLabel(wo.handler_workflow_type, wo.handler_domain || '')}</span>
          <span class="text-slate-400">${wo.mode || ''}</span>
          <span class="${info.textClass} ${info.bgClass} border ${info.borderClass} px-1.5 py-0.5 rounded">${wo.status}</span>
          ${handler ? `<span class="text-slate-300 font-mono">${wo.handler_instance_id.slice(0, 12)}</span>` : ''}
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

// ── Step Cards ─────────────────────────────────────────────────────
function renderStepCard(step, instanceId, idx) {
  const prim = step.primitive || 'unknown';
  const primInfo = getPrimitiveInfo(prim);
  const cardId = `step-${instanceId}-${idx}`;

  let bodyHtml = '';

  switch (prim) {
    case 'classify':
      bodyHtml = renderClassifyBody(step);
      break;
    case 'retrieve':
      bodyHtml = renderRetrieveBody(step);
      break;
    case 'investigate':
      bodyHtml = renderInvestigateBody(step);
      break;
    case 'think':
      bodyHtml = renderThinkBody(step);
      break;
    case 'verify':
      bodyHtml = renderVerifyBody(step);
      break;
    case 'challenge':
      bodyHtml = renderChallengeBody(step);
      break;
    case 'generate':
      bodyHtml = renderGenerateBody(step);
      break;
    default:
      bodyHtml = `<pre class="text-xs text-slate-500 overflow-x-auto">${escapeHtml(JSON.stringify(step, null, 2))}</pre>`;
  }

  return `
  <div class="step-card mx-3 my-2">
    <div class="step-header" onclick="toggleStep('${cardId}')">
      <span class="${primInfo.textClass} ${primInfo.bgClass} text-xs font-semibold px-2 py-0.5 rounded">${prim}</span>
      <span class="font-medium text-slate-700 text-sm flex-1">${step.step_name || 'step'}</span>
      ${renderConfidencePill(step.confidence)}
      <span class="text-slate-300 text-xs step-toggle-icon" id="${cardId}-icon">▼</span>
    </div>
    <div id="${cardId}" style="display:none">
      <div class="px-4 py-3 bg-white border-t border-slate-100 space-y-3">
        ${bodyHtml}
      </div>
    </div>
  </div>`;
}

function toggleStep(cardId) {
  const body = document.getElementById(cardId);
  const icon = document.getElementById(cardId + '-icon');
  if (!body) return;
  const isOpen = body.style.display === 'block';
  body.style.display = isOpen ? 'none' : 'block';
  if (icon) icon.textContent = isOpen ? '▼' : '▲';
}

function renderConfidencePill(confidence) {
  if (confidence == null) return '';
  const pct = Math.round(confidence * 100);
  const color = pct >= 80 ? 'text-green-700 bg-green-50 border-green-200'
    : pct >= 60 ? 'text-yellow-700 bg-yellow-50 border-yellow-200'
    : 'text-red-700 bg-red-50 border-red-200';
  return `<span class="text-xs font-medium ${color} border px-1.5 py-0.5 rounded">${pct}%</span>`;
}

function renderConfidenceBar(confidence) {
  if (confidence == null) return '';
  const pct = Math.round(confidence * 100);
  const color = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-yellow-500' : 'bg-red-500';
  return `
  <div class="flex items-center gap-2">
    <div class="flex-1 bg-slate-100 rounded-full h-2">
      <div class="conf-bar-fill ${color} h-2 rounded-full" style="width:${pct}%"></div>
    </div>
    <span class="text-xs font-medium text-slate-600 w-8 text-right">${pct}%</span>
  </div>`;
}

function renderClassifyBody(step) {
  return `
  <div class="flex items-center gap-3">
    <span class="text-sm font-semibold text-slate-800">${escapeHtml(step.category || '—')}</span>
    ${renderConfidencePill(step.confidence)}
  </div>
  ${step.confidence != null ? renderConfidenceBar(step.confidence) : ''}`;
}

function renderRetrieveBody(step) {
  const sources = step.sources || [];
  if (sources.length === 0) {
    return `<span class="text-sm text-slate-400">No sources recorded</span>`;
  }
  return `
  <div class="space-y-1">
    <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Sources Fetched</div>
    <div class="flex flex-wrap gap-2">
      ${sources.map(s => `
        <span class="text-xs bg-purple-50 text-purple-700 border border-purple-200 px-2 py-0.5 rounded font-mono">
          ${escapeHtml(s)}
        </span>`).join('')}
    </div>
  </div>`;
}

function renderInvestigateBody(step) {
  return `
  ${step.finding ? `
  <div>
    <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Finding</div>
    <p class="text-sm text-slate-700 leading-relaxed">${escapeHtml(step.finding)}</p>
  </div>` : ''}
  ${step.confidence != null ? `
  <div>
    <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Confidence</div>
    ${renderConfidenceBar(step.confidence)}
  </div>` : ''}
  ${step.evidence_flags && step.evidence_flags.length > 0 ? `
  <div>
    <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Evidence Flags</div>
    <div class="flex flex-wrap gap-1.5">
      ${step.evidence_flags.map(f => `
        <span class="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded">${escapeHtml(f)}</span>
      `).join('')}
    </div>
  </div>` : ''}
  ${step.missing_evidence && step.missing_evidence.length > 0 ? `
  <div>
    <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Missing Evidence</div>
    <div class="flex flex-wrap gap-1.5">
      ${step.missing_evidence.map(f => `
        <span class="text-xs bg-slate-50 text-slate-500 border border-slate-200 px-2 py-0.5 rounded">${escapeHtml(f)}</span>
      `).join('')}
    </div>
  </div>` : ''}`;
}

function renderThinkBody(step) {
  return `
  ${step.decision ? `
  <div class="flex items-center gap-3">
    <span class="text-sm font-semibold text-slate-800">${escapeHtml(step.decision)}</span>
    ${renderConfidencePill(step.confidence)}
  </div>` : ''}
  ${step.recommendation && step.recommendation !== step.decision ? `
  <div class="text-sm text-slate-600 italic">${escapeHtml(step.recommendation)}</div>` : ''}
  ${step.confidence != null ? renderConfidenceBar(step.confidence) : ''}
  ${step.reasoning ? `
  <details class="text-sm">
    <summary class="text-xs font-semibold text-slate-400 cursor-pointer hover:text-slate-600">▼ Reasoning</summary>
    <p class="mt-2 text-slate-600 leading-relaxed text-sm">${escapeHtml(step.reasoning)}</p>
  </details>` : ''}
  ${step.thought ? `
  <details class="text-sm">
    <summary class="text-xs font-semibold text-slate-400 cursor-pointer hover:text-slate-600">▼ Thought process</summary>
    <p class="mt-2 text-slate-600 leading-relaxed text-sm">${escapeHtml(step.thought)}</p>
  </details>` : ''}
  ${step.conclusions && step.conclusions.length > 0 ? `
  <div>
    <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Conclusions</div>
    <ul class="space-y-1">
      ${step.conclusions.map(c => `<li class="text-sm text-slate-600 flex gap-2"><span class="text-slate-300">·</span>${escapeHtml(String(c))}</li>`).join('')}
    </ul>
  </div>` : ''}`;
}

function renderVerifyBody(step) {
  const conformsColor = step.conforms ? 'text-green-700 bg-green-50 border-green-200' : 'text-red-700 bg-red-50 border-red-200';
  const conformsLabel = step.conforms === true ? '✓ Conforms' : step.conforms === false ? '✗ Non-conforming' : '— Unknown';
  return `
  <div class="flex items-center gap-3">
    <span class="text-xs font-medium ${conformsColor} border px-2.5 py-1 rounded-full">${conformsLabel}</span>
    ${step.violations != null ? `<span class="text-xs text-slate-500">${step.violations} violation${step.violations !== 1 ? 's' : ''}</span>` : ''}
  </div>
  ${step.confidence != null ? renderConfidenceBar(step.confidence) : ''}`;
}

function renderChallengeBody(step) {
  const survivesColor = step.survives ? 'text-green-700 bg-green-50 border-green-200' : 'text-red-700 bg-red-50 border-red-200';
  const survivesLabel = step.survives === true ? '✓ Survives challenge' : step.survives === false ? '✗ Did not survive' : '— Unknown';
  return `
  <div class="flex items-center gap-3">
    <span class="text-xs font-medium ${survivesColor} border px-2.5 py-1 rounded-full">${survivesLabel}</span>
    ${step.vulnerabilities != null ? `<span class="text-xs text-slate-500">${step.vulnerabilities} vulnerabilit${step.vulnerabilities !== 1 ? 'ies' : 'y'}</span>` : ''}
  </div>`;
}

function renderGenerateBody(step) {
  const preview = step.artifact_preview || step.artifact || '';
  const displayPreview = String(preview).slice(0, 300);
  return `
  ${displayPreview ? `
  <div>
    <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Artifact Preview</div>
    <pre class="text-xs text-slate-600 bg-slate-50 border border-slate-100 rounded p-3 whitespace-pre-wrap overflow-x-auto max-h-48">${escapeHtml(displayPreview)}${preview.length > 300 ? '…' : ''}</pre>
  </div>` : ''}
  ${step.confidence != null ? renderConfidenceBar(step.confidence) : ''}`;
}

// ── Submit Case Modal ──────────────────────────────────────────────
let availableCases = [];

async function loadCasesForModal() {
  try {
    const res = await fetch('/api/cases');
    if (!res.ok) return;
    availableCases = await res.json();
    const select = document.getElementById('submit-case-file');
    select.innerHTML = availableCases.map(c =>
      `<option value="${escapeAttr(c.path)}">${c.case_id} — ${formatFraudType(c.fraud_type)}</option>`
    ).join('');
    updateCaseDescription();
    select.addEventListener('change', updateCaseDescription);
  } catch (e) {
    console.warn('Could not load cases:', e);
  }
}

function updateCaseDescription() {
  const select = document.getElementById('submit-case-file');
  const desc = document.getElementById('submit-case-desc');
  const selected = availableCases.find(c => c.path === select.value);
  desc.textContent = selected ? selected.description : '';
}

function openSubmitModal() {
  document.getElementById('submit-modal').classList.remove('hidden');
  document.getElementById('submit-btn').disabled = false;
  document.getElementById('submit-btn').textContent = 'Run Workflow';
}

function closeSubmitModal() {
  document.getElementById('submit-modal').classList.add('hidden');
}

async function submitCase() {
  const caseFile = document.getElementById('submit-case-file').value;
  const workflow = document.getElementById('submit-workflow').value.trim();
  const domain = document.getElementById('submit-domain').value.trim();

  if (!caseFile) { showToast('Please select a case file'); return; }
  if (!workflow) { showToast('Please enter a workflow'); return; }

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case_file: caseFile, workflow, domain }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || 'Unknown error');
    }

    const data = await res.json();
    closeSubmitModal();
    showToast('Case submitted — workflow starting…');

    // Refresh backlog and select the new case
    await loadBacklog();
    if (data.instance_id) {
      await selectCase(data.instance_id);
    }
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Run Workflow';
  }
}

// ── Approve / Reject ───────────────────────────────────────────────
function openApproveModal(taskId, correlationId) {
  pendingConfirmAction = { type: 'approve', taskId, correlationId };
  document.getElementById('confirm-title').textContent = 'Approve Governance Gate';
  document.getElementById('confirm-message').textContent =
    'Review has been completed. Approving will finalize the workflow and execute any downstream delegations.';
  document.getElementById('confirm-notes-label').textContent = 'Approval Notes';
  document.getElementById('confirm-notes').placeholder = 'Optional approval notes...';
  document.getElementById('confirm-notes').value = '';
  document.getElementById('confirm-analyst').value = 'analyst';
  const btn = document.getElementById('confirm-action-btn');
  btn.className = 'px-5 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors';
  btn.textContent = '✓ Approve';
  document.getElementById('confirm-modal').classList.remove('hidden');
}

function openRejectModal(taskId, correlationId) {
  pendingConfirmAction = { type: 'reject', taskId, correlationId };
  document.getElementById('confirm-title').textContent = 'Reject Governance Gate';
  document.getElementById('confirm-message').textContent =
    'Rejecting will terminate this workflow instance. This action cannot be undone.';
  document.getElementById('confirm-notes-label').textContent = 'Rejection Reason';
  document.getElementById('confirm-notes').placeholder = 'Required: reason for rejection...';
  document.getElementById('confirm-notes').value = '';
  document.getElementById('confirm-analyst').value = 'analyst';
  const btn = document.getElementById('confirm-action-btn');
  btn.className = 'px-5 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors';
  btn.textContent = '✗ Reject';
  document.getElementById('confirm-modal').classList.remove('hidden');
}

function closeConfirmModal() {
  document.getElementById('confirm-modal').classList.add('hidden');
  pendingConfirmAction = null;
}

async function executeConfirm() {
  if (!pendingConfirmAction) return;
  const { type, taskId, correlationId } = pendingConfirmAction;
  const analyst = document.getElementById('confirm-analyst').value.trim() || 'analyst';
  const notes = document.getElementById('confirm-notes').value.trim();

  if (type === 'reject' && !notes) {
    showToast('Rejection reason is required', 'error');
    return;
  }

  const btn = document.getElementById('confirm-action-btn');
  btn.disabled = true;
  btn.textContent = 'Processing…';

  try {
    const endpoint = type === 'approve'
      ? `/api/tasks/${taskId}/approve`
      : `/api/tasks/${taskId}/reject`;

    const body = type === 'approve'
      ? { approver: analyst, notes }
      : { rejector: analyst, reason: notes };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || 'Unknown error');
    }

    closeConfirmModal();
    showToast(type === 'approve' ? 'Approved — workflow resuming…' : 'Rejected — workflow terminated');

    // Restart chain polling to pick up state changes
    if (selectedInstanceId) {
      if (chainPollingTimer) clearInterval(chainPollingTimer);
      chainPollingTimer = setInterval(async () => {
        const c = await loadChain(selectedInstanceId);
        if (!c || c.every(i => isTerminal(i.status))) {
          clearInterval(chainPollingTimer);
          chainPollingTimer = null;
        }
      }, 2000);
      await loadChain(selectedInstanceId);
    }
    await loadBacklog();
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
    btn.disabled = false;
    btn.textContent = type === 'approve' ? '✓ Approve' : '✗ Reject';
  }
}

// ── Helpers ────────────────────────────────────────────────────────
function isTerminal(status) {
  return ['completed', 'failed', 'terminated'].includes(status);
}

function getStatusInfo(status) {
  switch (status) {
    case 'running':
    case 'created':
      return { icon: '●', textClass: 'text-blue-700', bgClass: 'bg-blue-50', borderClass: 'border-blue-200', borderColor: 'blue-200' };
    case 'suspended':
      return { icon: '⏸', textClass: 'text-yellow-700', bgClass: 'bg-yellow-50', borderClass: 'border-yellow-200', borderColor: 'yellow-200' };
    case 'completed':
      return { icon: '✓', textClass: 'text-green-700', bgClass: 'bg-green-50', borderClass: 'border-green-200', borderColor: 'green-200' };
    case 'failed':
      return { icon: '✗', textClass: 'text-red-700', bgClass: 'bg-red-50', borderClass: 'border-red-200', borderColor: 'red-200' };
    case 'terminated':
      return { icon: '■', textClass: 'text-slate-700', bgClass: 'bg-slate-50', borderClass: 'border-slate-200', borderColor: 'slate-200' };
    default:
      return { icon: '○', textClass: 'text-slate-600', bgClass: 'bg-slate-50', borderClass: 'border-slate-200', borderColor: 'slate-200' };
  }
}

function getPrimitiveInfo(prim) {
  const map = {
    classify:    { textClass: 'text-blue-700',   bgClass: 'bg-blue-50'   },
    retrieve:    { textClass: 'text-purple-700',  bgClass: 'bg-purple-50' },
    investigate: { textClass: 'text-amber-700',   bgClass: 'bg-amber-50'  },
    think:       { textClass: 'text-orange-700',  bgClass: 'bg-orange-50' },
    verify:      { textClass: 'text-green-700',   bgClass: 'bg-green-50'  },
    challenge:   { textClass: 'text-red-700',     bgClass: 'bg-red-50'    },
    generate:    { textClass: 'text-teal-700',    bgClass: 'bg-teal-50'   },
    act:         { textClass: 'text-pink-700',    bgClass: 'bg-pink-50'   },
  };
  return map[prim] || { textClass: 'text-slate-700', bgClass: 'bg-slate-50' };
}

function formatCaseId(correlationId) {
  // Show last 12 chars of correlation_id as a compact case handle
  if (!correlationId) return '—';
  return correlationId.slice(-12).toUpperCase();
}

function formatDomain(domain) {
  if (!domain) return '';
  return domain.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatWorkflowLabel(workflowType, domain) {
  // Use domain for more descriptive label when available
  if (domain && domain !== workflowType) {
    return formatDomain(domain);
  }
  return formatDomain(workflowType);
}

function formatFraudType(fraudType) {
  if (!fraudType) return 'Unknown';
  return fraudType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatTimeAgo(ts) {
  if (!ts) return '';
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 5) return 'just now';
  if (diff < 60) return Math.round(diff) + 's ago';
  if (diff < 3600) return Math.round(diff / 60) + 'm ago';
  if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
  return Math.round(diff / 86400) + 'd ago';
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  if (str == null) return '';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.background = type === 'error' ? '#dc2626' : '#1e293b';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}
