"use strict";

const API = "";
let currentPO = null;
let sessionStats = { pending: 0, approved: 0, reset: 0 };
let allPOs = [];           // full unfiltered list
let activeStatusFilter = null; // "PENDING" | "APPROVED" | "RESET" | null

// ─── SSE ──────────────────────────────────────────────────────────────────────
function initSSE() {
  const dot = document.getElementById("sse-indicator");
  const es  = new EventSource("/events");

  es.onopen = () => dot.className = "sse-dot connected";

  es.addEventListener("po_released", e => {
    const data = JSON.parse(e.data);
    showToast(`PO ${data.ebeln} approved`, "success",
      `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>`
    );
    // Reload the list to get updated statistics
    if (!document.getElementById("view-list").classList.contains("hidden")) loadPOList();
    if (currentPO && currentPO.EBELN === data.ebeln) {
      setStatusBadge("APPROVED");
      disableActions("PO has been approved.");
      updateReleaseChain("APPROVED");
    }
  });

  es.addEventListener("po_rejected", e => {
    const data = JSON.parse(e.data);
    showToast(`PO ${data.ebeln} release reset`, "error",
      `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>`
    );
    // Reload the list to get updated statistics
    if (!document.getElementById("view-list").classList.contains("hidden")) loadPOList();
    if (currentPO && currentPO.EBELN === data.ebeln) {
      setStatusBadge("PENDING");
      disableActions("PO release has been reset.");
      updateReleaseChain("PENDING");
    }
  });

  es.onerror = () => {
    dot.className = "sse-dot error";
    console.warn("[SSE] Connection lost, retrying...");
    setTimeout(() => { dot.className = "sse-dot connected"; }, 5000);
  };
}

// ─── Sidebar stats ────────────────────────────────────────────────────────────
function updateSidebarStats() {
  document.getElementById("stat-pending").textContent  = sessionStats.pending;
  document.getElementById("stat-approved").textContent = sessionStats.approved;
  document.getElementById("stat-rejected").textContent = sessionStats.reset;

  // Highlight active filter card
  document.querySelectorAll(".stat-card").forEach(card => {
    card.classList.remove("stat-active");
  });
  if (activeStatusFilter) {
    const map = { PENDING: "stat-card-pending", APPROVED: "stat-card-approved", RESET: "stat-card-reset" };
    const el = document.getElementById(map[activeStatusFilter]);
    if (el) el.classList.add("stat-active");
  }
}

// ─── PO List ──────────────────────────────────────────────────────────────────
async function loadPOList() {
  const skeleton = document.getElementById("list-skeleton");
  const errorEl  = document.getElementById("list-error");
  const errorMsg = document.getElementById("list-error-msg");
  const grid     = document.getElementById("po-card-grid");
  const empty    = document.getElementById("list-empty");

  skeleton.classList.remove("hidden");
  errorEl.classList.add("hidden");
  grid.classList.add("hidden");
  empty.classList.add("hidden");

  try {
    // Get date filter values
    const fromDate = document.getElementById("filter-from-date")?.value || "";
    const toDate = document.getElementById("filter-to-date")?.value || "";
    
    // Build query params
    const params = new URLSearchParams();
    if (fromDate) params.append("fromDate", fromDate);
    if (toDate) params.append("toDate", toDate);
    
    const queryString = params.toString() ? `?${params.toString()}` : "";
    const res  = await fetch(`${API}/api/pos${queryString}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "Failed to load POs");

    skeleton.classList.add("hidden");
    const pos = json.data;

    // Store full list for client-side filtering
    allPOs = pos || [];

    // Calculate statistics from the actual list
    const pendingCount = pos.filter(po => po.STATUS === "PENDING").length;
    const approvedCount = pos.filter(po => po.STATUS === "APPROVED").length;
    const resetCount = pos.filter(po => po.STATUS === "RESET").length;

    // Update sidebar stats with actual counts from the list
    sessionStats.pending  = pendingCount;
    sessionStats.approved = approvedCount;
    sessionStats.reset    = resetCount;
    updateSidebarStats();

    if (!pos || pos.length === 0) {
      empty.classList.remove("hidden");
      return;
    }

    renderPOGrid();
  } catch (err) {
    skeleton.classList.add("hidden");
    errorMsg.textContent = err.message;
    errorEl.classList.remove("hidden");
  }
}

function clearDateFilters() {
  document.getElementById("filter-from-date").value = "";
  document.getElementById("filter-to-date").value = "";
  loadPOList();
}

// ─── Client-side status filter ────────────────────────────────────────────────
function filterByStatus(status) {
  const grid  = document.getElementById("po-card-grid");
  const empty = document.getElementById("list-empty");

  // Toggle off if same filter clicked again
  if (activeStatusFilter === status) {
    activeStatusFilter = null;
  } else {
    activeStatusFilter = status;
    // Navigate to PO list view if not already there
    showPOList();
  }

  updateSidebarStats();
  renderPOGrid();

  // Scroll to top of list
  grid.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderPOGrid() {
  const grid  = document.getElementById("po-card-grid");
  const empty = document.getElementById("list-empty");

  const filtered = activeStatusFilter
    ? allPOs.filter(po => (po.STATUS || "PENDING") === activeStatusFilter)
    : allPOs;

  // Show/hide filter badge in breadcrumb
  const breadcrumb = document.getElementById("breadcrumb");
  if (activeStatusFilter) {
    breadcrumb.innerHTML = `<span class="filter-indicator">
      ${activeStatusFilter}
      <button onclick="filterByStatus('${activeStatusFilter}')" title="Clear filter">✕</button>
    </span>`;
  } else {
    breadcrumb.innerHTML = "";
  }

  if (filtered.length === 0) {
    grid.classList.add("hidden");
    empty.classList.remove("hidden");
    const emptyP    = empty.querySelector("p");
    const emptySpan = empty.querySelector("span");
    if (activeStatusFilter && emptyP) {
      emptyP.textContent = `No ${activeStatusFilter.toLowerCase()} purchase orders`;
      if (emptySpan) emptySpan.textContent = `There are no POs with status "${activeStatusFilter}" at this time.`;
    } else if (emptyP) {
      emptyP.textContent = "No pending purchase orders";
      if (emptySpan) emptySpan.textContent = "All caught up — nothing waiting for approval.";
    }
    return;
  }

  empty.classList.add("hidden");
  grid.innerHTML = filtered.map(po => buildPOCard(po)).join("");
  grid.classList.remove("hidden");
}

function buildPOCard(po) {
  const steps   = po.releaseSteps || [];
  const stepDots = steps.map((s, i) => {
    const cls = s.completed ? "done" : (i === steps.findIndex(x => !x.completed) ? "pending" : "");
    return `<span class="step-dot ${cls}" title="${escHtml(s.label)} (${s.code})"></span>`;
  }).join("");

  const stepsLabel = steps.length
    ? `<span style="font-size:10px;color:var(--text-3);margin-right:6px;">${steps.filter(s=>s.completed).length}/${steps.length} steps</span>${stepDots}`
    : "";

  return `
    <div class="po-card" onclick="loadPODetail('${po.EBELN}')">
      <div class="po-card-top">
        <div>
          <div class="po-card-num">${po.EBELN}</div>
          <div class="po-card-vendor">${escHtml(po.VENDOR_NAME || po.LIFNR)}</div>
        </div>
        <span class="status-badge status-${(po.STATUS||"PENDING").toLowerCase()}">${po.STATUS||"PENDING"}</span>
      </div>
      <div class="po-card-body">
        <div class="po-card-field">
          <span class="po-card-field-label">Net Value</span>
          <span class="po-card-amount">${po.WAERS} ${formatAmount(po.NETWR)}</span>
        </div>
        <div class="po-card-field">
          <span class="po-card-field-label">Doc Date</span>
          <span class="po-card-field-value">${formatDate(po.BEDAT)}</span>
        </div>
        <div class="po-card-field">
          <span class="po-card-field-label">Purch. Org</span>
          <span class="po-card-field-value">${escHtml(po.EKORG)}</span>
        </div>
        <div class="po-card-field">
          <span class="po-card-field-label">Company Code</span>
          <span class="po-card-field-value">${escHtml(po.BUKRS)}</span>
        </div>
      </div>
      <div class="po-card-footer">
        <div class="po-card-steps">${stepsLabel}</div>
        <button class="btn-view-detail" onclick="event.stopPropagation(); loadPODetail('${po.EBELN}')">View Details</button>
      </div>
    </div>`;
}

// ─── Direct PO lookup ─────────────────────────────────────────────────────────
function lookupPO() {
  const val = (document.getElementById("po-lookup-input")?.value || "").trim();
  if (!val) return;
  loadPODetail(val);
}

// ─── PO Detail ────────────────────────────────────────────────────────────────
async function loadPODetail(ebeln) {
  showDetail(ebeln);

  const skeleton = document.getElementById("detail-skeleton");
  const errorEl  = document.getElementById("detail-error");
  const errorMsg = document.getElementById("detail-error-msg");
  const content  = document.getElementById("detail-content");

  skeleton.classList.remove("hidden");
  errorEl.classList.add("hidden");
  content.classList.add("hidden");

  try {
    const res  = await fetch(`${API}/api/po/${ebeln}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "Failed to load PO details");

    const po = json.data;
    currentPO = po;

    // Header
    document.getElementById("d-ebeln").textContent  = po.EBELN;
    document.getElementById("d-vendor").textContent = `${escHtml(po.VENDOR_NAME || "")} (${po.LIFNR})`;
    document.getElementById("d-bukrs").textContent  = po.BUKRS;
    document.getElementById("d-ekorg").textContent  = po.EKORG;
    document.getElementById("d-ekgrp").textContent  = po.EKGRP;
    document.getElementById("d-bedat").textContent  = formatDate(po.BEDAT);
    document.getElementById("d-waers").textContent  = po.WAERS;
    document.getElementById("d-netwr").textContent  = `${po.WAERS} ${formatAmount(po.NETWR)}`;
    setStatusBadge(po.STATUS || "PENDING");

    // Release chain
    renderReleaseChain(po);

    // Line items
    let total = 0;
    document.getElementById("d-items").innerHTML = (po.items || []).map(item => {
      const lineTotal = item.MENGE * item.NETPR;
      total += lineTotal;
      return `<tr>
        <td>${item.EBELP}</td>
        <td>${escHtml(item.TXZ01)}</td>
        <td>${item.MENGE}</td>
        <td>${item.MEINS}</td>
        <td class="text-right">${formatAmount(item.NETPR)}</td>
        <td>${item.WERKS}</td>
        <td class="text-right">${formatAmount(lineTotal)}</td>
      </tr>`;
    }).join("");
    document.getElementById("d-total").textContent = `${po.WAERS} ${formatAmount(total)}`;

    // Action panel
    document.getElementById("release-code").value = "";
    document.getElementById("action-msg").classList.add("hidden");
    document.getElementById("action-panel").classList.remove("hidden");
    
    // Enable/disable buttons based on status
    if (po.STATUS === "APPROVED") {
      // PO is approved - disable approve button, enable reset button
      document.getElementById("btn-approve").disabled = true;
      document.getElementById("btn-reject").disabled = false;
      
      // Show helpful message with the current release code
      const currentReleaseCode = po.FRGKE || '';
      if (currentReleaseCode) {
        showActionMsg(`PO is approved with release code '${currentReleaseCode}'. To reset, enter '${currentReleaseCode}' above.`, "success");
      } else {
        showActionMsg("PO is approved. You can reset the release if needed.", "success");
      }
    } else {
      // PO is pending - enable approve button, disable reset button
      document.getElementById("btn-approve").disabled = false;
      document.getElementById("btn-reject").disabled = true;
    }

    skeleton.classList.add("hidden");
    content.classList.remove("hidden");
  } catch (err) {
    skeleton.classList.add("hidden");
    errorMsg.textContent = err.message;
    errorEl.classList.remove("hidden");
  }
}

// ─── Release chain renderer ───────────────────────────────────────────────────
function renderReleaseChain(po) {
  const card  = document.getElementById("release-chain-card");
  const chain = document.getElementById("release-chain");
  const steps = po.releaseSteps;

  if (!steps || steps.length === 0) {
    // If no release steps but we have FRGKE/FRGZU, show basic approval status
    if (po.FRGKE !== undefined || po.FRGZU !== undefined) {
      card.classList.remove("hidden");

      const isApproved = po.FRGKE === 'G';
      const isPending  = !po.FRGKE;
      const statusKey  = isApproved ? 'approved' : isPending ? 'pending' : 'in-progress';

      const statusMeta = {
        approved:    { label: 'Fully Released',    sub: 'This purchase order has been approved and released for processing.', icon: `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>` },
        pending:     { label: 'Awaiting Approval', sub: 'No release code has been applied yet. Use the action panel below to approve.', icon: `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/></svg>` },
        'in-progress': { label: 'Approval In Progress', sub: 'Partial release applied. Further approval steps may be required.', icon: `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"/></svg>` }
      };

      const meta = statusMeta[statusKey];

      chain.innerHTML = `
        <div class="approval-status-banner ${statusKey}">
          <div class="asb-icon">${meta.icon}</div>
          <div class="asb-body">
            <div class="asb-title">${meta.label}</div>
            <div class="asb-sub">${meta.sub}</div>
          </div>
          ${po.FRGKE && !isApproved ? `<div class="asb-badge">Code: <strong>${escHtml(po.FRGKE)}</strong></div>` : ''}
          ${po.FRGZU ? `<div class="asb-badge secondary">Status: <strong>${escHtml(po.FRGZU)}</strong></div>` : ''}
        </div>
      `;
    } else {
      card.classList.add("hidden");
    }
    return;
  }

  card.classList.remove("hidden");
  chain.innerHTML = steps.map((step, i) => {
    const isFirst   = i === 0;
    const isDone    = step.completed;
    const isCurrent = !isDone && (i === 0 || steps[i - 1].completed);
    const circleClass = isDone ? "done" : isCurrent ? "current" : "";
    const labelClass  = isDone ? "done" : isCurrent ? "current" : "";
    const connClass   = isDone ? "done" : "";

    const connector = !isFirst
      ? `<div class="release-connector ${connClass}"></div>`
      : "";
    
    // Add approval details if available
    const approvalDetails = step.approver || step.approvalDate ? `
      <div class="release-step-details">
        ${step.approver ? `<div class="release-step-approver">Approved by ${escHtml(step.approver)}</div>` : ''}
        ${step.approvalDate ? `<div class="release-step-date">on ${formatDate(step.approvalDate)}</div>` : ''}
      </div>
    ` : '';

    return `${connector}
      <div class="release-step">
        <div class="release-step-inner">
          <div class="release-step-circle ${circleClass}">${isDone ? '✓' : step.code}</div>
          <div class="release-step-label ${labelClass}">${escHtml(step.label)}</div>
          ${approvalDetails}
        </div>
      </div>`;
  }).join("");
}

function updateReleaseChain(status) {
  if (!currentPO || !currentPO.releaseSteps) return;
  if (status === "APPROVED") currentPO.releaseSteps.forEach(s => s.completed = true);
  if (status === "PENDING") currentPO.releaseSteps.forEach(s => s.completed = false);
  renderReleaseChain(currentPO);
}

async function handleApprove() {
  const releaseCode = document.getElementById("release-code").value.trim().toUpperCase();
  if (!releaseCode) { showActionMsg("Please enter a release code.", "error"); return; }

  setActionLoading(true);
  try {
    const res  = await fetch(`${API}/api/po/${currentPO.EBELN}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ releaseCode })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "Approval failed");

    showActionMsg(json.message || "PO approved successfully.", "success");
    
    // Reload PO details from SAP to get updated status
    await loadPODetail(currentPO.EBELN);
  } catch (err) {
    showActionMsg(err.message, "error");
  } finally {
    setActionLoading(false);
  }
}

// ─── Reset Release (with modal) ───────────────────────────────────────────────
function handleReject() {
  const releaseCode = document.getElementById("release-code").value.trim().toUpperCase();
  if (!releaseCode) { showActionMsg("Please enter a release code.", "error"); return; }

  document.getElementById("modal-body").textContent =
    `This will reset the release for PO ${currentPO.EBELN} using code ${releaseCode}. The PO will return to unreleased status.`;

  document.getElementById("modal-confirm").onclick = () => {
    closeModal();
    submitReject(releaseCode);
  };

  document.getElementById("modal-overlay").classList.remove("hidden");
}

async function submitReject(releaseCode) {
  setActionLoading(true);
  try {
    const res  = await fetch(`${API}/api/po/${currentPO.EBELN}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ releaseCode })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "Reset release failed");

    showActionMsg(json.message || "PO release reset successfully.", "success");
    
    // Reload PO details from SAP to get updated status
    await loadPODetail(currentPO.EBELN);
  } catch (err) {
    showActionMsg(err.message, "error");
  } finally {
    setActionLoading(false);
  }
}

function closeModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
}

// Close modal on overlay click
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("modal-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget) closeModal();
  });
});

// ─── View helpers ─────────────────────────────────────────────────────────────
function showList() {
  document.getElementById("view-list").classList.remove("hidden");
  document.getElementById("view-detail").classList.add("hidden");
  document.getElementById("view-create").classList.add("hidden");
  document.getElementById("view-vendor-performance").classList.add("hidden");
  document.getElementById("view-pr-list")?.classList.add("hidden");
  document.getElementById("view-pr-detail")?.classList.add("hidden");
  document.getElementById("page-title").textContent = "Purchase Orders";
  document.getElementById("breadcrumb").textContent = "";
  document.getElementById("nav-po").classList.add("active");
  document.getElementById("nav-create").classList.remove("active");
  document.getElementById("nav-vendor").classList.remove("active");
  document.getElementById("nav-pr")?.classList.remove("active");
  currentPO = null;
  
  // Reload the list to ensure fresh data
  loadPOList();
}

function showDetail(ebeln) {
  document.getElementById("view-list").classList.add("hidden");
  document.getElementById("view-detail").classList.remove("hidden");
  document.getElementById("view-create").classList.add("hidden");
  document.getElementById("view-vendor-performance").classList.add("hidden");
  document.getElementById("view-pr-list")?.classList.add("hidden");
  document.getElementById("view-pr-detail")?.classList.add("hidden");
  document.getElementById("page-title").textContent = "PO Detail";
  document.getElementById("breadcrumb").textContent = `/ ${ebeln}`;
  document.getElementById("nav-po").classList.add("active");
  document.getElementById("nav-create").classList.remove("active");
  document.getElementById("nav-vendor").classList.remove("active");
  document.getElementById("nav-pr")?.classList.remove("active");
}

function showCreateForm() {
  document.getElementById("view-list").classList.add("hidden");
  document.getElementById("view-detail").classList.add("hidden");
  document.getElementById("view-create").classList.remove("hidden");
  document.getElementById("view-vendor-performance").classList.add("hidden");
  document.getElementById("view-pr-list")?.classList.add("hidden");
  document.getElementById("view-pr-detail")?.classList.add("hidden");
  document.getElementById("page-title").textContent = "Create PO";
  document.getElementById("breadcrumb").textContent = "/ New";
  document.getElementById("nav-po").classList.remove("active");
  document.getElementById("nav-create").classList.add("active");
  document.getElementById("nav-vendor").classList.remove("active");
  document.getElementById("nav-pr")?.classList.remove("active");
  
  // Reset form
  document.getElementById("create-po-form").reset();
  document.getElementById("po-items-container").innerHTML = "";
  document.getElementById("create-msg").classList.add("hidden");
  
  // Set default document date to today
  const today = new Date().toISOString().split('T')[0];
  document.getElementById("create-doc-date").value = today;
  
  // Add one default item
  addPOItem();
}

function setStatusBadge(status) {
  const badge = document.getElementById("d-status-badge");
  badge.className = `status-badge status-${status.toLowerCase()}`;
  badge.textContent = status;
}

function disableActions(msg) {
  document.getElementById("btn-approve").disabled = true;
  document.getElementById("btn-reject").disabled  = true;
  if (msg) showActionMsg(msg, "success");
}

function setActionLoading(loading) {
  document.getElementById("btn-approve").disabled = loading;
  document.getElementById("btn-reject").disabled  = loading;
}

function showActionMsg(msg, type) {
  const el = document.getElementById("action-msg");
  el.textContent = msg;
  el.className = `action-msg ${type}`;
  el.classList.remove("hidden");
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type, iconHtml = "") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `${iconHtml}<span style="flex:1">${escHtml(msg)}</span><div class="toast-progress"></div>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = "slideOut 0.3s ease forwards";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function formatAmount(val) {
  return Number(val).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(sapDate) {
  if (!sapDate || sapDate.length !== 8) return sapDate || "—";
  return `${sapDate.slice(0,4)}-${sapDate.slice(4,6)}-${sapDate.slice(6,8)}`;
}

function escHtml(str) {
  return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ─── PO Creation ──────────────────────────────────────────────────────────────
let itemCounter = 0;

function addPOItem() {
  itemCounter++;
  const container = document.getElementById("po-items-container");
  const itemDiv = document.createElement("div");
  itemDiv.className = "po-item-row";
  itemDiv.id = `item-${itemCounter}`;
  itemDiv.innerHTML = `
    <div class="po-item-header">
      <span class="po-item-number">Item ${itemCounter}</span>
      <button type="button" class="btn-remove-item" onclick="removePOItem(${itemCounter})" title="Remove item">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
      </button>
    </div>
    <div class="po-item-grid">
      <div class="input-group span-2">
        <label class="input-label">Description *</label>
        <input class="input-field item-description" type="text" required placeholder="Item description" />
      </div>
      <div class="input-group">
        <label class="input-label">Material</label>
        <input class="input-field item-material" type="text" placeholder="e.g. 100-100" />
      </div>
      <div class="input-group">
        <label class="input-label">Plant *</label>
        <input class="input-field item-plant" type="text" required placeholder="1000" />
      </div>
      <div class="input-group">
        <label class="input-label">Quantity *</label>
        <input class="input-field item-quantity" type="number" step="0.001" required placeholder="0" />
      </div>
      <div class="input-group">
        <label class="input-label">Unit *</label>
        <input class="input-field item-unit" type="text" required placeholder="EA" maxlength="3" style="text-transform:uppercase;" />
      </div>
      <div class="input-group">
        <label class="input-label">Net Price *</label>
        <input class="input-field item-price" type="number" step="0.01" required placeholder="0.00" />
      </div>
      <div class="input-group">
        <label class="input-label">Storage Location</label>
        <input class="input-field item-storage" type="text" placeholder="0001" />
      </div>
    </div>
  `;
  container.appendChild(itemDiv);
}

function removePOItem(id) {
  const item = document.getElementById(`item-${id}`);
  if (item) item.remove();
}

async function handleCreatePO(event) {
  event.preventDefault();
  
  const msgEl = document.getElementById("create-msg");
  msgEl.classList.add("hidden");
  
  // Collect header data
  const poData = {
    vendor: document.getElementById("create-vendor").value.trim(),
    companyCode: document.getElementById("create-company").value.trim(),
    purchOrg: document.getElementById("create-purch-org").value.trim(),
    purchGroup: document.getElementById("create-purch-group").value.trim(),
    docType: document.getElementById("create-doc-type").value.trim() || undefined,
    docDate: document.getElementById("create-doc-date").value.trim() || undefined,
    currency: document.getElementById("create-currency").value.trim() || undefined,
    deliveryDate: document.getElementById("create-delivery-date").value.trim() || undefined,
    items: []
  };
  
  // Collect items
  const itemRows = document.querySelectorAll(".po-item-row");
  for (const row of itemRows) {
    const item = {
      description: row.querySelector(".item-description").value.trim(),
      material: row.querySelector(".item-material").value.trim() || undefined,
      quantity: parseFloat(row.querySelector(".item-quantity").value),
      unit: row.querySelector(".item-unit").value.trim(),
      netPrice: parseFloat(row.querySelector(".item-price").value),
      plant: row.querySelector(".item-plant").value.trim(),
      storageLocation: row.querySelector(".item-storage").value.trim() || undefined
    };
    poData.items.push(item);
  }
  
  if (poData.items.length === 0) {
    msgEl.textContent = "Please add at least one line item";
    msgEl.className = "action-msg error";
    msgEl.classList.remove("hidden");
    return;
  }
  
  // Disable submit button
  const submitBtn = event.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  
  try {
    const res = await fetch(`${API}/api/po/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(poData)
    });
    const json = await res.json();
    
    if (!json.success) throw new Error(json.error || "PO creation failed");
    
    // Build success message with warnings if any
    let message = json.message || `PO ${json.poNumber} created successfully`;
    
    // Show warnings if present
    if (json.warnings && json.warnings.length > 0) {
      message += "\n\nWarnings:\n" + json.warnings.join("\n");
    }
    
    // Show errors if present (non-blocking errors)
    if (json.errors && json.errors.length > 0) {
      message += "\n\nNotes:\n" + json.errors.join("\n");
    }
    
    msgEl.textContent = message;
    msgEl.className = "action-msg success";
    msgEl.classList.remove("hidden");
    
    showToast(`PO ${json.poNumber} created`, "success",
      `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>`
    );
    
    // Redirect to detail view after 2 seconds
    setTimeout(() => {
      loadPODetail(json.poNumber);
    }, 2000);
    
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className = "action-msg error";
    msgEl.classList.remove("hidden");
    submitBtn.disabled = false;
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initSSE();
  updateSidebarStats();
  loadPOList();
});


// ─── Vendor Performance Functions ────────────────────────────────────────────

async function showVendorPerformance() {
  document.getElementById("view-list").classList.add("hidden");
  document.getElementById("view-detail").classList.add("hidden");
  document.getElementById("view-create").classList.add("hidden");
  document.getElementById("view-vendor-performance").classList.remove("hidden");
  document.getElementById("view-pr-list")?.classList.add("hidden");
  document.getElementById("view-pr-detail")?.classList.add("hidden");
  
  document.getElementById("page-title").textContent = "Vendor Performance";
  document.getElementById("breadcrumb").textContent = "";
  
  document.getElementById("nav-po").classList.remove("active");
  document.getElementById("nav-create").classList.remove("active");
  document.getElementById("nav-vendor").classList.add("active");
  document.getElementById("nav-pr")?.classList.remove("active");
  
  await loadVendorList();
}

async function loadVendorList() {
  try {
    const res = await fetch(`${API}/api/vendors`);
    const json = await res.json();
    
    if (json.success) {
      const selector = document.getElementById("vendor-selector");
      selector.innerHTML = '<option value="">-- Select a Vendor --</option>';
      
      json.data.forEach(vendor => {
        const option = document.createElement("option");
        option.value = vendor.vendorId;
        option.textContent = `${vendor.vendorId} - ${vendor.vendorName}`;
        selector.appendChild(option);
      });
    }
  } catch (error) {
    console.error("Error loading vendors:", error);
  }
}

async function loadVendorPerformance(vendorId) {
  if (!vendorId) {
    document.getElementById("vendor-metrics").classList.add("hidden");
    return;
  }
  
  document.getElementById("vendor-loading").classList.remove("hidden");
  document.getElementById("vendor-metrics").classList.add("hidden");
  document.getElementById("vendor-error").classList.add("hidden");
  
  try {
    const res = await fetch(`${API}/api/vendor/${vendorId}/performance`);
    const json = await res.json();
    
    if (!json.success) throw new Error(json.error);
    
    const data = json.data;
    
    document.getElementById("metric-total-pos").textContent = data.totalPOs;
    document.getElementById("metric-total-spend").textContent = 
      `${data.currency} ${data.totalSpend.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById("metric-avg-delay").textContent = `${data.avgDeliveryDelay} days`;
    document.getElementById("metric-ontime-percent").textContent = `${data.onTimeDeliveryPercent}%`;
    
    const tbody = document.getElementById("vendor-po-list");
    if (data.poList && data.poList.length > 0) {
      tbody.innerHTML = data.poList.map(po => `
        <tr>
          <td><a href="#" onclick="loadPODetail('${po.ebeln}'); return false;">${po.ebeln}</a></td>
          <td>${data.currency} ${po.amount.toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
          <td>${formatDate(po.scheduledDate)}</td>
          <td>${formatDate(po.actualDate)}</td>
          <td>${po.delay}</td>
          <td><span class="status-badge status-${po.delay <= 0 ? 'approved' : 'pending'}">${po.delay <= 0 ? 'On Time' : 'Delayed'}</span></td>
        </tr>
      `).join("");
    } else {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;">No purchase orders found</td></tr>';
    }
    
    document.getElementById("vendor-loading").classList.add("hidden");
    document.getElementById("vendor-metrics").classList.remove("hidden");
    
  } catch (error) {
    document.getElementById("vendor-loading").classList.add("hidden");
    document.getElementById("vendor-error").classList.remove("hidden");
    document.getElementById("vendor-error-msg").textContent = error.message;
  }
}

function formatDate(dateStr) {
  if (!dateStr || dateStr.length !== 8) return dateStr;
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const day = dateStr.substring(6, 8);
  return `${day}/${month}/${year}`;
}

function showPOList() {
  showList();
  loadPOList(); // Reload the list to get fresh data from SAP
}


// ─── Purchase Requisition Functions ──────────────────────────────────────────

let currentPR = null;

async function showPRList() {
  document.getElementById("view-list").classList.add("hidden");
  document.getElementById("view-detail").classList.add("hidden");
  document.getElementById("view-create").classList.add("hidden");
  document.getElementById("view-vendor-performance").classList.add("hidden");
  document.getElementById("view-pr-list").classList.remove("hidden");
  document.getElementById("view-pr-detail").classList.add("hidden");
  
  document.getElementById("page-title").textContent = "Purchase Requisitions";
  document.getElementById("breadcrumb").textContent = "";
  
  document.getElementById("nav-po").classList.remove("active");
  document.getElementById("nav-create").classList.remove("active");
  document.getElementById("nav-vendor").classList.remove("active");
  document.getElementById("nav-pr").classList.add("active");
  
  currentPR = null;
  
  // Set default date range to last 26 years if not already set
  const fromDateInput = document.getElementById("pr-filter-from-date");
  const toDateInput = document.getElementById("pr-filter-to-date");
  
  if (!fromDateInput.value) {
    const twentySixYearsAgo = new Date();
    twentySixYearsAgo.setFullYear(twentySixYearsAgo.getFullYear() - 26);
    fromDateInput.value = twentySixYearsAgo.toISOString().split('T')[0];
  }
  
  if (!toDateInput.value) {
    const today = new Date();
    toDateInput.value = today.toISOString().split('T')[0];
  }
  
  await loadPRList();
}

async function loadPRList() {
  const skeleton = document.getElementById("pr-list-skeleton");
  const errorEl  = document.getElementById("pr-list-error");
  const errorMsg = document.getElementById("pr-list-error-msg");
  const grid     = document.getElementById("pr-card-grid");
  const empty    = document.getElementById("pr-list-empty");

  skeleton.classList.remove("hidden");
  errorEl.classList.add("hidden");
  grid.classList.add("hidden");
  empty.classList.add("hidden");

  try {
    // Get date filter values
    const fromDate = document.getElementById("pr-filter-from-date")?.value || "";
    const toDate = document.getElementById("pr-filter-to-date")?.value || "";
    
    // Build query params
    const params = new URLSearchParams();
    if (fromDate) params.append("fromDate", fromDate);
    if (toDate) params.append("toDate", toDate);
    
    const queryString = params.toString() ? `?${params.toString()}` : "";
    console.log(`[loadPRList] Fetching: ${API}/api/prs${queryString}`);
    const res  = await fetch(`${API}/api/prs${queryString}`);
    console.log(`[loadPRList] Response status: ${res.status}`);
    console.log(`[loadPRList] Response headers:`, res.headers.get('content-type'));
    
    const text = await res.text();
    console.log(`[loadPRList] Response text (first 200 chars):`, text.substring(0, 200));
    
    let json;
    try {
      json = JSON.parse(text);
    } catch (parseErr) {
      console.error(`[loadPRList] JSON parse error:`, parseErr);
      throw new Error(`Server returned invalid response. Expected JSON but got: ${text.substring(0, 100)}`);
    }
    
    if (!json.success) throw new Error(json.error || "Failed to load PRs");

    skeleton.classList.add("hidden");
    const prs = json.data;

    if (!prs || prs.length === 0) {
      empty.classList.remove("hidden");
      return;
    }

    grid.innerHTML = prs.map(pr => buildPRCard(pr)).join("");
    grid.classList.remove("hidden");
  } catch (err) {
    skeleton.classList.add("hidden");
    errorMsg.textContent = err.message;
    errorEl.classList.remove("hidden");
  }
}

function clearPRDateFilters() {
  // Reset to default 26 year range
  const twentySixYearsAgo = new Date();
  twentySixYearsAgo.setFullYear(twentySixYearsAgo.getFullYear() - 26);
  const today = new Date();
  
  document.getElementById("pr-filter-from-date").value = twentySixYearsAgo.toISOString().split('T')[0];
  document.getElementById("pr-filter-to-date").value = today.toISOString().split('T')[0];
  
  loadPRList();
}

function buildPRCard(pr) {
  return `
    <div class="po-card" onclick="loadPRDetail('${pr.BANFN}')">
      <div class="po-card-top">
        <div>
          <div class="po-card-num">${pr.BANFN}</div>
          <div class="po-card-vendor">${escHtml(pr.REQUISITIONER || 'Unknown')}</div>
        </div>
        <span class="status-badge status-pending">PENDING</span>
      </div>
      <div class="po-card-body">
        <div class="po-card-field">
          <span class="po-card-field-label">Total Value</span>
          <span class="po-card-amount">${pr.WAERS || 'USD'} ${formatAmount(pr.TOTAL_VALUE || 0)}</span>
        </div>
        <div class="po-card-field">
          <span class="po-card-field-label">Doc Date</span>
          <span class="po-card-field-value">${formatDate(pr.ERDAT)}</span>
        </div>
        <div class="po-card-field">
          <span class="po-card-field-label">Items</span>
          <span class="po-card-field-value">${pr.ITEM_COUNT || 0}</span>
        </div>
      </div>
      <div class="po-card-footer">
        <button class="btn-view-detail" onclick="event.stopPropagation(); loadPRDetail('${pr.BANFN}')">View Details</button>
      </div>
    </div>`;
}

async function loadPRDetail(banfn) {
  // Show PR detail view and hide all others
  document.getElementById("view-list").classList.add("hidden");
  document.getElementById("view-detail").classList.add("hidden");
  document.getElementById("view-create").classList.add("hidden");
  document.getElementById("view-vendor-performance").classList.add("hidden");
  document.getElementById("view-pr-list").classList.add("hidden");
  document.getElementById("view-pr-detail").classList.remove("hidden");
  
  document.getElementById("page-title").textContent = "PR Detail";
  document.getElementById("breadcrumb").textContent = `/ ${banfn}`;
  
  // Keep PR tab active
  document.getElementById("nav-po").classList.remove("active");
  document.getElementById("nav-create").classList.remove("active");
  document.getElementById("nav-vendor").classList.remove("active");
  document.getElementById("nav-pr").classList.add("active");

  const skeleton = document.getElementById("pr-detail-skeleton");
  const errorEl  = document.getElementById("pr-detail-error");
  const errorMsg = document.getElementById("pr-detail-error-msg");
  const content  = document.getElementById("pr-detail-content");

  skeleton.classList.remove("hidden");
  errorEl.classList.add("hidden");
  content.classList.add("hidden");

  try {
    const res  = await fetch(`${API}/api/pr/${banfn}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "Failed to load PR details");

    const pr = json.data;
    currentPR = pr;

    // Header
    document.getElementById("pr-banfn").textContent = pr.BANFN;
    document.getElementById("pr-requisitioner").textContent = pr.ERNAM || "Unknown";
    document.getElementById("pr-badat").textContent = formatDate(pr.ERDAT);
    
    // Calculate total
    let total = 0;
    (pr.items || []).forEach(item => {
      total += (item.MENGE || 0) * (item.PREIS || 0);
    });
    
    document.getElementById("pr-total").textContent = `${pr.WAERS || 'USD'} ${formatAmount(total)}`;

    // Line items
    document.getElementById("pr-items").innerHTML = (pr.items || []).map(item => {
      const lineTotal = (item.MENGE || 0) * (item.PREIS || 0);
      return `<tr>
        <td>${item.BNFPO}</td>
        <td>${escHtml(item.TXZ01 || '')}</td>
        <td>${item.MENGE || 0}</td>
        <td>${item.MEINS || ''}</td>
        <td class="text-right">${formatAmount(item.PREIS || 0)}</td>
        <td>${item.WERKS || ''}</td>
        <td class="text-right">${formatAmount(lineTotal)}</td>
      </tr>`;
    }).join("");
    document.getElementById("pr-items-total").textContent = `${pr.WAERS || 'USD'} ${formatAmount(total)}`;

    // Reset form
    document.getElementById("pr-to-po-form").reset();
    document.getElementById("pr-create-msg").classList.add("hidden");
    
    // Set default document date to today
    const today = new Date().toISOString().split('T')[0];
    document.getElementById("pr-doc-date").value = today;

    skeleton.classList.add("hidden");
    content.classList.remove("hidden");
  } catch (err) {
    skeleton.classList.add("hidden");
    errorMsg.textContent = err.message;
    errorEl.classList.remove("hidden");
  }
}

async function handleCreatePOFromPR(event) {
  event.preventDefault();
  
  const msgEl = document.getElementById("pr-create-msg");
  msgEl.classList.add("hidden");
  
  if (!currentPR) {
    msgEl.textContent = "No PR selected";
    msgEl.className = "action-msg error";
    msgEl.classList.remove("hidden");
    return;
  }
  
  // Collect form data
  const poData = {
    prNumber: currentPR.BANFN,
    vendor: document.getElementById("pr-vendor").value.trim(),
    companyCode: document.getElementById("pr-company").value.trim(),
    purchOrg: document.getElementById("pr-purch-org").value.trim(),
    purchGroup: document.getElementById("pr-purch-group").value.trim() || undefined,
    docDate: document.getElementById("pr-doc-date").value.trim() || undefined,
    deliveryDate: document.getElementById("pr-delivery-date").value.trim() || undefined
  };
  
  if (!poData.vendor || !poData.companyCode || !poData.purchOrg) {
    msgEl.textContent = "Vendor, Company Code, and Purchasing Org are required";
    msgEl.className = "action-msg error";
    msgEl.classList.remove("hidden");
    return;
  }
  
  // Disable submit button
  const submitBtn = event.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  
  try {
    const res = await fetch(`${API}/api/pr/${currentPR.BANFN}/create-po`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(poData)
    });
    const json = await res.json();
    
    if (!json.success) throw new Error(json.error || "PO creation failed");
    
    msgEl.textContent = json.message || `PO ${json.poNumber} created successfully from PR ${currentPR.BANFN}`;
    msgEl.className = "action-msg success";
    msgEl.classList.remove("hidden");
    
    showToast(`PO ${json.poNumber} created from PR`, "success",
      `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>`
    );
    
    // Redirect to PO detail view after 2 seconds
    setTimeout(() => {
      loadPODetail(json.poNumber);
    }, 2000);
    
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className = "action-msg error";
    msgEl.classList.remove("hidden");
    submitBtn.disabled = false;
  }
}
