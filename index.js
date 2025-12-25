// ==========================================
// AutoRefiner v15.0 - 静默后台版
// ==========================================

let eventSource, saveChat, reloadCurrentChat, getContext;
let Generate, sendMessageAsUser; // 核心发送函数

// 动态导入
(async () => {
    try {
        const script = await import('../../../../script.js');
        const ext = await import('../../../extensions.js');
        eventSource = script.eventSource;
        saveChat = script.saveChat;
        reloadCurrentChat = script.reloadCurrentChat;
        Generate = script.Generate;
        getContext = ext.getContext;
        init();
    } catch (e) {
        try {
            const script = await import('../../../script.js');
            const ext = await import('../../extensions.js');
            eventSource = script.eventSource;
            saveChat = script.saveChat;
            reloadCurrentChat = script.reloadCurrentChat;
            Generate = script.Generate;
            getContext = ext.getContext;
            init();
        } catch (e2) {
            console.error('[AutoRefiner] Failed to load:', e2);
        }
    }
})();

// ==========================================
// 1. 常量
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
// 2. 状态
// ==========================================
let globalTxId = 0;        
let lastStopTimestamp = 0;
let isCurrentlyProcessing = false;

// ==========================================
// 3. 工具函数
// ==========================================
const logger = {
    info: (msg) => console.log(`%c${LOG_PREFIX} ${msg}`, 'color: #03a9f4'),
    warn: (msg) => console.warn(`${LOG_PREFIX} ${msg}`),
    error: (msg) => console.error(`${LOG_PREFIX} ${msg}`),
    step: (msg) => console.log(`%c${LOG_PREFIX} ${msg}`, 'color: #8bc34a; font-weight: bold;')
};

function getSettings() {
    const context = getContext();
    if (!context.extensionSettings) context.extensionSettings = {};
    if (!context.extensionSettings[SETTING_KEY]) {
        context.extensionSettings[SETTING_KEY] = { ...DEFAULT_SETTINGS };
    }
    const s = context.extensionSettings[SETTING_KEY];
    s.minLength ??= 15;
    s.showQuickToggle ??= false;
    s.prompt ??= DEFAULT_SETTINGS.prompt;
    s.enabled ??= false;
    return s;
}

function savePluginSettings() {
    getContext()?.saveSettingsDebounced?.();
}

function killTransaction(reason) {
    globalTxId++;
    isCurrentlyProcessing = false;
    logger.warn(`Reset: ${reason}`);
}

// ==========================================
// 4. 静默发送 (核心)
// ==========================================
async function sendSilently(message) {
    const ctx = getContext();
    const chat = ctx?.chat;
    
    if (!chat) {
        logger.error('Chat not available');
        return false;
    }

    try {
        // 方法1: 直接写入历史并触发生成
        chat.push({
            name: ctx.name1,        // 用户名
            is_user: true,
            mes: message,
            send_date: Date.now()
        });

        await saveChat();
        
        logger.step('Message injected. Triggering generation...');
        
        // 触发 AI 回复
        if (typeof Generate === 'function') {
            await Generate('normal');
        } else {
            // 备选：使用 jQuery 触发
            $('#send_but').trigger('click');
        }
        
        return true;
    } catch (e) {
        logger.error('Silent send failed: ' + e.message);
        return false;
    }
}

// ==========================================
// 5. 核心逻辑
// ==========================================
async function handleGenerationEnded() {
    const settings = getSettings();
    
    if (!settings.enabled) return;
    if (!isQuickToggleActive()) return;
    if (isCurrentlyProcessing) return;
    if (Date.now() - lastStopTimestamp < 2000) return;

    const currentTxId = ++globalTxId;
    
    // 短暂等待
    await new Promise(r => setTimeout(r, 300));
    
    if (currentTxId !== globalTxId) return;
    
    const ctx = getContext();
    const liveChat = ctx?.chat;
    
    if (!liveChat?.length || liveChat.length < 2) return;

    const lastMsg = liveChat[liveChat.length - 1];     
    const prevMsg = liveChat[liveChat.length - 2];     

    if (lastMsg.is_user) return;

    const hasMarker = prevMsg.is_user && prevMsg.mes.includes('<!--AR-->');

    // === Phase 1: 发起精修 ===
    if (!hasMarker) {
        if (!prevMsg.is_user) return;

        if (lastMsg.mes.trim().length < settings.minLength) {
            logger.warn(`Too short. Skip.`);
            return;
        }

        isCurrentlyProcessing = true;
        logger.step('Starting refinement (silent)...');

        const prompt = REFINE_MARKER + settings.prompt;
        await sendSilently(prompt);
    }
    
    // === Phase 2: 合并 ===
    else {
        if (liveChat.length < 3) {
            isCurrentlyProcessing = false;
            return;
        }

        const originalDraft = liveChat[liveChat.length - 3];
        const refinedDraft = liveChat[liveChat.length - 1];

        if (refinedDraft.mes.trim().length < settings.minLength) {
            logger.error('Refined too short.');
            toastr.warning('精修版过短', MODULE_NAME);
            isCurrentlyProcessing = false;
            return;
        }

        try {
            logger.step('Merging...');
            originalDraft.mes = refinedDraft.mes;
            liveChat.splice(liveChat.length - 2, 2);
            await saveChat();
            await reloadCurrentChat();
            logger.info('Done.');
            toastr.success('✨ 已合并', MODULE_NAME);
        } catch (e) {
            logger.error('Merge failed: ' + e.message);
        } finally {
            isCurrentlyProcessing = false;
        }
    }
}

// ==========================================
// 6. 快捷按钮
// ==========================================
function updateQuickButtonVisibility() {
    const settings = getSettings();
    const btn = $('#auto_refiner_quick_btn');
    btn.toggle(settings.showQuickToggle && settings.enabled);
}

function isQuickToggleActive() {
    const settings = getSettings();
    if (!settings.showQuickToggle) return true;
    return $('#auto_refiner_quick_btn').hasClass('active');
}

// ==========================================
// 7. 样式
// ==========================================
function injectStyles() {
    if ($('#auto-refiner-style').length) return;
    $('head').append(`
        <style id="auto-refiner-style">
            #auto_refiner_quick_btn {
                display: none;
                align-items: center;
                justify-content: center;
                width: 30px;
                cursor: pointer;
                margin-right: 5px;
                font-size: 1.2em;
                opacity: 0.3;
                transition: 0.3s;
            }
            #auto_refiner_quick_btn:hover { opacity: 0.7; }
            #auto_refiner_quick_btn.active {
                opacity: 1;
                color: #00bcd4;
                text-shadow: 0 0 8px rgba(0,188,212,0.6);
            }
        </style>
    `);
}

// ==========================================
// 8. 初始化
// ==========================================
function init() {
    if (!eventSource) return;

    eventSource.on('chat_id_changed', () => killTransaction('Chat Switched'));
    eventSource.on('character_loaded', () => killTransaction('Character'));
    eventSource.on('generation_stopped', () => {
        lastStopTimestamp = Date.now();
        killTransaction('Stopped');
    });
    eventSource.on('generation_ended', handleGenerationEnded);

    jQuery(() => {
        injectStyles();
        
        if (!$('#auto_refiner_quick_btn').length) {
            $('#send_but').before(`
                <div id="auto_refiner_quick_btn" class="fa-solid fa-wand-magic-sparkles active" title="Auto Refiner"></div>
            `);
            $('#auto_refiner_quick_btn').on('click', function() {
                $(this).toggleClass('active');
                toastr.info($(this).hasClass('active') ? '开启' : '暂停', MODULE_NAME);
            });
        }

        const settings = getSettings();
        if (!$('.auto-refiner-settings').length) {
            $('#extensions_settings').append(`
                <div class="auto-refiner-settings">
                    <div class="inline-drawer">
                        <div class="inline-drawer-toggle inline-drawer-header">
                            <b>Auto Refiner</b>
                            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                        </div>
                        <div class="inline-drawer-content" style="font-size:small;">
                            <label class="checkbox_label"><input type="checkbox" id="auto_refiner_enable" /> 启用</label><br>
                            <label class="checkbox_label"><input type="checkbox" id="auto_refiner_show_quick" /> 显示快捷开关</label>
                            <div style="margin-top:5px;">最低字数: <input type="number" id="auto_refiner_min_length" style="width:50px;" min="0" /></div>
                            <div style="margin-top:5px;"><label>提示词:</label><textarea id="auto_refiner_prompt" rows="3" class="text_pole" style="width:100%"></textarea></div>
                            <small style="opacity:0.5;">v15.0 Silent</small>
                        </div>
                    </div>
                </div>
            `);
            
            $('#auto_refiner_enable').prop('checked', settings.enabled).on('change', function() {
                settings.enabled = this.checked;
                savePluginSettings();
                updateQuickButtonVisibility();
            });
            $('#auto_refiner_show_quick').prop('checked', settings.showQuickToggle).on('change', function() {
                settings.showQuickToggle = this.checked;
                savePluginSettings();
                updateQuickButtonVisibility();
            });
            $('#auto_refiner_min_length').val(settings.minLength).on('input', function() {
                settings.minLength = parseInt(this.value) || 0;
                savePluginSettings();
            });
            $('#auto_refiner_prompt').val(settings.prompt).on('input', function() {
                settings.prompt = this.value;
                savePluginSettings();
            });
        }

        updateQuickButtonVisibility();
        console.log(`${LOG_PREFIX} v15.0 Silent Mode Ready`);
    });
}
