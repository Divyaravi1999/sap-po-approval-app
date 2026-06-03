"use strict";

/**
 * AI Chat Panel — all intent/slot logic handled by backend agent.
 * Frontend is a thin UI layer: send message → show response.
 */

// ─── State ────────────────────────────────────────────────────────────────────
let aiEnabled   = false;
let chatHistory = [];

// Stable session ID for this browser tab (persists across messages)
const SESSION_ID = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;

// ─── Toggle panel ─────────────────────────────────────────────────────────────
function toggleAIMode() {
  aiEnabled = !aiEnabled;
  const panel      = document.getElementById('ai-chat-panel');
  const toggleBtn  = document.getElementById('ai-toggle-text');
  const toggleIcon = document.getElementById('ai-toggle-icon');
  const toggleEl   = document.querySelector('.ai-toggle');

  if (aiEnabled) {
    panel.classList.add('open');
    toggleBtn.textContent  = 'Disable AI';
    toggleIcon.textContent = '🤖';
    toggleEl.classList.add('ai-active', 'ai-toggle-hidden');
    if (chatHistory.length === 0) {
      appendAssistant("👋 Hi! I'm **FlowAI**, your procurement assistant. I can help you with **purchase orders**, **purchase requisitions**, and **vendor performance**.\n\nJust tell me what you'd like to do.");
    }
    setTimeout(() => document.getElementById('ai-chat-input').focus(), 150);
  } else {
    panel.classList.remove('open');
    toggleBtn.textContent  = 'Enable AI Assistant';
    toggleIcon.textContent = '✨';
    toggleEl.classList.remove('ai-active', 'ai-toggle-hidden');
  }
}

// ─── Send message ─────────────────────────────────────────────────────────────
async function sendChatMessage() {
  const input = document.getElementById('ai-chat-input');
  const text  = input.value.trim();
  if (!text) return;

  input.value = '';
  autoResizeInput(input);
  appendUser(text);

  // Route everything through the backend agent
  await callBackendAI(text);
}

// ─── Shared: navigate to list, move PO to top, highlight ─────────────────────
async function bringToTopAndHighlight(poId, hlClass = 'po-card-highlight-approved') {
  if (typeof showPOList === 'function') showPOList();
  if (typeof loadPOList === 'function') await loadPOList();

  // Move PO to top of allPOs
  if (typeof allPOs !== 'undefined') {
    const idx = allPOs.findIndex(p => p.EBELN === poId);
    if (idx > 0) {
      const [po] = allPOs.splice(idx, 1);
      allPOs.unshift(po);
    } else if (idx === -1) {
      allPOs.unshift({ EBELN: poId, STATUS: 'PENDING', LIFNR: '—', WAERS: '—', NETWR: 0, BEDAT: '' });
    }
    if (typeof renderPOGrid === 'function') renderPOGrid();
  }

  // Highlight after render
  requestAnimationFrame(() => {
    const card = document.querySelector(`.po-card[onclick*="${poId}"]`);
    if (!card) return;
    card.classList.add('po-card-highlight', hlClass);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => card.classList.remove('po-card-highlight', hlClass), 15000);
  });
}

// ─── Backend AI call ──────────────────────────────────────────────────────────
async function callBackendAI(text) {
  showTyping();
  try {
    const res  = await fetch('/api/ai/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': SESSION_ID },
      body: JSON.stringify({
        message: text,
        context: {
          sessionId:   SESSION_ID,
          currentView: getCurrentView(),
          currentPO:   currentPO?.EBELN
        }
      })
    });
    const data = await res.json();
    hideTyping();

    if (data.success) {
      appendAssistant(data.response);
      if (data.actionPerformed) {
        if (data.action === 'LIST_POS') {
          setTimeout(() => {
            if (typeof showPOList === 'function') showPOList();
            if (typeof loadPOList === 'function') loadPOList().then(() => {
              // Apply status filter if specified
              if (data.filter && typeof filterByStatus === 'function') {
                filterByStatus(data.filter);
              }
            });
          }, 300);
        } else if (['CREATED_PO','APPROVED_PO','RESET_PO_DONE'].includes(data.action) && data.poNumber) {
          const hlClass = data.action === 'RESET_PO_DONE' ? 'po-card-highlight-reset' : 'po-card-highlight-approved';
          bringToTopAndHighlight(data.poNumber, hlClass);
        } else if (data.action === 'VENDOR_PERFORMANCE') {
          setTimeout(async () => {
            if (typeof showVendorPerformance === 'function') await showVendorPerformance();
            if (data.vendorId) {
              // Wait for vendor list to populate, then select
              const selector = document.getElementById('vendor-selector');
              if (selector) {
                // Poll until options are loaded
                let attempts = 0;
                const trySelect = setInterval(() => {
                  attempts++;
                  const opt = selector.querySelector(`option[value="${data.vendorId}"]`);
                  if (opt) {
                    selector.value = data.vendorId;
                    clearInterval(trySelect);
                  } else if (attempts > 20) {
                    // Options not found — add one manually and select
                    const o = document.createElement('option');
                    o.value = data.vendorId;
                    o.textContent = data.vendorId;
                    selector.appendChild(o);
                    selector.value = data.vendorId;
                    clearInterval(trySelect);
                  }
                  if (selector.value === data.vendorId && typeof loadVendorPerformance === 'function') {
                    loadVendorPerformance(data.vendorId);
                    clearInterval(trySelect);
                  }
                }, 100);
              }
            }
          }, 300);
        } else if (data.poNumber) {
          setTimeout(() => {
            const poId = data.poNumber;
            // Reorder allPOs so this PO is first in the list
            if (typeof allPOs !== 'undefined') {
              const idx = allPOs.findIndex(p => p.EBELN === poId);
              if (idx > 0) {
                const [po] = allPOs.splice(idx, 1);
                allPOs.unshift(po);
                if (typeof renderPOGrid === 'function') renderPOGrid();
              }
            }
            // Highlight the card briefly, then navigate to detail
            const card = document.querySelector(`.po-card[onclick*="${poId}"]`);
            if (card) {
              card.classList.add('po-card-highlight', 'po-card-highlight-view');
              card.scrollIntoView({ behavior: 'smooth', block: 'center' });
              setTimeout(() => {
                card.classList.remove('po-card-highlight', 'po-card-highlight-view');
                if (typeof loadPODetail === 'function') loadPODetail(poId);
              }, 800);            } else {
              if (typeof loadPODetail === 'function') loadPODetail(poId);
            }
          }, 300);
        } else {
          setTimeout(() => refreshCurrentView(), 800);
        }
      }
    } else {
      appendAssistant(`❌ ${data.error || 'Something went wrong'}`);
    }
  } catch (err) {
    hideTyping();
    appendAssistant(`❌ Failed: ${err.message}`);
  }
}

// ─── PO card highlight + reorder ─────────────────────────────────────────────
function highlightPOCard(poId, type = 'view') {
  const idx = allPOs.findIndex(p => p.EBELN === poId);
  if (idx > 0) {
    const [po] = allPOs.splice(idx, 1);
    allPOs.unshift(po);
    renderPOGrid();
  }
  requestAnimationFrame(() => {
    const card = document.querySelector(`.po-card[onclick*="${poId}"]`);
    if (!card) return;
    card.classList.add('po-card-highlight', `po-card-highlight-${type}`);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => card.classList.remove('po-card-highlight', `po-card-highlight-${type}`), 3500);
  });
}

// ─── Chat renderers ───────────────────────────────────────────────────────────
function appendUser(text) {
  chatHistory.push({ role: 'user', text, ts: Date.now() });
  renderMessage('user', text);
}

function appendAssistant(text) {
  chatHistory.push({ role: 'assistant', text, ts: Date.now() });
  renderMessage('assistant', text);
}

function renderMessage(role, text) {
  const body = document.getElementById('ai-chat-body');
  if (!body) return;
  const wrap   = document.createElement('div');
  wrap.className = `chat-msg chat-msg-${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.innerHTML = formatChatText(text);
  wrap.appendChild(bubble);
  body.appendChild(wrap);
  body.scrollTop = body.scrollHeight;
}

function showTyping() {
  const body = document.getElementById('ai-chat-body');
  if (!body || document.getElementById('chat-typing')) return;
  const wrap = document.createElement('div');
  wrap.className = 'chat-msg chat-msg-assistant';
  wrap.id = 'chat-typing';
  wrap.innerHTML = `<div class="chat-bubble chat-typing-indicator"><span></span><span></span><span></span></div>`;
  body.appendChild(wrap);
  body.scrollTop = body.scrollHeight;
}

function hideTyping() {
  const el = document.getElementById('chat-typing');
  if (el) el.remove();
}

function formatChatText(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function autoResizeInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function getCurrentView() {
  if (!document.getElementById('view-list')?.classList.contains('hidden'))   return 'po-list';
  if (!document.getElementById('view-detail')?.classList.contains('hidden')) return 'po-detail';
  if (!document.getElementById('view-create')?.classList.contains('hidden')) return 'po-create';
  if (!document.getElementById('view-vendor-performance')?.classList.contains('hidden')) return 'vendor-performance';
  if (document.getElementById('view-pr-list') && !document.getElementById('view-pr-list').classList.contains('hidden')) return 'pr-list';
  return 'unknown';
}

function refreshCurrentView() {
  switch (getCurrentView()) {
    case 'po-list':   loadPOList(); break;
    case 'po-detail': if (currentPO) loadPODetail(currentPO.EBELN); break;
    case 'pr-list':   if (typeof loadPRList === 'function') loadPRList(); break;
  }
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    if (!aiEnabled) toggleAIMode();
    else document.getElementById('ai-chat-input')?.focus();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('ai-chat-input');
  if (!input) return;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  input.addEventListener('input', () => autoResizeInput(input));
});
