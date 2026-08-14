import {
    extension_prompt_roles,
    extension_prompt_types,
    generateQuietPrompt,
    getRequestHeaders,
    saveSettingsDebounced,
    setExtensionPrompt,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { SECRET_KEYS, secret_state, writeSecret } from '../../../secrets.js';
import { getCurrentUserHandle } from '../../../user.js';
import { createWorldInfoEntry, getWorldInfoPrompt, loadWorldInfo, reloadEditor, saveWorldInfo } from '../../../world-info.js';

const MODULE_NAME = 'fandom_canon_retriever';
const PROMPT_KEY = 'fandom_canon_reference';
const PANEL_ID = 'fandom-canon-settings';
const QUICK_BUTTON_ID = 'fandom-canon-quick-button';
const MENU_ENTRY_ID = 'fandom-canon-menu-entry';
const LOCAL_CREDENTIAL_PREFIX = 'sillytavern-fandom-canon-retriever';
const WORLD_ENTRY_PREFIX = '【同人原作资料库·插件自动维护】';
const EXTENSION_VERSION = '2.1.5';
const DEFAULTS = {
    enabled: true,
    language: 'zh',
    autoPlanner: true,
    autoUpdateProfile: true,
    strictMode: true,
    maxQueries: 3,
    pagesPerQuery: 2,
    cacheMinutes: 360,
    searchWaitSeconds: 15,
    maxPageChars: 2600,
    searchProvider: 'wiki',
    searxngUrl: '',
    searchAiBaseUrl: '',
    searchAiModel: '',
    searchAiModels: [],
    searchAiProtocol: 'responses',
    sourceStrategy: 'auto',
    analysisSource: 'current',
    analysisBaseUrl: '',
    analysisModel: '',
    analysisModels: [],
    profiles: {},
    cache: {},
};

let busy = false;
let lastReport = { status: '尚未检索', queries: [], sources: [], at: 0 };
const inFlightResearch = new Map();

function settings() {
    extension_settings[MODULE_NAME] ??= structuredClone(DEFAULTS);
    const value = extension_settings[MODULE_NAME];
    for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
        value[key] ??= structuredClone(defaultValue);
    }
    return value;
}

function credentialStorageKey(kind) {
    return `${LOCAL_CREDENTIAL_PREFIX}:${getCurrentUserHandle()}:${kind}`;
}

function readLocalCredential(kind) {
    try {
        return String(localStorage.getItem(credentialStorageKey(kind)) || '');
    } catch (error) {
        console.warn('[Fandom Canon] Unable to read local credential.', error);
        return '';
    }
}

function writeLocalCredential(kind, value) {
    try {
        const key = credentialStorageKey(kind);
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
        return true;
    } catch (error) {
        console.error('[Fandom Canon] Unable to save local credential.', error);
        return false;
    }
}

function directApiHeaders(kind) {
    const key = readLocalCredential(kind);
    if (!key) throw new Error('尚未在此设备保存 API Key');
    return {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
}

function apiEndpoint(baseUrl, path) {
    return `${String(baseUrl).replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
}

async function directApiFetch(url, options, label) {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            const detail = (await response.text()).slice(0, 500);
            throw new Error(`${label}失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
        }
        return response;
    } catch (error) {
        if (error instanceof TypeError) {
            throw new Error(`${label}无法从浏览器直连。请确认 API 使用 HTTPS，并允许浏览器跨域访问（CORS）；此插件不会要求修改酒馆服务器源码。`);
        }
        throw error;
    }
}

function customAuthorizationHeader(kind) {
    const key = readLocalCredential(kind);
    if (!key) throw new Error('尚未在此设备保存 API Key');
    return JSON.stringify({ Authorization: `Bearer ${key}` });
}

async function fetchModelsWithFallback(baseUrl, kind) {
    let directError = '';
    try {
        const response = await directApiFetch(apiEndpoint(baseUrl, 'models'), {
            method: 'GET',
            headers: directApiHeaders(kind),
        }, '读取模型');
        return await response.json();
    } catch (error) {
        directError = error?.message || String(error);
    }

    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: baseUrl,
            custom_include_headers: customAuthorizationHeader(kind),
        }),
    });
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`${directError}；酒馆通用代理也失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
    }
    return await response.json();
}

async function chatCompletionWithFallback(baseUrl, kind, body, label) {
    try {
        const response = await directApiFetch(apiEndpoint(baseUrl, 'chat/completions'), {
            method: 'POST',
            headers: directApiHeaders(kind),
            body: JSON.stringify(body),
        }, label);
        return await response.json();
    } catch (directError) {
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: baseUrl,
                custom_include_headers: customAuthorizationHeader(kind),
                custom_include_body: '',
                custom_exclude_body: '',
                ...body,
            }),
        });
        if (!response.ok) {
            const detail = (await response.text()).slice(0, 500);
            throw new Error(`${directError?.message || directError}；酒馆通用代理也失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
        }
        return await response.json();
    }
}

function currentCharacter() {
    const context = getContext();
    const characters = Array.isArray(context.characters) ? context.characters : [];
    const direct = characters[context.characterId];
    if (direct) return direct;

    const id = String(context.characterId ?? '');
    if (id) {
        const byId = characters.find(character => [character?.avatar, character?.name, character?.id]
            .some(value => String(value ?? '') === id));
        if (byId) return byId;
    }

    const lastCharacterMessage = [...(Array.isArray(context.chat) ? context.chat : [])]
        .reverse()
        .find(message => message && !message.is_user && !message.is_system);
    const avatar = String(lastCharacterMessage?.original_avatar || lastCharacterMessage?.force_avatar || '');
    const messageName = String(lastCharacterMessage?.name || context.name2 || '');
    return characters.find(character => (avatar && character?.avatar === avatar)
        || (messageName && character?.name === messageName)) ?? null;
}

function currentGroup() {
    const context = getContext();
    if (!context.groupId || !Array.isArray(context.groups)) return null;
    return context.groups.find(group => String(group?.id) === String(context.groupId)) ?? null;
}

function currentGroupCharacters() {
    const context = getContext();
    const group = currentGroup();
    if (!group || !Array.isArray(group.members)) return [];
    return group.members
        .map(member => context.characters?.find(character => character?.avatar === member))
        .filter(Boolean);
}

function currentTargetName() {
    const group = currentGroup();
    if (group) return `群聊：${group.name || group.id}`;
    return currentCharacter()?.name || '未识别到当前角色';
}

function profileKey() {
    const group = currentGroup();
    if (group) return `group:${group.id}`;
    const character = currentCharacter();
    return String(character?.avatar || character?.name || (getContext().characterId ?? 'global'));
}

function profile() {
    const all = settings().profiles;
    const key = profileKey();
    all[key] ??= {
        workTitle: '',
        timeline: '',
        entities: '',
        customWikiApi: '',
    };
    const cardProfile = all[key];
    // Existing profiles were produced by the automatic fill flow before
    // incremental tracking existed, so treat their current values as auto data.
    cardProfile.lastAutoWorkTitle ??= cardProfile.workTitle || '';
    cardProfile.lastAutoTimeline ??= cardProfile.timeline || '';
    cardProfile.lastAutoEntities ??= manualEntities(cardProfile.entities || '');
    return cardProfile;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function stripMarkup(value) {
    const node = document.createElement('div');
    node.innerHTML = String(value ?? '');
    return (node.textContent || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripWikiText(value) {
    return String(value ?? '')
        .slice(0, 24000)
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>|<ref\b[^>]*\/\s*>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1')
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        .replace(/\[(?:https?:\/\/\S+)\s+([^\]]+)\]/g, '$1')
        .replace(/'{2,}/g, '')
        .replace(/[{}]/g, ' ')
        .replace(/^\s*\|\s*/gm, '')
        .replace(/\s*=\s*/g, '：')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function clampInt(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function recentContext(chat) {
    return (Array.isArray(chat) ? chat : [])
        .filter(message => message?.mes)
        .slice(-7)
        .map(message => `${message.is_user ? '用户' : '角色'}：${stripMarkup(message.mes).slice(0, 1200)}`)
        .join('\n');
}

function characterCardContext() {
    const group = currentGroup();
    const characters = group ? currentGroupCharacters() : [currentCharacter()].filter(Boolean);
    if (!characters.length) return '';
    const cards = characters.slice(0, 8).map(character => {
        const data = character.data ?? character;
        return [
            `角色卡名：${character.name || data.name || ''}`,
            `简介：${stripMarkup(data.description || character.description || '').slice(0, 3000)}`,
            `性格：${stripMarkup(data.personality || character.personality || '').slice(0, 1600)}`,
            `场景：${stripMarkup(data.scenario || character.scenario || '').slice(0, 2200)}`,
            `首条消息：${stripMarkup(data.first_mes || character.first_mes || '').slice(0, 2200)}`,
            `创作者说明：${stripMarkup(data.creator_notes || character.creatorcomment || '').slice(0, 1800)}`,
            `角色深度设定：${stripMarkup(data.extensions?.depth_prompt?.prompt || '').slice(0, 1200)}`,
            `系统设定：${stripMarkup(data.system_prompt || '').slice(0, 1200)}`,
            `历史后指令：${stripMarkup(data.post_history_instructions || '').slice(0, 1000)}`,
        ].filter(Boolean).join('\n');
    });
    return [group ? `当前群聊：${group.name || group.id}` : '', ...cards].filter(Boolean).join('\n\n');
}

async function worldInfoContext(chat) {
    const context = getContext();
    const characters = currentGroup() ? currentGroupCharacters() : [currentCharacter()].filter(Boolean);
    const values = field => characters.map(character => {
        const data = character.data ?? character;
        return stripMarkup(field(data, character));
    }).filter(Boolean).join('\n');
    const chatForWorldInfo = (Array.isArray(chat) ? chat : [])
        .filter(message => message?.mes)
        .map(message => `${message.name || (message.is_user ? '用户' : '角色')}：${message.mes}`)
        .reverse();
    try {
        const result = await getWorldInfoPrompt(chatForWorldInfo, Number(context.maxContext) || 32768, true, {
            personaDescription: '',
            characterDescription: values(data => data.description || ''),
            characterPersonality: values(data => data.personality || ''),
            characterDepthPrompt: values(data => data.extensions?.depth_prompt?.prompt || ''),
            scenario: values(data => data.scenario || ''),
            creatorNotes: values((data, character) => data.creator_notes || character.creatorcomment || ''),
            trigger: 'normal',
        });
        const extraEntries = [
            ...(result.worldInfoExamples || []),
            ...(result.worldInfoDepth || []),
            ...(result.anBefore || []),
            ...(result.anAfter || []),
            ...Object.values(result.outletEntries || {}).flat(),
        ].map(entry => typeof entry === 'string' ? entry : entry?.content || '').filter(Boolean);
        const combined = [result.worldInfoString, ...extraEntries].filter(Boolean).join('\n\n')
            .replace(/<!-- FCR_CANON_DATABASE_V2 -->[\s\S]*?<!-- \/FCR_CANON_DATABASE_V2 -->/g, '');
        return stripMarkup(combined).slice(0, 18000);
    } catch (error) {
        console.warn('[Fandom Canon] Failed to read active World Info.', error);
        return '';
    }
}

async function researchContext(chat) {
    const card = characterCardContext();
    const active = await worldInfoContext(chat);
    return {
        card,
        // Only use SillyTavern's dry-run activation result. This preserves the
        // user's enabled/disabled state, keys, probability, character filters,
        // recursion and current-chat activation rules instead of reading a whole book.
        worldInfo: active,
        recent: recentContext(chat),
    };
}

function parseJsonObject(text) {
    const cleaned = String(text ?? '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
        return null;
    }
}

async function runJsonAnalysisPrompt(prompt, maxTokens = 1800) {
    let lastRaw = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        const budget = attempt === 0 ? maxTokens : Math.max(3200, maxTokens * 2);
        const retryInstruction = attempt === 0
            ? ''
            : '\n\n上一次回答被截断。请重新输出完整、紧凑的单行 JSON；必须闭合全部引号、数组和大括号，不要 Markdown。';
        lastRaw = await runAnalysisPrompt(prompt + retryInstruction, budget);
        const parsed = parseJsonObject(lastRaw);
        if (parsed) return parsed;
        console.warn('[Fandom Canon] Analysis JSON was incomplete; retrying with a larger output budget.', lastRaw.slice(-160));
    }
    throw new Error(`分析模型两次返回了不完整 JSON：${stripMarkup(lastRaw).slice(0, 220)}`);
}

function normalizeLlmBaseUrl(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return '';
    try {
        const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        url.search = '';
        url.hash = '';
        url.pathname = url.pathname
            .replace(/\/(?:models|chat\/completions|completions)\/?$/i, '')
            .replace(/\/$/, '');
        return url.toString().replace(/\/$/, '');
    } catch {
        return '';
    }
}

function llmBaseCandidates(input) {
    const base = normalizeLlmBaseUrl(input);
    if (!base) return [];
    const candidates = [base];
    const url = new URL(base);
    if (!/\/v\d+(?:beta)?$/i.test(url.pathname)) candidates.push(`${base}/v1`);
    return [...new Set(candidates)];
}

function extractAssistantContent(data) {
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(item => item?.text || item?.content || '').join('');
    return String(content ?? '');
}

async function callCustomAnalysis(baseUrl, model, prompt, maxTokens = 500) {
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        const tokenBudget = attempt === 0 ? maxTokens : Math.max(1600, maxTokens * 2);
        const data = await chatCompletionWithFallback(baseUrl, 'analysis', {
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: tokenBudget,
            max_completion_tokens: tokenBudget,
            stream: false,
        }, '分析 LLM 请求');
        const content = extractAssistantContent(data).trim();
        if (content) return content;
        lastError = `第 ${attempt + 1} 次请求返回空正文（可能被隐藏推理耗尽输出额度）`;
        console.warn('[Fandom Canon] Analysis model returned empty content; retrying with a larger output budget.', data?.choices?.[0]?.finish_reason);
    }
    throw new Error(`${lastError || '分析 LLM 返回了空内容'}；已自动扩大额度重试`);
}

async function runAnalysisPrompt(prompt, maxTokens = 500) {
    const config = settings();
    if (config.analysisSource !== 'custom') {
        return await generateQuietPrompt({
            quietPrompt: prompt,
            skipWIAN: true,
            responseLength: maxTokens,
            removeReasoning: true,
        });
    }
    if (!config.analysisBaseUrl || !config.analysisModel) {
        throw new Error('请先检测分析 LLM 并选择模型');
    }
    return await callCustomAnalysis(config.analysisBaseUrl, config.analysisModel, prompt, maxTokens);
}

async function detectAnalysisModels() {
    const config = settings();
    const rawBase = String($('#fcr-llm-url').val() ?? config.analysisBaseUrl).trim();
    const candidates = llmBaseCandidates(rawBase);
    if (!candidates.length) {
        toastr.warning('请填写有效的 LLM 地址。', '分析 LLM');
        return;
    }
    const keyValue = String($('#fcr-llm-key').val() ?? '').trim();
    if (keyValue && !writeLocalCredential('analysis', keyValue)) {
        toastr.error('无法把 LLM Key 保存到此设备浏览器。', '分析 LLM');
        return;
    }
    if (!readLocalCredential('analysis')) {
        toastr.warning('请先填写此设备使用的 LLM Key。', '分析 LLM');
        return;
    }
    $('#fcr-llm-key').val('');
    $('#fcr-llm-state').text('正在检测地址并读取模型…').removeClass('fcr-key-ok');
    let lastError = '';
    let discovered = null;
    for (const baseUrl of candidates) {
        try {
            const data = await fetchModelsWithFallback(baseUrl, 'analysis');
            const models = [...new Set((data?.data ?? data?.models ?? [])
                .map(model => typeof model === 'string' ? model : model?.id || model?.name)
                .filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
            if (!models.length) {
                lastError = '连接成功，但 /models 没有返回可选模型';
                continue;
            }
            const selectedModel = models.includes(config.analysisModel) ? config.analysisModel : models[0];
            discovered = { baseUrl, models, selectedModel };
            config.analysisBaseUrl = baseUrl;
            config.analysisModels = models;
            config.analysisModel = selectedModel;
            saveSettingsDebounced();
            $('#fcr-llm-url').val(baseUrl);
            renderAnalysisModels();
            $('#fcr-llm-state').text(`已读取 ${models.length} 个模型，正在验证 Key 与实际生成…`);
            const probe = await callCustomAnalysis(baseUrl, selectedModel, '只输出一行完整 JSON，不使用 Markdown：{"ok":true}', 1000);
            if (!/\S/.test(probe)) throw new Error('模型连接测试返回空内容');
            $('#fcr-llm-state').text(`实际生成验证成功，发现 ${models.length} 个模型`).addClass('fcr-key-ok');
            toastr.success(`Key 与实际生成均验证成功；已读取 ${models.length} 个模型。`, '分析 LLM');
            return;
        } catch (error) {
            lastError = error?.message || String(error);
        }
    }
    if (discovered) {
        config.analysisBaseUrl = discovered.baseUrl;
        config.analysisModels = discovered.models;
        config.analysisModel = discovered.selectedModel;
        saveSettingsDebounced();
        $('#fcr-llm-url').val(discovered.baseUrl);
        renderAnalysisModels();
        $('#fcr-llm-state').text(`已读取模型，但生成验证失败：${lastError}`).removeClass('fcr-key-ok');
        toastr.error(`${lastError}；模型列表已保留，可以重试。`, '分析 LLM 验证失败');
        return;
    }
    config.analysisModels = [];
    config.analysisModel = '';
    saveSettingsDebounced();
    renderAnalysisModels();
    $('#fcr-llm-state').text(`检测失败：${lastError || '无法访问模型接口'}`).removeClass('fcr-key-ok');
    toastr.error(lastError || '无法访问模型接口', '分析 LLM 检测失败');
}

async function detectSearchAiModels() {
    const config = settings();
    const rawBase = String($('#fcr-search-ai-url').val() ?? config.searchAiBaseUrl).trim();
    const candidates = llmBaseCandidates(rawBase);
    if (!candidates.length) {
        toastr.warning('请填写有效的搜索 AI 地址。', '自定义搜索 AI');
        return;
    }
    const keyValue = String($('#fcr-search-ai-key').val() ?? '').trim();
    if (keyValue && !writeLocalCredential('search-ai', keyValue)) {
        toastr.error('无法把搜索 AI Key 保存到此设备浏览器。', '自定义搜索 AI');
        return;
    }
    if (!readLocalCredential('search-ai')) {
        toastr.warning('请先填写此设备使用的搜索 AI Key。', '自定义搜索 AI');
        return;
    }
    $('#fcr-search-ai-key').val('');
    $('#fcr-search-ai-state').text('正在检测地址并读取模型…').removeClass('fcr-key-ok');
    let lastError = '';
    for (const baseUrl of candidates) {
        try {
            const data = await fetchModelsWithFallback(baseUrl, 'search-ai');
            const models = [...new Set((data?.data ?? data?.models ?? [])
                .map(model => typeof model === 'string' ? model : model?.id || model?.name)
                .filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
            if (!models.length) {
                lastError = '连接成功，但 /models 没有返回可选模型';
                continue;
            }
            config.searchAiBaseUrl = baseUrl;
            config.searchAiModels = models;
            if (!models.includes(config.searchAiModel)) config.searchAiModel = models[0];
            saveSettingsDebounced();
            $('#fcr-search-ai-url').val(baseUrl);
            renderSearchAiModels();
            $('#fcr-search-ai-state').text(`连接成功，发现 ${models.length} 个模型`).addClass('fcr-key-ok');
            toastr.success(`已读取 ${models.length} 个搜索模型，请在下拉框中选择。`, '自定义搜索 AI');
            return;
        } catch (error) {
            lastError = error?.message || String(error);
        }
    }
    config.searchAiModels = [];
    config.searchAiModel = '';
    saveSettingsDebounced();
    renderSearchAiModels();
    $('#fcr-search-ai-state').text(`检测失败：${lastError || '无法访问模型接口'}`).removeClass('fcr-key-ok');
    toastr.error(lastError || '无法访问模型接口', '搜索 AI 检测失败');
}

function manualEntities(value) {
    return String(value ?? '').split(/[，,、\n]/).map(normalizeEntityDisplay).filter(Boolean).slice(0, 40);
}

const GENERIC_RESEARCH_TERMS = new Set(['兄妹', '姐妹', '兄弟', '家人', '家庭', '角色', '人物', '主角', '配角', 'oc', '原创角色', '同人', '剧情', '故事', '冒险', '角色卡']);
const INVALID_ENTITY_PATTERNS = [/法定(?:饮酒|吸烟|成年|结婚)?年龄/i, /^\d{4}年.*趋势$/i, /^(?:法律|法规|规则|规定|年龄限制)$/i];
const ENTITY_NAME_VARIANTS = new Map(Object.entries({
    錦: '锦', 瀧: '泷', 澤: '泽', 邊: '边', 邉: '边', 齊: '齐', 齋: '斋', 國: '国', 戶: '户', 櫻: '樱', 條: '条',
    廣: '广', 髙: '高', 﨑: '崎', 龍: '龙', 鳳: '凤', 亞: '亚', 眞: '真', 榮: '荣', 優: '优', 結: '结',
    愛: '爱', 夢: '梦', 葉: '叶', 遙: '遥', 曉: '晓', 暁: '晓', 島: '岛', 門: '门', 風: '风', 雲: '云',
}));

function normalizeEntityDisplay(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[錦瀧澤邊邉齊齋國戶櫻條廣髙﨑龍鳳亞眞榮優結愛夢葉遙曉暁島門風雲]/g, character => ENTITY_NAME_VARIANTS.get(character) || character);
}

function canonicalEntityKey(value) {
    return normalizeEntityDisplay(value)
        .toLocaleLowerCase()
        .replace(/[\s·・•._\-—–,，、:：'"“”‘’()（）\[\]【】{}《》〈〉]/g, '');
}

function cleanDetectedEntities(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(String)
        .map(normalizeEntityDisplay)
        .filter(value => value.length >= 2
            && !GENERIC_RESEARCH_TERMS.has(value.toLowerCase())
            && !INVALID_ENTITY_PATTERNS.some(pattern => pattern.test(value))))]
        .slice(0, 40);
}

function cleanPlannedQueries(values, work = '') {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(String)
        .map(value => value.trim())
        .filter(Boolean)
        .filter(value => {
            const withoutWork = work ? value.replaceAll(work, '').trim() : value;
            return withoutWork.length >= 2 && !GENERIC_RESEARCH_TERMS.has(withoutWork.toLowerCase());
        }))];
}

function shouldAttachWorkTitle(work) {
    return Boolean(work) && !/(多作品|交叉|混合|跨作品)/i.test(work);
}

async function planQueries(chat) {
    const config = settings();
    const cardProfile = profile();
    const work = cardProfile.workTitle.trim();
    const visibleEntities = manualEntities(cardProfile.entities);
    const previousAutoEntities = cleanDetectedEntities(cardProfile.lastAutoEntities);
    const fixedEntities = visibleEntities.filter(entity => !previousAutoEntities.includes(entity));
    const fallbackEntities = [...new Set(visibleEntities.filter(Boolean))];
    const database = storedCanonEntities();
    const missingFallbackEntities = fallbackEntities.filter(entity => !database[entity]?.sources?.length);
    const fallbackQueries = missingFallbackEntities.map(name =>
        `${name} ${work} 原作完整角色档案：身份、年龄、外貌身材、典型穿着、性格行为逻辑、能力、重要经历、人际关系、说话风格`.trim());

    if (!config.autoPlanner) {
        return {
            work,
            timeline: cardProfile.timeline.trim(),
            entities: fallbackEntities,
            timelineChanged: false,
            queries: fallbackQueries,
        };
    }

    const source = await researchContext(chat);
    const plannerPrompt = `你是同人写作前的资料检索规划器。必须先阅读角色卡正文、世界书和最近剧情，再找出本轮续写真正需要外部核实的原作人物、地点、组织、事件或时间线节点。角色卡标题只是文件名，绝不能仅凭标题生成实体或搜索词。\n\n作品（当前表值）：${work || '未填写，请从正文判断'}\n当前时间线/AU节点（上轮表值）：${cardProfile.timeline || '未填写'}\n用户手动固定实体：${fixedEntities.join('、') || '无'}\n\n角色卡正文：\n${source.card || '未读取到'}\n\n本轮实际激活世界书：\n${source.worldInfo || '无'}\n\n最近剧情：\n${source.recent || '无'}\n\n只输出 JSON，不写解释：{"work":"有明确证据的原作名，否则沿用当前作品","storyType":"canon_timeline|au_timeline|original_world_with_fandom_characters|original_only|unknown","timeline":"当前剧情线","timelineChanged":false,"entities":["本轮新登场、重新登场或明确即将登场的具体原作人物/地点/组织"],"canonChanges":["正文明确说明的角色或剧情相对原著变化"],"queries":["仅用于已有档案的明确新增差异或重大时间线变化"]}\n规则：新角色首先需要完整基础档案，不能把饮食、喝酒、车辆等当前场景琐事当成主档案；插件会自动生成基础档案查询，你不要为新角色规划零碎问题。queries 最多 ${config.maxQueries} 条；不得使用“兄妹”“冒险”“OC”等泛称或角色卡标题；用户原创人物不应单独外搜；仅含同人角色但剧情属于用户原创世界时，不得硬套原作时间节点。只有篇章、原作事件阶段、AU关键状态或重大剧情线确实变化时，timelineChanged 才能为 true；普通对话、日常推进、换地点或时间流逝不得改写上轮时间线。已有角色默认沿用原著与缓存，只有正文明确给出相对原著的差异时才写入 canonChanges。`;

    try {
        const parsed = await runJsonAnalysisPrompt(plannerPrompt, 1800);
        const manualWork = work && work !== cardProfile.lastAutoWorkTitle ? work : '';
        const plannedWork = manualWork || String(parsed.work ?? '').trim() || work;
        const detectedEntities = cleanDetectedEntities(parsed.entities);
        const missingVisibleEntities = visibleEntities.filter(entity => !database[entity]?.sources?.length);
        const entities = [...new Set([...fixedEntities, ...missingVisibleEntities, ...detectedEntities])].slice(0, 8);
        let deltaQueries = Array.isArray(parsed.queries) ? parsed.queries.map(String) : [];
        deltaQueries = deltaQueries.map(x => x.trim()).filter(Boolean).map(x => {
            if (!shouldAttachWorkTitle(plannedWork) || x.includes(plannedWork)) return x;
            return `${x} ${plannedWork}`;
        });
        deltaQueries = cleanPlannedQueries(deltaQueries, plannedWork);
        const newEntities = entities.filter(entity => !database[entity]?.sources?.length);
        const baselineQueries = newEntities.map(entity =>
            `${entity} ${plannedWork} 原作完整角色档案：身份、年龄、外貌身材、典型穿着、性格行为逻辑、能力、重要经历、人际关系、说话风格`.trim());
        const queries = baselineQueries.length
            ? baselineQueries
            : (parsed.timelineChanged === true || (Array.isArray(parsed.canonChanges) && parsed.canonChanges.length) ? deltaQueries : []);
        const manualTimeline = cardProfile.timeline.trim() && cardProfile.timeline.trim() !== cardProfile.lastAutoTimeline
            ? cardProfile.timeline.trim()
            : '';
        const inferredTimeline = parsed.timelineChanged === true
            ? String(parsed.timeline ?? '').trim()
            : cardProfile.timeline.trim();
        return {
            work: plannedWork,
            timeline: manualTimeline || (parsed.storyType === 'original_world_with_fandom_characters' || parsed.storyType === 'original_only'
                ? '用户原创世界（仅含同人角色，非原作剧情）'
                : inferredTimeline) || cardProfile.timeline.trim(),
            entities,
            autoEntities: detectedEntities,
            canonChanges: Array.isArray(parsed.canonChanges) ? parsed.canonChanges.map(String).filter(Boolean) : [],
            timelineChanged: parsed.timelineChanged === true,
            queries: [...new Set(queries)].slice(0, config.maxQueries),
        };
    } catch (error) {
        console.warn('[Fandom Canon] Query planner failed; using configured names.', error);
        return {
            work,
            timeline: cardProfile.timeline.trim(),
            entities: fallbackEntities,
            timelineChanged: false,
            queries: fallbackQueries.slice(0, config.maxQueries),
        };
    }
}

function syncProfileFromPlan(plan) {
    if (!settings().autoUpdateProfile || !plan) return;
    const cardProfile = profile();
    const currentEntities = manualEntities(cardProfile.entities);
    const previousAutoEntities = cleanDetectedEntities(cardProfile.lastAutoEntities);
    const manualFixed = currentEntities.filter(entity => !previousAutoEntities.includes(entity));
    const newlyDetectedEntities = cleanDetectedEntities(plan.autoEntities ?? plan.entities);
    const nextAutoEntities = [...new Set([...previousAutoEntities, ...newlyDetectedEntities])].slice(0, 40);
    const nextEntities = [...new Set([...manualFixed, ...nextAutoEntities])].slice(0, 40);

    if (plan.work && (!cardProfile.workTitle || cardProfile.workTitle === cardProfile.lastAutoWorkTitle)) {
        cardProfile.workTitle = plan.work;
        cardProfile.lastAutoWorkTitle = plan.work;
    }
    if (plan.timeline && (!cardProfile.timeline || cardProfile.timeline === cardProfile.lastAutoTimeline)) {
        cardProfile.timeline = plan.timeline;
        cardProfile.lastAutoTimeline = plan.timeline;
    }
    cardProfile.entities = nextEntities.join('，');
    cardProfile.lastAutoEntities = nextAutoEntities;
    saveSettingsDebounced();
    loadProfileIntoPanel();
}

function normalizeApiUrl(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return '';
    try {
        const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        if (/api\.php$/i.test(url.pathname)) return url.toString();
        const wikiIndex = url.pathname.toLowerCase().indexOf('/wiki/');
        url.pathname = wikiIndex >= 0 ? `${url.pathname.slice(0, wikiIndex)}/api.php` : '/api.php';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return '';
    }
}

async function fetchJson(url, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

async function fetchWikiFallback(apiUrl, page, sourceName, query) {
    const config = settings();
    const url = new URL(apiUrl);
    url.search = new URLSearchParams({
        action: 'query',
        prop: 'revisions',
        titles: page.title,
        rvprop: 'content',
        rvslots: 'main',
        rvsection: '0',
        redirects: '1',
        format: 'json',
        formatversion: '2',
        origin: '*',
    }).toString();
    const json = await fetchJson(url);
    const raw = json?.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content ?? '';
    const extract = stripWikiText(raw).slice(0, config.maxPageChars);
    if (!extract) return null;
    return {
        title: page.title,
        extract,
        url: page.fullurl || '',
        source: sourceName,
        query,
    };
}

async function searchWiki(apiUrl, query, sourceName) {
    const config = settings();
    const key = `${apiUrl}|${query}`;
    const cached = config.cache[key];
    const maxAge = config.cacheMinutes * 60 * 1000;
    if (cached?.at && Date.now() - cached.at < maxAge && Array.isArray(cached.pages)) {
        return cached.pages;
    }

    const url = new URL(apiUrl);
    url.search = new URLSearchParams({
        action: 'query',
        generator: 'search',
        gsrsearch: query,
        gsrlimit: String(config.pagesPerQuery),
        prop: 'extracts|info',
        explaintext: '1',
        exintro: '1',
        exchars: String(config.maxPageChars),
        inprop: 'url',
        redirects: '1',
        format: 'json',
        formatversion: '2',
        origin: '*',
    }).toString();

    const json = await fetchJson(url);
    const candidates = (json?.query?.pages ?? []).filter(page => page?.title);
    const pages = candidates.filter(page => page.extract).map(page => ({
        title: page.title,
        extract: stripMarkup(page.extract).slice(0, config.maxPageChars),
        url: page.fullurl || '',
        source: sourceName,
        query,
    }));
    if (!pages.length && candidates.length) {
        const fallback = await Promise.allSettled(candidates.map(page => fetchWikiFallback(apiUrl, page, sourceName, query)));
        pages.push(...fallback.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []));
    }
    config.cache[key] = { at: Date.now(), pages };
    pruneCache();
    saveSettingsDebounced();
    return pages;
}

const SEARCH_SECRET_KEYS = {
    tavily: SECRET_KEYS.TAVILY,
    serper: SECRET_KEYS.SERPER,
    serpapi: SECRET_KEYS.SERPAPI,
};

function hasSearchSecret(provider = settings().searchProvider) {
    if (provider === 'custom_ai') return Boolean(readLocalCredential('search-ai'));
    const key = SEARCH_SECRET_KEYS[provider];
    if (!key) return provider === 'wiki' || provider === 'searxng';
    const value = secret_state[key];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function unpackSearchAiResponse(data, model) {
    const texts = [];
    const sources = new Map();
    if (typeof data?.output_text === 'string') texts.push(data.output_text);
    for (const output of Array.isArray(data?.output) ? data.output : []) {
        for (const content of Array.isArray(output?.content) ? output.content : []) {
            if (typeof content?.text === 'string') texts.push(content.text);
            for (const annotation of Array.isArray(content?.annotations) ? content.annotations : []) {
                const url = annotation?.url || annotation?.url_citation?.url;
                const title = annotation?.title || annotation?.url_citation?.title || url;
                if (url) sources.set(url, { title, url });
            }
        }
    }
    for (const citation of Array.isArray(data?.citations) ? data.citations : []) {
        const url = typeof citation === 'string' ? citation : citation?.url;
        if (url) sources.set(url, { title: citation?.title || url, url });
    }
    const chatContent = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
    if (typeof chatContent === 'string') texts.push(chatContent);
    const answer = texts.filter(Boolean).join('\n\n').trim();
    if (!answer) throw new Error('搜索 AI 返回了空内容');
    return { answer, sources: [...sources.values()], rawModel: data?.model || model };
}

async function callCustomSearchAi(query) {
    const config = settings();
    const isResponses = config.searchAiProtocol === 'responses';
    const path = isResponses ? 'responses' : 'chat/completions';
    const researchInstruction = 'Search the live web for the following fandom canon question. Independently choose the most accurate and authoritative sources for this specific question. Sources may include official publishers or studios, creator interviews, official guides, reputable databases, encyclopedias, and high-quality specialist wikis; do not restrict the search to wikis. Cross-check conflicting claims, clearly distinguish canon facts from speculation, and include source links.';
    const body = isResponses ? {
        model: config.searchAiModel,
        input: [{ role: 'user', content: `${researchInstruction}\n\n${query}` }],
        tools: [{ type: 'web_search' }],
    } : {
        model: config.searchAiModel,
        messages: [
            { role: 'system', content: researchInstruction },
            { role: 'user', content: query },
        ],
        temperature: 0.1,
        stream: false,
    };
    if (!isResponses) {
        const data = await chatCompletionWithFallback(config.searchAiBaseUrl, 'search-ai', body, '搜索 AI 请求');
        return unpackSearchAiResponse(data, config.searchAiModel);
    }
    const response = await directApiFetch(apiEndpoint(config.searchAiBaseUrl, path), {
        method: 'POST',
        headers: directApiHeaders('search-ai'),
        body: JSON.stringify(body),
    }, '搜索 AI Responses 请求');
    return unpackSearchAiResponse(await response.json(), config.searchAiModel);
}

function parseWebResults(provider, data, query) {
    let items = [];
    if (provider === 'tavily') {
        items = (data?.results ?? []).map(item => ({
            title: item.title,
            url: item.url,
            extract: item.content || item.raw_content || '',
        }));
        if (data?.answer) items.unshift({ title: 'Tavily 综合回答', url: '', extract: data.answer });
    } else if (provider === 'serper') {
        items = (data?.organic ?? []).map(item => ({ title: item.title, url: item.link, extract: item.snippet || '' }));
        if (data?.knowledgeGraph) {
            items.unshift({
                title: data.knowledgeGraph.title || 'Serper 知识图谱',
                url: data.knowledgeGraph.website || '',
                extract: data.knowledgeGraph.description || '',
            });
        }
    } else if (provider === 'serpapi') {
        items = (data?.organic_results ?? []).map(item => ({ title: item.title, url: item.link, extract: item.snippet || '' }));
        if (data?.knowledge_graph) {
            items.unshift({
                title: data.knowledge_graph.title || 'SerpApi 知识图谱',
                url: data.knowledge_graph.website || '',
                extract: data.knowledge_graph.description || '',
            });
        }
    } else if (provider === 'custom_ai') {
        const structured = parseJsonObject(data?.answer);
        const records = Array.isArray(structured?.records) ? structured.records : [];
        const isBatchProfileRequest = /研究对象[：:]|"records"|完整角色档案/.test(query);
        if (isBatchProfileRequest && !records.length) return [];
        items = records.length ? records.map(record => ({
            title: String(record?.entity || '').trim(),
            url: data?.sources?.[0]?.url || '',
            extract: String(record?.summary || '').trim(),
        })) : [{
            title: `搜索 AI 综合结果（${data?.rawModel || settings().searchAiModel}）`,
            url: data?.sources?.[0]?.url || '',
            extract: String(data?.answer || '').trim(),
        }];
    }
    return items.filter(item => item.title && item.extract).slice(0, 6).map(item => ({
        ...item,
        extract: provider === 'custom_ai'
            ? stripMarkup(item.extract)
            : stripMarkup(item.extract).slice(0, settings().maxPageChars),
        source: provider === 'tavily' ? 'Tavily' : provider === 'serper' ? 'Serper' : provider === 'serpapi' ? 'SerpApi' : '自定义搜索 AI',
        query,
    }));
}

function parseSearxngResults(html, query) {
    const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
    return [...doc.querySelectorAll('article.result, .result')].slice(0, 6).map(item => {
        const link = item.querySelector('h3 a, .result_header a, a.url_header, a[href]');
        const content = item.querySelector('.content, .result-content, p');
        return {
            title: link?.textContent?.trim() || '',
            url: link?.href || '',
            extract: content?.textContent?.trim() || '',
            source: 'SearXNG',
            query,
        };
    }).filter(item => item.title && item.extract);
}

async function searchWeb(query) {
    const config = settings();
    const provider = config.searchProvider;
    if (provider === 'wiki') return [];

    const key = `web|${provider}|${config.searxngUrl}|${config.searchAiBaseUrl}|${config.searchAiModel}|${config.searchAiProtocol}|${query}`;
    const cached = config.cache[key];
    const maxAge = config.cacheMinutes * 60 * 1000;
    if (cached?.at && Date.now() - cached.at < maxAge && Array.isArray(cached.pages)) return cached.pages;

    if (!hasSearchSecret(provider)) {
        throw new Error(`${provider} 尚未配置 API Key`);
    }
    if (provider === 'searxng' && !config.searxngUrl.trim()) {
        throw new Error('尚未填写 SearXNG 地址');
    }

    if (provider === 'custom_ai' && (!config.searchAiBaseUrl || !config.searchAiModel)) {
        throw new Error('请先检测自定义搜索 AI 并选择模型');
    }

    if (provider === 'custom_ai') {
        const pages = parseWebResults(provider, await callCustomSearchAi(query), query);
        config.cache[key] = { at: Date.now(), pages };
        pruneCache();
        saveSettingsDebounced();
        return pages;
    }

    const endpoint = `/api/search/${provider}`;
    const body = provider === 'searxng'
        ? { query, baseUrl: config.searxngUrl.trim(), categories: 'general' }
        : { query };
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const message = (await response.text()).slice(0, 300);
        throw new Error(`${provider} 搜索失败（HTTP ${response.status}）${message ? `：${message}` : ''}`);
    }
    const pages = provider === 'searxng'
        ? parseSearxngResults(await response.text(), query)
        : parseWebResults(provider, await response.json(), query);
    config.cache[key] = { at: Date.now(), pages };
    pruneCache();
    saveSettingsDebounced();
    return pages;
}

function pruneCache() {
    const cache = settings().cache;
    const entries = Object.entries(cache).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0));
    for (const [key] of entries.slice(80)) delete cache[key];
}

function storedCanonEntities() {
    const cardProfile = profile();
    cardProfile.canonDatabase ??= {};
    return cardProfile.canonDatabase;
}

function currentWorldBookName() {
    const character = currentCharacter();
    const data = character?.data ?? character;
    return String(data?.extensions?.world || data?.character_book?.name || '').trim();
}

function worldEntryComment(entity) {
    return `${WORLD_ENTRY_PREFIX}${profileKey()}·${entity}`;
}

function extractEntitySpecificText(value, entity, candidateEntities = []) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const chunks = raw
        .split(/(?=\*\*\s*\d+[.、．])|\n{2,}/)
        .map(chunk => chunk.trim())
        .filter(Boolean);
    const matching = chunks.filter(chunk => chunk.toLowerCase().includes(entity.toLowerCase()));
    if (matching.length) return matching.join('\n\n');
    const containsAnotherEntity = cleanDetectedEntities(candidateEntities)
        .some(other => other !== entity && raw.toLowerCase().includes(other.toLowerCase()));
    return containsAnotherEntity ? '' : raw;
}

function consolidateCanonAliases(database, cardProfile) {
    const groups = new Map();
    for (const name of Object.keys(database)) {
        const key = canonicalEntityKey(name);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(name);
    }

    let changed = false;
    const replacements = new Map();
    for (const names of groups.values()) {
        const normalizedNames = names.map(normalizeEntityDisplay);
        const preferredName = normalizedNames.find((name, index) => name === names[index])
            || normalizedNames[0];
        if (names.length === 1 && names[0] === preferredName) continue;

        const records = names.map(name => database[name]).filter(Boolean);
        const quality = record => (record?.sources || []).reduce((total, source) => total + String(source?.extract || '').length, 0);
        const preferredRecord = records.find(record => String(record?.entity || '') === preferredName)
            || [...records].sort((a, b) => quality(b) - quality(a))[0]
            || {};
        const sourceMap = new Map();
        for (const record of records) {
            for (const source of (Array.isArray(record?.sources) ? record.sources : [])) {
                const normalizedTitle = canonicalEntityKey(source?.title) === canonicalEntityKey(preferredName)
                    ? preferredName
                    : String(source?.title || '');
                const normalizedSource = { ...source, title: normalizedTitle };
                const sourceKey = `${normalizedSource.source || ''}|${canonicalEntityKey(normalizedTitle)}|${normalizedSource.url || ''}`;
                const previous = sourceMap.get(sourceKey);
                if (!previous || String(normalizedSource.extract || '').length > String(previous.extract || '').length) {
                    sourceMap.set(sourceKey, normalizedSource);
                }
            }
        }

        const merged = {
            ...preferredRecord,
            entity: preferredName,
            work: preferredRecord.work || records.find(record => record?.work)?.work || '',
            timeline: preferredRecord.timeline || records.find(record => record?.timeline)?.timeline || '',
            updatedAt: Math.max(0, ...records.map(record => Number(record?.updatedAt) || 0)),
            canonChanges: [...new Set(records.flatMap(record => Array.isArray(record?.canonChanges) ? record.canonChanges : []).map(String).filter(Boolean))],
            sources: [...sourceMap.values()],
        };
        for (const name of names) {
            replacements.set(name, preferredName);
            if (name !== preferredName) delete database[name];
        }
        database[preferredName] = merged;
        changed = true;
    }

    if (changed) {
        const replaceNames = values => cleanDetectedEntities(values.map(name => replacements.get(name) || name));
        cardProfile.entities = replaceNames(manualEntities(cardProfile.entities)).join('，');
        cardProfile.lastAutoEntities = replaceNames(Array.isArray(cardProfile.lastAutoEntities) ? cardProfile.lastAutoEntities : []);
    }
    return changed;
}

function sanitizeCanonDatabase(database, cardProfile = profile()) {
    const entities = Object.keys(database);
    let changed = false;
    const removedEntities = new Set();
    const rejectedProfile = /无原作对应|未(?:在|能).*发现|音译变体|误写|混淆|并非独立实体|原作.*(?:登場しない|存在しない)|公式.*(?:記述|確認).*(?:ない|ず)|記録対象外/i;
    for (const entity of entities) {
        const record = database[entity];
        if (!cleanDetectedEntities([entity]).length || !record) {
            delete database[entity];
            removedEntities.add(entity);
            changed = true;
            continue;
        }
        const sources = (Array.isArray(record.sources) ? record.sources : [])
            .filter(source => {
                const text = String(source?.extract || '');
                if (rejectedProfile.test(text)) return false;
                if (source?.source === '自定义搜索 AI' && String(source?.title || '').trim() !== entity) return false;
                return true;
            })
            .map(source => ({
                ...source,
                extract: extractEntitySpecificText(source.extract, entity, entities),
            }))
            .filter(source => source.extract)
            .filter((source, index, array) => array.findIndex(other =>
                `${other.title}|${other.url}|${other.extract}` === `${source.title}|${source.url}|${source.extract}`) === index);
        if (sources.length !== (record.sources || []).length
            || sources.some((source, index) => source.extract !== record.sources?.[index]?.extract)) changed = true;
        record.sources = sources;
        if (!sources.length) {
            delete database[entity];
            removedEntities.add(entity);
            changed = true;
        }
    }
    changed = consolidateCanonAliases(database, cardProfile) || changed;
    const preferredEntities = manualEntities(cardProfile.entities);
    const normalizeFamily = value => String(value || '').replaceAll('結', '结').slice(0, 2);
    for (const entity of Object.keys(database)) {
        if (preferredEntities.includes(entity)) continue;
        const summary = (database[entity]?.sources || []).map(source => source.extract).join('\n');
        const looksLikeRejectedAlias = rejectedProfile.test(summary);
        const preferredSameFamily = preferredEntities.some(preferred =>
            normalizeFamily(preferred) && normalizeFamily(preferred) === normalizeFamily(entity));
        if (looksLikeRejectedAlias && preferredSameFamily) {
            delete database[entity];
            removedEntities.add(entity);
            changed = true;
        }
    }
    if (removedEntities.size) {
        cardProfile.entities = manualEntities(cardProfile.entities).filter(entity => !removedEntities.has(entity)).join('，');
        cardProfile.lastAutoEntities = cleanDetectedEntities(cardProfile.lastAutoEntities).filter(entity => !removedEntities.has(entity));
    }
    return changed;
}

async function sanitizePersistedProfiles() {
    const profiles = settings().profiles || {};
    let settingsChanged = false;
    for (const [savedProfileKey, cardProfile] of Object.entries(profiles)) {
        if (!cardProfile?.canonDatabase) continue;
        const databaseChanged = sanitizeCanonDatabase(cardProfile.canonDatabase, cardProfile);
        settingsChanged ||= databaseChanged;
        const worldName = String(cardProfile.canonWorldBook || '').trim();
        if (!databaseChanged || !worldName) continue;
        const data = await loadWorldInfo(worldName);
        if (!data?.entries) continue;
        const prefix = `${WORLD_ENTRY_PREFIX}${savedProfileKey}·`;
        let worldChanged = false;
        for (const [uid, entry] of Object.entries(data.entries)) {
            if (!String(entry?.comment || '').startsWith(prefix)) continue;
            const entity = String(entry.comment).slice(prefix.length);
            const record = cardProfile.canonDatabase[entity];
            if (!record?.sources?.length) {
                delete data.entries[uid];
            } else {
                entry.content = formatCanonWorldEntry(record);
            }
            worldChanged = true;
        }
        if (worldChanged) {
            await saveWorldInfo(worldName, data, true);
            reloadEditor(worldName, false);
        }
    }
    if (settingsChanged) saveSettingsDebounced();
}

function formatCanonWorldEntry(record) {
    const cleanSummary = value => String(value || '')
        .replace(/\[\[?\d+\]?\]\([^)]*\)/g, '')
        .replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g, match => match.replace(/^\[|\]\([\s\S]*$/g, ''))
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\*{0,2}(?:权威|可靠|参考|引用|资料)来源\*{0,2}\s*[:：]?[\s\S]*$/i, '')
        .replace(/^\s*(?:[-*]\s*)?(?:权威|可靠|参考|引用|资料)?来源\s*[:：].*$/gmi, '')
        .replace(/\*\*/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    const seen = new Set();
    const extracts = (record.sources || [])
        .map(source => extractEntitySpecificText(source.extract, record.entity))
        .map(cleanSummary)
        .filter(text => text && !/^这是搜索 AI 在本轮检索中选择/.test(text))
        .filter(text => {
            const key = text.replace(/\s+/g, ' ');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .join('\n\n');
    const changes = Array.isArray(record.canonChanges) && record.canonChanges.length
        ? record.canonChanges.join('；')
        : '无正文明确声明的原著差异；沿用原著设定';
    return `<!-- FCR_CANON_DATABASE_V2 -->\n人物/实体：${record.entity}\n作品：${record.work || '未确认'}\n当前剧情线：${record.timeline || '未确认'}\n已确认AU差异：${changes}\n\n角色档案：\n${extracts || '尚无可用资料'}\n<!-- /FCR_CANON_DATABASE_V2 -->`;
}

async function syncCanonDatabaseToWorldBook(entities) {
    const worldName = currentWorldBookName();
    if (!worldName) return false;
    const data = await loadWorldInfo(worldName);
    if (!data?.entries) return false;
    const database = storedCanonEntities();
    const databaseChanged = sanitizeCanonDatabase(database);
    const characterFile = String(currentCharacter()?.avatar || currentCharacter()?.name || '').replace(/\.[^.]+$/, '');
    let changed = false;
    const prefix = `${WORLD_ENTRY_PREFIX}${profileKey()}·`;
    for (const [uid, entry] of Object.entries(data.entries)) {
        if (!String(entry?.comment || '').startsWith(prefix)) continue;
        const entity = String(entry.comment).slice(prefix.length);
        if (cleanDetectedEntities([entity]).length && database[entity]?.sources?.length) continue;
        delete data.entries[uid];
        delete database[entity];
        changed = true;
    }
    for (const entity of cleanDetectedEntities(entities)) {
        const record = database[entity];
        if (!record?.sources?.length) continue;
        const comment = worldEntryComment(entity);
        let entry = Object.values(data.entries).find(item => item?.comment === comment);
        if (!entry) {
            entry = createWorldInfoEntry(worldName, data);
            if (!entry) continue;
        }
        Object.assign(entry, {
            key: [entity],
            keysecondary: [],
            comment,
            content: formatCanonWorldEntry(record),
            constant: false,
            selective: true,
            addMemo: true,
            order: 100,
            position: 0,
            disable: false,
            probability: 100,
            useProbability: true,
            excludeRecursion: true,
            preventRecursion: true,
            characterFilter: {
                isExclude: false,
                names: characterFile ? [characterFile] : [],
                tags: [],
            },
        });
        changed = true;
    }
    if (changed || databaseChanged) {
        await saveWorldInfo(worldName, data, true);
        reloadEditor(worldName, false);
        profile().canonWorldBook = worldName;
        saveSettingsDebounced();
    }
    return changed;
}

async function clearCanonWorldBookEntries() {
    const worldName = currentWorldBookName();
    if (!worldName) return;
    const data = await loadWorldInfo(worldName);
    if (!data?.entries) return;
    const prefix = `${WORLD_ENTRY_PREFIX}${profileKey()}·`;
    let changed = false;
    for (const [uid, entry] of Object.entries(data.entries)) {
        if (String(entry?.comment || '').startsWith(prefix)) {
            delete data.entries[uid];
            changed = true;
        }
    }
    if (changed) {
        await saveWorldInfo(worldName, data, true);
        reloadEditor(worldName, false);
    }
}

async function saveCanonResearch(plan, pages) {
    if (!Array.isArray(pages) || !pages.length) return;
    const database = storedCanonEntities();
    const planEntities = cleanDetectedEntities(plan.entities);
    sanitizeCanonDatabase(database);
    for (const entity of planEntities) {
        const previous = database[entity];
        const relevant = pages.filter(page => page.source !== '自定义搜索 AI'
            || String(page.title || '').trim() === entity).map(page => ({
            ...page,
            extract: extractEntitySpecificText(page.extract, entity, planEntities),
        })).filter(page => page.extract && ([page.title, page.extract]
            .some(value => String(value ?? '').toLowerCase().includes(entity.toLowerCase()))));
        if (!relevant.length && !previous?.sources?.length) continue;
        const mergedSources = [...(Array.isArray(previous?.sources) ? previous.sources : []), ...relevant]
            .map(source => ({
                title: source.title,
                url: source.url,
                source: source.source,
                extract: String(source.extract || ''),
            }))
            .filter((source, index, array) => array.findIndex(other =>
                `${other.title}|${other.url}|${other.extract}` === `${source.title}|${source.url}|${source.extract}`) === index);
        database[entity] = {
            entity,
            work: plan.work || '',
            timeline: plan.timeline || '',
            updatedAt: Date.now(),
            canonChanges: [...new Set([
                ...(Array.isArray(previous?.canonChanges) ? previous.canonChanges : []),
                ...(Array.isArray(plan.canonChanges) ? plan.canonChanges : []),
            ].map(String).filter(Boolean))].slice(0, 20),
            sources: mergedSources,
        };
    }
    saveSettingsDebounced();
    await syncCanonDatabaseToWorldBook(planEntities);
}

function loadCanonResearch(plan) {
    const database = storedCanonEntities();
    const pages = [];
    for (const entity of cleanDetectedEntities(plan.entities)) {
        const record = database[entity];
        if (!record || !Array.isArray(record.sources)) continue;
        for (const source of record.sources) {
            pages.push({
                ...source,
                source: `本卡资料库 / ${source.source || '原始来源'}`,
                query: entity,
            });
        }
    }
    const seen = new Set();
    return pages.filter(page => {
        const key = `${page.url}|${page.title}|${page.extract}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 10);
}

function missingCanonEntities(plan) {
    const database = storedCanonEntities();
    return cleanDetectedEntities(plan.entities).filter(entity => !database[entity]?.sources?.length);
}

async function retrieve(plan) {
    const config = settings();
    const cardProfile = profile();
    const useWiki = config.searchProvider === 'wiki'
        || config.sourceStrategy === 'wiki_plus'
        || (config.sourceStrategy === 'auto' && config.searchProvider !== 'custom_ai');
    const useWeb = config.searchProvider !== 'wiki';
    const apis = [{
        url: `https://${config.language || 'zh'}.wikipedia.org/w/api.php`,
        name: `${String(config.language || 'zh').toUpperCase()} Wikipedia`,
    }];
    const customUrl = normalizeApiUrl(cardProfile.customWikiApi);
    if (customUrl) apis.unshift({ url: customUrl, name: '专属 Wiki' });

    const jobs = [];
    const batchCustomAi = useWeb && config.searchProvider === 'custom_ai';
    for (const query of plan.queries) {
        if (useWiki) {
            for (const api of apis) jobs.push(searchWiki(api.url, query, api.name));
        }
        if (useWeb && !batchCustomAi) jobs.push(searchWeb(query));
    }
    if (batchCustomAi && plan.queries.length) {
        const batchQuery = `请在一次联网研究中核实下列同人对象。先自行查阅和交叉核对权威资料，但回答正文不要写网址、参考资料列表或引用编号。只输出合法 JSON：{"records":[{"entity":"必须与研究对象名称完全一致","summary":"必须以该对象的准确名称开头；给写作模型使用的完整角色档案；只写确认事实，紧凑无重复；按适用情况包含身份、年龄、外貌身材、典型穿着、性格与行为逻辑、能力、重要经历、人际关系、说话风格及不可违背的核心设定"}]}。不要限制档案长度；每个对象单独一条，不得把其他对象资料混入。没有可靠原作对应的对象不要返回记录，也不要为其猜测别名。\n\n研究对象：\n${cleanDetectedEntities(plan.entities).map((entity, index) => `${index + 1}. ${entity}`).join('\n')}\n\n检索问题：\n${plan.queries.map((query, index) => `${index + 1}. ${query}`).join('\n')}`;
        jobs.push(searchWeb(batchQuery));
    }
    const settled = await Promise.allSettled(jobs);
    const pages = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    const unique = [];
    const seen = new Set();
    for (const page of pages) {
        const key = `${page.source}|${page.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(page);
    }
    return unique.slice(0, 10);
}

function researchJobKey(plan) {
    return `${profileKey()}|${settings().searchProvider}|${settings().searchAiModel}|${(plan.queries || []).join('|')}`;
}

function startCanonEnrichment(plan) {
    const key = researchJobKey(plan);
    const existing = inFlightResearch.get(key);
    if (existing) return existing;

    const job = (async () => {
        const pages = await retrieve(plan);
        await saveCanonResearch(plan, pages);
        return pages;
    })().finally(() => inFlightResearch.delete(key));
    // Attach a rejection handler immediately so a background request can never
    // become an unhandled promise rejection after generation has continued.
    job.catch(error => console.error('[Fandom Canon] Background research failed.', error));
    inFlightResearch.set(key, job);
    return job;
}

async function waitForResearch(job, seconds) {
    const waitMs = clampInt(seconds, 0, 60, 15) * 1000;
    if (waitMs <= 0) return { timedOut: true, pages: [] };
    let timer;
    try {
        return await Promise.race([
            job.then(pages => ({ timedOut: false, pages })),
            new Promise(resolve => {
                timer = setTimeout(() => resolve({ timedOut: true, pages: [] }), waitMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function autoFillCurrentProfile() {
    const startedAt = performance.now();
    const secondsSince = mark => ((performance.now() - mark) / 1000).toFixed(1);
    const cardProfile = profile();
    const context = getContext();
    const source = await researchContext(context.chat);
    const contextSeconds = secondsSince(startedAt);
    if (!source.card && !source.worldInfo && !source.recent) {
        toastr.error('没有识别到当前角色卡或聊天内容。请先打开一个角色聊天，再执行自动填写。', '无法自动填写');
        updateReport('自动填写已停止：没有识别到当前角色卡或聊天内容');
        return;
    }
    updateReport('AI 正在识别角色卡与剧情…');
    try {
        const identifyStartedAt = performance.now();
        const firstPrompt = `你是同人资料识别助手。必须阅读角色卡正文、世界书和最近剧情，判断是否涉及已有作品，以及剧情属于原作时间线、AU，还是仅借用了同人角色的用户原创世界。角色卡标题只是文件名，不得把标题本身当人物、作品或搜索实体。\n\n只输出 JSON：{"workTitle":"正文能明确确认的作品正式名称；多作品时写多作品交叉同人（当前涉及：作品名）","storyType":"canon_timeline|au_timeline|original_world_with_fandom_characters|original_only|unknown","timeline":"原作/AU节点；若仅含同人角色但剧情是原创世界，则写用户原创世界（仅含同人角色，非原作剧情）；完全无法判断则空字符串","entities":["本轮刚出现、正在场或上下文明确即将登场且需要核实原作资料的具体人物/地点/组织"],"queries":["带人物各自作品名和具体专有名词的全网检索词"]}。不确定的字段留空，不得编造；不要输出“兄妹”“OC”“角色卡”等泛称；用户原创人物不要作为外部检索实体；世界书中的全部候选角色不等于本轮都要搜索，只选择最近剧情相关对象；queries 最多 ${settings().maxQueries} 条，没有具体核实对象就返回空数组。\n\n角色卡正文：\n${source.card || '未读取到'}\n\n当前触发及角色卡内置世界书：\n${source.worldInfo || '无'}\n\n最近剧情：\n${source.recent || '暂无聊天内容。'}`;
        const first = await runJsonAnalysisPrompt(firstPrompt, 2000);
        const identifySeconds = secondsSince(identifyStartedAt);
        const workTitle = String(first.workTitle || cardProfile.workTitle || '').trim();
        const originalWorld = first.storyType === 'original_world_with_fandom_characters' || first.storyType === 'original_only';
        const timeline = originalWorld
            ? '用户原创世界（仅含同人角色，非原作剧情）'
            : String(first.timeline || cardProfile.timeline || '').trim();
        const entities = cleanDetectedEntities(first.entities).slice(0, 8);
        const database = storedCanonEntities();
        const missingEntities = entities.filter(entity => !database[entity]?.sources?.length);
        let queries = missingEntities.map(entity =>
            `${entity} ${workTitle} 原作完整角色档案：身份、年龄、外貌身材、典型穿着、性格行为逻辑、能力、重要经历、人际关系、说话风格`.trim());
        queries = cleanPlannedQueries(queries, workTitle).slice(0, settings().maxQueries);
        const provisional = { work: workTitle, timeline, entities, queries };
        // The first structured pass has already read the card, active lore and
        // recent chat. Fill the visible table now; web research enriches the
        // persistent database in the background and must not hold the UI open.
        const detectedEntities = entities;
        const nextWorkTitle = workTitle;
        const nextTimeline = timeline;
        const nextEntities = [...new Set(detectedEntities)].slice(0, 40).join('，');
        if (!nextWorkTitle && !nextTimeline && !nextEntities) {
            throw new Error('分析模型没有识别出任何可填写内容，已取消“成功”提示；请确认当前角色卡已打开。');
        }
        cardProfile.workTitle = nextWorkTitle;
        cardProfile.timeline = nextTimeline;
        cardProfile.entities = nextEntities;
        cardProfile.lastAutoWorkTitle = nextWorkTitle;
        cardProfile.lastAutoTimeline = nextTimeline;
        cardProfile.lastAutoEntities = [...new Set(detectedEntities)].slice(0, 40);
        const suggestedWiki = normalizeApiUrl(first.customWikiApi || '');
        if (suggestedWiki) cardProfile.customWikiApi = suggestedWiki;
        saveSettingsDebounced();
        loadProfileIntoPanel();
        const filled = [nextWorkTitle && '作品名', nextTimeline && '时间线/AU', nextEntities && '人物/地点'].filter(Boolean);
        const totalSeconds = secondsSince(startedAt);
        const storedPages = loadCanonResearch(provisional);
        const missingResearchEntities = missingCanonEntities(provisional);
        const needsResearch = queries.length && (missingResearchEntities.length > 0 || storedPages.length === 0);
        updateReport(`已实际填写：${filled.join('、')}；耗时 ${totalSeconds} 秒（读取 ${contextSeconds} / 识别 ${identifySeconds}）。${needsResearch ? '新资料正在后台检索，不再阻塞页面。' : `已复用本卡资料库 ${storedPages.length} 条资料。`}`, provisional, storedPages);
        toastr.success(`已写入：${filled.join('、')}。${needsResearch ? '原作资料会在后台继续补入世界书。' : ''}`, '晋阳的同人库');
        if (needsResearch) {
            const backgroundStartedAt = performance.now();
            startCanonEnrichment(provisional).then(pages => {
                const searchSeconds = secondsSince(backgroundStartedAt);
                updateReport(`后台检索完成：已保存 ${pages.length} 条资料到本卡资料库/世界书（${searchSeconds} 秒）`, provisional, pages);
            }).catch(error => updateReport(`表格已填写，但后台检索失败：${error?.message || error}`, provisional));
        }
    } catch (error) {
        console.error('[Fandom Canon] Auto-fill failed.', error);
        updateReport(`自动填写失败：${error?.message || error}`);
        toastr.error(error?.message || String(error), '自动填写失败');
    }
}

function buildReference(plan, pages) {
    const strict = settings().strictMode;
    const sources = pages.map((page, index) =>
        `[资料 ${index + 1}] ${page.source}｜${page.title}${page.url ? `｜${page.url}` : ''}\n${page.extract}`,
    ).join('\n\n');
    const database = storedCanonEntities();
    const persistedChanges = cleanDetectedEntities(plan.entities)
        .flatMap(entity => Array.isArray(database[entity]?.canonChanges) ? database[entity].canonChanges : []);
    const allCanonChanges = [...new Set([...(plan.canonChanges || []), ...persistedChanges].map(String).filter(Boolean))];
    const canonChanges = allCanonChanges.length
        ? allCanonChanges.join('；')
        : '本轮没有检测到正文明确声明的新差异；已有角色继续沿用原著资料和既有AU设定';
    return `<fandom_canon_reference>\n作品：${plan.work || '未确认'}\n当前时间线/AU节点：${plan.timeline || '未确认；必须避免擅自假定具体集数或时期'}\n本轮核实对象：${plan.entities.join('、') || '由上下文判断'}\n本轮明确的原著差异：${canonChanges}\n\n${sources}\n\n写作约束：\n1. 先依据上述资料与角色卡核对外貌、身材、惯常服装、性格、能力、经历和人际关系，再推进剧情。\n2. 角色卡、用户明确设定和本次 AU 高于原作；除此之外保持原作一致。\n3. 严守当前时间线：此节点之后才发生的事件、关系变化、伤亡、能力、秘密和人物认知不得提前出现。\n4. 资料只证明其中明确写出的事实；搜索摘要缺失不代表不存在。${strict ? '没有证据的精确原作事实不得编造，必要时采用不冲突的模糊描写。' : ''}\n5. 不要在正文提及检索、Wiki、资料编号或这些规则，直接自然写作。\n</fandom_canon_reference>`;
}

function updateReport(status, plan = null, pages = []) {
    lastReport = {
        status,
        queries: plan?.queries ?? [],
        sources: pages.map(page => ({ title: page.title, url: page.url, source: page.source })),
        at: Date.now(),
    };
    renderReport();
}

async function runPreflight(chat, type = 'normal', force = false) {
    const startedAt = performance.now();
    const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);
    setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    if ((!settings().enabled && !force) || type === 'quiet' || busy) return;
    if (!profile().workTitle.trim() && !profile().entities.trim() && !currentCharacter()?.name) {
        updateReport('缺少作品名或人物名，已跳过');
        return;
    }

    busy = true;
    updateReport('正在规划检索…');
    try {
        const plan = await planQueries(chat);
        syncProfileFromPlan(plan);
        const storedPages = loadCanonResearch(plan);
        const missingEntities = missingCanonEntities(plan);
        const hasExplicitChanges = Boolean(plan.timelineChanged || plan.canonChanges?.length);
        const shouldFetch = force || missingEntities.length > 0 || hasExplicitChanges || storedPages.length === 0;
        if (!plan.queries.length && !storedPages.length) {
            updateReport(`资料表已自动检查；没有新的有效检索对象（${elapsed()} 秒）`, plan);
            return;
        }
        updateReport(shouldFetch && plan.queries.length
            ? `资料表已自动更新，正在批量检索…（${elapsed()} 秒）`
            : `资料表已自动更新，正在读取本卡资料库…（${elapsed()} 秒）`, plan);
        let fetchedPages = [];
        let timedOut = false;
        if (shouldFetch && plan.queries.length) {
            const result = await waitForResearch(startCanonEnrichment(plan), settings().searchWaitSeconds);
            fetchedPages = result.pages;
            timedOut = result.timedOut;
        }
        const pages = [...fetchedPages, ...storedPages].filter((page, index, array) =>
            array.findIndex(other => `${other.url}|${other.title}` === `${page.url}|${page.title}`) === index,
        ).slice(0, 10);
        if (!pages.length) {
            updateReport(timedOut
                ? `新角色资料检索超过 ${settings().searchWaitSeconds} 秒，已转入后台；本轮不再等待，酒馆继续生成（${elapsed()} 秒）`
                : `未找到资料，本轮不注入（${elapsed()} 秒）`, plan);
            return;
        }
        const reference = buildReference(plan, pages).slice(0, 24000);
        setExtensionPrompt(PROMPT_KEY, reference, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
        updateReport(`${timedOut ? '新资料仍在后台检索；已先复用资料库并' : '已自动更新资料表并'}注入 ${pages.length} 条原作资料（总耗时 ${elapsed()} 秒）`, plan, pages);
        console.info('[Fandom Canon] Reference injected.', { plan, pages });
    } catch (error) {
        console.error('[Fandom Canon] Retrieval failed.', error);
        updateReport(`检索失败：${error?.message || error}`);
    } finally {
        busy = false;
    }
}

globalThis.fandomCanonPreflight = async (chat, _contextSize, _abort, type) => runPreflight(chat, type, false);

function panelHtml() {
    const config = settings();
    return `<div id="${PANEL_ID}" class="fandom-canon-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-book-atlas"></i> 晋阳的同人库 <small class="fcr-version">v${EXTENSION_VERSION}</small></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <button id="fcr-enabled" class="fcr-check-row" type="button" aria-pressed="${config.enabled}"><span class="fcr-check-box" aria-hidden="true"></span><span>生成前自动核实原作资料</span></button>
                <button id="fcr-planner" class="fcr-check-row" type="button" aria-pressed="${config.autoPlanner}"><span class="fcr-check-box" aria-hidden="true"></span><span>让分析模型规划本轮检索词（会多一次短请求）</span></button>
                <button id="fcr-auto-update-profile" class="fcr-check-row" type="button" aria-pressed="${config.autoUpdateProfile}"><span class="fcr-check-box" aria-hidden="true"></span><span>随剧情自动更新作品、时间线和当前人物表</span></button>
                <button id="fcr-strict" class="fcr-check-row" type="button" aria-pressed="${config.strictMode}"><span class="fcr-check-box" aria-hidden="true"></span><span>严格模式：没有资料依据时不编造精确设定</span></button>
                <div class="fcr-grid">
                    <label>Wikipedia 语言<select id="fcr-language"><option value="zh">中文</option><option value="ja">日文</option><option value="en">英文</option></select></label>
                    <label>每次最多查询数<input id="fcr-max-queries" type="number" min="1" max="5" value="${config.maxQueries}"></label>
                    <label>缓存分钟<input id="fcr-cache-minutes" type="number" min="10" max="10080" value="${config.cacheMinutes}"></label>
                    <label>生成前最多等待检索（秒）<input id="fcr-search-wait" type="number" min="0" max="60" value="${config.searchWaitSeconds}"></label>
                </div>
                <details class="fcr-api-box" open>
                    <summary><i class="fa-solid fa-globe"></i> 搜索 API 配置</summary>
                    <div class="fcr-grid fcr-api-grid">
                        <label>搜索服务<select id="fcr-search-provider">
                            <option value="wiki">仅 Wiki（免费，无需 Key）</option>
                            <option value="tavily">Tavily</option>
                            <option value="serper">Serper</option>
                            <option value="serpapi">SerpApi</option>
                            <option value="searxng">SearXNG（自建/公共实例）</option>
                            <option value="custom_ai">自定义搜索 AI（Grok 等）</option>
                        </select></label>
                        <label class="fcr-api-key-wrap">API Key（安全保存到酒馆密钥库）<input id="fcr-search-key" type="password" class="text_pole" autocomplete="off" placeholder="输入后点击保存"></label>
                        <label class="fcr-searxng-wrap">SearXNG 地址<input id="fcr-searxng-url" class="text_pole" placeholder="https://你的搜索实例"></label>
                        <label>资料来源策略<select id="fcr-source-strategy">
                            <option value="auto">智能选择（搜索AI不强制Wiki）</option>
                            <option value="search_only">只使用所选搜索服务</option>
                            <option value="wiki_plus">Wiki + 搜索服务交叉核对</option>
                        </select></label>
                    </div>
                    <div class="fcr-api-actions">
                        <button id="fcr-save-search-key" class="menu_button"><i class="fa-solid fa-key"></i> 保存搜索 Key</button>
                        <span id="fcr-search-key-state" class="fcr-key-state"></span>
                    </div>
                    <div class="fcr-search-ai-fields">
                        <div class="fcr-grid fcr-llm-grid">
                            <label>搜索 AI 地址<input id="fcr-search-ai-url" class="text_pole" placeholder="Grok 官方：https://api.x.ai/v1"></label>
                            <label>API Key（仅保存在此设备）<input id="fcr-search-ai-key" type="password" class="text_pole" autocomplete="off" placeholder="已有 Key 时可以留空"></label>
                            <label>选择搜索模型<select id="fcr-search-ai-model"><option value="">请先检测并读取模型</option></select></label>
                            <label>联网协议<select id="fcr-search-ai-protocol">
                                <option value="responses">Responses API + web_search（Grok/OpenAI）</option>
                                <option value="chat">Chat Completions（模型自身联网）</option>
                            </select></label>
                        </div>
                        <div class="fcr-api-actions">
                            <button id="fcr-detect-search-ai" class="menu_button"><i class="fa-solid fa-satellite-dish"></i> 保存 Key、检测并读取模型</button>
                            <button id="fcr-delete-search-ai-key" class="menu_button"><i class="fa-solid fa-key"></i> 删除此设备 Key</button>
                            <span id="fcr-search-ai-state" class="fcr-key-state"></span>
                        </div>
                        <div class="fcr-help">搜索 AI 会自主选择权威来源并返回引用；“智能选择”不会强制它先查 Wiki。Responses 联网模式须使用 HTTPS 并允许浏览器跨域访问（CORS）；模型列表、分析及 Chat 模式可自动回退到酒馆通用代理。</div>
                    </div>
                    <div class="fcr-help">搜索 Key 不写入插件设置或聊天记录。</div>
                </details>
                <details class="fcr-api-box fcr-llm-box" open>
                    <summary><i class="fa-solid fa-brain"></i> 分析 LLM 配置</summary>
                    <label>分析模型来源<select id="fcr-analysis-source">
                        <option value="current">使用当前酒馆模型</option>
                        <option value="custom">独立 OpenAI 兼容 API</option>
                    </select></label>
                    <div class="fcr-custom-llm-fields">
                        <div class="fcr-grid fcr-llm-grid">
                            <label>LLM 地址<input id="fcr-llm-url" class="text_pole" placeholder="https://api.example.com 或 https://api.example.com/v1"></label>
                            <label>API Key（仅保存在此设备）<input id="fcr-llm-key" type="password" class="text_pole" autocomplete="off" placeholder="已有 Key 时可以留空"></label>
                            <label>选择模型<select id="fcr-llm-model"><option value="">请先检测并读取模型</option></select></label>
                        </div>
                        <div class="fcr-api-actions">
                            <button id="fcr-detect-llm" class="menu_button"><i class="fa-solid fa-plug-circle-check"></i> 保存 Key、检测并读取模型</button>
                            <button id="fcr-delete-llm-key" class="menu_button"><i class="fa-solid fa-key"></i> 删除此设备 Key</button>
                            <span id="fcr-llm-state" class="fcr-key-state"></span>
                        </div>
                    </div>
                    <div class="fcr-help">独立 LLM 只负责检索规划、资料核对和自动填写，不会改变当前角色回复使用的模型。Key 按酒馆账号隔离，仅保存在当前浏览器；换手机或电脑需要重新填写。</div>
                </details>
                <div class="fcr-card-title">当前角色卡：<span id="fcr-card-name"></span></div>
                <label>原作/作品名<input id="fcr-work" class="text_pole" placeholder="例如：火影忍者"></label>
                <label>当前时间线或 AU 节点<textarea id="fcr-timeline" class="text_pole" rows="2" placeholder="例如：中忍考试正式赛前；自来也尚未登场。AU改动也写在这里"></textarea></label>
                <label>当前人物/地点（自动更新；手动添加项会保留）<input id="fcr-entities" class="text_pole" placeholder="例如：漩涡鸣人，旗木卡卡西"></label>
                <label>专属 Wiki 地址（可选）<input id="fcr-custom-wiki" class="text_pole" placeholder="例如：https://naruto.fandom.com/wiki/ 或完整 api.php 地址"></label>
                <div class="fcr-actions">
                    <button id="fcr-auto-fill" class="menu_button"><i class="fa-solid fa-wand-magic-sparkles"></i> AI识别并填写本卡</button>
                    <button id="fcr-test" class="menu_button"><i class="fa-solid fa-magnifying-glass"></i> 立即检索测试</button>
                    <button id="fcr-clear-cache" class="menu_button"><i class="fa-solid fa-trash-can"></i> 清空缓存</button>
                    <button id="fcr-clear-database" class="menu_button"><i class="fa-solid fa-database"></i> 清空本卡资料库</button>
                </div>
                <div id="fcr-report" class="fcr-report"></div>
            </div>
        </div>
    </div>`;
}

function loadProfileIntoPanel() {
    const cardProfile = profile();
    $('#fcr-card-name').text(currentTargetName());
    $('#fcr-work').val(cardProfile.workTitle);
    $('#fcr-timeline').val(cardProfile.timeline);
    $('#fcr-entities').val(cardProfile.entities);
    $('#fcr-custom-wiki').val(cardProfile.customWikiApi);
    $('#fcr-language').val(settings().language);
    $('#fcr-search-provider').val(settings().searchProvider);
    $('#fcr-searxng-url').val(settings().searxngUrl);
    $('#fcr-source-strategy').val(settings().sourceStrategy);
    $('#fcr-search-ai-url').val(settings().searchAiBaseUrl);
    $('#fcr-search-ai-protocol').val(settings().searchAiProtocol);
    $('#fcr-analysis-source').val(settings().analysisSource);
    $('#fcr-llm-url').val(settings().analysisBaseUrl);
    updateApiControls();
    renderSearchAiModels();
    renderAnalysisModels();
    updateAnalysisControls();
    renderReport();
}

function updateApiControls() {
    const provider = settings().searchProvider;
    $('.fcr-api-key-wrap, #fcr-save-search-key').toggle(Boolean(SEARCH_SECRET_KEYS[provider]) && provider !== 'custom_ai');
    $('.fcr-searxng-wrap').toggle(provider === 'searxng');
    $('.fcr-search-ai-fields').toggle(provider === 'custom_ai');
    const state = provider === 'wiki'
        ? '免费 Wiki 模式，无需 Key'
        : provider === 'searxng'
            ? (settings().searxngUrl ? '已填写搜索实例' : '请填写 SearXNG 地址')
            : provider === 'custom_ai'
                ? (hasSearchSecret(provider) ? '搜索 AI Key 已配置' : '请配置搜索 AI')
            : (hasSearchSecret(provider) ? 'Key 已配置' : 'Key 尚未配置');
    $('#fcr-search-key-state').text(state).toggleClass('fcr-key-ok', hasSearchSecret(provider));
    updateSearchAiControls();
}

function renderSearchAiModels() {
    const config = settings();
    const select = $('#fcr-search-ai-model');
    if (!select.length) return;
    select.empty();
    if (!config.searchAiModels.length) select.append(new Option('请先检测并读取模型', ''));
    else for (const model of config.searchAiModels) select.append(new Option(model, model));
    select.val(config.searchAiModel);
}

function updateSearchAiControls() {
    const config = settings();
    if (config.searchProvider !== 'custom_ai') return;
    if (config.searchAiModels.length && config.searchAiModel) {
        $('#fcr-search-ai-state').text(`已选择：${config.searchAiModel}`).addClass('fcr-key-ok');
    } else {
        $('#fcr-search-ai-state').text('请填写地址和 Key，然后检测模型').removeClass('fcr-key-ok');
    }
}

function renderAnalysisModels() {
    const config = settings();
    const select = $('#fcr-llm-model');
    if (!select.length) return;
    select.empty();
    if (!config.analysisModels.length) {
        select.append(new Option('请先检测并读取模型', ''));
    } else {
        for (const model of config.analysisModels) select.append(new Option(model, model));
    }
    select.val(config.analysisModel);
}

function updateAnalysisControls() {
    const config = settings();
    $('.fcr-custom-llm-fields').toggle(config.analysisSource === 'custom');
    if (config.analysisSource === 'current') {
        $('#fcr-llm-state').text('当前使用酒馆已连接的模型').addClass('fcr-key-ok');
    } else if (config.analysisModels.length && config.analysisModel && readLocalCredential('analysis')) {
        $('#fcr-llm-state').text(`已选择：${config.analysisModel}`).addClass('fcr-key-ok');
    } else {
        $('#fcr-llm-state').text(readLocalCredential('analysis') ? '请检测地址并选择模型' : '请填写此设备的 Key，然后检测模型').removeClass('fcr-key-ok');
    }
}

function renderReport() {
    const node = document.getElementById('fcr-report');
    if (!node) return;
    const databaseCount = Object.values(storedCanonEntities()).filter(record => record?.sources?.length).length;
    const worldBook = currentWorldBookName();
    const queries = lastReport.queries.length
        ? `<div><b>检索词：</b>${lastReport.queries.map(escapeHtml).join('；')}</div>` : '';
    const sources = lastReport.sources.length
        ? `<details><summary>本轮来源（${lastReport.sources.length}）</summary>${lastReport.sources.map(item =>
            `<div>${escapeHtml(item.source)}：${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</div>`,
        ).join('')}</details>` : '';
    node.innerHTML = `<div><b>状态：</b>${escapeHtml(lastReport.status)}</div><div><b>本卡持久资料库：</b>${databaseCount} 个角色${worldBook ? `；同步到世界书「${escapeHtml(worldBook)}」` : '；当前角色未绑定世界书'}</div>${queries}${sources}`;
}

function bindPanel() {
    const bindSetting = (selector, key, transform = value => value) => {
        $(selector).on('change input', function () {
            settings()[key] = transform(this.type === 'checkbox' ? this.checked : this.value);
            saveSettingsDebounced();
        });
    };
    const bindToggle = (selector, key) => {
        const button = document.querySelector(selector);
        if (!(button instanceof HTMLButtonElement)) return;
        const render = () => button.setAttribute('aria-pressed', String(Boolean(settings()[key])));
        button.addEventListener('click', () => {
            settings()[key] = !Boolean(settings()[key]);
            render();
            saveSettingsDebounced();
        });
        render();
    };
    bindToggle('#fcr-enabled', 'enabled');
    bindToggle('#fcr-planner', 'autoPlanner');
    bindToggle('#fcr-auto-update-profile', 'autoUpdateProfile');
    bindToggle('#fcr-strict', 'strictMode');

    bindSetting('#fcr-language', 'language', String);
    bindSetting('#fcr-max-queries', 'maxQueries', value => clampInt(value, 1, 5, 3));
    bindSetting('#fcr-cache-minutes', 'cacheMinutes', value => clampInt(value, 10, 10080, 360));
    bindSetting('#fcr-search-wait', 'searchWaitSeconds', value => clampInt(value, 0, 60, 15));
    bindSetting('#fcr-search-provider', 'searchProvider', String);
    bindSetting('#fcr-searxng-url', 'searxngUrl', String);
    bindSetting('#fcr-source-strategy', 'sourceStrategy', String);
    bindSetting('#fcr-search-ai-url', 'searchAiBaseUrl', value => normalizeLlmBaseUrl(value) || String(value).trim());
    bindSetting('#fcr-search-ai-model', 'searchAiModel', String);
    bindSetting('#fcr-search-ai-protocol', 'searchAiProtocol', String);
    bindSetting('#fcr-analysis-source', 'analysisSource', String);
    bindSetting('#fcr-llm-url', 'analysisBaseUrl', value => normalizeLlmBaseUrl(value) || String(value).trim());
    bindSetting('#fcr-llm-model', 'analysisModel', String);
    $('#fcr-search-provider').on('change', updateApiControls);
    $('#fcr-searxng-url').on('input change', updateApiControls);
    $('#fcr-search-ai-model').on('change', updateSearchAiControls);
    $('#fcr-detect-search-ai').on('click', detectSearchAiModels);
    $('#fcr-delete-search-ai-key').on('click', () => {
        writeLocalCredential('search-ai', '');
        $('#fcr-search-ai-key').val('');
        updateApiControls();
        toastr.success('已删除此设备保存的搜索 AI Key。', '自定义搜索 AI');
    });
    $('#fcr-analysis-source').on('change', updateAnalysisControls);
    $('#fcr-llm-model').on('change', updateAnalysisControls);
    $('#fcr-detect-llm').on('click', detectAnalysisModels);
    $('#fcr-delete-llm-key').on('click', () => {
        writeLocalCredential('analysis', '');
        $('#fcr-llm-key').val('');
        updateAnalysisControls();
        toastr.success('已删除此设备保存的分析 LLM Key。', '分析 LLM');
    });

    const profileFields = {
        '#fcr-work': 'workTitle',
        '#fcr-timeline': 'timeline',
        '#fcr-entities': 'entities',
        '#fcr-custom-wiki': 'customWikiApi',
    };
    for (const [selector, key] of Object.entries(profileFields)) {
        $(selector).on('change input', function () {
            profile()[key] = this.value;
            saveSettingsDebounced();
        });
    }
    $('#fcr-save-search-key').on('click', async () => {
        const provider = settings().searchProvider;
        const secretKey = SEARCH_SECRET_KEYS[provider];
        const value = String($('#fcr-search-key').val() ?? '').trim();
        if (!secretKey || !value) {
            toastr.warning('请先选择需要 Key 的搜索服务并填写 Key。', '搜索 API');
            return;
        }
        const id = await writeSecret(secretKey, value, `同人检索-${provider}`);
        $('#fcr-search-key').val('');
        updateApiControls();
        if (id) toastr.success(`${provider} Key 已安全保存。`, '搜索 API');
        else toastr.error('Key 保存失败，请查看酒馆后台。', '搜索 API');
    });
    $('#fcr-auto-fill').on('click', autoFillCurrentProfile);
    $('#fcr-test').on('click', async () => runPreflight(getContext().chat ?? [], 'manual', true));
    $('#fcr-clear-cache').on('click', () => {
        settings().cache = {};
        saveSettingsDebounced();
        updateReport('缓存已清空');
    });
    $('#fcr-clear-database').on('click', async () => {
        profile().canonDatabase = {};
        await clearCanonWorldBookEntries();
        saveSettingsDebounced();
        updateReport('当前角色卡的持久资料库及插件世界书条目已清空；下次生成会重新检索');
    });
}

async function openSettingsPopup() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
        $('#extensions_settings2').append(panelHtml());
        bindPanel();
        panel = document.getElementById(PANEL_ID);
    }
    if (!panel) {
        toastr.error('设置界面未能加载，请刷新酒馆。', '晋阳的同人库');
        return;
    }

    loadProfileIntoPanel();
    const home = document.createComment('fandom-canon-panel-home');
    panel.before(home);
    panel.classList.add('fcr-popup-mode');
    const content = panel.querySelector('.inline-drawer-content');
    if (content instanceof HTMLElement) content.style.display = 'block';

    await callGenericPopup(panel, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: '关闭',
        onClosing: () => {
            panel.classList.remove('fcr-popup-mode');
            if (content instanceof HTMLElement) content.style.display = '';
            home.replaceWith(panel);
            return true;
        },
    });
}

function installMainEntries() {
    const leftSendForm = document.getElementById('leftSendForm');
    const extensionsMenu = document.getElementById('extensionsMenu');

    if (leftSendForm && !document.getElementById(QUICK_BUTTON_ID)) {
        const button = document.createElement('div');
        button.id = QUICK_BUTTON_ID;
        button.className = 'fa-solid fa-book-atlas interactable';
        button.title = '晋阳的同人库';
        button.tabIndex = 0;
        button.addEventListener('click', openSettingsPopup);
        button.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') openSettingsPopup();
        });
        const wandButton = document.getElementById('extensionsMenuButton');
        if (wandButton) leftSendForm.insertBefore(button, wandButton);
        else leftSendForm.append(button);
    }

    if (extensionsMenu && !document.getElementById(MENU_ENTRY_ID)) {
        const entry = document.createElement('div');
        entry.id = MENU_ENTRY_ID;
        entry.className = 'list-group-item flex-container flexGap5';
        entry.title = '打开晋阳的同人库设置';
        entry.innerHTML = '<div class="fa-solid fa-book-atlas extensionsMenuExtensionButton" aria-hidden="true"></div><span>晋阳的同人库</span>';
        entry.addEventListener('click', openSettingsPopup);
        extensionsMenu.append(entry);
        document.getElementById('extensionsMenuButton')?.style.setProperty('display', 'flex');
    }

    return Boolean(leftSendForm && extensionsMenu);
}

async function refreshOrMigrateCanonDatabase() {
    if (!currentCharacter()) return;
    const cardProfile = profile();
    if ((cardProfile.canonDatabaseFormatVersion || 0) < 4) {
        await clearCanonWorldBookEntries();
        cardProfile.canonDatabase = {};
        cardProfile.canonDatabaseFormatVersion = 4;
        cardProfile.entities = cleanDetectedEntities(manualEntities(cardProfile.entities)).join('，');
        cardProfile.lastAutoEntities = cleanDetectedEntities(cardProfile.lastAutoEntities);
        saveSettingsDebounced();
        loadProfileIntoPanel();
        updateReport('已清除旧版错误混合资料，正在按角色分别重建完整基础档案…');
        runPreflight(getContext().chat ?? [], 'manual', true)
            .catch(error => console.error('[Fandom Canon] Could not rebuild canon database.', error));
        return;
    }
    const entities = Object.keys(storedCanonEntities());
    if (entities.length) await syncCanonDatabaseToWorldBook(entities);
}

function initialize() {
    settings();
    if (!document.getElementById(PANEL_ID)) {
        $('#extensions_settings2').append(panelHtml());
        bindPanel();
    }
    loadProfileIntoPanel();
    sanitizePersistedProfiles().catch(error => console.error('[Fandom Canon] Could not sanitize persisted profiles.', error));
    for (const delay of [1200, 3000, 7000]) {
        setTimeout(() => refreshOrMigrateCanonDatabase()
            .catch(error => console.error('[Fandom Canon] Could not migrate canon database.', error)), delay);
    }
    installMainEntries();
    const entryTimer = setInterval(() => {
        if (installMainEntries()) clearInterval(entryTimer);
    }, 500);
    setTimeout(() => clearInterval(entryTimer), 15000);
    const context = getContext();
    context.eventSource?.on?.(context.eventTypes?.CHAT_CHANGED ?? 'chat_changed', () => setTimeout(() => {
        loadProfileIntoPanel();
        refreshOrMigrateCanonDatabase()
            .catch(error => console.error('[Fandom Canon] Could not refresh canon database.', error));
    }, 150));
    console.info('[Fandom Canon] Loaded.');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}
