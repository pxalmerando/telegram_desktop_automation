/**
 * Modern Toast Notification System
 */
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');

    const styles = {
        success: {
            bg: 'from-green-500 to-emerald-600',
            icon: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>'
        },
        error: {
            bg: 'from-red-500 to-rose-600',
            icon: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>'
        },
        warning: {
            bg: 'from-yellow-500 to-orange-500',
            icon: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>'
        },
        info: {
            bg: 'from-purple-500 to-pink-500',
            icon: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>'
        }
    };

    const style = styles[type] || styles.info;

    toast.className = 'toast-enter';
    toast.innerHTML = `
        <div class="flex items-center p-4 bg-gradient-to-r ${style.bg} rounded-xl shadow-2xl backdrop-blur-xl border border-white/10">
            <div class="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center mr-3">
                ${style.icon}
            </div>
            <span class="text-white font-medium flex-1">${message}</span>
            <button class="ml-4 p-1 rounded-lg hover:bg-white/20 transition-colors" onclick="this.closest('.toast-enter, .toast-exit').remove()">
                <svg class="w-4 h-4 text-white/70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        </div>
    `;

    container.appendChild(toast);

    // Auto remove after 4 seconds
    setTimeout(() => {
        toast.classList.remove('toast-enter');
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}

/**
 * Modern Modal System
 */
function showModal(title, content, actions = []) {
    const container = document.getElementById('modal-container');

    const actionsHtml = actions.map(action => `
        <button class="px-5 py-2.5 rounded-xl font-medium transition-all ${action.class || 'bg-white/10 hover:bg-white/20 text-white'}"
                onclick="${action.onclick}">
            ${action.label}
        </button>
    `).join('');

    container.innerHTML = `
        <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onclick="closeModal(event)">
            <div class="bg-dark-200/90 backdrop-blur-xl rounded-2xl w-full max-w-md border border-white/10 shadow-2xl" onclick="event.stopPropagation()">
                <div class="flex items-center justify-between px-6 py-4 border-b border-white/5">
                    <h3 class="text-lg font-semibold text-white">${title}</h3>
                    <button onclick="closeModal()" class="p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-all">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
                <div class="p-6">
                    ${content}
                </div>
                ${actions.length > 0 ? `
                    <div class="flex justify-end space-x-3 px-6 py-4 border-t border-white/5">
                        ${actionsHtml}
                    </div>
                ` : ''}
            </div>
        </div>
    `;
}

function closeModal(event) {
    if (!event || event.target === event.currentTarget) {
        document.getElementById('modal-container').innerHTML = '';
    }
}

/**
 * Confirm Dialog
 */
function confirmDialog(message) {
    return new Promise((resolve) => {
        showModal('Confirm Action', `<p class="text-gray-300">${message}</p>`, [
            {
                label: 'Cancel',
                class: 'bg-white/10 hover:bg-white/20 text-white',
                onclick: 'closeModal(); window._confirmResolve(false)'
            },
            {
                label: 'Confirm',
                class: 'bg-gradient-to-r from-red-500 to-rose-600 text-white shadow-lg shadow-red-500/25',
                onclick: 'closeModal(); window._confirmResolve(true)'
            }
        ]);
        window._confirmResolve = resolve;
    });
}

/**
 * Format utilities
 */
function formatDate(dateString) {
    return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Keyboard shortcuts
 */
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeModal();
    }
});

/**
 * Page transition effect
 */
document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('loaded');

    // Add smooth page load animation
    const main = document.querySelector('main');
    if (main) {
        main.style.opacity = '0';
        main.style.transform = 'translateY(10px)';
        setTimeout(() => {
            main.style.transition = 'all 0.5s cubic-bezier(0.16, 1, 0.3, 1)';
            main.style.opacity = '1';
            main.style.transform = 'translateY(0)';
        }, 100);
    }
});

/**
 * Ripple effect for buttons
 */
document.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (button && !button.classList.contains('no-ripple')) {
        const ripple = document.createElement('span');
        const rect = button.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        const x = e.clientX - rect.left - size / 2;
        const y = e.clientY - rect.top - size / 2;

        ripple.style.cssText = `
            position: absolute;
            width: ${size}px;
            height: ${size}px;
            left: ${x}px;
            top: ${y}px;
            background: rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            transform: scale(0);
            animation: ripple 0.6s ease-out;
            pointer-events: none;
        `;

        button.style.position = 'relative';
        button.style.overflow = 'hidden';
        button.appendChild(ripple);

        setTimeout(() => ripple.remove(), 600);
    }
});

// Add ripple animation
const _rippleStyle = document.createElement('style');
_rippleStyle.textContent = `
    @keyframes ripple {
        to {
            transform: scale(4);
            opacity: 0;
        }
    }
`;
document.head.appendChild(_rippleStyle);
