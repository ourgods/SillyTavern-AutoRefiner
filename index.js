// ==========================================
// AutoRefiner v13.0 - 兼容 third-party 安装
// ==========================================

// 动态导入，兼容两种安装路径
let eventSource, saveChat, reloadCurrentChat, chat, getContext;

// 尝试 third-party 路径
try {
    const script = await import('../../../../script.js');
    const ext = await import('../../../extensions.js');
    eventSource = script.eventSource;
    saveChat = script.saveChat;
    reloadCurrentChat = script.reloadCurrentChat;
    chat = script.chat;
    getContext = ext.getContext;
} catch (e) {
    // 回退到直接安装路径
    try {
        const script = await import('../../../script.js');
        const ext = await import('../../extensions.js');
        eventSource = script.eventSource;
        saveChat = script.saveChat;
        reloadCurrentChat = script.reloadCurrentChat;
        chat = script.chat;
        getContext = ext.getContext;
    } catch (e2) {
        console.error('[AutoRefiner] Failed to load dependencies:', e2);
    }
}

// ==========================================
// 1. 常量与配置
// ==========================================
const MODULE_NAME = 'AutoRefiner';
const LOG_PREFIX = `[${MODULE_NAME}]`;
const SETTING_KEY = 'auto_refiner'; 
const REFINE_MARKER = "\u200B<!--AR-->\u200B"; 

const DEFAULT_SETTINGS = {
    enabled: false,
    showQuickToggle: true,
    prompt: "请反思刚才的回答，指出其中的逻辑漏洞或不符合设定的地方，并给出一个更完美的修正版。",
    minLength: 15 
};

// ==========================================
// 2. 状态管理
// ==========================================
let globalTxId = 0;        
let lastStopTimestamp = 0;
let isCurrentlyProcessing = false;

// ==========================================
// 3. 日志工具
// ==========================================
const logger = {
    info: (msg) => console.log(`%c${LOG_PREFIX} [INFO] ${msg}`, 'color: #03a9f4'),
    warn: (msg) => console.warn(`${LOG_PREFIX} [WARN] ${msg}`),
    error: (msg) => console.error(`${LOG_PREFIX} [ERROR] ${msg}`),
    step: (msg) => console.log(`%c${LOG_PREFIX} [STEP] ${msg}`, 'color: #8bc34a; font-weight: bold;')
};

// ==========================================
// 4. 设置管理
// ==========================================
function getSettings() {
    const context = getContext();
    if (!context.extensionSettings) {
        context.extensionSettings = {};
    }
    if (!context.extensionSettings[SETTING_KEY]) {
        context.extensionSettings[SETTING_KEY] = { ...DEFAULT_SETTINGS };
    }
    const s = context.extensionSettings[SETTING_KEY];
    if (typeof s.minLength === 'undefined') s.minLength = 15;
    if (typeof s.showQuickToggle === 'undefined') s.showQuickToggle = false;
    if (typeof s.prompt === 'undefined') s.prompt = DEFAULT_SETTINGS.prompt;
    if (typeof s.enabled === 'undefined') s.enabled = false;
    return s;
}

function savePluginSettings() {
    const context = getContext();
    if (context && typeof context.saveSettingsDebounced === 'function') {
        context.saveSettingsDebounced();
    }
}

// ==========================================
// 5. 快捷按钮逻辑
// ==========================================
function updateQuickButtonVisibility() {
    const settings = getSettings();
    const btn = $('#auto_refiner_quick_btn');
    
    if (!settings.showQuickToggle || !settings.enabled) {
        btn.hide();
    } else {
        btn.css('display', 'flex');
    }
}

function isQuickToggleActive() {
    const settings = getSettings();
    if (!settings.showQuickToggle) return true;
    
    const btn = document.getElementById('auto_refiner_quick_btn');
    if (btn && btn.classList.contains('active')) return true;
    
    return false;
}

// ==========================================
// 6. 生命周期监听
// ==========================================
function killTransaction(reason) {
    globalTxId++;
    isCurrentlyProcessing = false;
    logger.warn(`Context changed (${reason}). TxId: ${globalTxId}.`);
}

function initEventListeners() {
    if (!eventSource) {
        logger.error('eventSource not available!');
        return;
    }

    eventSource.on('chat_id_changed', () => killTransaction('Chat Switched'));
    eventSource.on('character_loaded', () => killTransaction('Character Loaded'));
    eventSource.on('generation_stopped', () => {
        lastStopTimestamp = Date.now();
        killTransaction('User Clicked Stop');
    });

    eventSource.on('generation_started', () => {
        if (isCurrentlyProcessing) {
            logger.warn('New generation started while processing. Resetting lock.');
            isCurrentlyProcessing = false;
        }
    });

    eventSource.on('generation_ended', handleGenerationEnded);
    
    logger.info('Event listeners initialized.');
}

// ==========================================
// 7. 核心逻辑
// ==========================================
async function handleGenerationEnded() {
    const settings = getSettings();
    
    if (!settings.enabled) return;
    if (!isQuickToggleActive()) return;
    
    if (isCurrentlyProcessing) {
        logger.info('Already processing. Skipping.');
        return;
    }
    
    if (Date.now() - lastStopTimestamp < 2000) {
        logger.warn('Blocked: User stopped recently.');
        return;
    }

    const currentTaskTxId = ++globalTxId;
    
    setTimeout(async () => {
        if (currentTaskTxId !== globalTxId) return; 
        if (Date.now() - lastStopTimestamp < 2000) return;
        
        const ctx = getContext();
        const liveChat = ctx.chat;
        
        if (!liveChat || !Array.isArray(liveChat) || liveChat.length < 2) return;

        const lastMsg = liveChat[liveChat.length - 1];     
        const prevMsg = liveChat[liveChat.length - 2];     

        if (lastMsg.is_user) return;

        const hasMarker = prevMsg.is_user && prevMsg.mes.includes('<!--AR-->');

        // === Phase 1: 初稿 ===
        if (!hasMarker) {
            if (!prevMsg.is_user) return;

            const cleanText = lastMsg.mes.trim();
            if (cleanText.length < settings.minLength) {
                logger.warn(`Too short (${cleanText.length}). Skipping.`);
                return;
            }

            isCurrentlyProcessing = true;
            logger.step(`Initiating Refinement...`);

            const textarea = document.getElementById('send_textarea');
            if (!textarea) {
                isCurrentlyProcessing = false;
                return;
            }

            textarea.value = REFINE_MARKER + settings.prompt;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            
            clickSendButtonSafe(currentTaskTxId);
        }
        
        // === Phase 2: 合并 ===
        else {
            if (liveChat.length < 3) {
                isCurrentlyProcessing = false;
                return;
            }

            const originalDraft = liveChat[liveChat.length - 3];
            const instructionMsg = liveChat[liveChat.length - 2];
            const refinedDraft = liveChat[liveChat.length - 1];

            if (liveChat[liveChat.length - 1] !== refinedDraft || 
                liveChat[liveChat.length - 2] !== instructionMsg ||
                liveChat[liveChat.length - 3] !== originalDraft) {
                logger.error('Integrity Check Failed.');
                isCurrentlyProcessing = false;
                return;
            }

            if (refinedDraft.mes.trim().length < settings.minLength) {
                logger.error('Refined too short. Aborting.');
                toastr.warning('精修版过短，已放弃', MODULE_NAME);
                isCurrentlyProcessing = false;
                return;
            }

            try {
                logger.step('Merging...');
                
                const finalCheck = getContext().chat;
                if (finalCheck[finalCheck.length - 1] !== refinedDraft) {
                    throw new Error('Chat modified during merge');
                }
                
                originalDraft.mes = refinedDraft.mes;
                finalCheck.splice(finalCheck.length - 2, 2);
                
                await saveChat();
                await reloadCurrentChat();
                
                logger.info('Merge done.');
                toastr.success('✨ 已精修合并', MODULE_NAME);
            } catch (e) {
                logger.error('Merge failed: ' + e.message);
                toastr.error('合并失败', MODULE_NAME);
            } finally {
                isCurrentlyProcessing = false;
            }
        }
    }, 800);
}

// ==========================================
// 8. 点击器
// ==========================================
function clickSendButtonSafe(txId, attempt = 0) {
    if (txId !== globalTxId) {
        isCurrentlyProcessing = false;
        return;
    }
    if (attempt > 20) {
        isCurrentlyProcessing = false;
        logger.error('Send button timeout.');
        return;
    }

    const btn = document.getElementById('send_but');
    if (btn && !btn.disabled && btn.offsetParent !== null) {
        btn.click();
    } else {
        setTimeout(() => clickSendButtonSafe(txId, attempt + 1), 50);
    }
}

// ==========================================
// 9. 样式注入
// ==========================================
function injectStyles() {
    if ($('#auto-refiner-style').length > 0) return;
    $('head').append(`
        <style id="auto-refiner-style">
            #auto_refiner_quick_btn {
                width: 30px;
                height: 100%;
                display: none;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                margin-right: 5px;
                font-size: 1.2em;
                opacity: 0.3;
                transition: all 0.3s ease;
                color: var(--SmartThemeBodyColor, #ccc);
            }
            #auto_refiner_quick_btn:hover {
                opacity: 0.7;
            }
            #auto_refiner_quick_btn.active {
                opacity: 1;
                color: #00bcd4;
                text-shadow: 0 0 8px rgba(0,188,212,0.6);
            }
        </style>
    `);
}

// ==========================================
// 10. 初始化
// ==========================================
jQuery(async () => {
    // 初始化事件监听
    initEventListeners();
    
    injectStyles();
    
    if ($('#auto_refiner_quick_btn').length === 0) {
        const btnHtml = `<div id="auto_refiner_quick_btn" class="fa-solid fa-wand-magic-sparkles active" title="Auto Refiner: ON"></div>`;
        const sendBtn = $('#send_but');
        if (sendBtn.length) {
            sendBtn.before(btnHtml);
            
            $('#auto_refiner_quick_btn').on('click', function() {
                $(this).toggleClass('active');
                const isActive = $(this).hasClass('active');
                $(this).attr('title', isActive ? 'Auto Refiner: ON' : 'Auto Refiner: PAUSED');
                toastr.info(isActive ? '临时开启' : '临时关闭', MODULE_NAME);
            });
        }
    }

    const settings = getSettings();
    
    if ($('#extensions_settings').find('.auto-refiner-settings').length === 0) {
        const templateHtml = `
        <div class="auto-refiner-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Auto Refiner</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content" style="font-size:small;">
                    <div class="flex-container">
                        <label class="checkbox_label">
                            <input type="checkbox" id="auto_refiner_enable" />
                            启用插件
                        </label>
                    </div>
                    
                    <div class="flex-container">
                        <label class="checkbox_label">
                            <input type="checkbox" id="auto_refiner_show_quick" />
                            显示临时开关
                        </label>
                    </div>

                    <div class="flex-container" style="margin-top:5px; align-items:center;">
                        <span style="flex:1;">最低字数:</span>
                        <input type="number" id="auto_refiner_min_length" style="width:60px;" min="0" />
                    </div>
                    
                    <div style="margin-top:5px;">
                        <label>精修提示词:</label>
                        <textarea id="auto_refiner_prompt" rows="3" class="text_pole" style="width:100%"></textarea>
                    </div>
                    
                    <hr style="margin:10px 0; opacity:0.3;">
                    <small style="opacity:0.6;">v13.0</small>
                </div>
            </div>
        </div>
        `;

        $('#extensions_settings').append(templateHtml);
        
        $('#auto_refiner_enable').prop('checked', settings.enabled).on('change', function() {
            settings.enabled = $(this).is(':checked');
            savePluginSettings();
            updateQuickButtonVisibility();
        });

        $('#auto_refiner_show_quick').prop('checked', settings.showQuickToggle).on('change', function() {
            settings.showQuickToggle = $(this).is(':checked');
            savePluginSettings();
            updateQuickButtonVisibility();
        });

        $('#auto_refiner_min_length').val(settings.minLength).on('input', function() {
            settings.minLength = parseInt($(this).val()) || 0;
            savePluginSettings();
        });

        $('#auto_refiner_prompt').val(settings.prompt).on('input', function() {
            settings.prompt = $(this).val();
            savePluginSettings();
        });
    }

    updateQuickButtonVisibility();
    
    console.log(`${LOG_PREFIX} v13.0 Loaded.`);
});
