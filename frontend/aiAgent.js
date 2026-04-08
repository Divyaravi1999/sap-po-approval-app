"use strict";

/**
 * AI Agent Frontend
 * Handles AI command input and execution
 */

let aiEnabled = false;

// Toggle AI mode on/off
function toggleAIMode() {
  aiEnabled = !aiEnabled;
  const commandBar = document.querySelector('.ai-command-bar');
  const toggleBtn = document.getElementById('ai-toggle-text');
  const toggleIcon = document.getElementById('ai-toggle-icon');
  
  if (aiEnabled) {
    commandBar.classList.add('active');
    toggleBtn.textContent = 'Disable AI';
    toggleIcon.textContent = '🤖';
    // Focus on input
    setTimeout(() => {
      document.getElementById('ai-command-input').focus();
    }, 100);
  } else {
    commandBar.classList.remove('active');
    toggleBtn.textContent = 'Enable AI Assistant';
    toggleIcon.textContent = '✨';
  }
}

// Execute AI command
async function executeAICommand() {
  const input = document.getElementById('ai-command-input');
  const resultDiv = document.getElementById('ai-result');
  const command = input.value.trim();
  
  if (!command) {
    showAIResult('Please enter a command', 'error');
    return;
  }
  
  // Show loading
  showAIResult('🤖 AI is processing your request...', 'loading');
  
  try {
    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        message: command,
        context: {
          currentView: getCurrentView(),
          currentPO: currentPO?.EBELN,
          userRole: 'approver'
        }
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      showAIResult(data.response, 'success');
      
      // If AI performed an action, refresh the UI
      if (data.actionPerformed) {
        console.log('[AI] Action performed, refreshing view...');
        setTimeout(() => {
          refreshCurrentView();
        }, 1000);
      }
      
      // Clear input on success
      input.value = '';
      
    } else {
      showAIResult('❌ ' + (data.error || 'Something went wrong'), 'error');
    }
    
  } catch (error) {
    console.error('[AI] Error:', error);
    showAIResult('❌ Failed to execute command: ' + error.message, 'error');
  }
}

// Show AI result message
function showAIResult(message, type) {
  const resultDiv = document.getElementById('ai-result');
  resultDiv.className = `ai-result ${type}`;
  
  // Format message with line breaks
  resultDiv.innerHTML = message.replace(/\n/g, '<br>');
  resultDiv.classList.remove('hidden');
  
  // Auto-hide after 10 seconds for success messages
  if (type === 'success') {
    setTimeout(() => {
      resultDiv.classList.add('hidden');
    }, 10000);
  }
}

// Get current view name
function getCurrentView() {
  if (!document.getElementById('view-list').classList.contains('hidden')) return 'po-list';
  if (!document.getElementById('view-detail').classList.contains('hidden')) return 'po-detail';
  if (!document.getElementById('view-create').classList.contains('hidden')) return 'po-create';
  if (!document.getElementById('view-vendor-performance').classList.contains('hidden')) return 'vendor-performance';
  if (document.getElementById('view-pr-list') && !document.getElementById('view-pr-list').classList.contains('hidden')) return 'pr-list';
  if (document.getElementById('view-pr-detail') && !document.getElementById('view-pr-detail').classList.contains('hidden')) return 'pr-detail';
  return 'unknown';
}

// Refresh current view after AI action
function refreshCurrentView() {
  const view = getCurrentView();
  console.log('[AI] Refreshing view:', view);
  
  switch (view) {
    case 'po-list':
      loadPOList();
      break;
    case 'po-detail':
      if (currentPO) loadPODetail(currentPO.EBELN);
      break;
    case 'vendor-performance':
      const vendorSelector = document.getElementById('vendor-selector');
      if (vendorSelector && vendorSelector.value) {
        loadVendorPerformance(vendorSelector.value);
      }
      break;
    case 'pr-list':
      if (typeof loadPRList === 'function') loadPRList();
      break;
  }
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Ctrl+K or Cmd+K to focus AI input
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    if (!aiEnabled) toggleAIMode();
    document.getElementById('ai-command-input').focus();
  }
  
  // Enter key in AI input to execute
  if (e.target.id === 'ai-command-input' && e.key === 'Enter') {
    e.preventDefault();
    executeAICommand();
  }
  
  // Escape key to close AI result
  if (e.key === 'Escape') {
    const resultDiv = document.getElementById('ai-result');
    if (!resultDiv.classList.contains('hidden')) {
      resultDiv.classList.add('hidden');
    }
  }
});

// Show example commands on focus
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('ai-command-input');
  if (input) {
    input.addEventListener('focus', () => {
      input.placeholder = 'Try: "Approve PO 4500022395 with code R" or "Show vendor 1000 performance"';
    });
    input.addEventListener('blur', () => {
      input.placeholder = 'Type a command... (Ctrl+K)';
    });
  }
});
