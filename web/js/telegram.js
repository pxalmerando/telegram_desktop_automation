// ==================== STATE ====================
let accounts = [];
let selectedAccountId = null;
let selectedChatId = null;
let expandedAccounts = new Set();
let chatSearchTimers = {};
let analyticsOpen = false;

// ==================== EEL CALLBACKS (replaces Socket.IO) ====================
eel.expose(on_new_message);
function on_new_message(data) {
    // If viewing this chat, append message
    if (data.account_id === selectedAccountId && data.chat_id == selectedChatId) {
        appendMessage(data.message);
        scrollToBottom();
        eel.mark_read(data.account_id, data.chat_id)();
    }
    // Update chat list preview
    if (data.chat) {
        updateChatInList(data.account_id, data.chat);
    }
}

eel.expose(on_unread_update);
function on_unread_update(data) {
    updateUnreadBadge(data.account_id, data.total_unread);
    if (data.chat_id !== undefined && data.chat_unread !== undefined) {
        updateChatUnread(data.account_id, data.chat_id, data.chat_unread);
    }
    updateTotalUnread();
}

// ==================== ANALYTICS ====================
function toggleAnalytics() {
    analyticsOpen = !analyticsOpen;
    const content = document.getElementById('analytics-content');
    const chevron = document.getElementById('analytics-chevron');
    const panels = document.getElementById('main-panels');
    if (!content) return;

    if (analyticsOpen) {
        content.classList.remove('hidden');
        if (chevron) chevron.style.transform = 'rotate(180deg)';
        if (panels) panels.style.height = 'calc(100vh - 140px - ' + (content.offsetHeight + 60) + 'px)';
        loadAnalytics();
    } else {
        content.classList.add('hidden');
        if (chevron) chevron.style.transform = 'rotate(0deg)';
        if (panels) panels.style.height = 'calc(100vh - 140px)';
    }
}

async function loadAnalytics() {
    const days = document.getElementById('analytics-period')?.value || 7;
    try {
        const data = await eel.get_analytics(parseInt(days))();
        if (data && !data.error) renderAnalytics(data);
    } catch (e) {
        console.error('Failed to load analytics:', e);
    }
}

function renderAnalytics(data) {
    const el = (id) => document.getElementById(id);
    const set = (id, val) => { const e = el(id); if (e) e.textContent = val; };

    set('stat-today-total', data.today_total.toLocaleString());
    set('stat-today-incoming', data.today_incoming.toLocaleString());
    set('stat-unique-chats', data.unique_chats_today.toLocaleString());
    set('stat-total', data.total_messages.toLocaleString());
    set('stat-incoming', data.total_incoming.toLocaleString());
    set('stat-outgoing', data.total_outgoing.toLocaleString());
    set('stat-auto-replies', data.auto_replies.toLocaleString());

    renderAnalyticsChart(data.chart);
    renderAccountStats(data.account_stats);

    setTimeout(() => {
        const content = document.getElementById('analytics-content');
        const panels = document.getElementById('main-panels');
        if (content && panels && analyticsOpen) {
            panels.style.height = 'calc(100vh - 140px - ' + (content.offsetHeight + 60) + 'px)';
        }
    }, 50);
}

function renderAnalyticsChart(chart) {
    const container = document.getElementById('analytics-chart');
    if (!container || !chart) return;

    const maxVal = Math.max(...chart.incoming, ...chart.outgoing, 1);

    container.innerHTML = `
        <div class="flex items-end justify-between h-full gap-1">
            ${chart.labels.map((label, i) => {
                const inH = Math.max((chart.incoming[i] / maxVal) * 100, 2);
                const outH = Math.max((chart.outgoing[i] / maxVal) * 100, 2);
                const total = chart.incoming[i] + chart.outgoing[i];
                return `
                <div class="flex-1 flex flex-col items-center justify-end h-full group relative">
                    <div class="absolute -top-1 left-1/2 -translate-x-1/2 bg-dark-100 border border-white/10 rounded-lg px-2 py-1 text-[9px] text-white opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10 shadow-lg">
                        ${label}: ${total} (${chart.incoming[i]} in / ${chart.outgoing[i]} out)
                    </div>
                    <div class="w-full flex gap-px justify-center items-end flex-1">
                        <div class="w-1/2 bg-green-500/60 rounded-t-sm transition-all" style="height: ${inH}%"></div>
                        <div class="w-1/2 bg-blue-500/60 rounded-t-sm transition-all" style="height: ${outH}%"></div>
                    </div>
                    <span class="text-[8px] text-gray-600 mt-1 truncate w-full text-center">${label.split(' ')[1] || label}</span>
                </div>`;
            }).join('')}
        </div>
        <div class="flex items-center justify-end gap-3 mt-2">
            <span class="flex items-center gap-1 text-[9px] text-gray-500"><span class="w-2 h-2 rounded-sm bg-green-500/60"></span>Incoming</span>
            <span class="flex items-center gap-1 text-[9px] text-gray-500"><span class="w-2 h-2 rounded-sm bg-blue-500/60"></span>Outgoing</span>
        </div>`;
}

function renderAccountStats(stats) {
    const container = document.getElementById('analytics-accounts');
    if (!container) return;

    if (!stats || stats.length === 0) {
        container.innerHTML = '<div class="text-[11px] text-gray-500 text-center py-4">No data yet</div>';
        return;
    }

    const maxMsg = Math.max(...stats.map(s => s.total), 1);
    container.innerHTML = stats.slice(0, 10).map(acc => {
        const pct = (acc.total / maxMsg) * 100;
        return `
        <div class="flex items-center gap-2">
            <span class="text-[10px] text-gray-400 truncate w-20 flex-shrink-0" title="${escapeHtml(acc.name)}">${escapeHtml(acc.name)}</span>
            <div class="flex-1 h-4 bg-dark-100/50 rounded-full overflow-hidden relative">
                <div class="h-full bg-gradient-to-r from-purple-500/40 to-pink-500/40 rounded-full transition-all" style="width: ${pct}%"></div>
                <span class="absolute inset-0 flex items-center px-2 text-[9px] text-gray-300">${acc.total} (${acc.incoming} in)</span>
            </div>
        </div>`;
    }).join('');
}

// ==================== LISTENER HEALTH ====================
async function pollListenerHealth() {
    try {
        const statuses = await eel.get_listener_health()();
        if (!statuses || !Array.isArray(statuses)) return;
        for (const status of statuses) {
            const dot = document.querySelector(`.listener-dot-${status.id}`);
            if (dot) {
                if (status.listener_active) {
                    dot.className = `listener-dot-${status.id} w-2 h-2 rounded-full bg-green-400`;
                    dot.title = 'Listener active';
                } else {
                    dot.className = `listener-dot-${status.id} w-2 h-2 rounded-full bg-yellow-400 animate-pulse`;
                    dot.title = 'Listener reconnecting...';
                }
            }
        }
    } catch (e) {}
}

// ==================== ACCOUNTS ====================
async function loadAccounts() {
    try {
        accounts = await eel.get_accounts()();
        if (!Array.isArray(accounts)) accounts = [];
        renderAccounts();
        updateTotalUnread();
        for (const accId of expandedAccounts) {
            loadChats(accId);
        }
    } catch (e) {
        const loading = document.getElementById('accounts-loading');
        if (loading) loading.classList.add('hidden');
        showToast('Failed to load accounts: ' + e.message, 'error');
    }
}

function renderAccounts() {
    const container = document.getElementById('accounts-list');
    const loading = document.getElementById('accounts-loading');
    if (loading) loading.classList.add('hidden');

    if (accounts.length === 0) {
        container.innerHTML = `
            <div class="flex flex-col items-center py-8">
                <div class="w-16 h-16 rounded-2xl bg-purple-500/10 flex items-center justify-center mb-3">
                    <svg class="w-8 h-8 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path>
                    </svg>
                </div>
                <p class="text-gray-400 text-sm">No accounts added</p>
                <button onclick="showAddAccountModal()" class="mt-2 text-purple-400 text-sm hover:text-purple-300 transition-colors">+ Add first account</button>
            </div>`;
        return;
    }

    let html = '';
    accounts.forEach(acc => {
        const isExpanded = expandedAccounts.has(acc.id);
        const isSelected = selectedAccountId === acc.id;
        const statusColor = acc.is_connected ? 'from-green-500 to-emerald-500' : (acc.is_authorized ? 'from-yellow-500 to-orange-500' : 'from-gray-500 to-gray-600');
        const statusDot = acc.is_connected ? 'bg-green-400' : (acc.is_authorized ? 'bg-yellow-400' : 'bg-gray-400');

        html += `
        <div class="account-item" data-account-id="${acc.id}" data-search="${(acc.display_name + ' ' + acc.phone_number).toLowerCase()}">
            <div class="flex items-center">
                <button onclick="toggleAccount(${acc.id})"
                        class="flex-1 flex items-center px-3 py-2.5 rounded-xl transition-all duration-200
                               ${isSelected ? 'bg-gradient-to-r from-purple-500/20 to-pink-500/20 border border-purple-500/20' : 'hover:bg-white/5'}">
                    <div class="relative w-8 h-8 rounded-full bg-gradient-to-br ${statusColor} flex items-center justify-center mr-3 flex-shrink-0">
                        <span class="text-white text-xs font-semibold">${(acc.display_name || acc.phone_number).charAt(0).toUpperCase()}</span>
                        <span class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 ${statusDot} rounded-full border-2 border-dark-200"></span>
                        ${acc.is_connected ? `<span class="listener-dot-${acc.id} absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-gray-400" title="Checking listener..."></span>` : ''}
                    </div>
                    <div class="flex-1 min-w-0 text-left">
                        <p class="text-sm font-medium text-white truncate">${acc.display_name || acc.phone_number}</p>
                        <p class="text-xs text-gray-500 truncate">${acc.phone_number}</p>
                    </div>
                    ${acc.total_unread_count > 0 ? `
                        <span class="unread-badge-${acc.id} ml-2 min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-xs font-bold flex items-center justify-center animate-pulse">
                            ${acc.total_unread_count > 999 ? '999+' : acc.total_unread_count}
                        </span>
                    ` : `<span class="unread-badge-${acc.id} hidden ml-2 min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-xs font-bold flex items-center justify-center"></span>`}
                    <svg class="w-4 h-4 ml-1 text-gray-500 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
                    </svg>
                </button>
                <!-- Account action menu -->
                <div class="flex flex-col ml-1 space-y-0.5">
                    ${acc.is_authorized && !acc.is_connected ? `
                        <button onclick="connectAccount(${acc.id})" class="p-1.5 rounded-lg hover:bg-green-500/20 text-gray-500 hover:text-green-400 transition-all" title="Connect">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                        </button>
                    ` : ''}
                    ${acc.is_connected ? `
                        <button onclick="disconnectAccount(${acc.id})" class="p-1.5 rounded-lg hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-all" title="Disconnect">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>
                        </button>
                    ` : ''}
                    ${!acc.is_authorized && acc.has_pending_code ? `
                        <button onclick="showVerificationModal(${acc.id})" class="p-1.5 rounded-lg hover:bg-purple-500/20 text-gray-500 hover:text-purple-400 transition-all" title="Enter Code">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
                        </button>
                        <button onclick="cancelVerification(${acc.id})" class="p-1.5 rounded-lg hover:bg-orange-500/20 text-gray-500 hover:text-orange-400 transition-all" title="Stop Verification">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"></path></svg>
                        </button>
                    ` : ''}
                    ${!acc.is_authorized && !acc.has_pending_code ? `
                        <button onclick="startVerification(${acc.id})" class="p-1.5 rounded-lg hover:bg-purple-500/20 text-gray-500 hover:text-purple-400 transition-all" title="Send Code">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                        </button>
                    ` : ''}
                    <button onclick="deleteAccount(${acc.id})" class="p-1.5 rounded-lg hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-all" title="Remove">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    </button>
                </div>
            </div>
            <!-- Collapsible chat list -->
            <div id="chats-${acc.id}" class="${isExpanded ? '' : 'hidden'} ml-6 mt-1 space-y-0.5 border-l border-white/5 pl-2">
                <div class="chat-loading-${acc.id} ${isExpanded ? '' : 'hidden'} py-2">
                    <div class="shimmer w-full h-8 rounded-lg"></div>
                </div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

// ==================== CHAT LIST ====================
async function toggleAccount(accountId) {
    if (expandedAccounts.has(accountId)) {
        expandedAccounts.delete(accountId);
        renderAccounts();
    } else {
        expandedAccounts.add(accountId);
        selectedAccountId = accountId;
        renderAccounts();
        await loadChats(accountId);
    }
}

async function loadChats(accountId) {
    const container = document.getElementById(`chats-${accountId}`);
    if (!container) return;

    try {
        const chats = await eel.get_chats(accountId)();
        if (!Array.isArray(chats)) { container.innerHTML = '<p class="text-gray-500 text-xs py-2 px-2">No chats</p>'; return; }
        renderChatsForAccount(accountId, chats);
    } catch (e) {
        container.innerHTML = '<p class="text-gray-500 text-xs py-2 px-2">Failed to load chats</p>';
    }
}

function renderChatsForAccount(accountId, chats) {
    const container = document.getElementById(`chats-${accountId}`);
    if (!container) return;

    if (chats.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-xs py-2 px-2">No chats yet. Connect account first.</p>';
        return;
    }

    let html = '';

    if (chats.length > 5) {
        html += `<div class="mb-1">
            <input type="text" placeholder="Search chats..." data-chat-search="${accountId}"
                   oninput="filterChats(${accountId}, this.value)"
                   class="w-full px-2 py-1 bg-dark-100/50 border border-white/10 rounded-lg text-[11px] text-white placeholder-gray-500 outline-none focus:border-purple-500/50">
        </div>`;
    }

    html += chats.map(chat => {
        const isActive = selectedAccountId === accountId && selectedChatId == chat.chat_id;
        const isPinned = chat.is_manually_pinned || chat.is_pinned;
        const typeIcon = chat.chat_type === 'private' ? 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z' :
                         chat.chat_type === 'channel' ? 'M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z' :
                         'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z';

        return `
        <div class="chat-item group flex items-center" data-chat-search-text="${(chat.chat_title || '').toLowerCase()}">
            <button onclick="selectChat(${accountId}, ${chat.chat_id}, '${(chat.chat_title || '').replace(/'/g, "\\'")}')"
                    class="flex-1 flex items-center px-2 py-1.5 rounded-lg transition-all duration-150 text-left min-w-0
                           ${isActive ? 'bg-purple-500/20 border border-purple-500/10' : 'hover:bg-white/5'}">
                <svg class="w-4 h-4 ${isActive ? 'text-purple-400' : 'text-gray-500'} mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${typeIcon}"></path>
                </svg>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center">
                        <p class="text-xs font-medium ${isActive ? 'text-white' : 'text-gray-300'} truncate">${chat.chat_title}</p>
                        ${isPinned ? '<svg class="w-3 h-3 text-yellow-400 ml-1 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path d="M5 5a2 2 0 012-2h6a2 2 0 012 2v2a2 2 0 01-2 2H7a2 2 0 01-2-2V5zm2 10v3a1 1 0 001 1h4a1 1 0 001-1v-3l2-4H5l2 4z"/></svg>' : ''}
                    </div>
                    ${chat.last_message_preview ? `<p class="text-[10px] text-gray-500 truncate">${chat.last_message_preview}</p>` : ''}
                </div>
                ${chat.unread_count > 0 ? `
                    <span class="chat-unread-${accountId}-${chat.chat_id} ml-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                        ${chat.unread_count > 99 ? '99+' : chat.unread_count}
                    </span>
                ` : `<span class="chat-unread-${accountId}-${chat.chat_id} hidden ml-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center"></span>`}
            </button>
            <button onclick="event.stopPropagation(); toggleChatPin(${accountId}, ${chat.chat_id})"
                    class="p-1 rounded-md ${chat.is_manually_pinned ? 'text-yellow-400 bg-yellow-400/10' : 'text-gray-600 opacity-0 group-hover:opacity-100'} hover:text-yellow-400 hover:bg-yellow-400/10 transition-all flex-shrink-0 ml-0.5"
                    title="${chat.is_manually_pinned ? 'Unpin' : 'Pin'}">
                <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M5 5a2 2 0 012-2h6a2 2 0 012 2v2a2 2 0 01-2 2H7a2 2 0 01-2-2V5zm2 10v3a1 1 0 001 1h4a1 1 0 001-1v-3l2-4H5l2 4z"/></svg>
            </button>
        </div>`;
    }).join('');

    container.innerHTML = html;
}

function filterChats(accountId, query) {
    const container = document.getElementById(`chats-${accountId}`);
    if (!container) return;
    const q = query.toLowerCase();
    container.querySelectorAll('.chat-item').forEach(item => {
        const text = item.dataset.chatSearchText || '';
        item.style.display = text.includes(q) ? '' : 'none';
    });
}

async function toggleChatPin(accountId, chatId) {
    try {
        const result = await eel.toggle_chat_pin(accountId, chatId)();
        if (result && result.error) {
            showToast(result.error, 'error');
            return;
        }
        await loadChats(accountId);
    } catch (e) {
        showToast('Failed to toggle pin', 'error');
    }
}

async function selectChat(accountId, chatId, chatTitle) {
    selectedAccountId = accountId;
    selectedChatId = chatId;

    // Mark as read
    eel.mark_read(accountId, String(chatId))();

    // Update chat header
    document.getElementById('chat-header').classList.remove('hidden');
    document.getElementById('chat-title').textContent = chatTitle || 'Chat';
    document.getElementById('chat-subtitle').textContent = `Account: ${accounts.find(a => a.id === accountId)?.phone_number || ''}`;
    document.getElementById('chat-avatar-letter').textContent = (chatTitle || '?').charAt(0).toUpperCase();
    const noChat = document.getElementById('no-chat-selected');
    if (noChat) noChat.classList.add('hidden');
    document.getElementById('message-input-area').classList.remove('hidden');

    // Load messages
    const messagesArea = document.getElementById('messages-area');
    messagesArea.innerHTML = `
        <div class="flex items-center justify-center h-full">
            <div class="flex items-center space-x-3">
                <div class="w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                <span class="text-gray-400 text-sm">Loading messages...</span>
            </div>
        </div>`;

    try {
        const data = await eel.get_messages(accountId, chatId)();
        if (data && data.messages && data.messages.length > 0) {
            renderMessages(data.messages);
            scrollToBottom();
        } else {
            messagesArea.innerHTML = `
                <div class="flex items-center justify-center h-full">
                    <p class="text-gray-500 text-sm">No messages yet</p>
                </div>`;
        }
    } catch (e) {
        messagesArea.innerHTML = `
            <div class="flex items-center justify-center h-full">
                <p class="text-red-400 text-sm">Failed to load messages</p>
            </div>`;
    }

    renderAccounts();
    if (expandedAccounts.has(accountId)) {
        await loadChats(accountId);
    }
}

// ==================== MESSAGES ====================
function renderMessages(messages) {
    const area = document.getElementById('messages-area');
    if (!messages || messages.length === 0) {
        area.innerHTML = `<div class="flex items-center justify-center h-full"><p class="text-gray-500 text-sm">No messages</p></div>`;
        return;
    }
    area.innerHTML = messages.map(msg => renderSingleMessage(msg)).join('');
}

function renderSingleMessage(msg) {
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isIncoming = msg.is_incoming;
    const isAutoReply = msg.is_auto_reply;

    let content = '';
    if (msg.text) {
        content = `<p class="text-sm break-words">${escapeHtml(msg.text)}</p>`;
    }
    if (msg.media_type) {
        const mediaLabel = msg.media_type.charAt(0).toUpperCase() + msg.media_type.slice(1);
        content += `<p class="text-xs italic text-gray-400 mt-1">[${mediaLabel}]</p>`;
    }
    if (!msg.text && !msg.media_type) {
        content = `<p class="text-xs italic text-gray-400">[Empty message]</p>`;
    }

    const aiBadge = isAutoReply ? '<span class="inline-block px-1.5 py-0.5 text-[9px] font-bold bg-cyan-500/20 text-cyan-400 rounded-md ml-1">AI</span>' : '';

    if (isIncoming) {
        return `
        <div class="flex justify-start">
            <div class="max-w-[70%]">
                <p class="text-[10px] text-gray-500 mb-1 ml-1">${escapeHtml(msg.sender_name || 'Unknown')}</p>
                <div class="bg-dark-100/80 border border-white/5 rounded-2xl rounded-tl-md px-4 py-2.5">
                    ${content}
                    <p class="text-[10px] text-gray-500 mt-1 text-right">${time}</p>
                </div>
            </div>
        </div>`;
    } else {
        return `
        <div class="flex justify-end">
            <div class="max-w-[70%]">
                <div class="${isAutoReply ? 'bg-gradient-to-br from-cyan-500/20 to-blue-500/20 border border-cyan-500/10' : 'bg-gradient-to-br from-purple-500/30 to-pink-500/30 border border-purple-500/10'} rounded-2xl rounded-tr-md px-4 py-2.5">
                    ${content}
                    <p class="text-[10px] text-gray-400 mt-1 text-right">${aiBadge} ${time}</p>
                </div>
            </div>
        </div>`;
    }
}

function appendMessage(msg) {
    if (!msg) return;
    const area = document.getElementById('messages-area');
    const placeholder = area.querySelector('.flex.items-center.justify-center');
    if (placeholder && area.children.length === 1) {
        area.innerHTML = '';
    }

    const div = document.createElement('div');
    div.className = 'animate-fade-in';
    div.innerHTML = renderSingleMessage(msg);
    area.appendChild(div);
}

// ==================== ACTIONS ====================
async function handleSendMessage(e) {
    e.preventDefault();
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text || !selectedAccountId || !selectedChatId) return;

    input.value = '';
    input.focus();

    appendMessage({
        text: text,
        is_incoming: false,
        sender_name: 'You',
        timestamp: new Date().toISOString(),
        media_type: null
    });
    scrollToBottom();

    try {
        const result = await eel.send_message(selectedAccountId, parseInt(selectedChatId), text)();
        if (result && !result.success) {
            showToast(result.error || 'Failed to send message', 'error');
        }
    } catch (e) {
        showToast('Failed to send message', 'error');
    }
}

async function connectAccount(accountId) {
    showToast('Connecting & fetching chats...', 'info');
    try {
        const result = await eel.connect_account(accountId)();
        if (result && result.error) {
            showToast(result.error, 'error');
            return;
        }
        showToast('Account connected!', 'success');
        expandedAccounts.add(accountId);
        selectedAccountId = accountId;
        await loadAccounts();
    } catch (e) {
        showToast('Failed to connect account: ' + e.message, 'error');
    }
}

async function disconnectAccount(accountId) {
    try {
        const result = await eel.disconnect_account(accountId)();
        if (result && result.error) {
            showToast(result.error, 'error');
            return;
        }
        showToast('Account disconnected', 'info');
        await loadAccounts();
    } catch (e) {
        showToast('Failed to disconnect: ' + e.message, 'error');
    }
}

async function deleteAccount(accountId) {
    const confirmed = await confirmDialog('Are you sure you want to remove this Telegram account?');
    if (!confirmed) return;

    try {
        const result = await eel.delete_account(accountId)();
        if (result && result.error) { showToast(result.error, 'error'); return; }
        showToast('Account removed', 'success');
        if (selectedAccountId === accountId) {
            selectedAccountId = null;
            selectedChatId = null;
            document.getElementById('chat-header').classList.add('hidden');
            document.getElementById('message-input-area').classList.add('hidden');
            document.getElementById('messages-area').innerHTML = '<div id="no-chat-selected" class="flex flex-col items-center justify-center h-full"><p class="text-gray-400">Select an account and chat</p></div>';
        }
        expandedAccounts.delete(accountId);
        await loadAccounts();
    } catch (e) {
        showToast('Failed to remove account', 'error');
    }
}

async function startVerification(accountId) {
    showToast('Sending verification code...', 'info');
    try {
        const result = await eel.send_code(accountId)();
        if (result && result.success) {
            await loadAccounts();
            showVerificationModal(accountId);
        } else {
            showToast((result && result.error) || 'Failed to send code', 'error');
        }
    } catch (e) {
        showToast('Failed to send verification code: ' + e.message, 'error');
    }
}

async function cancelVerification(accountId) {
    try {
        const result = await eel.cancel_verification(accountId)();
        if (result && result.error) { showToast(result.error, 'error'); return; }
        showToast('Verification cancelled', 'info');
        await loadAccounts();
    } catch (e) {
        showToast('Failed to cancel verification', 'error');
    }
}

function refreshCurrentChat() {
    if (selectedAccountId && selectedChatId) {
        selectChat(selectedAccountId, selectedChatId, document.getElementById('chat-title')?.textContent || '');
    }
}

// ==================== TELEGRAM MODALS ====================
function showTelegramModal(title, contentHtml, actions, options = {}) {
    const container = document.getElementById('modal-container');
    const maxWidth = options.wide ? 'max-w-2xl' : 'max-w-md';

    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4';
    modal.addEventListener('click', (e) => { if (e.target === modal) closeTelegramModal(); });

    const dialog = document.createElement('div');
    dialog.className = `bg-dark-200/90 backdrop-blur-xl rounded-2xl w-full ${maxWidth} border border-white/10 shadow-2xl`;
    dialog.addEventListener('click', (e) => e.stopPropagation());

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between px-6 py-4 border-b border-white/5';
    header.innerHTML = `
        <h3 class="text-lg font-semibold text-white">${title}</h3>
        <button class="tg-modal-close p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-all">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
        </button>`;
    header.querySelector('.tg-modal-close').addEventListener('click', closeTelegramModal);

    const body = document.createElement('div');
    body.className = 'p-6';
    body.innerHTML = contentHtml;

    dialog.appendChild(header);
    dialog.appendChild(body);

    if (actions && actions.length > 0) {
        const footer = document.createElement('div');
        footer.className = 'flex justify-end space-x-3 px-6 py-4 border-t border-white/5';
        actions.forEach(action => {
            const btn = document.createElement('button');
            btn.className = `px-5 py-2.5 rounded-xl font-medium transition-all text-white ${action.class || 'bg-white/10 hover:bg-white/20'}`;
            btn.textContent = action.label;
            btn.addEventListener('click', action.onClick);
            footer.appendChild(btn);
        });
        dialog.appendChild(footer);
    }

    modal.appendChild(dialog);
    container.innerHTML = '';
    container.appendChild(modal);
}

function closeTelegramModal() {
    document.getElementById('modal-container').innerHTML = '';
}

function showAddAccountModal() {
    const contentHtml = `
        <div class="space-y-4">
            <div>
                <label class="block text-sm text-gray-400 mb-1">Phone Number</label>
                <input type="text" id="modal-phone" placeholder="+1234567890"
                       class="w-full px-4 py-3 bg-dark-100/50 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:border-purple-500/50 focus:ring-2 focus:ring-purple-500/20 outline-none">
                <p class="text-xs text-gray-500 mt-1">International format with country code</p>
            </div>
            <div>
                <label class="block text-sm text-gray-400 mb-1">API ID</label>
                <input type="number" id="modal-api-id" placeholder="12345678"
                       class="w-full px-4 py-3 bg-dark-100/50 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:border-purple-500/50 focus:ring-2 focus:ring-purple-500/20 outline-none">
            </div>
            <div>
                <label class="block text-sm text-gray-400 mb-1">API Hash</label>
                <input type="text" id="modal-api-hash" placeholder="your-api-hash"
                       class="w-full px-4 py-3 bg-dark-100/50 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:border-purple-500/50 focus:ring-2 focus:ring-purple-500/20 outline-none">
            </div>
            <div>
                <label class="block text-sm text-gray-400 mb-1">Display Name (optional)</label>
                <input type="text" id="modal-display-name" placeholder="My Account"
                       class="w-full px-4 py-3 bg-dark-100/50 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:border-purple-500/50 focus:ring-2 focus:ring-purple-500/20 outline-none">
            </div>
            <p class="text-xs text-gray-500">Get API ID & Hash from <a href="https://my.telegram.org" target="_blank" class="text-purple-400 hover:text-purple-300">my.telegram.org</a></p>
        </div>`;

    showTelegramModal('Add Telegram Account', contentHtml, [
        {
            label: 'Add & Send Code',
            class: 'bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600',
            onClick: async () => {
                const phone = document.getElementById('modal-phone').value.trim();
                const apiId = document.getElementById('modal-api-id').value.trim();
                const apiHash = document.getElementById('modal-api-hash').value.trim();
                const displayName = document.getElementById('modal-display-name').value.trim();

                if (!phone || !apiId || !apiHash) {
                    showToast('All fields except display name are required', 'error');
                    return;
                }

                try {
                    const result = await eel.add_account(phone, apiId, apiHash, displayName || null)();
                    if (result && result.error) {
                        showToast(result.error, 'error');
                        return;
                    }

                    closeTelegramModal();
                    showToast('Account added! Sending verification code...', 'success');
                    await loadAccounts();

                    const accountId = result.account ? result.account.id : result.id;
                    if (accountId) {
                        try {
                            const codeResult = await eel.send_code(accountId)();
                            if (codeResult && codeResult.success) {
                                await loadAccounts();
                                showVerificationModal(accountId);
                            } else {
                                showToast((codeResult && codeResult.error) || 'Failed to send code', 'error');
                            }
                        } catch (codeErr) {
                            showToast('Failed to send code. You can retry from the verify button.', 'error');
                        }
                    }
                } catch (e) {
                    showToast('Failed to add account', 'error');
                }
            }
        }
    ]);
}

function showVerificationModal(accountId) {
    const contentHtml = `
        <div class="space-y-4">
            <div class="flex items-center justify-center">
                <div class="w-16 h-16 rounded-2xl bg-purple-500/20 flex items-center justify-center">
                    <svg class="w-8 h-8 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
                    </svg>
                </div>
            </div>
            <p class="text-center text-gray-400 text-sm">Enter the verification code sent to your Telegram app</p>
            <div>
                <input type="text" id="modal-verify-code" placeholder="12345" maxlength="6"
                       class="w-full px-4 py-3 bg-dark-100/50 border border-white/10 rounded-xl text-white text-center text-2xl tracking-[0.5em] placeholder-gray-500 focus:border-purple-500/50 focus:ring-2 focus:ring-purple-500/20 outline-none"
                       autofocus>
            </div>
            <div id="2fa-section" class="hidden">
                <label class="block text-sm text-gray-400 mb-1">2FA Password</label>
                <input type="password" id="modal-2fa-password" placeholder="Your 2FA password"
                       class="w-full px-4 py-3 bg-dark-100/50 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:border-purple-500/50 focus:ring-2 focus:ring-purple-500/20 outline-none">
            </div>
        </div>`;

    showTelegramModal('Verify Account', contentHtml, [
        {
            label: 'Verify',
            class: 'bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600',
            onClick: async () => {
                const code = document.getElementById('modal-verify-code').value.trim();
                const password = document.getElementById('modal-2fa-password')?.value?.trim();

                if (!code) {
                    showToast('Please enter the verification code', 'error');
                    return;
                }

                showToast('Verifying...', 'info');
                try {
                    const result = await eel.verify_code(accountId, code, password || null)();

                    if (result && result.success) {
                        closeTelegramModal();
                        showToast('Account verified successfully!', 'success');
                        loadAccounts();
                    } else if (result && result.needs_2fa) {
                        document.getElementById('2fa-section').classList.remove('hidden');
                        showToast('Please enter your 2FA password', 'warning');
                    } else {
                        showToast((result && result.error) || 'Verification failed', 'error');
                    }
                } catch (e) {
                    showToast('Verification failed: ' + e.message, 'error');
                }
            }
        }
    ]);
}

// ==================== SETTINGS MODAL ====================
let settingsActiveTab = 'ai';

function openSettingsModal(tab) {
    if (tab) settingsActiveTab = tab;
    const container = document.getElementById('modal-container');
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4';
    modal.addEventListener('click', (e) => { if (e.target === modal) closeTelegramModal(); });

    modal.innerHTML = `
    <div class="bg-dark-200/95 backdrop-blur-xl rounded-2xl w-full max-w-6xl h-[85vh] border border-white/10 shadow-2xl flex flex-col" onclick="event.stopPropagation()">
        <div class="flex items-center justify-between px-6 py-0 border-b border-white/5 flex-shrink-0">
            <div class="flex items-center space-x-1">
                <button onclick="switchSettingsTab('ai')" id="settings-tab-ai"
                        class="settings-tab px-4 py-3.5 text-sm font-medium border-b-2 transition-all">
                    <span class="flex items-center space-x-2">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"></path></svg>
                        <span>AI Settings</span>
                    </span>
                </button>
                <button onclick="switchSettingsTab('media')" id="settings-tab-media"
                        class="settings-tab px-4 py-3.5 text-sm font-medium border-b-2 transition-all">
                    <span class="flex items-center space-x-2">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                        <span>Media Manager</span>
                    </span>
                </button>
                <button onclick="switchSettingsTab('profiles')" id="settings-tab-profiles"
                        class="settings-tab px-4 py-3.5 text-sm font-medium border-b-2 transition-all">
                    <span class="flex items-center space-x-2">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>
                        <span>Profiles</span>
                    </span>
                </button>
            </div>
            <button onclick="closeTelegramModal()" class="p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-all">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
        </div>
        <div class="flex-1 overflow-hidden">
            <!-- AI Settings Tab -->
            <div id="settings-panel-ai" class="h-full flex overflow-hidden">
                <div class="w-[340px] flex-shrink-0 border-r border-white/5 overflow-y-auto custom-scrollbar p-4 space-y-4">
                    <div class="bg-dark-100/30 rounded-xl p-4 border border-white/5">
                        <h4 class="text-[10px] font-semibold text-purple-400 uppercase tracking-wider mb-3">Provider</h4>
                        <div class="space-y-2.5">
                            <div class="grid grid-cols-2 gap-2">
                                <div>
                                    <label class="block text-[10px] text-gray-500 mb-0.5">Provider</label>
                                    <select id="ai-provider" onchange="onProviderChange()"
                                            class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-purple-500/50">
                                        <option value="openai">OpenAI</option>
                                        <option value="anthropic">Anthropic</option>
                                        <option value="grok">Grok (xAI)</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-[10px] text-gray-500 mb-0.5">Model</label>
                                    <select id="ai-model" class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-purple-500/50"></select>
                                </div>
                            </div>
                            <div>
                                <label class="block text-[10px] text-gray-500 mb-0.5">API Key</label>
                                <input type="password" id="ai-api-key" placeholder="sk-... or sk-ant-..."
                                       class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white placeholder-gray-500 outline-none focus:border-purple-500/50">
                            </div>
                        </div>
                    </div>
                    <div class="bg-dark-100/30 rounded-xl p-4 border border-white/5">
                        <h4 class="text-[10px] font-semibold text-purple-400 uppercase tracking-wider mb-3">Auto-Reply</h4>
                        <div class="space-y-2.5">
                            <label class="flex items-center justify-between cursor-pointer">
                                <span class="text-xs text-gray-300">Enable Auto-Reply</span>
                                <div class="relative">
                                    <input type="checkbox" id="ai-auto-reply-enabled" class="sr-only peer">
                                    <div class="w-9 h-[18px] bg-gray-600 rounded-full peer peer-checked:bg-purple-500 transition-colors"></div>
                                    <div class="absolute left-0.5 top-0.5 w-3.5 h-3.5 bg-white rounded-full transition-transform peer-checked:translate-x-[18px]"></div>
                                </div>
                            </label>
                            <div class="grid grid-cols-3 gap-2">
                                <div>
                                    <label class="block text-[10px] text-gray-500 mb-0.5">Scope</label>
                                    <select id="ai-reply-scope" class="w-full px-2 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-purple-500/50">
                                        <option value="all">All</option>
                                        <option value="selected">Selected</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-[10px] text-gray-500 mb-0.5">Max Tokens</label>
                                    <input type="number" id="ai-max-tokens" value="500" min="50" max="4000" class="w-full px-2 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-purple-500/50">
                                </div>
                                <div>
                                    <label class="block text-[10px] text-gray-500 mb-0.5">Temp</label>
                                    <input type="number" id="ai-temperature" value="0.7" min="0" max="2" step="0.1" class="w-full px-2 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-purple-500/50">
                                </div>
                            </div>
                            <div id="ai-account-select" class="hidden bg-dark-100/30 rounded-xl border border-white/5 overflow-hidden">
                                <div class="flex items-center justify-between px-3 py-1.5 border-b border-white/5">
                                    <span class="text-[10px] text-gray-400"><span id="ai-selected-count">0</span> of <span id="ai-total-count">0</span> selected</span>
                                    <div class="flex items-center space-x-1.5">
                                        <button type="button" onclick="aiSelectAllAccounts()" class="text-[10px] text-purple-400 hover:text-purple-300 transition-colors">All</button>
                                        <span class="text-[10px] text-gray-600">|</span>
                                        <button type="button" onclick="aiDeselectAllAccounts()" class="text-[10px] text-gray-400 hover:text-gray-300 transition-colors">None</button>
                                    </div>
                                </div>
                                <div class="px-2 py-1.5">
                                    <input type="text" id="ai-account-search" placeholder="Search accounts..." oninput="aiFilterAccounts(this.value)"
                                           class="w-full px-2.5 py-1.5 bg-dark-100/50 border border-white/10 rounded-lg text-[11px] text-white placeholder-gray-500 outline-none focus:border-purple-500/50 transition-all">
                                </div>
                                <div id="ai-account-list" class="max-h-36 overflow-y-auto custom-scrollbar px-1 pb-1.5"></div>
                            </div>
                            <div>
                                <div class="flex items-center justify-between mb-0.5">
                                    <label class="text-[10px] text-gray-500">System Prompt</label>
                                    <div class="flex items-center space-x-1.5">
                                        <select id="ai-prompt-profile-select" class="px-1.5 py-0.5 rounded bg-dark-100/50 border border-white/10 text-[9px] text-gray-400 outline-none max-w-[100px]">
                                            <option value="">Profile...</option>
                                        </select>
                                        <button onclick="loadPromptFromProfile()" class="px-1.5 py-0.5 rounded bg-purple-500/20 hover:bg-purple-500/30 text-[9px] text-purple-300 hover:text-purple-200 transition-all">Load Prompt</button>
                                    </div>
                                </div>
                                <textarea id="ai-system-prompt" rows="5" placeholder="Select a profile and click 'Load Prompt' to generate, or write your own..."
                                          class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white placeholder-gray-500 outline-none focus:border-purple-500/50 resize-none"></textarea>
                            </div>
                            <button onclick="saveAISettings()"
                                    class="w-full px-3 py-2.5 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 rounded-xl text-xs font-medium text-white transition-all shadow-lg shadow-purple-500/20">
                                <span class="flex items-center justify-center">
                                    <svg class="w-3.5 h-3.5 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
                                    Save Settings
                                </span>
                            </button>
                        </div>
                    </div>
                </div>
                <div class="flex-1 flex flex-col overflow-hidden">
                    <div class="px-5 py-3 border-b border-white/5 flex items-center justify-between flex-shrink-0">
                        <div class="flex items-center space-x-2.5">
                            <div class="w-8 h-8 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
                                <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"></path></svg>
                            </div>
                            <div>
                                <h4 class="text-sm font-semibold text-white">Test Chat</h4>
                                <p id="ai-test-subtitle" class="text-[10px] text-gray-500">Send messages to test your AI prompt in real-time</p>
                            </div>
                        </div>
                        <div class="flex items-center space-x-2">
                            <select id="ai-test-profile" onchange="onTestProfileChange()"
                                    class="px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[11px] text-gray-300 outline-none focus:border-cyan-500/50 transition-all max-w-[160px]">
                                <option value="">System Prompt</option>
                            </select>
                            <button onclick="clearTestChat()" class="px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] text-gray-400 hover:text-white transition-all">Clear Chat</button>
                        </div>
                    </div>
                    <div id="ai-test-messages" class="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3">
                        <div class="flex flex-col items-center justify-center h-full text-center">
                            <div class="w-14 h-14 rounded-2xl bg-cyan-500/10 flex items-center justify-center mb-3">
                                <svg class="w-7 h-7 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path></svg>
                            </div>
                            <p class="text-gray-400 text-sm">Test your AI configuration</p>
                            <p class="text-gray-500 text-xs mt-1">Select a profile above to test conversation, or use System Prompt for name extraction</p>
                        </div>
                    </div>
                    <div class="px-4 py-3 border-t border-white/5 flex-shrink-0">
                        <form onsubmit="handleTestChatSend(event)" class="flex space-x-2">
                            <input type="text" id="ai-test-input" placeholder="Type a test message..."
                                   class="flex-1 px-4 py-2.5 bg-dark-100/50 border border-white/10 rounded-xl text-sm text-white placeholder-gray-500 focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20 outline-none transition-all" autocomplete="off">
                            <button type="submit" id="ai-test-send-btn"
                                    class="px-4 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 rounded-xl font-medium text-white text-sm transition-all shadow-lg shadow-cyan-500/20 disabled:opacity-50 disabled:cursor-not-allowed">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
                            </button>
                        </form>
                    </div>
                </div>
            </div>
            <!-- Media Manager Tab -->
            <div id="settings-panel-media" class="h-full flex overflow-hidden">
                <div class="w-60 border-r border-white/5 flex flex-col flex-shrink-0">
                    <div class="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Folders</span>
                        <button onclick="mmShowAddFolder()" class="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-all" title="New Folder">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>
                        </button>
                    </div>
                    <div id="mm-folder-list" class="flex-1 overflow-y-auto custom-scrollbar px-2 py-2 space-y-1">
                        <div class="text-center py-8"><div class="w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto"></div></div>
                    </div>
                </div>
                <div class="flex-1 flex flex-col overflow-hidden">
                    <div id="mm-toolbar" class="px-4 py-3 border-b border-white/5 hidden">
                        <div class="flex items-center justify-between">
                            <div class="flex items-center space-x-2">
                                <h4 id="mm-folder-title" class="text-sm font-semibold text-white"></h4>
                                <span id="mm-file-count" class="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-gray-400"></span>
                            </div>
                            <div class="flex items-center space-x-1.5">
                                <button onclick="mmSelectAll()" class="px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] text-gray-400 hover:text-white transition-all">Select All</button>
                                <button onclick="mmDeselectAll()" class="px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] text-gray-400 hover:text-white transition-all">Clear</button>
                                <button onclick="mmDeleteSelected()" id="mm-bulk-delete-btn" class="px-2.5 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-[11px] text-red-400 hover:text-red-300 transition-all hidden">Delete Selected</button>
                                <div class="w-px h-5 bg-white/10"></div>
                                <button onclick="mmUploadFiles()" class="p-1.5 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 hover:text-purple-300 transition-all" title="Upload Images">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
                                </button>
                                <button onclick="mmScanFolder()" id="mm-scan-btn" class="p-1.5 rounded-lg bg-green-500/20 hover:bg-green-500/30 text-green-400 hover:text-green-300 transition-all hidden" title="Scan Local Folder">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                                </button>
                            </div>
                        </div>
                        <div class="mt-3">
                            <div class="flex items-center space-x-3">
                                <span class="text-[11px] text-gray-500 flex-shrink-0">Map to:</span>
                                <select id="mm-account-scope" onchange="mmOnScopeChange()" class="px-2 py-1 bg-dark-100/50 border border-white/10 rounded-lg text-[11px] text-white outline-none focus:border-purple-500/50">
                                    <option value="all">All Accounts</option>
                                    <option value="selected">Selected Accounts</option>
                                </select>
                                <span id="mm-selected-summary" class="text-[10px] text-indigo-400 hidden"></span>
                                <button onclick="mmSaveAccountMapping()" class="px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-[11px] text-indigo-400 hover:text-indigo-300 transition-all flex-shrink-0 ml-auto">Save Mapping</button>
                            </div>
                            <div id="mm-account-picker" class="hidden mt-2 bg-dark-100/30 rounded-xl border border-white/5 overflow-hidden">
                                <div class="flex items-center justify-between px-3 py-1.5 border-b border-white/5">
                                    <span class="text-[10px] text-gray-400"><span id="mm-selected-count">0</span> of <span id="mm-total-count">0</span> selected</span>
                                    <div class="flex items-center space-x-1.5">
                                        <button type="button" onclick="mmSelectAllAccounts()" class="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors">All</button>
                                        <span class="text-[10px] text-gray-600">|</span>
                                        <button type="button" onclick="mmDeselectAllAccounts()" class="text-[10px] text-gray-400 hover:text-gray-300 transition-colors">None</button>
                                    </div>
                                </div>
                                <div class="px-2 py-1.5">
                                    <input type="text" id="mm-account-search" placeholder="Search accounts..." oninput="mmFilterAccounts(this.value)"
                                           class="w-full px-2.5 py-1.5 bg-dark-100/50 border border-white/10 rounded-lg text-[11px] text-white placeholder-gray-500 outline-none focus:border-indigo-500/50 transition-all">
                                </div>
                                <div id="mm-account-list" class="max-h-32 overflow-y-auto custom-scrollbar px-1 pb-1.5"></div>
                            </div>
                        </div>
                    </div>
                    <div id="mm-files-area" class="flex-1 overflow-y-auto custom-scrollbar p-4">
                        <div class="flex flex-col items-center justify-center h-full text-center">
                            <div class="w-16 h-16 rounded-2xl bg-indigo-500/10 flex items-center justify-center mb-3">
                                <svg class="w-8 h-8 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
                            </div>
                            <p class="text-gray-400 text-sm">Select a folder to view images</p>
                            <p class="text-gray-500 text-xs mt-1">Create a folder or select one from the sidebar</p>
                        </div>
                    </div>
                </div>
            </div>
            <!-- Profiles Tab -->
            <div id="settings-panel-profiles" class="h-full flex overflow-hidden hidden">
                <div class="w-60 border-r border-white/5 flex flex-col flex-shrink-0">
                    <div class="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Profiles</span>
                        <button onclick="showCreateProfileForm()" class="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-all" title="New Profile">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>
                        </button>
                    </div>
                    <div id="profile-list" class="flex-1 overflow-y-auto custom-scrollbar px-2 py-2 space-y-1">
                        <div class="text-center py-8"><div class="w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto"></div></div>
                    </div>
                </div>
                <div class="flex-1 flex flex-col overflow-hidden">
                    <div id="profile-form-area" class="flex-1 overflow-y-auto custom-scrollbar p-5">
                        <div class="flex flex-col items-center justify-center h-full text-center">
                            <div class="w-16 h-16 rounded-2xl bg-pink-500/10 flex items-center justify-center mb-3">
                                <svg class="w-8 h-8 text-pink-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>
                            </div>
                            <p class="text-gray-400 text-sm">Select or create a profile</p>
                            <p class="text-gray-500 text-xs mt-1">Profiles build dynamic personas for auto-reply</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    container.innerHTML = '';
    container.appendChild(modal);
    switchSettingsTab(settingsActiveTab);
}

function switchSettingsTab(tab) {
    settingsActiveTab = tab;
    const tabs = {
        ai: { tab: document.getElementById('settings-tab-ai'), panel: document.getElementById('settings-panel-ai') },
        media: { tab: document.getElementById('settings-tab-media'), panel: document.getElementById('settings-panel-media') },
        profiles: { tab: document.getElementById('settings-tab-profiles'), panel: document.getElementById('settings-panel-profiles') },
    };

    const activeClass = 'settings-tab px-4 py-3.5 text-sm font-medium border-b-2 transition-all text-white border-purple-500';
    const inactiveClass = 'settings-tab px-4 py-3.5 text-sm font-medium border-b-2 transition-all text-gray-500 hover:text-gray-300 border-transparent';

    for (const [key, el] of Object.entries(tabs)) {
        if (!el.tab || !el.panel) continue;
        if (key === tab) {
            el.tab.className = activeClass;
            el.panel.classList.remove('hidden');
        } else {
            el.tab.className = inactiveClass;
            el.panel.classList.add('hidden');
        }
    }

    if (tab === 'ai') { setTimeout(loadAISettings, 50); loadTestChatProfiles(); }
    else if (tab === 'media') mmLoadFolders();
    else if (tab === 'profiles') loadProfiles();
}

const AI_MODELS = {
    openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    anthropic: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'],
    grok: ['grok-4-fast-non-reasoning', 'grok-3-fast', 'grok-3-mini-fast', 'grok-2']
};

function onProviderChange() {
    const provider = document.getElementById('ai-provider').value;
    const modelSelect = document.getElementById('ai-model');
    const models = AI_MODELS[provider] || [];
    modelSelect.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
}

// ==================== AI SETTINGS ====================

async function loadAISettings() {
    try {
        const config = await eel.get_ai_config()();
        if (config.error) return;

        document.getElementById('ai-provider').value = config.provider || 'openai';
        onProviderChange();
        if (config.model) document.getElementById('ai-model').value = config.model;
        if (config.api_key) document.getElementById('ai-api-key').value = config.api_key;
        document.getElementById('ai-system-prompt').value = config.system_prompt || '';
        document.getElementById('ai-auto-reply-enabled').checked = config.auto_reply_enabled || false;
        document.getElementById('ai-reply-scope').value = config.auto_reply_scope || 'all';
        document.getElementById('ai-max-tokens').value = config.max_tokens || 500;
        document.getElementById('ai-temperature').value = config.temperature || 0.7;

        // Account picker for scope=selected
        const scopeSelect = document.getElementById('ai-reply-scope');
        const accountSelect = document.getElementById('ai-account-select');
        const updateScope = () => {
            if (scopeSelect.value === 'selected') {
                accountSelect.classList.remove('hidden');
                aiRenderAccountPicker(config.selected_account_ids || []);
            } else {
                accountSelect.classList.add('hidden');
            }
        };
        scopeSelect.onchange = updateScope;
        updateScope();

        // Populate the prompt profile selector
        try {
            const profiles = await eel.get_profiles()();
            const sel = document.getElementById('ai-prompt-profile-select');
            if (sel && profiles.length) {
                sel.innerHTML = '<option value="">Profile...</option>' +
                    profiles.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
            }
        } catch (e) {}
    } catch (e) {
        console.error('Failed to load AI settings:', e);
    }
}

async function loadPromptFromProfile() {
    const sel = document.getElementById('ai-prompt-profile-select');
    const profileId = sel?.value ? parseInt(sel.value) : null;
    if (!profileId) {
        showToast('Select a profile first', 'warning');
        return;
    }
    try {
        const result = await eel.preview_system_prompt(profileId)();
        if (result.success && result.prompt) {
            document.getElementById('ai-system-prompt').value = result.prompt;
            showToast('System prompt loaded from profile', 'success');
        } else {
            showToast(result.error || 'Failed to load prompt', 'error');
        }
    } catch (e) {
        showToast('Failed to load prompt', 'error');
    }
}

async function saveAISettings() {
    const data = {
        provider: document.getElementById('ai-provider').value,
        api_key: document.getElementById('ai-api-key').value,
        model: document.getElementById('ai-model').value,
        system_prompt: document.getElementById('ai-system-prompt').value,
        auto_reply_enabled: document.getElementById('ai-auto-reply-enabled').checked,
        auto_reply_scope: document.getElementById('ai-reply-scope').value,
        selected_account_ids: Array.from(aiSelectedAccountIds),
        max_tokens: parseInt(document.getElementById('ai-max-tokens').value) || 500,
        temperature: parseFloat(document.getElementById('ai-temperature').value) || 0.7
    };

    try {
        const result = await eel.save_ai_config(data)();
        if (result.success) {
            showToast('AI settings saved!', 'success');
        } else {
            showToast(result.error || 'Failed to save settings', 'error');
        }
    } catch (e) {
        showToast('Failed to save AI settings', 'error');
    }
}

// ==================== AI ACCOUNT PICKER ====================
let aiSelectedAccountIds = new Set();

function aiRenderAccountPicker(selectedIds = []) {
    aiSelectedAccountIds = new Set(selectedIds);
    const searchInput = document.getElementById('ai-account-search');
    if (searchInput) searchInput.value = '';
    aiFilterAccounts('');
    aiUpdateSelectedCount();
}

function aiFilterAccounts(query) {
    const list = document.getElementById('ai-account-list');
    if (!list) return;
    const q = query.toLowerCase().trim();
    const filtered = q
        ? accounts.filter(a => (a.display_name || '').toLowerCase().includes(q) || a.phone_number.toLowerCase().includes(q))
        : accounts;

    if (filtered.length === 0) {
        list.innerHTML = '<div class="px-3 py-2 text-[10px] text-gray-500 text-center">No accounts found</div>';
        return;
    }

    list.innerHTML = filtered.map(acc => {
        const checked = aiSelectedAccountIds.has(acc.id);
        return `
        <label class="flex items-center space-x-2 px-2 py-1 rounded-lg hover:bg-white/5 cursor-pointer group">
            <input type="checkbox" ${checked ? 'checked' : ''} onchange="aiToggleAccount(${acc.id}, this.checked)"
                   class="rounded text-purple-500 w-3.5 h-3.5 flex-shrink-0">
            <span class="text-[11px] text-gray-300 truncate">${escapeHtml(acc.display_name || acc.phone_number)}</span>
        </label>`;
    }).join('');
}

function aiToggleAccount(id, checked) {
    if (checked) aiSelectedAccountIds.add(id);
    else aiSelectedAccountIds.delete(id);
    aiUpdateSelectedCount();
}

function aiSelectAllAccounts() {
    accounts.forEach(a => aiSelectedAccountIds.add(a.id));
    aiFilterAccounts(document.getElementById('ai-account-search')?.value || '');
    aiUpdateSelectedCount();
}

function aiDeselectAllAccounts() {
    aiSelectedAccountIds.clear();
    aiFilterAccounts(document.getElementById('ai-account-search')?.value || '');
    aiUpdateSelectedCount();
}

function aiUpdateSelectedCount() {
    const countEl = document.getElementById('ai-selected-count');
    const totalEl = document.getElementById('ai-total-count');
    if (countEl) countEl.textContent = aiSelectedAccountIds.size;
    if (totalEl) totalEl.textContent = accounts.length;
}

// ==================== TEST CHAT ====================
let testChatMessages = [];
let testChatProfiles = [];
let _pendingTestProfileId = null;
let _selectedTestProfileId = null;

async function loadTestChatProfiles() {
    try {
        testChatProfiles = await eel.get_profiles()();
        const sel = document.getElementById('ai-test-profile');
        if (!sel) return;

        const prevId = _pendingTestProfileId || _selectedTestProfileId;
        _pendingTestProfileId = null;

        sel.innerHTML = '<option value="">System Prompt</option>' +
            testChatProfiles.map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${escapeHtml(p.username)})</option>`).join('');

        if (prevId) {
            sel.value = String(prevId);
            if (sel.value === String(prevId)) {
                onTestProfileChange(true);
            }
        } else {
            const active = testChatProfiles.find(p => p.is_active);
            if (active) {
                sel.value = String(active.id);
                _selectedTestProfileId = active.id;
                onTestProfileChange(true);
            }
        }
    } catch (e) { /* ignore */ }
}

function onTestProfileChange(forceKeepChat) {
    const sel = document.getElementById('ai-test-profile');
    const newId = sel?.value ? parseInt(sel.value) : null;
    if (!forceKeepChat && newId !== _selectedTestProfileId) {
        clearTestChat();
    }
    _selectedTestProfileId = newId;
    const profile = testChatProfiles.find(p => p.id == sel?.value);
    const subtitle = document.getElementById('ai-test-subtitle');
    if (subtitle) {
        if (profile) {
            subtitle.textContent = `Testing as ${profile.username} (${profile.name})`;
            subtitle.classList.replace('text-gray-500', 'text-cyan-400');
        } else {
            subtitle.textContent = 'Using system prompt (name extraction)';
            subtitle.classList.replace('text-cyan-400', 'text-gray-500');
        }
    }
    // Auto-load system prompt from selected profile
    if (newId) {
        eel.preview_system_prompt(newId)().then(result => {
            if (result.success && result.prompt) {
                document.getElementById('ai-system-prompt').value = result.prompt;
            }
        }).catch(() => {});
    }
}

function clearTestChat() {
    testChatMessages = [];
    renderTestChat();
}

function renderTestChat() {
    const area = document.getElementById('ai-test-messages');
    if (!area) return;

    if (testChatMessages.length === 0) {
        area.innerHTML = `
            <div class="flex flex-col items-center justify-center h-full text-center">
                <div class="w-14 h-14 rounded-2xl bg-cyan-500/10 flex items-center justify-center mb-3">
                    <svg class="w-7 h-7 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path></svg>
                </div>
                <p class="text-gray-400 text-sm">Test your AI configuration</p>
                <p class="text-gray-500 text-xs mt-1">Type a message below to see how the AI responds</p>
            </div>`;
        return;
    }

    area.innerHTML = testChatMessages.map(msg => {
        const time = msg.time || '';
        if (msg.role === 'user') {
            return `
            <div class="flex justify-end animate-fade-in">
                <div class="max-w-[75%]">
                    <div class="bg-gradient-to-br from-purple-500/30 to-pink-500/30 border border-purple-500/10 rounded-2xl rounded-tr-md px-4 py-2.5">
                        <p class="text-sm text-white break-words">${escapeHtml(msg.text)}</p>
                        <p class="text-[10px] text-gray-400 mt-1 text-right">${time}</p>
                    </div>
                </div>
            </div>`;
        } else if (msg.role === 'typing') {
            return `
            <div class="flex justify-start animate-fade-in">
                <div class="max-w-[75%]">
                    <p class="text-[10px] text-gray-500 mb-1 ml-1">AI</p>
                    <div class="bg-dark-100/80 border border-white/5 rounded-2xl rounded-tl-md px-4 py-3">
                        <div class="flex items-center space-x-1.5">
                            <div class="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style="animation-delay: 0ms"></div>
                            <div class="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style="animation-delay: 150ms"></div>
                            <div class="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style="animation-delay: 300ms"></div>
                        </div>
                    </div>
                </div>
            </div>`;
        } else {
            const isError = msg.role === 'error';
            if (isError) {
                return `
                <div class="flex justify-start animate-fade-in">
                    <div class="max-w-[75%]">
                        <p class="text-[10px] text-gray-500 mb-1 ml-1">AI ${msg.model ? `<span class="text-gray-600">· ${msg.model}</span>` : ''}</p>
                        <div class="bg-red-500/10 border border-red-500/20 rounded-2xl rounded-tl-md px-4 py-2.5">
                            <p class="text-sm text-red-400 break-words">${escapeHtml(msg.text)}</p>
                            <p class="text-[10px] text-gray-500 mt-1 text-right">${time}</p>
                        </div>
                    </div>
                </div>`;
            }
            const bubbles = msg.text.split('|||').map(b => b.trim()).filter(b => b);
            return bubbles.map((bubble, i) => `
            <div class="flex justify-start animate-fade-in">
                <div class="max-w-[75%]">
                    ${i === 0 ? `<p class="text-[10px] text-gray-500 mb-1 ml-1">AI ${msg.model ? `<span class="text-gray-600">· ${msg.model}</span>` : ''}</p>` : ''}
                    <div class="bg-gradient-to-br from-cyan-500/15 to-blue-500/15 border border-cyan-500/10 rounded-2xl rounded-tl-md px-4 py-2.5">
                        <p class="text-sm text-gray-200 break-words">${escapeHtml(bubble)}</p>
                        ${i === bubbles.length - 1 ? `<p class="text-[10px] text-gray-500 mt-1 text-right">${time}</p>` : ''}
                    </div>
                </div>
            </div>`).join('');
        }
    }).join('');

    requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; });
}

async function handleTestChatSend(e) {
    e.preventDefault();
    const input = document.getElementById('ai-test-input');
    const btn = document.getElementById('ai-test-send-btn');
    const text = input.value.trim();
    if (!text) return;

    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    testChatMessages.push({ role: 'user', text, time: now });
    input.value = '';
    input.focus();

    testChatMessages.push({ role: 'typing' });
    renderTestChat();

    input.disabled = true;
    btn.disabled = true;

    try {
        const history = testChatMessages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(0, -1)
            .map(m => ({ role: m.role, content: m.text }));

        const profileId = document.getElementById('ai-test-profile')?.value || '';

        const data = {
            provider: document.getElementById('ai-provider')?.value || '',
            model: document.getElementById('ai-model')?.value || '',
            system_prompt: document.getElementById('ai-system-prompt')?.value || '',
            test_message: text,
            profile_id: profileId ? parseInt(profileId) : null,
            conversation_history: history
        };

        const result = await eel.test_ai_prompt(data)();

        testChatMessages = testChatMessages.filter(m => m.role !== 'typing');
        const replyTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        if (result.success) {
            testChatMessages.push({
                role: 'assistant',
                text: result.reply,
                model: result.model,
                time: replyTime
            });
        } else {
            testChatMessages.push({
                role: 'error',
                text: result.error || 'Failed to get response',
                time: replyTime
            });
        }
    } catch (err) {
        testChatMessages = testChatMessages.filter(m => m.role !== 'typing');
        testChatMessages.push({
            role: 'error',
            text: err.message || 'Network error',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
    }

    input.disabled = false;
    btn.disabled = false;
    input.focus();
    renderTestChat();
}

// ==================== MEDIA MANAGER ====================
let mediaManagerState = { folders: [], selectedFolderId: null, files: [], selectedFileIds: new Set() };

async function loadMediaFolders() {
    // No-op — media folders load within the settings modal media tab
}

async function mmLoadFolders() {
    try {
        mediaManagerState.folders = await eel.get_media_folders()();
        mmRenderFolderList();
    } catch (e) {
        showToast('Failed to load folders', 'error');
    }
}

function mmRenderFolderList() {
    const container = document.getElementById('mm-folder-list');
    if (!container) return;
    const folders = mediaManagerState.folders;

    if (folders.length === 0) {
        container.innerHTML = `
            <div class="flex flex-col items-center py-8 text-center">
                <svg class="w-10 h-10 text-gray-600 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
                <p class="text-gray-500 text-xs">No folders yet</p>
                <button onclick="mmShowAddFolder()" class="mt-2 text-purple-400 text-xs hover:text-purple-300 transition-colors">+ Create folder</button>
            </div>`;
        return;
    }

    container.innerHTML = folders.map(f => {
        const isActive = mediaManagerState.selectedFolderId === f.id;
        const scopeIcon = f.account_scope === 'selected'
            ? '<span class="text-[9px] px-1 py-0.5 rounded bg-indigo-500/20 text-indigo-400">Mapped</span>'
            : '';
        return `
        <div class="group relative">
            <button onclick="mmSelectFolder(${f.id})"
                    class="w-full flex items-center px-3 py-2.5 rounded-xl text-left transition-all duration-150
                           ${isActive ? 'bg-gradient-to-r from-indigo-500/20 to-purple-500/20 border border-indigo-500/20' : 'hover:bg-white/5 border border-transparent'}">
                <div class="w-8 h-8 rounded-lg ${isActive ? 'bg-indigo-500/30' : 'bg-white/5'} flex items-center justify-center mr-2.5 flex-shrink-0">
                    <svg class="w-4 h-4 ${isActive ? 'text-indigo-400' : 'text-gray-500'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${f.folder_type === 'local' ? 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z' : 'M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12'}"></path>
                    </svg>
                </div>
                <div class="flex-1 min-w-0 pr-6">
                    <p class="text-xs font-medium ${isActive ? 'text-white' : 'text-gray-300'} truncate">${escapeHtml(f.name)}</p>
                    <div class="flex items-center space-x-1.5">
                        <span class="text-[10px] text-gray-500">${f.file_count} files</span>
                        ${scopeIcon}
                    </div>
                </div>
            </button>
            <button onclick="event.stopPropagation(); mmDeleteFolder(${f.id})"
                    class="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-red-500/20 text-gray-600 hover:text-red-400 transition-all opacity-0 group-hover:opacity-100"
                    title="Delete Folder">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
        </div>`;
    }).join('');
}

async function mmSelectFolder(folderId) {
    mediaManagerState.selectedFolderId = folderId;
    mediaManagerState.selectedFileIds.clear();
    mmRenderFolderList();

    const folder = mediaManagerState.folders.find(f => f.id === folderId);
    if (!folder) return;

    const toolbar = document.getElementById('mm-toolbar');
    if (toolbar) toolbar.classList.remove('hidden');
    const title = document.getElementById('mm-folder-title');
    if (title) title.textContent = folder.name;

    const scanBtn = document.getElementById('mm-scan-btn');
    if (scanBtn) {
        if (folder.folder_type === 'local') scanBtn.classList.remove('hidden');
        else scanBtn.classList.add('hidden');
    }

    const scopeSelect = document.getElementById('mm-account-scope');
    if (scopeSelect) scopeSelect.value = folder.account_scope || 'all';
    mmRenderAccountPicker(folder);

    mmLoadFiles(folderId);
}

// ==================== MEDIA ACCOUNT PICKER ====================
let mmSelectedAccountIds = new Set();

function mmRenderAccountPicker(folder) {
    const picker = document.getElementById('mm-account-picker');
    const scopeSelect = document.getElementById('mm-account-scope');
    if (!picker || !scopeSelect) return;

    mmSelectedAccountIds = new Set(folder.mapped_account_ids || []);

    if (scopeSelect.value === 'selected') {
        picker.classList.remove('hidden');
        const searchInput = document.getElementById('mm-account-search');
        if (searchInput) searchInput.value = '';
        mmFilterAccounts('');
        mmUpdateSelectedCount();
    } else {
        picker.classList.add('hidden');
    }
    mmUpdateSelectedSummary();
}

function mmFilterAccounts(query) {
    const list = document.getElementById('mm-account-list');
    if (!list) return;
    const q = query.toLowerCase().trim();
    const filtered = q
        ? accounts.filter(a => (a.display_name || '').toLowerCase().includes(q) || a.phone_number.toLowerCase().includes(q))
        : accounts;

    if (filtered.length === 0) {
        list.innerHTML = '<div class="px-3 py-2 text-[10px] text-gray-500 text-center">No accounts found</div>';
        return;
    }

    list.innerHTML = filtered.map(acc => {
        const checked = mmSelectedAccountIds.has(acc.id);
        return `
        <label class="flex items-center space-x-2 px-2 py-1 rounded-lg hover:bg-white/5 cursor-pointer">
            <input type="checkbox" ${checked ? 'checked' : ''} onchange="mmToggleAccount(${acc.id}, this.checked)"
                   class="rounded text-indigo-500 w-3.5 h-3.5 flex-shrink-0">
            <span class="text-[11px] text-gray-300 truncate">${escapeHtml(acc.display_name || acc.phone_number)}</span>
        </label>`;
    }).join('');
}

function mmToggleAccount(id, checked) {
    if (checked) mmSelectedAccountIds.add(id);
    else mmSelectedAccountIds.delete(id);
    mmUpdateSelectedCount();
    mmUpdateSelectedSummary();
}

function mmSelectAllAccounts() {
    accounts.forEach(a => mmSelectedAccountIds.add(a.id));
    mmFilterAccounts(document.getElementById('mm-account-search')?.value || '');
    mmUpdateSelectedCount();
    mmUpdateSelectedSummary();
}

function mmDeselectAllAccounts() {
    mmSelectedAccountIds.clear();
    mmFilterAccounts(document.getElementById('mm-account-search')?.value || '');
    mmUpdateSelectedCount();
    mmUpdateSelectedSummary();
}

function mmUpdateSelectedCount() {
    const countEl = document.getElementById('mm-selected-count');
    const totalEl = document.getElementById('mm-total-count');
    if (countEl) countEl.textContent = mmSelectedAccountIds.size;
    if (totalEl) totalEl.textContent = accounts.length;
}

function mmUpdateSelectedSummary() {
    const summary = document.getElementById('mm-selected-summary');
    const scope = document.getElementById('mm-account-scope')?.value;
    if (!summary) return;
    if (scope === 'selected') {
        summary.classList.remove('hidden');
        summary.textContent = `${mmSelectedAccountIds.size} account${mmSelectedAccountIds.size !== 1 ? 's' : ''} selected`;
    } else {
        summary.classList.add('hidden');
    }
}

function mmOnScopeChange() {
    const folder = mediaManagerState.folders.find(f => f.id === mediaManagerState.selectedFolderId);
    if (folder) {
        folder.account_scope = document.getElementById('mm-account-scope').value;
        mmRenderAccountPicker(folder);
    }
}

async function mmSaveAccountMapping() {
    const folderId = mediaManagerState.selectedFolderId;
    if (!folderId) return;

    const scope = document.getElementById('mm-account-scope').value;
    const accountIds = Array.from(mmSelectedAccountIds);

    try {
        const result = await eel.set_folder_accounts(folderId, accountIds, scope)();
        if (result.error) {
            showToast(result.error, 'error');
            return;
        }
        if (result.folder) {
            const idx = mediaManagerState.folders.findIndex(f => f.id === folderId);
            if (idx >= 0) mediaManagerState.folders[idx] = result.folder;
        }
        showToast('Account mapping saved!', 'success');
        mmRenderFolderList();
    } catch (e) {
        showToast('Failed to save mapping', 'error');
    }
}

async function mmLoadFiles(folderId) {
    const area = document.getElementById('mm-files-area');
    if (!area) return;

    area.innerHTML = `
        <div class="flex items-center justify-center h-32">
            <div class="w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
        </div>`;

    try {
        mediaManagerState.files = await eel.get_media_files(folderId)();
        mmRenderFiles();
    } catch (e) {
        area.innerHTML = '<p class="text-red-400 text-sm text-center py-8">Failed to load files</p>';
    }
}

function mmRenderFiles() {
    const area = document.getElementById('mm-files-area');
    if (!area) return;

    const files = mediaManagerState.files;
    const countEl = document.getElementById('mm-file-count');
    if (countEl) countEl.textContent = `${files.length} images`;

    if (files.length === 0) {
        area.innerHTML = `
            <div class="flex flex-col items-center justify-center h-full text-center">
                <div class="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mb-3">
                    <svg class="w-8 h-8 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                </div>
                <p class="text-gray-400 text-sm">No images in this folder</p>
                <p class="text-gray-500 text-xs mt-1">Upload images or scan a local folder</p>
            </div>`;
        return;
    }

    area.innerHTML = `
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            ${files.map(f => {
                const isSelected = mediaManagerState.selectedFileIds.has(f.id);
                const sizeKB = (f.file_size / 1024).toFixed(1);
                return `
                <div class="mm-file-card group relative rounded-xl overflow-hidden border transition-all duration-200 cursor-pointer
                            ${isSelected ? 'border-purple-500/50 ring-2 ring-purple-500/20' : 'border-white/5 hover:border-white/15'}
                            ${!f.auto_send_enabled ? 'opacity-50' : ''}"
                     data-file-id="${f.id}">
                    <!-- Thumbnail -->
                    <div class="aspect-square bg-dark-100/50 relative overflow-hidden" onclick="mmToggleFileSelect(${f.id})">
                        <img data-file-id="${f.id}" alt="${escapeHtml(f.original_name || f.filename)}"
                             class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                             loading="lazy"
                             onerror="this.parentElement.innerHTML='<div class=\\'flex items-center justify-center h-full\\'><svg class=\\'w-8 h-8 text-gray-600\\' fill=\\'none\\' stroke=\\'currentColor\\' viewBox=\\'0 0 24 24\\'><path stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\' stroke-width=\\'2\\' d=\\'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z\\'></path></svg></div>'">
                        <!-- Selection checkbox overlay -->
                        <div class="absolute top-2 left-2 ${isSelected ? '' : 'opacity-0 group-hover:opacity-100'} transition-opacity">
                            <div class="w-5 h-5 rounded-md ${isSelected ? 'bg-purple-500' : 'bg-black/50 border border-white/30'} flex items-center justify-center">
                                ${isSelected ? '<svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>' : ''}
                            </div>
                        </div>
                        <!-- Auto-send badge -->
                        <div class="absolute top-2 right-2">
                            <button onclick="event.stopPropagation(); mmToggleAutoSend(${f.id})" title="${f.auto_send_enabled ? 'Disable auto-send' : 'Enable auto-send'}"
                                    class="w-5 h-5 rounded-md ${f.auto_send_enabled ? 'bg-green-500/80' : 'bg-gray-600/80'} flex items-center justify-center transition-colors hover:scale-110">
                                <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${f.auto_send_enabled ? 'M5 13l4 4L19 7' : 'M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636'}"></path>
                                </svg>
                            </button>
                        </div>
                        <!-- Used count -->
                        ${f.used_count > 0 ? `<div class="absolute bottom-2 left-2"><span class="text-[9px] px-1.5 py-0.5 rounded-md bg-black/60 text-gray-300">Sent ${f.used_count}x</span></div>` : ''}
                    </div>
                    <!-- File info -->
                    <div class="px-2.5 py-2 bg-dark-100/30">
                        <p class="text-[11px] text-gray-300 truncate" title="${escapeHtml(f.original_name || f.filename)}">${escapeHtml(f.original_name || f.filename)}</p>
                        <div class="flex items-center justify-between mt-0.5">
                            <span class="text-[10px] text-gray-500">${sizeKB} KB</span>
                            <button onclick="event.stopPropagation(); mmDeleteFile(${f.id})"
                                    class="p-0.5 rounded hover:bg-red-500/20 text-gray-600 hover:text-red-400 transition-all opacity-0 group-hover:opacity-100" title="Delete">
                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                            </button>
                        </div>
                    </div>
                </div>`;
            }).join('')}
        </div>`;

    mmUpdateBulkDeleteBtn();
    // Load thumbnails via base64
    mmLoadThumbnails();
}

async function mmLoadThumbnails() {
    const imgs = document.querySelectorAll('img[data-file-id]');
    for (const img of imgs) {
        const fileId = parseInt(img.dataset.fileId);
        if (!fileId || img.src) continue;
        try {
            const dataUrl = await eel.serve_media_file(fileId)();
            if (dataUrl) img.src = dataUrl;
        } catch (e) { /* ignore */ }
    }
}

function mmToggleFileSelect(fileId) {
    if (mediaManagerState.selectedFileIds.has(fileId)) {
        mediaManagerState.selectedFileIds.delete(fileId);
    } else {
        mediaManagerState.selectedFileIds.add(fileId);
    }
    mmRenderFiles();
}

function mmSelectAll() {
    mediaManagerState.files.forEach(f => mediaManagerState.selectedFileIds.add(f.id));
    mmRenderFiles();
}

function mmDeselectAll() {
    mediaManagerState.selectedFileIds.clear();
    mmRenderFiles();
}

function mmUpdateBulkDeleteBtn() {
    const btn = document.getElementById('mm-bulk-delete-btn');
    if (!btn) return;
    if (mediaManagerState.selectedFileIds.size > 0) {
        btn.classList.remove('hidden');
        btn.textContent = `Delete Selected (${mediaManagerState.selectedFileIds.size})`;
    } else {
        btn.classList.add('hidden');
    }
}

async function mmToggleAutoSend(fileId) {
    try {
        const result = await eel.toggle_file_auto_send(fileId)();
        if (result.error) { showToast(result.error, 'error'); return; }
        const file = mediaManagerState.files.find(f => f.id === fileId);
        if (file) file.auto_send_enabled = result.auto_send_enabled;
        mmRenderFiles();
    } catch (e) {
        showToast('Failed to toggle auto-send', 'error');
    }
}

async function mmDeleteFile(fileId) {
    if (!confirm('Delete this image?')) return;
    try {
        const result = await eel.delete_media_file(fileId)();
        if (result.error) { showToast(result.error, 'error'); return; }
        mediaManagerState.files = mediaManagerState.files.filter(f => f.id !== fileId);
        mediaManagerState.selectedFileIds.delete(fileId);
        mmRenderFiles();
        const folder = mediaManagerState.folders.find(f => f.id === mediaManagerState.selectedFolderId);
        if (folder) folder.file_count = mediaManagerState.files.length;
        mmRenderFolderList();
        showToast('Image deleted', 'success');
    } catch (e) {
        showToast('Failed to delete image', 'error');
    }
}

async function mmDeleteSelected() {
    const count = mediaManagerState.selectedFileIds.size;
    if (!count) return;
    if (!confirm(`Delete ${count} selected images?`)) return;

    const ids = [...mediaManagerState.selectedFileIds];
    let deleted = 0;
    for (const id of ids) {
        try {
            const result = await eel.delete_media_file(id)();
            if (result.success) deleted++;
        } catch (e) { /* continue */ }
    }
    mediaManagerState.files = mediaManagerState.files.filter(f => !ids.includes(f.id));
    mediaManagerState.selectedFileIds.clear();
    mmRenderFiles();
    const folder = mediaManagerState.folders.find(f => f.id === mediaManagerState.selectedFolderId);
    if (folder) folder.file_count = mediaManagerState.files.length;
    mmRenderFolderList();
    showToast(`Deleted ${deleted} images`, 'success');
}

async function mmDeleteFolder(folderId) {
    if (!confirm('Delete this folder and all its images?')) return;
    try {
        const result = await eel.delete_media_folder(folderId)();
        if (result.error) { showToast(result.error, 'error'); return; }
        mediaManagerState.folders = mediaManagerState.folders.filter(f => f.id !== folderId);
        if (mediaManagerState.selectedFolderId === folderId) {
            mediaManagerState.selectedFolderId = null;
            mediaManagerState.files = [];
            const toolbar = document.getElementById('mm-toolbar');
            if (toolbar) toolbar.classList.add('hidden');
            const area = document.getElementById('mm-files-area');
            if (area) area.innerHTML = `
                <div class="flex flex-col items-center justify-center h-full text-center">
                    <div class="w-16 h-16 rounded-2xl bg-indigo-500/10 flex items-center justify-center mb-3">
                        <svg class="w-8 h-8 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
                    </div>
                    <p class="text-gray-400 text-sm">Select a folder to view images</p>
                </div>`;
        }
        mmRenderFolderList();
        showToast('Folder deleted', 'success');
    } catch (e) {
        showToast('Failed to delete folder', 'error');
    }
}

function mmShowAddFolder() {
    const contentHtml = `
        <div class="space-y-3">
            <div>
                <label class="block text-sm text-gray-400 mb-1">Folder Name</label>
                <input type="text" id="mm-new-folder-name" placeholder="My Images"
                       class="w-full px-3 py-2.5 bg-dark-100/50 border border-white/10 rounded-xl text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500/50">
            </div>
            <div>
                <label class="block text-sm text-gray-400 mb-1">Type</label>
                <select id="mm-new-folder-type" onchange="document.getElementById('mm-folder-path-section').classList.toggle('hidden', this.value !== 'local')"
                        class="w-full px-3 py-2.5 bg-dark-100/50 border border-white/10 rounded-xl text-sm text-white outline-none focus:border-purple-500/50">
                    <option value="uploaded">Upload Folder</option>
                    <option value="local">Local Folder (map path)</option>
                </select>
            </div>
            <div id="mm-folder-path-section" class="hidden">
                <label class="block text-sm text-gray-400 mb-1">Folder Path</label>
                <input type="text" id="mm-new-folder-path" placeholder="C:\\Users\\images"
                       class="w-full px-3 py-2.5 bg-dark-100/50 border border-white/10 rounded-xl text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500/50">
            </div>
            <div>
                <label class="block text-sm text-gray-400 mb-1">Description (optional)</label>
                <input type="text" id="mm-new-folder-desc" placeholder="Images for auto-sending"
                       class="w-full px-3 py-2.5 bg-dark-100/50 border border-white/10 rounded-xl text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500/50">
            </div>
        </div>`;

    showTelegramModal('New Media Folder', contentHtml, [
        {
            label: 'Create Folder',
            class: 'bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600',
            onClick: async () => {
                const name = document.getElementById('mm-new-folder-name').value.trim();
                const type = document.getElementById('mm-new-folder-type').value;
                const path = document.getElementById('mm-new-folder-path')?.value?.trim();
                const desc = document.getElementById('mm-new-folder-desc').value.trim();

                if (!name) { showToast('Folder name is required', 'error'); return; }
                if (type === 'local' && !path) { showToast('Folder path is required', 'error'); return; }

                try {
                    const result = await eel.create_media_folder(name, type === 'local' ? path : null, type, desc || null)();
                    if (result.error) { showToast(result.error, 'error'); return; }
                    closeTelegramModal();
                    showToast('Folder created!', 'success');
                    setTimeout(() => openSettingsModal('media'), 100);
                } catch (e) {
                    showToast('Failed to create folder', 'error');
                }
            }
        }
    ]);
}

async function mmScanFolder() {
    const folderId = mediaManagerState.selectedFolderId;
    if (!folderId) return;
    showToast('Scanning folder...', 'info');
    try {
        const result = await eel.scan_media_folder(folderId)();
        if (result.error) { showToast(result.error, 'error'); return; }
        showToast(`Found ${result.new_files} new files`, 'success');
        mmLoadFiles(folderId);
        mmLoadFolders();
    } catch (e) {
        showToast('Scan failed', 'error');
    }
}

async function mmUploadFiles() {
    const folderId = mediaManagerState.selectedFolderId;
    if (!folderId) { showToast('Select a folder first', 'error'); return; }

    showToast('Opening file picker...', 'info');
    try {
        const paths = await eel.open_file_dialog()();
        if (!paths || paths.length === 0) return;

        showToast(`Uploading ${paths.length} images...`, 'info');
        const results = await eel.upload_files_from_paths(folderId, paths)();
        const uploaded = results.filter(r => r.success || r.id).length;
        showToast(`Uploaded ${uploaded} images`, 'success');
        mmLoadFiles(folderId);
        mmLoadFolders();
    } catch (e) {
        showToast('Upload failed', 'error');
    }
}

// ==================== PROFILES ====================
let profileState = { profiles: [], selectedProfileId: null };
let profileSelectedAccountIds = new Set();

async function loadProfiles() {
    try {
        profileState.profiles = await eel.get_profiles()();
        renderProfileList();
    } catch (e) {
        console.error('Failed to load profiles:', e);
    }
}

function renderProfileList() {
    const list = document.getElementById('profile-list');
    if (!list) return;

    if (profileState.profiles.length === 0) {
        list.innerHTML = `
            <div class="text-center py-8">
                <p class="text-gray-500 text-xs">No profiles yet</p>
                <button onclick="showCreateProfileForm()" class="mt-2 text-xs text-purple-400 hover:text-purple-300">Create one</button>
            </div>`;
        return;
    }

    list.innerHTML = profileState.profiles.map(p => {
        const isActive = p.id === profileState.selectedProfileId;
        const accCount = (p.mapped_account_ids || []).length;
        return `
        <div class="flex items-center rounded-xl transition-all ${isActive ? 'bg-pink-500/20 border border-pink-500/30' : 'hover:bg-white/5 border border-transparent'}">
            <button onclick="selectProfile(${p.id})"
                    class="flex-1 text-left px-3 py-2.5">
                <div class="flex items-center justify-between">
                    <p class="text-xs font-medium ${isActive ? 'text-white' : 'text-gray-300'} truncate">${escapeHtml(p.name)}</p>
                    ${p.is_active ? '<div class="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0"></div>' : '<div class="w-1.5 h-1.5 rounded-full bg-gray-600 flex-shrink-0"></div>'}
                </div>
                <p class="text-[10px] text-gray-500 mt-0.5 truncate">${escapeHtml(p.username)} · ${accCount} account${accCount !== 1 ? 's' : ''}</p>
            </button>
            <button onclick="event.stopPropagation(); testProfile(${p.id})" title="Test this profile"
                    class="px-2 py-2 mr-1 rounded-lg hover:bg-cyan-500/20 text-gray-500 hover:text-cyan-400 transition-all flex-shrink-0">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            </button>
        </div>`;
    }).join('');
}

function selectProfile(id) {
    profileState.selectedProfileId = id;
    renderProfileList();
    const profile = profileState.profiles.find(p => p.id === id);
    if (!profile) return;
    renderProfileForm(profile);
}

function testProfile(profileId) {
    _pendingTestProfileId = profileId;
    _selectedTestProfileId = profileId;
    switchSettingsTab('ai');
}

function showCreateProfileForm() {
    profileState.selectedProfileId = null;
    renderProfileList();
    renderProfileForm(null);
}

// JS-side defaults (mirrors ai_service.py DEFAULT_SETTINGS / DEFAULT_CTA)
const PROFILE_DEFAULT_SETTINGS = {
    TEMPERATURE: 0.5, MODEL_NAME: 'grok-4-fast-non-reasoning',
    MAX_BUBBLES: 3, MAX_CHARS_PER_BUBBLE: 999,
    BUBBLE_DELAY_RANGE_S: [5.0, 8.0], TIMEZONE: 'Europe/Berlin',
    ALLOW_QUESTIONS_PROB: 0.0, ENABLE_MISMATCH_CLASSIFIER: true,
    PHOTO_MODE: 'percent', PHOTO_PERCENT: 0.7,
    PHOTO_CAPTIONS: ['\u270c\ufe0f','hoffe, ich gefall dir \ud83d\ude07','bisschen spontan\u2026','hier was aktuelles','bin gespannt was du sagst \ud83d\ude05','nur f\u00fcr dich \ud83d\ude09'],
    ON_DEMAND_PHOTO_CAPTION: 'ok, hier \ud83d\ude0a',
    FIRST_ASK_ORIGIN: true,
    FIRST_ASK_TEXT: 'Hey, sch\u00f6n dass du mir geschrieben hast, wie hei\u00dft du? \ud83d\ude18 \ud83d\ude18',
    NAMECARD: { enabled: true, template_path: 'template.png', caption: 'nur f\u00fcr dich, {name} \ud83d\ude09', late_send: 'next_media_slot' }
};
const PROFILE_DEFAULT_CTA = {
    enabled: true, start_at: 20,
    start_delay_range_s: [650, 800], step_delay_range_s: [300, 600],
    vars: { domain: 'fast-verliebt.de', username: 'Linea' },
    steps: [
        { type: 'text', content: 'Hmm shit.. deine nachricht wird mir nicht mehr angezeigt ich sehe nur das du mir geschrieben hast aber kann sie nicht sehen...' },
        { type: 'image', filename: '__LAST__', caption: 'Diese Meldung wird mir auf jeden Fall angezeigt...' },
        { type: 'text', content: 'ich hab\u2019s nochmal getestet... \ud83d\ude44 telegram blockt mich irgendwie...schreib mir sonst auf {domain} , ich bin da als {username}...' },
        { type: 'text', content: 'Hier nochmal die Seite {domain} \ud83d\ude18' }
    ]
};
const ALL_AI_MODELS = [...AI_MODELS.openai, ...AI_MODELS.anthropic, ...AI_MODELS.grok];

let profileCTASteps = [];

function mergeSettings(saved) {
    return Object.assign({}, PROFILE_DEFAULT_SETTINGS, saved || {});
}
function mergeCTA(saved) {
    const base = JSON.parse(JSON.stringify(PROFILE_DEFAULT_CTA));
    if (!saved) return base;
    Object.assign(base, saved);
    if (saved.vars) base.vars = Object.assign({}, PROFILE_DEFAULT_CTA.vars, saved.vars);
    if (saved.steps) base.steps = saved.steps;
    if (saved.NAMECARD) base.NAMECARD = Object.assign({}, PROFILE_DEFAULT_SETTINGS.NAMECARD, saved.NAMECARD);
    return base;
}

function addCTAStep() {
    profileCTASteps.push({ type: 'text', content: '' });
    renderCTASteps();
}
function removeCTAStep(idx) {
    profileCTASteps.splice(idx, 1);
    renderCTASteps();
}
function renderCTASteps() {
    const container = document.getElementById('cta-steps-list');
    if (!container) return;
    if (profileCTASteps.length === 0) {
        container.innerHTML = '<div class="text-[10px] text-gray-500 text-center py-2">No steps — click Add Step</div>';
        return;
    }
    container.innerHTML = profileCTASteps.map((step, i) => `
        <div class="bg-dark-100/40 rounded-lg p-2.5 border border-white/5 space-y-2">
            <div class="flex items-center justify-between">
                <span class="text-[10px] text-gray-400 font-medium">Step ${i + 1}</span>
                <button type="button" onclick="removeCTAStep(${i})" class="text-[10px] text-red-400 hover:text-red-300">&times; Remove</button>
            </div>
            <div class="grid grid-cols-3 gap-2">
                <div>
                    <label class="block text-[10px] text-gray-500 mb-0.5">Type</label>
                    <select onchange="profileCTASteps[${i}].type=this.value; renderCTASteps()"
                            class="w-full px-2 py-1.5 bg-dark-100/50 border border-white/10 rounded-lg text-[11px] text-white outline-none">
                        <option value="text" ${step.type==='text'?'selected':''}>Text</option>
                        <option value="image" ${step.type==='image'?'selected':''}>Image</option>
                    </select>
                </div>
                ${step.type === 'image' ? `<div class="col-span-2">
                    <label class="block text-[10px] text-gray-500 mb-0.5">Filename (__LAST__ = last sent photo)</label>
                    <input type="text" value="${escapeHtml(step.filename||'__LAST__')}"
                           onchange="profileCTASteps[${i}].filename=this.value"
                           class="w-full px-2 py-1.5 bg-dark-100/50 border border-white/10 rounded-lg text-[11px] text-white outline-none">
                </div>` : '<div class="col-span-2"></div>'}
            </div>
            <div>
                <label class="block text-[10px] text-gray-500 mb-0.5">${step.type==='image'?'Caption':'Content'}</label>
                <textarea rows="2" onchange="profileCTASteps[${i}].${step.type==='image'?'caption':'content'}=this.value"
                          class="w-full px-2 py-1.5 bg-dark-100/50 border border-white/10 rounded-lg text-[11px] text-white outline-none resize-none">${escapeHtml(step.type==='image'?(step.caption||''):(step.content||''))}</textarea>
            </div>
        </div>
    `).join('');
}

function renderProfileForm(profile) {
    const area = document.getElementById('profile-form-area');
    if (!area) return;

    const isNew = !profile;
    const p = profile || { name: '', username: '', age: '', city: '', job: '', hobbies: '', flirt_level: 'hot', location_mode: 'fixed', is_active: true, mapped_account_ids: [], settings: {}, cta: {} };
    const s = mergeSettings(p.settings);
    const c = mergeCTA(p.cta);
    const nc = s.NAMECARD ? Object.assign({}, PROFILE_DEFAULT_SETTINGS.NAMECARD, s.NAMECARD) : Object.assign({}, PROFILE_DEFAULT_SETTINGS.NAMECARD);
    profileCTASteps = JSON.parse(JSON.stringify(c.steps || []));

    profileSelectedAccountIds = new Set(p.mapped_account_ids || []);

    area.innerHTML = `
    <div class="space-y-4 max-w-2xl">
        <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-white">${isNew ? 'New Profile' : 'Edit Profile'}</h3>
            ${!isNew ? `<button onclick="deleteProfile(${p.id})" class="px-2.5 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-[11px] text-red-400 hover:text-red-300 transition-all">Delete</button>` : ''}
        </div>

        <!-- Basic Info -->
        <div class="bg-dark-100/30 rounded-xl p-4 border border-white/5 space-y-3">
            <h4 class="text-[10px] font-semibold text-pink-400 uppercase tracking-wider">Character Info</h4>
            <div class="grid grid-cols-2 gap-3">
                <div>
                    <label class="block text-[10px] text-gray-500 mb-0.5">Profile Label</label>
                    <input type="text" id="profile-name" value="${escapeHtml(p.name)}" placeholder="e.g. Linea Profile"
                           class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white placeholder-gray-500 outline-none focus:border-pink-500/50">
                </div>
                <div>
                    <label class="block text-[10px] text-gray-500 mb-0.5">Character Name</label>
                    <input type="text" id="profile-username" value="${escapeHtml(p.username)}" placeholder="e.g. Linea"
                           class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white placeholder-gray-500 outline-none focus:border-pink-500/50">
                </div>
                <div>
                    <label class="block text-[10px] text-gray-500 mb-0.5">Age</label>
                    <input type="text" id="profile-age" value="${escapeHtml(p.age || '')}" placeholder="e.g. 24"
                           class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white placeholder-gray-500 outline-none focus:border-pink-500/50">
                </div>
                <div>
                    <label class="block text-[10px] text-gray-500 mb-0.5">City</label>
                    <input type="text" id="profile-city" value="${escapeHtml(p.city || '')}" placeholder="e.g. Berlin"
                           class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white placeholder-gray-500 outline-none focus:border-pink-500/50">
                </div>
            </div>
            <div>
                <label class="block text-[10px] text-gray-500 mb-0.5">Job</label>
                <input type="text" id="profile-job" value="${escapeHtml(p.job || '')}" placeholder="e.g. Bei Orion"
                       class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white placeholder-gray-500 outline-none focus:border-pink-500/50">
            </div>
            <div>
                <label class="block text-[10px] text-gray-500 mb-0.5">Hobbies</label>
                <input type="text" id="profile-hobbies" value="${escapeHtml(p.hobbies || '')}" placeholder="e.g. Freunde treffen, Partys, Fitness"
                       class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white placeholder-gray-500 outline-none focus:border-pink-500/50">
            </div>
        </div>

        <!-- Behavior -->
        <div class="bg-dark-100/30 rounded-xl p-4 border border-white/5 space-y-3">
            <h4 class="text-[10px] font-semibold text-pink-400 uppercase tracking-wider">Behavior</h4>
            <div class="grid grid-cols-3 gap-3">
                <div>
                    <label class="block text-[10px] text-gray-500 mb-0.5">Flirt Level</label>
                    <select id="profile-flirt-level"
                            class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                        <option value="normal" ${p.flirt_level === 'normal' ? 'selected' : ''}>Normal</option>
                        <option value="hot" ${p.flirt_level === 'hot' ? 'selected' : ''}>Hot</option>
                        <option value="extreme" ${p.flirt_level === 'extreme' ? 'selected' : ''}>Extreme</option>
                    </select>
                </div>
                <div>
                    <label class="block text-[10px] text-gray-500 mb-0.5">Location Mode</label>
                    <select id="profile-location-mode"
                            class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                        <option value="fixed" ${p.location_mode === 'fixed' ? 'selected' : ''}>Fixed City</option>
                        <option value="near_user" ${p.location_mode === 'near_user' ? 'selected' : ''}>Near User</option>
                        <option value="vague" ${p.location_mode === 'vague' ? 'selected' : ''}>Vague</option>
                    </select>
                </div>
                <div>
                    <label class="block text-[10px] text-gray-500 mb-0.5">Active</label>
                    <select id="profile-is-active"
                            class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                        <option value="true" ${p.is_active ? 'selected' : ''}>Yes</option>
                        <option value="false" ${!p.is_active ? 'selected' : ''}>No</option>
                    </select>
                </div>
            </div>
        </div>

        <!-- Account Mapping -->
        <div class="bg-dark-100/30 rounded-xl p-4 border border-white/5 space-y-3">
            <h4 class="text-[10px] font-semibold text-pink-400 uppercase tracking-wider">Mapped Accounts</h4>
            <div class="bg-dark-100/30 rounded-xl border border-white/5 overflow-hidden">
                <div class="flex items-center justify-between px-3 py-1.5 border-b border-white/5">
                    <span class="text-[10px] text-gray-400"><span id="profile-selected-count">0</span> of <span id="profile-total-count">0</span> selected</span>
                    <div class="flex items-center space-x-1.5">
                        <button type="button" onclick="profileSelectAllAccounts()" class="text-[10px] text-pink-400 hover:text-pink-300 transition-colors">All</button>
                        <span class="text-[10px] text-gray-600">|</span>
                        <button type="button" onclick="profileDeselectAllAccounts()" class="text-[10px] text-gray-400 hover:text-gray-300 transition-colors">None</button>
                    </div>
                </div>
                <div class="px-2 py-1.5">
                    <input type="text" id="profile-account-search" placeholder="Search accounts..."
                           oninput="profileFilterAccounts(this.value)"
                           class="w-full px-2.5 py-1.5 bg-dark-100/50 border border-white/10 rounded-lg text-[11px] text-white placeholder-gray-500 outline-none focus:border-pink-500/50 transition-all">
                </div>
                <div id="profile-account-list" class="max-h-36 overflow-y-auto custom-scrollbar px-1 pb-1.5"></div>
            </div>
        </div>

        <!-- Message Settings (collapsible) -->
        <div class="bg-dark-100/30 rounded-xl border border-white/5 overflow-hidden">
            <button type="button" onclick="this.nextElementSibling.classList.toggle('hidden'); this.querySelector('.chv').classList.toggle('rotate-180')"
                    class="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-white/5 transition-colors">
                <h4 class="text-[10px] font-semibold text-pink-400 uppercase tracking-wider">Message Settings</h4>
                <svg class="chv w-3.5 h-3.5 text-gray-500 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
            </button>
            <div class="hidden px-4 pb-4 pt-1 space-y-3">
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Model</label>
                        <select id="ps-model"
                                class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                            ${ALL_AI_MODELS.map(m => '<option value="'+m+'" '+(s.MODEL_NAME===m?'selected':'')+'>'+m+'</option>').join('')}
                        </select>
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Temperature</label>
                        <input type="number" id="ps-temperature" value="${s.TEMPERATURE}" min="0" max="2" step="0.1"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Max Bubbles</label>
                        <input type="number" id="ps-max-bubbles" value="${s.MAX_BUBBLES}" min="1" max="10"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Max Chars/Bubble</label>
                        <input type="number" id="ps-max-chars" value="${s.MAX_CHARS_PER_BUBBLE}" min="50" max="4096"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Bubble Delay Min (s)</label>
                        <input type="number" id="ps-delay-min" value="${s.BUBBLE_DELAY_RANGE_S[0]}" min="0" step="0.5"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Bubble Delay Max (s)</label>
                        <input type="number" id="ps-delay-max" value="${s.BUBBLE_DELAY_RANGE_S[1]}" min="0" step="0.5"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Timezone</label>
                        <input type="text" id="ps-timezone" value="${escapeHtml(s.TIMEZONE)}"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Allow Questions Prob</label>
                        <input type="number" id="ps-questions-prob" value="${s.ALLOW_QUESTIONS_PROB}" min="0" max="1" step="0.1"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                </div>
                <label class="flex items-center space-x-2 cursor-pointer">
                    <input type="checkbox" id="ps-mismatch" ${s.ENABLE_MISMATCH_CLASSIFIER ? 'checked' : ''}
                           class="rounded text-pink-500 w-3.5 h-3.5">
                    <span class="text-[11px] text-gray-300">Enable Mismatch Classifier</span>
                </label>
            </div>
        </div>

        <!-- Photo Settings (collapsible) -->
        <div class="bg-dark-100/30 rounded-xl border border-white/5 overflow-hidden">
            <button type="button" onclick="this.nextElementSibling.classList.toggle('hidden'); this.querySelector('.chv').classList.toggle('rotate-180')"
                    class="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-white/5 transition-colors">
                <h4 class="text-[10px] font-semibold text-pink-400 uppercase tracking-wider">Photo Settings</h4>
                <svg class="chv w-3.5 h-3.5 text-gray-500 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
            </button>
            <div class="hidden px-4 pb-4 pt-1 space-y-3">
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Photo Mode</label>
                        <select id="ps-photo-mode"
                                class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                            <option value="percent" ${s.PHOTO_MODE==='percent'?'selected':''}>Percent</option>
                            <option value="off" ${s.PHOTO_MODE==='off'?'selected':''}>Off</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Photo Percent (0-1)</label>
                        <input type="number" id="ps-photo-pct" value="${s.PHOTO_PERCENT}" min="0" max="1" step="0.1"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                </div>
                <div>
                    <label class="block text-[10px] text-gray-500 mb-0.5">Photo Captions (one per line)</label>
                    <textarea id="ps-photo-captions" rows="4"
                              class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50 resize-none">${(s.PHOTO_CAPTIONS||[]).join('\n')}</textarea>
                </div>
                <div>
                    <label class="block text-[10px] text-gray-500 mb-0.5">On-Demand Photo Caption</label>
                    <input type="text" id="ps-ondemand-caption" value="${escapeHtml(s.ON_DEMAND_PHOTO_CAPTION||'')}"
                           class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                </div>
            </div>
        </div>

        <!-- First Message (collapsible) -->
        <div class="bg-dark-100/30 rounded-xl border border-white/5 overflow-hidden">
            <button type="button" onclick="this.nextElementSibling.classList.toggle('hidden'); this.querySelector('.chv').classList.toggle('rotate-180')"
                    class="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-white/5 transition-colors">
                <h4 class="text-[10px] font-semibold text-pink-400 uppercase tracking-wider">First Message</h4>
                <svg class="chv w-3.5 h-3.5 text-gray-500 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
            </button>
            <div class="hidden px-4 pb-4 pt-1 space-y-3">
                <label class="flex items-center space-x-2 cursor-pointer">
                    <input type="checkbox" id="ps-first-ask" ${s.FIRST_ASK_ORIGIN ? 'checked' : ''}
                           class="rounded text-pink-500 w-3.5 h-3.5">
                    <span class="text-[11px] text-gray-300">Send first-ask on first incoming message</span>
                </label>
                <div>
                    <label class="block text-[10px] text-gray-500 mb-0.5">First Ask Text (use ||| to split into bubbles)</label>
                    <textarea id="ps-first-ask-text" rows="2"
                              class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50 resize-none">${escapeHtml(s.FIRST_ASK_TEXT||'')}</textarea>
                </div>
            </div>
        </div>

        <!-- CTA (collapsible) -->
        <div class="bg-dark-100/30 rounded-xl border border-white/5 overflow-hidden">
            <button type="button" onclick="this.nextElementSibling.classList.toggle('hidden'); this.querySelector('.chv').classList.toggle('rotate-180')"
                    class="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-white/5 transition-colors">
                <h4 class="text-[10px] font-semibold text-pink-400 uppercase tracking-wider">CTA (Call-to-Action)</h4>
                <svg class="chv w-3.5 h-3.5 text-gray-500 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
            </button>
            <div class="hidden px-4 pb-4 pt-1 space-y-3">
                <label class="flex items-center space-x-2 cursor-pointer">
                    <input type="checkbox" id="ps-cta-enabled" ${c.enabled ? 'checked' : ''}
                           class="rounded text-pink-500 w-3.5 h-3.5">
                    <span class="text-[11px] text-gray-300">Enable CTA sequence</span>
                </label>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Start After N Messages</label>
                        <input type="number" id="ps-cta-start" value="${c.start_at}" min="1"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                    <div></div>
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Start Delay Min (s)</label>
                        <input type="number" id="ps-cta-sdelay-min" value="${c.start_delay_range_s[0]}" min="0"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Start Delay Max (s)</label>
                        <input type="number" id="ps-cta-sdelay-max" value="${c.start_delay_range_s[1]}" min="0"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Step Delay Min (s)</label>
                        <input type="number" id="ps-cta-delay-min" value="${c.step_delay_range_s[0]}" min="0"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Step Delay Max (s)</label>
                        <input type="number" id="ps-cta-delay-max" value="${c.step_delay_range_s[1]}" min="0"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Domain</label>
                        <input type="text" id="ps-cta-domain" value="${escapeHtml(c.vars?.domain||'')}"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Username</label>
                        <input type="text" id="ps-cta-username" value="${escapeHtml(c.vars?.username||'')}"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                </div>
                <div>
                    <div class="flex items-center justify-between mb-2">
                        <span class="text-[10px] text-gray-400 font-medium">Steps</span>
                        <button type="button" onclick="addCTAStep()" class="text-[10px] text-pink-400 hover:text-pink-300">+ Add Step</button>
                    </div>
                    <div id="cta-steps-list" class="space-y-2"></div>
                </div>
            </div>
        </div>

        <!-- Namecard (collapsible) -->
        <div class="bg-dark-100/30 rounded-xl border border-white/5 overflow-hidden">
            <button type="button" onclick="this.nextElementSibling.classList.toggle('hidden'); this.querySelector('.chv').classList.toggle('rotate-180')"
                    class="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-white/5 transition-colors">
                <h4 class="text-[10px] font-semibold text-pink-400 uppercase tracking-wider">Namecard</h4>
                <svg class="chv w-3.5 h-3.5 text-gray-500 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
            </button>
            <div class="hidden px-4 pb-4 pt-1 space-y-3">
                <label class="flex items-center space-x-2 cursor-pointer">
                    <input type="checkbox" id="ps-nc-enabled" ${nc.enabled ? 'checked' : ''}
                           class="rounded text-pink-500 w-3.5 h-3.5">
                    <span class="text-[11px] text-gray-300">Enable Namecard</span>
                </label>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Template Path</label>
                        <input type="text" id="ps-nc-template" value="${escapeHtml(nc.template_path||'')}"
                               class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                    </div>
                    <div>
                        <label class="block text-[10px] text-gray-500 mb-0.5">Late Send</label>
                        <select id="ps-nc-latesend"
                                class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                            <option value="next_media_slot" ${nc.late_send==='next_media_slot'?'selected':''}>Next Media Slot</option>
                            <option value="immediate" ${nc.late_send==='immediate'?'selected':''}>Immediate</option>
                            <option value="skip" ${nc.late_send==='skip'?'selected':''}>Skip</option>
                        </select>
                    </div>
                </div>
                <div>
                    <label class="block text-[10px] text-gray-500 mb-0.5">Caption (use {name} for recipient name)</label>
                    <input type="text" id="ps-nc-caption" value="${escapeHtml(nc.caption||'')}"
                           class="w-full px-2.5 py-2 bg-dark-100/50 border border-white/10 rounded-lg text-xs text-white outline-none focus:border-pink-500/50">
                </div>
            </div>
        </div>

        <!-- Save Button -->
        <button onclick="saveProfile(${isNew ? 'null' : p.id})"
                class="w-full px-3 py-2.5 bg-gradient-to-r from-pink-500 to-purple-500 hover:from-pink-600 hover:to-purple-600 rounded-xl text-xs font-medium text-white transition-all shadow-lg shadow-pink-500/20">
            <span class="flex items-center justify-center">
                <svg class="w-3.5 h-3.5 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
                ${isNew ? 'Create Profile' : 'Save Profile'}
            </span>
        </button>
    </div>`;

    profileFilterAccounts('');
    profileUpdateSelectedCount();
    renderCTASteps();
}

function profileFilterAccounts(query) {
    const list = document.getElementById('profile-account-list');
    if (!list) return;
    const q = query.toLowerCase().trim();
    const filtered = q
        ? accounts.filter(a => (a.display_name || '').toLowerCase().includes(q) || a.phone_number.toLowerCase().includes(q))
        : accounts;

    if (filtered.length === 0) {
        list.innerHTML = '<div class="px-3 py-2 text-[10px] text-gray-500 text-center">No accounts found</div>';
        return;
    }

    list.innerHTML = filtered.map(acc => {
        const checked = profileSelectedAccountIds.has(acc.id);
        return `
        <label class="flex items-center space-x-2 px-2 py-1 rounded-lg hover:bg-white/5 cursor-pointer group">
            <input type="checkbox" ${checked ? 'checked' : ''} onchange="profileToggleAccount(${acc.id}, this.checked)"
                   class="rounded text-pink-500 w-3.5 h-3.5 flex-shrink-0">
            <span class="text-[11px] text-gray-300 truncate">${escapeHtml(acc.display_name || acc.phone_number)}</span>
        </label>`;
    }).join('');
}

function profileToggleAccount(id, checked) {
    if (checked) profileSelectedAccountIds.add(id);
    else profileSelectedAccountIds.delete(id);
    profileUpdateSelectedCount();
}

function profileSelectAllAccounts() {
    accounts.forEach(a => profileSelectedAccountIds.add(a.id));
    profileFilterAccounts(document.getElementById('profile-account-search')?.value || '');
    profileUpdateSelectedCount();
}

function profileDeselectAllAccounts() {
    profileSelectedAccountIds.clear();
    profileFilterAccounts(document.getElementById('profile-account-search')?.value || '');
    profileUpdateSelectedCount();
}

function profileUpdateSelectedCount() {
    const countEl = document.getElementById('profile-selected-count');
    const totalEl = document.getElementById('profile-total-count');
    if (countEl) countEl.textContent = profileSelectedAccountIds.size;
    if (totalEl) totalEl.textContent = accounts.length;
}

async function saveProfile(profileId) {
    const name = document.getElementById('profile-name')?.value.trim();
    const username = document.getElementById('profile-username')?.value.trim();
    if (!name || !username) {
        showToast('Profile label and character name are required', 'error');
        return;
    }

    const val = (id, fallback) => { const el = document.getElementById(id); return el ? el.value : fallback; };
    const num = (id, fallback) => { const v = parseFloat(val(id, fallback)); return isNaN(v) ? fallback : v; };
    const chk = (id) => !!document.getElementById(id)?.checked;
    const captionsRaw = (document.getElementById('ps-photo-captions')?.value || '').split('\n').map(l => l.trim()).filter(Boolean);

    const settings = {
        MODEL_NAME: val('ps-model', 'grok-4-fast-non-reasoning'),
        TEMPERATURE: num('ps-temperature', 0.5),
        MAX_BUBBLES: num('ps-max-bubbles', 3),
        MAX_CHARS_PER_BUBBLE: num('ps-max-chars', 999),
        BUBBLE_DELAY_RANGE_S: [num('ps-delay-min', 5.0), num('ps-delay-max', 8.0)],
        TIMEZONE: val('ps-timezone', 'Europe/Berlin'),
        ALLOW_QUESTIONS_PROB: num('ps-questions-prob', 0.0),
        ENABLE_MISMATCH_CLASSIFIER: chk('ps-mismatch'),
        PHOTO_MODE: val('ps-photo-mode', 'percent'),
        PHOTO_PERCENT: num('ps-photo-pct', 0.7),
        PHOTO_CAPTIONS: captionsRaw.length ? captionsRaw : PROFILE_DEFAULT_SETTINGS.PHOTO_CAPTIONS,
        ON_DEMAND_PHOTO_CAPTION: val('ps-ondemand-caption', ''),
        FIRST_ASK_ORIGIN: chk('ps-first-ask'),
        FIRST_ASK_TEXT: document.getElementById('ps-first-ask-text')?.value || '',
        NAMECARD: {
            enabled: chk('ps-nc-enabled'),
            template_path: val('ps-nc-template', 'template.png'),
            caption: val('ps-nc-caption', ''),
            late_send: val('ps-nc-latesend', 'next_media_slot')
        }
    };

    const cta = {
        enabled: chk('ps-cta-enabled'),
        start_at: num('ps-cta-start', 20),
        start_delay_range_s: [num('ps-cta-sdelay-min', 650), num('ps-cta-sdelay-max', 800)],
        step_delay_range_s: [num('ps-cta-delay-min', 300), num('ps-cta-delay-max', 600)],
        vars: {
            domain: val('ps-cta-domain', ''),
            username: val('ps-cta-username', '')
        },
        steps: JSON.parse(JSON.stringify(profileCTASteps))
    };

    const data = {
        name,
        username,
        age: document.getElementById('profile-age')?.value.trim() || null,
        city: document.getElementById('profile-city')?.value.trim() || null,
        job: document.getElementById('profile-job')?.value.trim() || null,
        hobbies: document.getElementById('profile-hobbies')?.value.trim() || null,
        flirt_level: document.getElementById('profile-flirt-level')?.value || 'hot',
        location_mode: document.getElementById('profile-location-mode')?.value || 'fixed',
        is_active: document.getElementById('profile-is-active')?.value === 'true',
        account_ids: Array.from(profileSelectedAccountIds),
        settings,
        cta
    };

    try {
        const isNew = !profileId;
        let result;
        if (isNew) {
            result = await eel.create_profile(data)();
        } else {
            result = await eel.update_profile(profileId, data)();
        }
        if (result.error) {
            showToast(result.error, 'error');
            return;
        }
        showToast(isNew ? 'Profile created!' : 'Profile saved!', 'success');
        profileState.selectedProfileId = result.id;
        await loadProfiles();
        selectProfile(result.id);
    } catch (e) {
        showToast('Failed to save profile', 'error');
    }
}

async function deleteProfile(profileId) {
    if (!confirm('Delete this profile?')) return;
    try {
        const result = await eel.delete_profile(profileId)();
        if (result.error) {
            showToast(result.error, 'error');
            return;
        }
        showToast('Profile deleted', 'success');
        profileState.selectedProfileId = null;
        await loadProfiles();
        const area = document.getElementById('profile-form-area');
        if (area) {
            area.innerHTML = `
            <div class="flex flex-col items-center justify-center h-full text-center">
                <div class="w-16 h-16 rounded-2xl bg-pink-500/10 flex items-center justify-center mb-3">
                    <svg class="w-8 h-8 text-pink-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>
                </div>
                <p class="text-gray-400 text-sm">Select or create a profile</p>
                <p class="text-gray-500 text-xs mt-1">Profiles build dynamic personas for auto-reply</p>
            </div>`;
        }
    } catch (e) {
        showToast('Failed to delete profile', 'error');
    }
}

// ==================== HELPERS ====================
function filterAccounts(query) {
    const items = document.querySelectorAll('.account-item');
    const q = query.toLowerCase();
    items.forEach(item => {
        const search = item.dataset.search || '';
        item.style.display = search.includes(q) ? '' : 'none';
    });
}

function updateUnreadBadge(accountId, totalUnread) {
    const badge = document.querySelector(`.unread-badge-${accountId}`);
    if (badge) {
        if (totalUnread > 0) {
            badge.textContent = totalUnread > 999 ? '999+' : totalUnread;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }
    const acc = accounts.find(a => a.id === accountId);
    if (acc) acc.total_unread_count = totalUnread;
}

function updateChatUnread(accountId, chatId, unreadCount) {
    const badge = document.querySelector(`.chat-unread-${accountId}-${chatId}`);
    if (badge) {
        if (unreadCount > 0) {
            badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }
}

function updateChatInList(accountId, chatData) {
    if (expandedAccounts.has(accountId)) {
        loadChats(accountId);
    }
}

function updateTotalUnread() {
    const total = accounts.reduce((sum, a) => sum + (a.total_unread_count || 0), 0);
    const footer = document.getElementById('total-unread-footer');
    const count = document.getElementById('total-unread-count');
    if (footer) {
        if (total > 0) {
            footer.classList.remove('hidden');
            if (count) count.textContent = total > 9999 ? '9999+' : total;
        } else {
            footer.classList.add('hidden');
        }
    }
}

function scrollToBottom() {
    const area = document.getElementById('messages-area');
    if (area) {
        requestAnimationFrame(() => {
            area.scrollTop = area.scrollHeight;
        });
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==================== DB TRANSFER ====================

function openTransferModal() {
    const container = document.getElementById('modal-container');
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 z-[9999] flex items-center justify-center';
    modal.innerHTML = `
    <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeTelegramModal()"></div>
    <div class="relative w-full max-w-2xl max-h-[85vh] bg-dark-200 rounded-2xl border border-white/10 shadow-2xl flex flex-col overflow-hidden animate-fade-in">
        <!-- Header -->
        <div class="px-6 py-4 border-b border-white/5 flex items-center justify-between">
            <div class="flex items-center space-x-3">
                <div class="p-2 bg-purple-500/10 rounded-lg">
                    <svg class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"></path>
                    </svg>
                </div>
                <div>
                    <h3 class="text-base font-semibold text-white">Database Transfer</h3>
                    <p class="text-xs text-gray-400 mt-0.5">Migrate your local SQLite data to a remote MySQL server</p>
                </div>
            </div>
            <button onclick="closeTelegramModal()" class="p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-all">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
        </div>
        <!-- Body -->
        <div class="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-5">
            <!-- Description -->
            <div class="bg-blue-500/5 border border-blue-500/10 rounded-xl p-4 flex items-start space-x-3">
                <svg class="w-5 h-5 text-blue-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                <div class="text-xs text-gray-300 leading-relaxed">
                    <p>Transfer all your accounts, chats, messages, media, and settings from the local database to a remote MySQL server. The transfer is <strong class="text-white">resumable</strong> — if interrupted, it will pick up where it left off.</p>
                </div>
            </div>
            <!-- Connection -->
            <div class="bg-dark-100/30 rounded-xl p-5 border border-white/5 space-y-4">
                <h4 class="text-xs font-semibold text-purple-400 uppercase tracking-wider">MySQL Connection</h4>
                <div class="flex items-center space-x-3">
                    <input type="text" id="transfer-db-url" placeholder="mysql+pymysql://user:pass@host:3306/dbname"
                           class="flex-1 px-3 py-2.5 bg-dark-300/50 border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500/50 font-mono">
                    <button onclick="testTransferConnection()" id="transfer-test-btn"
                            class="px-4 py-2.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white text-sm font-medium transition-all border border-white/10">
                        Test
                    </button>
                </div>
                <div id="transfer-conn-status" class="hidden text-sm"></div>
            </div>
            <!-- Actions -->
            <div class="flex items-center justify-between">
                <div class="text-sm text-gray-400" id="transfer-overall-label">No transfer in progress</div>
                <div class="flex items-center space-x-3">
                    <button onclick="cancelDbTransfer()" id="transfer-cancel-btn"
                            class="hidden px-4 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 text-sm font-medium transition-all border border-red-500/20">
                        Cancel
                    </button>
                    <button onclick="startDbTransfer()" id="transfer-start-btn"
                            class="px-5 py-2.5 rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 text-white text-sm font-semibold hover:opacity-90 transition-all shadow-lg shadow-purple-500/20">
                        Start Transfer
                    </button>
                </div>
            </div>
            <!-- Overall Progress -->
            <div class="bg-dark-100/30 rounded-xl p-5 border border-white/5 space-y-3">
                <div class="flex items-center justify-between text-xs text-gray-400">
                    <span>Overall Progress</span>
                    <span id="transfer-overall-pct">0%</span>
                </div>
                <div class="w-full h-3 bg-dark-400/50 rounded-full overflow-hidden">
                    <div id="transfer-overall-bar" class="h-full bg-gradient-to-r from-purple-500 to-pink-500 rounded-full transition-all duration-300" style="width:0%"></div>
                </div>
                <div id="transfer-overall-count" class="text-[11px] text-gray-500 text-right">0 / 0 rows</div>
            </div>
            <!-- Per-table Progress -->
            <div class="space-y-2" id="transfer-tables-area">
                <h4 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Tables</h4>
                <div id="transfer-tables-list" class="space-y-2">
                    <div class="text-sm text-gray-500 text-center py-4">Click "Start Transfer" to begin</div>
                </div>
            </div>
        </div>
    </div>`;

    container.innerHTML = '';
    container.appendChild(modal);
    loadTransferStatus();
}

let _transferPollingId = null;

eel.expose(on_transfer_progress);
function on_transfer_progress(data) {
    if (data.error) {
        showToast('Transfer error: ' + data.error, 'error');
        _stopTransferPolling();
        _setTransferButtons(false);
        return;
    }
    // Update overall bar
    const bar = document.getElementById('transfer-overall-bar');
    const pct = document.getElementById('transfer-overall-pct');
    const count = document.getElementById('transfer-overall-count');
    const label = document.getElementById('transfer-overall-label');
    if (bar) bar.style.width = data.overall_percent + '%';
    if (pct) pct.textContent = data.overall_percent + '%';
    if (count) count.textContent = `${data.overall_transferred.toLocaleString()} / ${data.overall_total.toLocaleString()} rows`;
    if (label) label.textContent = data.overall_percent >= 100 ? 'Transfer complete!' : 'Transferring...';

    // Update specific table row
    if (data.table) {
        const row = document.getElementById('tbl-' + data.table);
        if (row) {
            const rowBar = row.querySelector('.tbl-bar');
            const rowPct = row.querySelector('.tbl-pct');
            const rowCount = row.querySelector('.tbl-count');
            if (rowBar) rowBar.style.width = data.percent + '%';
            if (rowPct) rowPct.textContent = data.percent + '%';
            if (rowCount) rowCount.textContent = `${data.transferred.toLocaleString()} / ${data.total.toLocaleString()}`;
        }
    }

    if (data.overall_percent >= 100) {
        _stopTransferPolling();
        _setTransferButtons(false);
        showToast('Database transfer complete!', 'success');
    }
}

async function testTransferConnection() {
    const url = document.getElementById('transfer-db-url')?.value?.trim();
    if (!url) { showToast('Enter a database URL', 'warning'); return; }

    const btn = document.getElementById('transfer-test-btn');
    const status = document.getElementById('transfer-conn-status');
    if (btn) btn.disabled = true;
    if (status) { status.classList.remove('hidden'); status.innerHTML = '<span class="text-gray-400">Testing connection...</span>'; }

    try {
        const result = await eel.test_db_connection(url)();
        if (result.success) {
            if (status) status.innerHTML = '<span class="text-green-400">Connected successfully (' + (result.tables?.length || 0) + ' tables found)</span>';
        } else {
            if (status) status.innerHTML = '<span class="text-red-400">Failed: ' + escapeHtml(result.error || 'Unknown error') + '</span>';
        }
    } catch (e) {
        if (status) status.innerHTML = '<span class="text-red-400">Connection failed</span>';
    }
    if (btn) btn.disabled = false;
}

async function startDbTransfer() {
    const url = document.getElementById('transfer-db-url')?.value?.trim();
    if (!url) { showToast('Enter a database URL first', 'warning'); return; }

    try {
        const result = await eel.start_db_transfer(url)();
        if (result.success) {
            showToast('Transfer started!', 'info');
            _setTransferButtons(true);
            _startTransferPolling();
        } else {
            showToast(result.error || 'Failed to start transfer', 'error');
        }
    } catch (e) {
        showToast('Failed to start transfer', 'error');
    }
}

async function cancelDbTransfer() {
    try {
        await eel.cancel_db_transfer()();
        showToast('Transfer cancelling...', 'warning');
        _stopTransferPolling();
        _setTransferButtons(false);
    } catch (e) {}
}

async function loadTransferStatus() {
    try {
        const data = await eel.get_transfer_status()();
        if (!data || data.error) return;

        // Update overall
        const bar = document.getElementById('transfer-overall-bar');
        const pct = document.getElementById('transfer-overall-pct');
        const count = document.getElementById('transfer-overall-count');
        const label = document.getElementById('transfer-overall-label');
        if (bar) bar.style.width = data.overall_percent + '%';
        if (pct) pct.textContent = data.overall_percent + '%';
        if (count) count.textContent = `${data.transferred_rows.toLocaleString()} / ${data.total_rows.toLocaleString()} rows`;

        if (data.running) {
            if (label) label.textContent = 'Transferring...';
            _setTransferButtons(true);
            _startTransferPolling();
        } else if (data.overall_percent >= 100 && data.total_rows > 0) {
            if (label) label.textContent = 'Transfer complete!';
        } else if (data.tables && data.tables.some(t => t.status === 'in_progress' || t.status === 'pending')) {
            if (label) label.textContent = 'Transfer paused — click Start to resume';
            const btn = document.getElementById('transfer-start-btn');
            if (btn) btn.textContent = 'Resume Transfer';
        }

        // Render table rows
        renderTransferTables(data.tables || []);
    } catch (e) {}
}

function renderTransferTables(tables) {
    const list = document.getElementById('transfer-tables-list');
    if (!list) return;
    if (!tables.length) {
        list.innerHTML = '<div class="text-sm text-gray-500 text-center py-4">Click "Start Transfer" to begin</div>';
        return;
    }
    list.innerHTML = tables.map(t => {
        const statusColor = t.status === 'completed' ? 'text-green-400' :
                            t.status === 'in_progress' ? 'text-blue-400' :
                            t.status === 'failed' ? 'text-red-400' : 'text-gray-500';
        const barColor = t.status === 'completed' ? 'bg-green-500' :
                         t.status === 'failed' ? 'bg-red-500' : 'bg-purple-500';
        return `
        <div id="tbl-${t.table_name}" class="flex items-center space-x-3 bg-dark-100/20 rounded-lg px-3 py-2 border border-white/5">
            <span class="text-[11px] text-gray-300 w-48 truncate font-mono">${escapeHtml(t.table_name)}</span>
            <div class="flex-1 h-2 bg-dark-400/50 rounded-full overflow-hidden">
                <div class="tbl-bar h-full ${barColor} rounded-full transition-all duration-300" style="width:${t.percent}%"></div>
            </div>
            <span class="tbl-pct text-[11px] ${statusColor} w-12 text-right font-semibold">${t.percent}%</span>
            <span class="tbl-count text-[10px] text-gray-500 w-28 text-right">${t.transferred_rows.toLocaleString()} / ${t.total_rows.toLocaleString()}</span>
        </div>`;
    }).join('');
}

function _setTransferButtons(running) {
    const startBtn = document.getElementById('transfer-start-btn');
    const cancelBtn = document.getElementById('transfer-cancel-btn');
    if (startBtn) {
        startBtn.disabled = running;
        startBtn.classList.toggle('opacity-50', running);
        startBtn.classList.toggle('cursor-not-allowed', running);
        if (!running) startBtn.textContent = 'Start Transfer';
    }
    if (cancelBtn) cancelBtn.classList.toggle('hidden', !running);
}

function _startTransferPolling() {
    if (_transferPollingId) return;
    _transferPollingId = setInterval(loadTransferStatus, 2000);
}

function _stopTransferPolling() {
    if (_transferPollingId) { clearInterval(_transferPollingId); _transferPollingId = null; }
}


// ==================== LIVE LOGS ====================

let logPanelOpen = false;
let logAutoScroll = true;
let logEntries = [];
let logErrorCount = 0;
let logWarningCount = 0;

// Eel callback for real-time log entries
eel.expose(on_log_entry);
function on_log_entry(entry) {
    logEntries.push(entry);
    // Keep max 500 in JS
    if (logEntries.length > 500) logEntries.shift();

    if (entry.level === 'ERROR') logErrorCount++;
    if (entry.level === 'WARNING') logWarningCount++;

    updateLogCountBadges();
    appendLogEntry(entry);

    // Show error dot on toggle button when panel is closed
    if (!logPanelOpen && entry.level === 'ERROR') {
        const dot = document.getElementById('log-error-dot');
        if (dot) dot.classList.remove('hidden');
    }
}

function toggleLogPanel() {
    logPanelOpen = !logPanelOpen;
    const panel = document.getElementById('log-panel');
    const chevron = document.getElementById('log-chevron');
    const dot = document.getElementById('log-error-dot');

    if (logPanelOpen) {
        panel.classList.remove('translate-y-full');
        panel.classList.add('translate-y-0');
        if (chevron) chevron.style.transform = 'rotate(0deg)';
        if (dot) dot.classList.add('hidden');
        // Load historical logs on first open
        if (logEntries.length === 0) loadHistoricalLogs();
        if (logAutoScroll) scrollLogToBottom();
    } else {
        panel.classList.remove('translate-y-0');
        panel.classList.add('translate-y-full');
        if (chevron) chevron.style.transform = 'rotate(180deg)';
    }
}

async function loadHistoricalLogs() {
    try {
        const entries = await eel.get_recent_logs(200)();
        if (entries && entries.length) {
            logEntries = entries;
            logErrorCount = entries.filter(e => e.level === 'ERROR').length;
            logWarningCount = entries.filter(e => e.level === 'WARNING').length;
            updateLogCountBadges();
            renderAllLogs();
        }
    } catch (e) {
        console.error('Failed to load logs:', e);
    }
}

function appendLogEntry(entry) {
    const container = document.getElementById('log-entries');
    const empty = document.getElementById('log-empty');
    if (!container) return;
    if (empty) empty.classList.add('hidden');

    // Check filter
    if (!matchesLogFilter(entry)) return;

    const el = createLogElement(entry, true);
    container.appendChild(el);

    // Cap DOM entries at 300
    while (container.children.length > 300) {
        container.removeChild(container.firstChild);
    }

    if (logAutoScroll && logPanelOpen) scrollLogToBottom();
}

function createLogElement(entry, animate) {
    const div = document.createElement('div');
    const rowClass = `log-row-${entry.level}`;
    const animClass = animate ? ' log-entry-new' : '';
    div.className = `log-entry flex items-start space-x-2 py-0.5 px-1 rounded hover:bg-white/5 ${rowClass}${animClass}`;
    div.dataset.level = entry.level;

    const levelColors = {
        'ERROR': 'text-red-400 bg-red-500/10',
        'WARNING': 'text-yellow-400 bg-yellow-500/10',
        'INFO': 'text-blue-400 bg-blue-500/10',
        'DEBUG': 'text-gray-500 bg-gray-500/10',
    };
    const color = levelColors[entry.level] || levelColors['INFO'];

    div.innerHTML = `
        <span class="text-gray-600 shrink-0">${escapeHtml(entry.timestamp)}</span>
        <span class="px-1 rounded text-[10px] font-semibold shrink-0 ${color}">${entry.level.substring(0, 4)}</span>
        <span class="text-gray-500 shrink-0 max-w-[120px] truncate">${escapeHtml(entry.logger)}</span>
        <span class="text-gray-300 break-all">${escapeHtml(entry.message)}</span>
    `;
    return div;
}

function renderAllLogs() {
    const container = document.getElementById('log-entries');
    const empty = document.getElementById('log-empty');
    if (!container) return;
    container.innerHTML = '';

    const filtered = logEntries.filter(matchesLogFilter);
    if (filtered.length === 0) {
        if (empty) empty.classList.remove('hidden');
        return;
    }
    if (empty) empty.classList.add('hidden');

    const frag = document.createDocumentFragment();
    // Only render last 300
    const toRender = filtered.slice(-300);
    for (const entry of toRender) {
        frag.appendChild(createLogElement(entry));
    }
    container.appendChild(frag);

    if (logAutoScroll) scrollLogToBottom();
}

function matchesLogFilter(entry) {
    const levelFilter = document.getElementById('log-level-filter')?.value || 'all';
    const searchFilter = (document.getElementById('log-search')?.value || '').toLowerCase();

    if (levelFilter !== 'all' && entry.level !== levelFilter) return false;
    if (searchFilter && !entry.message.toLowerCase().includes(searchFilter) &&
        !entry.logger.toLowerCase().includes(searchFilter)) return false;
    return true;
}

function filterLogs() {
    renderAllLogs();
}

function scrollLogToBottom() {
    const content = document.getElementById('log-content');
    if (content) {
        requestAnimationFrame(() => { content.scrollTop = content.scrollHeight; });
    }
}

function toggleLogAutoScroll() {
    logAutoScroll = !logAutoScroll;
    const btn = document.getElementById('log-autoscroll-btn');
    if (btn) {
        btn.className = logAutoScroll
            ? 'p-1.5 rounded-lg bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-all'
            : 'p-1.5 rounded-lg bg-white/5 text-gray-500 hover:bg-white/10 transition-all';
    }
    if (logAutoScroll) scrollLogToBottom();
}

async function clearLogs() {
    try {
        await eel.clear_logs()();
    } catch (e) {}
    logEntries = [];
    logErrorCount = 0;
    logWarningCount = 0;
    updateLogCountBadges();
    const container = document.getElementById('log-entries');
    const empty = document.getElementById('log-empty');
    if (container) container.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
}

function updateLogCountBadges() {
    const badge = document.getElementById('log-count-badge');
    const errSpan = document.getElementById('log-error-count');
    const warnSpan = document.getElementById('log-warning-count');

    if (badge) badge.textContent = logEntries.length;
    if (errSpan) {
        if (logErrorCount > 0) {
            errSpan.textContent = `${logErrorCount} error${logErrorCount > 1 ? 's' : ''}`;
            errSpan.classList.remove('hidden');
        } else {
            errSpan.classList.add('hidden');
        }
    }
    if (warnSpan) {
        if (logWarningCount > 0) {
            warnSpan.textContent = `${logWarningCount} warning${logWarningCount > 1 ? 's' : ''}`;
            warnSpan.classList.remove('hidden');
        } else {
            warnSpan.classList.add('hidden');
        }
    }
}


// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', () => {
    loadAccounts();

    // Refresh accounts every 30 seconds
    setInterval(loadAccounts, 30000);

    // Poll listener health every 30 seconds
    pollListenerHealth();
    setInterval(pollListenerHealth, 30000);

    // Auto-refresh analytics every 60 seconds if open
    setInterval(() => { if (analyticsOpen) loadAnalytics(); }, 60000);

    // Load historical logs on startup
    loadHistoricalLogs();
});
