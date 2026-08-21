import {
    extension_prompt_roles,
    extension_prompt_types,
    generateQuietPrompt,
    getRequestHeaders,
    saveSettingsDebounced,
    setExtensionPrompt,
    updateMessageBlock,
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
const WORLD_ENTRY_MARKER = '·同人原作资料库·';
const SCENE_ENTRY_PREFIX = '【晋阳的同人库·当前场景】';
const SCENE_ENTRY_MARKER = '<!-- FCR_CURRENT_SCENE_V1 -->';
const SCENE_ENTRY_END_MARKER = '<!-- /FCR_CURRENT_SCENE_V1 -->';
const SCENE_SYNC_FORMAT_VERSION = 4;
const EXTENSION_VERSION = '2.4.1';
// Keep this history and CHANGELOG.md in sync for every release.
const RELEASE_HISTORY = [{
    version: '2.4.1',
    notes: [
        '生成后审核现在会优先对照用户最近明确写出的年份、年初/年底、季节或月份，只修正相互矛盾的时间短语。',
        '明确的用户时间锚点会同时约束当前场景和世界书，防止正文中的模糊时间反向污染资料库。',
        '时间核对只做本地文本比对，不增加搜索、分析请求或生成前等待。',
    ],
}, {
    version: '2.4.0',
    notes: [
        '修复生成后自动总结偶尔完全不触发的问题：消息接收、渲染完成与生成结束都会进入同一去重队列，并由后台巡检自动补跑遗漏。',
        '新增“当前场景”常驻世界书条目，自动同步作品、时间线、在场人物、地点和已发生状态；角色基础档案继续独立保存。',
        '场景分析失败会按退避自动重试并在设置页保留明确状态；刷新或升级后会自动补同步最新正文。',
        '新原作角色完成检索并写入档案后，会再次审核刚才的正文，自动修正首轮因缺少资料而漏掉的姓名、外貌或 OOC 问题。',
        '世界书写入改为串行队列，避免当前场景与角色档案同时保存时互相覆盖。',
        '插件升级、刷新或切换聊天后会检查最后一条完整助手正文，自动修复旧版本漏掉的场景同步。',
        '时间线明确切换时，已有角色档案的“当前剧情线”标题会一起刷新，避免和当前场景条目互相矛盾。',
        '若正文带有 NE-BANNER 场景横幅，以横幅中的人物、地点和时段为准重建快照，避免上一场景角色残留。',
        '用户/原创人物不会再被原作档案中的错误别名映射；检测到存量污染别名时会自动清理并同步世界书。',
    ],
}, {
    version: '2.3.9',
    notes: [
        '“AI识别并填写”改用同一套当前场景快照逻辑，替换旧自动项时会保留用户手动固定项。',
        '手动“立即检索”现在只核验和补充资料，不再把被提及但未在场的人物加入当前人物表。',
    ],
}, {
    version: '2.3.8',
    notes: [
        '当前人物/地点改为场景快照：自动项会随角色进场、离场和地点切换增减，不再永久累加。',
        '用户手动添加的人物或地点继续保留；离场角色的历史档案仍留在本卡资料库，回归时可以直接复用。',
        '作品、时间线和时间节点只在正文明确切换时更新，不允许分析模型自行推进剧情。',
        '场景状态更新与生成后 OOC 审核合并为一次异步分析请求，不阻塞正文，也不额外重复调用分析 API。',
    ],
}, {
    version: '2.3.7',
    notes: [
        '正常生成改为立即放行，不再在正文生成前调用分析或搜索 API，避免插件导致等待、空回复或额外 429。',
        '手动核验只识别用户最新输入中明确点名的对象，不再从角色卡、世界书或历史剧情推测下一位登场角色。',
        '生成后审核只检查正文中实际出现的角色，并严格禁止改变剧情走向、登场角色、行动结果和场景顺序。',
        '自动修订仅允许替换最短冲突片段，并增加长度与扩写限制，防止审核模型整段重写正文。',
    ],
}];
const RELEASE_NOTES = RELEASE_HISTORY[0].notes;
const DEFAULTS = {
    enabled: true,
    language: 'zh',
    autoPlanner: true,
    autoUpdateProfile: true,
    strictMode: true,
    reviewEnabled: true,
    maxQueries: 3,
    pagesPerQuery: 2,
    cacheMinutes: 360,
    searchWaitSeconds: 15,
    newEntityWaitSeconds: 60,
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
let lastRunSignature = '';
let lastReferenceText = '';
let conversationTransition = null;
const scopeEpochs = new Map();
const inFlightResearch = new Map();
const inFlightSceneReviews = new Map();
const scheduledSceneReviews = new Map();
const worldBookWriteQueues = new Map();
const SCENE_RETRY_DELAYS_MS = [5000, 15000, 45000];

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

function releaseNotesStorageKey() {
    return `${LOCAL_CREDENTIAL_PREFIX}:${getCurrentUserHandle()}:release-notes-seen`;
}

function releaseNotesListHtml(notes = RELEASE_NOTES) {
    return `<ul>${notes.map(note => `<li>${note}</li>`).join('')}</ul>`;
}

function releaseHistoryHtml() {
    return RELEASE_HISTORY.map(release => `<section class="fcr-release-version"><b>v${release.version}</b>${releaseNotesListHtml(release.notes)}</section>`).join('');
}

async function showReleaseNotesOnce() {
    const storageKey = releaseNotesStorageKey();
    try {
        if (localStorage.getItem(storageKey) === EXTENSION_VERSION) return;
        localStorage.setItem(storageKey, EXTENSION_VERSION);
    } catch (error) {
        console.warn('[Fandom Canon] Unable to persist release-note state.', error);
    }

    const content = document.createElement('div');
    content.className = 'fcr-release-popup';
    content.innerHTML = `<h3><i class="fa-solid fa-clock-rotate-left"></i> 晋阳的同人库 v${EXTENSION_VERSION}</h3>${releaseNotesListHtml()}<p>以后每次更新都会在这里显示本版改动，完整历史也会保留在设置页。</p>`;
    await callGenericPopup(content, POPUP_TYPE.TEXT, '', {
        wide: false,
        large: false,
        allowVerticalScrolling: true,
        okButton: '知道了',
    });
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

// 分析/搜索 LLM 请求的兜底超时：防止中转挂起导致规划阶段永久卡住 busy。
const LLM_FETCH_TIMEOUT_MS = 150000;

async function directApiFetch(url, options, label) {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            const detail = (await response.text()).slice(0, 500);
            throw new Error(`${label}失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
        }
        return response;
    } catch (error) {
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
            throw new Error(`${label}超时：服务器长时间无响应`);
        }
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
            signal: AbortSignal.timeout(LLM_FETCH_TIMEOUT_MS),
        }, label);
        return await response.json();
    } catch (directError) {
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            signal: AbortSignal.timeout(LLM_FETCH_TIMEOUT_MS),
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

function currentConversationId() {
    return String(getContext().chatId || '').trim();
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
    cardProfile.currentScene ??= null;
    cardProfile.sceneSync ??= {
        status: 'idle',
        signature: '',
        messageId: null,
        updatedAt: 0,
        error: '',
        formatVersion: 0,
    };
    return cardProfile;
}

function scopeIdentity(targetProfileKey = profileKey(), targetConversationId = currentConversationId()) {
    return `${targetProfileKey}\u0000${targetConversationId}`;
}

function clearRuntimeState(targetProfileKey = profileKey(), targetConversationId = currentConversationId()) {
    const targetScope = scopeIdentity(targetProfileKey, targetConversationId);
    scopeEpochs.set(targetScope, (scopeEpochs.get(targetScope) || 0) + 1);
    busy = false;
    lastRunSignature = '';
    lastReferenceText = '';
    for (const key of inFlightResearch.keys()) {
        if (key.startsWith(`${targetScope}|`)) inFlightResearch.delete(key);
    }
    for (const signature of reviewedMessageSignatures) {
        if (signature.startsWith(`${targetScope}|`)) reviewedMessageSignatures.delete(signature);
    }
    for (const [key, timer] of scheduledSceneReviews) {
        if (!key.startsWith(`${targetScope}|`)) continue;
        clearTimeout(timer);
        scheduledSceneReviews.delete(key);
    }
    setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
}

function clearConversationProfile(cardProfile, conversationId = currentConversationId()) {
    cardProfile.workTitle = '';
    cardProfile.timeline = '';
    cardProfile.entities = '';
    cardProfile.customWikiApi = '';
    cardProfile.lastAutoWorkTitle = '';
    cardProfile.lastAutoTimeline = '';
    cardProfile.lastAutoEntities = [];
    cardProfile.canonDatabase = {};
    cardProfile.canonWorldBook = '';
    cardProfile.canonDatabaseFormatVersion = 4;
    cardProfile.currentScene = null;
    cardProfile.sceneSync = {
        status: 'idle',
        signature: '',
        messageId: null,
        updatedAt: 0,
        error: '',
        formatVersion: SCENE_SYNC_FORMAT_VERSION,
    };
    cardProfile.conversationId = conversationId;
}

function profileHasConversationData(cardProfile = profile()) {
    return Boolean(
        String(cardProfile.workTitle || '').trim()
        || String(cardProfile.timeline || '').trim()
        || String(cardProfile.entities || '').trim()
        || String(cardProfile.customWikiApi || '').trim()
        || String(cardProfile.canonWorldBook || '').trim()
        || Object.keys(cardProfile.canonDatabase || {}).length
        || cleanDetectedEntities(cardProfile.lastAutoEntities).length
        || Boolean(cardProfile.currentScene)
    );
}

function captureScopeToken() {
    const currentProfileKey = profileKey();
    const conversationId = currentConversationId();
    const scope = scopeIdentity(currentProfileKey, conversationId);
    return {
        epoch: scopeEpochs.get(scope) || 0,
        profileKey: currentProfileKey,
        conversationId,
    };
}

function scopeTokenIsCurrent(token) {
    const currentProfileKey = profileKey();
    const conversationId = currentConversationId();
    const scope = scopeIdentity(currentProfileKey, conversationId);
    return token?.epoch === (scopeEpochs.get(scope) || 0)
        && token?.profileKey === currentProfileKey
        && token?.conversationId === conversationId;
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
            .replace(/<!-- FCR_CANON_DATABASE_V2 -->[\s\S]*?<!-- \/FCR_CANON_DATABASE_V2 -->/g, '')
            .replace(/<!-- FCR_CURRENT_SCENE_V1 -->[\s\S]*?<!-- \/FCR_CURRENT_SCENE_V1 -->/g, '');
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

function cleanEntityCandidates(values) {
    const candidates = [];
    for (const value of Array.isArray(values) ? values : []) {
        const raw = typeof value === 'string' ? { candidateName: value } : (value || {});
        const candidateName = normalizeEntityDisplay(raw.candidateName ?? raw.name ?? raw.entity ?? '');
        if (!cleanDetectedEntities([candidateName]).length) continue;
        const key = canonicalEntityKey(candidateName);
        if (candidates.some(item => canonicalEntityKey(item.candidateName) === key)) continue;
        candidates.push({
            candidateName,
            isOriginal: raw.isOriginal === true,
            workHint: String(raw.workHint ?? raw.work ?? '').trim(),
            contextEvidence: String(raw.contextEvidence ?? raw.evidence ?? '').trim(),
        });
    }
    return candidates.slice(0, 40);
}

function cleanSceneEntityCandidates(values) {
    const candidates = [];
    for (const value of Array.isArray(values) ? values : []) {
        const raw = typeof value === 'string' ? { candidateName: value } : (value || {});
        const candidate = cleanEntityCandidates([raw])[0];
        if (!candidate) continue;
        const kind = String(raw.kind ?? raw.type ?? '').toLowerCase();
        if (!['character', 'location'].includes(kind)) continue;
        if (candidates.some(item => canonicalEntityKey(item.candidateName) === canonicalEntityKey(candidate.candidateName))) continue;
        candidates.push({ ...candidate, kind });
    }
    return candidates.slice(0, 40);
}

function recordAliases(record, fallbackName = '') {
    return cleanDetectedEntities([
        fallbackName,
        record?.entity,
        ...(Array.isArray(record?.aliases) ? record.aliases : []),
    ]);
}

function findCanonRecordName(candidate, database = storedCanonEntities()) {
    const key = canonicalEntityKey(candidate);
    if (!key) return '';
    return Object.entries(database).find(([name, record]) =>
        recordAliases(record, name).some(alias => canonicalEntityKey(alias) === key))?.[0] || '';
}

function resolveCanonEntityName(candidate, database = storedCanonEntities()) {
    return findCanonRecordName(candidate, database) || normalizeEntityDisplay(candidate);
}

function normalizeChangeText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '')
        .replace(/[的了着]/g, '');
}

function textBigrams(value) {
    const normalized = normalizeChangeText(value);
    if (normalized.length < 2) return new Set([normalized]);
    return new Set(Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2)));
}

function changesAreEquivalent(left, right) {
    const a = normalizeChangeText(left);
    const b = normalizeChangeText(right);
    if (!a || !b) return false;
    if (a === b || (Math.min(a.length, b.length) >= 18 && (a.includes(b) || b.includes(a)))) return true;
    const aPairs = textBigrams(a);
    const bPairs = textBigrams(b);
    const intersection = [...aPairs].filter(pair => bPairs.has(pair)).length;
    const union = new Set([...aPairs, ...bPairs]).size;
    return union > 0 && intersection / union >= 0.78;
}

function cleanCanonChanges(values) {
    return (Array.isArray(values) ? values : [])
        .map(value => typeof value === 'string' ? value : value?.change)
        .map(value => String(value ?? '').trim())
        .filter(Boolean);
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
    const database = storedCanonEntities();
    const latestUserText = String([...((Array.isArray(chat) ? chat : []))]
        .reverse().find(message => message?.is_user && message?.mes)?.mes ?? '');
    const explicitlyStoredEntities = relevantCanonRecords(latestUserText, database)
        .map(record => record.entity);

    if (!config.autoPlanner) {
        return {
            work,
            timeline: cardProfile.timeline.trim(),
            entities: cleanDetectedEntities(explicitlyStoredEntities),
            timelineChanged: false,
            queries: [],
        };
    }

    const source = await researchContext(chat);
    const existingChanges = Object.values(database).flatMap(record => Array.isArray(record?.canonChanges) ? record.canonChanges : []);
    const plannerPrompt = `你是同人正文的原作事实核验器，不是编剧、导演或剧情规划器。你只能识别用户最新输入中已经逐字点名的原作人物、地点、组织或物品，以便核对这些对象的姓名与设定。严禁预测、建议或选择下一位登场角色，严禁把角色卡、世界书、历史剧情或资料库里出现但用户最新输入没有点名的对象放入 entities。角色卡和世界书仅用于判断作品归属与用户明确 AU，不是候选人物清单。\n\n作品（当前表值）：${work || '未填写，请从背景判断'}\n当前时间线/AU节点（上轮表值）：${cardProfile.timeline || '未填写'}\n已经保存的 AU 差异（不得重复返回或改写复述）：\n${existingChanges.length ? existingChanges.join('\n') : '无'}\n\n用户最新输入（entities 中的 candidateName 必须是这里逐字出现的连续文本）：\n${latestUserText || '无'}\n\n角色卡背景（只能用于作品和 AU 判断）：\n${source.card || '未读取到'}\n\n本轮实际激活世界书（只能用于作品和 AU 判断）：\n${source.worldInfo || '无'}\n\n只输出 JSON，不写解释：{"work":"有明确证据的原作名，否则沿用当前作品","storyType":"canon_timeline|au_timeline|original_world_with_fandom_characters|original_only|unknown","timeline":"仅在用户最新输入明确改变时填写当前剧情线","timelineChanged":false,"entities":[{"candidateName":"必须逐字摘自用户最新输入","isOriginal":false,"workHint":"该对象实际所属作品；不确定留空","contextEvidence":"逐字摘录用户点名该对象的短语"}],"canonChanges":["仅写用户最新输入首次明确声明的新 AU 差异；格式为角色正式名：变化"],"queries":["仅用于用户明确点名的新对象，或用户明确改变时间线后需要补查的官方设定"]}\n规则：没有逐字点名的对象必须省略，代词、暗示、可能登场、即将发生、角色卡预设对象、世界书候选对象和历史中曾出现的对象都不得返回。逐个判断对象是否为用户原创；原创对象 isOriginal=true，不外搜。queries 最多 ${config.maxQueries} 条；不得使用“兄妹”“冒险”“OC”等泛称或角色卡标题。只有用户最新输入明确宣布篇章、原作事件阶段或 AU 关键状态跨越到不同节点时，timelineChanged 才能为 true；普通对话、日常推进、换地点、时间流逝和模型自行推断都必须为 false。你的输出只用于事实核验，绝不能参与剧情走向。`;

    try {
        const parsed = await runJsonAnalysisPrompt(plannerPrompt, 1800);
        const manualWork = work && work !== cardProfile.lastAutoWorkTitle ? work : '';
        const plannedWork = manualWork || String(parsed.work ?? '').trim() || work;
        const detectedCandidates = cleanEntityCandidates(parsed.entities)
            .filter(item => latestUserText.toLowerCase().includes(item.candidateName.toLowerCase()));
        const detectedCanonCandidates = detectedCandidates.filter(item => !item.isOriginal);
        const detectedEntities = cleanDetectedEntities(detectedCanonCandidates.map(item => item.candidateName));
        const entities = [...new Set([...explicitlyStoredEntities, ...detectedEntities])].slice(0, 8);
        let deltaQueries = Array.isArray(parsed.queries) ? parsed.queries.map(String) : [];
        deltaQueries = deltaQueries.map(x => x.trim()).filter(Boolean).map(x => {
            if (!shouldAttachWorkTitle(plannedWork) || x.includes(plannedWork)) return x;
            return `${x} ${plannedWork}`;
        });
        deltaQueries = cleanPlannedQueries(deltaQueries, plannedWork);
        const newEntities = entities.filter(entity => !findCanonRecordName(entity, database));
        const baselineQueries = newEntities.map(entity => {
            const candidate = detectedCanonCandidates.find(item => canonicalEntityKey(item.candidateName) === canonicalEntityKey(entity));
            const workHint = candidate?.workHint || (shouldAttachWorkTitle(plannedWork) ? plannedWork : '');
            return `${entity} ${workHint} 核对正式姓名及原作完整角色档案：身份、年龄、外貌身材、典型穿着、性格行为逻辑、能力、重要经历、人际关系、说话风格`.trim();
        });
        const proposedTimeline = String(parsed.timeline ?? '').trim();
        const actualTimelineChanged = parsed.timelineChanged === true
            && normalizeChangeText(proposedTimeline) !== normalizeChangeText(cardProfile.timeline);
        const queries = baselineQueries.length
            ? baselineQueries
            : (actualTimelineChanged ? deltaQueries : []);
        const manualTimeline = cardProfile.timeline.trim() && cardProfile.timeline.trim() !== cardProfile.lastAutoTimeline
            ? cardProfile.timeline.trim()
            : '';
        const inferredTimeline = actualTimelineChanged
            ? proposedTimeline
            : cardProfile.timeline.trim();
        return {
            work: plannedWork,
            timeline: manualTimeline || (parsed.storyType === 'original_world_with_fandom_characters' || parsed.storyType === 'original_only'
                ? '用户原创世界（仅含同人角色，非原作剧情）'
                : inferredTimeline) || cardProfile.timeline.trim(),
            entities: cleanDetectedEntities(entities.map(entity => resolveCanonEntityName(entity, database))),
            entityCandidates: detectedCanonCandidates,
            autoEntities: cleanDetectedEntities(detectedEntities.map(entity => resolveCanonEntityName(entity, database))),
            canonChanges: cleanCanonChanges(parsed.canonChanges),
            timelineChanged: actualTimelineChanged,
            researchMode: baselineQueries.length ? 'new_entities' : (queries.length ? 'official_delta' : 'none'),
            queries: [...new Set(queries)].slice(0, config.maxQueries),
        };
    } catch (error) {
        console.warn('[Fandom Canon] Fact checker failed; using only stored entities explicitly named by the user.', error);
        return {
            work,
            timeline: cardProfile.timeline.trim(),
            entities: cleanDetectedEntities(explicitlyStoredEntities),
            timelineChanged: false,
            queries: [],
        };
    }
}

function syncProfileFromPlan(plan) {
    if (!settings().autoUpdateProfile || !plan) return;
    const cardProfile = profile();
    const before = JSON.stringify({
        workTitle: cardProfile.workTitle,
        timeline: cardProfile.timeline,
        entities: cardProfile.entities,
        lastAutoWorkTitle: cardProfile.lastAutoWorkTitle,
        lastAutoTimeline: cardProfile.lastAutoTimeline,
        lastAutoEntities: cardProfile.lastAutoEntities,
    });
    const currentEntities = manualEntities(cardProfile.entities);
    const previousAutoEntities = cleanDetectedEntities(cardProfile.lastAutoEntities);
    const previousAutoKeys = new Set(previousAutoEntities.map(canonicalEntityKey));
    const manualFixed = currentEntities.filter(entity => !previousAutoKeys.has(canonicalEntityKey(entity)));
    const database = storedCanonEntities();
    const newlyDetectedEntities = cleanDetectedEntities(plan.autoEntities ?? plan.entities)
        .map(entity => resolveCanonEntityName(entity, database));
    const nextAutoEntities = plan.replaceAutoEntities === true
        ? [...new Set(newlyDetectedEntities)].slice(0, 40)
        : [...new Set([...previousAutoEntities, ...newlyDetectedEntities])].slice(0, 40);
    const nextEntities = [...new Set([...manualFixed, ...nextAutoEntities])].slice(0, 40);

    if (plan.work && (!cardProfile.workTitle || cardProfile.workTitle === cardProfile.lastAutoWorkTitle)) {
        cardProfile.workTitle = plan.work;
        cardProfile.lastAutoWorkTitle = plan.work;
    }
    if (plan.timeline && (!cardProfile.timeline || cardProfile.timeline === cardProfile.lastAutoTimeline)) {
        cardProfile.timeline = plan.timeline;
        cardProfile.lastAutoTimeline = plan.timeline;
    }
    if (plan.updateEntities !== false) {
        cardProfile.entities = nextEntities.join('，');
        cardProfile.lastAutoEntities = nextAutoEntities;
    }
    const after = JSON.stringify({
        workTitle: cardProfile.workTitle,
        timeline: cardProfile.timeline,
        entities: cardProfile.entities,
        lastAutoWorkTitle: cardProfile.lastAutoWorkTitle,
        lastAutoTimeline: cardProfile.lastAutoTimeline,
        lastAutoEntities: cardProfile.lastAutoEntities,
    });
    if (before !== after) {
        saveSettingsDebounced();
        loadProfileIntoPanel();
    }
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

function wikiQueryVariants(query) {
    const raw = String(query ?? '').trim();
    if (!raw) return [];
    const compact = raw
        .replace(/\s+(?:核对正式姓名(?:及原作)?(?:完整角色档案)?|原作完整角色档案|完整角色档案|角色档案)\s*[：:]?[\s\S]*$/i, '')
        .trim();
    return [...new Set([compact, raw].filter(Boolean))];
}

async function searchWikiOnce(apiUrl, searchQuery, resultQuery, sourceName) {
    const config = settings();
    const url = new URL(apiUrl);
    url.search = new URLSearchParams({
        action: 'query',
        generator: 'search',
        gsrsearch: searchQuery,
        gsrlimit: String(config.pagesPerQuery),
        prop: 'extracts|info',
        explaintext: '1',
        exintro: '1',
        exchars: String(Math.min(1200, config.maxPageChars)),
        exlimit: String(Math.min(20, config.pagesPerQuery)),
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
        query: resultQuery,
    }));
    if (!pages.length && candidates.length) {
        const fallback = await Promise.allSettled(candidates
            .map(page => fetchWikiFallback(apiUrl, page, sourceName, resultQuery)));
        pages.push(...fallback.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []));
    }
    return pages;
}

async function searchWiki(apiUrl, query, sourceName) {
    const config = settings();
    const key = `${apiUrl}|${query}`;
    const cached = config.cache[key];
    const maxAge = config.cacheMinutes * 60 * 1000;
    if (cached?.at && Date.now() - cached.at < maxAge && Array.isArray(cached.pages) && cached.pages.length) {
        return cached.pages;
    }

    let lastError = null;
    for (const searchQuery of wikiQueryVariants(query)) {
        try {
            const pages = await searchWikiOnce(apiUrl, searchQuery, query, sourceName);
            if (!pages.length) continue;
            // Empty results can be temporary, so only successful lookups are cached.
            config.cache[key] = { at: Date.now(), pages };
            pruneCache();
            saveSettingsDebounced();
            return pages;
        } catch (error) {
            lastError = error;
        }
    }
    if (lastError) throw lastError;
    return [];
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
        signal: AbortSignal.timeout(180000),
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
            title: String(record?.canonicalName || record?.entity || '').trim(),
            url: data?.sources?.[0]?.url || '',
            extract: String(record?.summary || '').trim(),
            candidateName: String(record?.candidateName || record?.candidate || '').trim(),
            canonicalName: String(record?.canonicalName || record?.entity || '').trim(),
            originalName: String(record?.originalName || '').trim(),
            workTitle: String(record?.workTitle || '').trim(),
            aliases: Array.isArray(record?.aliases) ? record.aliases.map(String) : [],
            verified: record?.verified !== false,
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
    return `${entity}${WORLD_ENTRY_MARKER}${profileKey()}`;
}

// 兼容两种条目标题：旧版前缀式（【同人原作资料库·插件自动维护】卡·角色）与
// 新版角色名在前式（角色·同人原作资料库·卡）。只认属于当前资料档案的条目。
function parseWorldEntryComment(comment, expectedProfileKey) {
    const text = String(comment || '');
    if (text.startsWith(WORLD_ENTRY_PREFIX)) {
        const rest = text.slice(WORLD_ENTRY_PREFIX.length);
        return rest.startsWith(`${expectedProfileKey}·`) ? rest.slice(expectedProfileKey.length + 1) : '';
    }
    const markerIndex = text.indexOf(WORLD_ENTRY_MARKER);
    if (markerIndex > 0 && text.slice(markerIndex + WORLD_ENTRY_MARKER.length) === expectedProfileKey) {
        return text.slice(0, markerIndex);
    }
    return '';
}

function sceneEntryComment(targetProfileKey = profileKey()) {
    return `${SCENE_ENTRY_PREFIX}${targetProfileKey}`;
}

function isSceneEntryComment(comment, expectedProfileKey = profileKey()) {
    return String(comment || '') === sceneEntryComment(expectedProfileKey);
}

async function enqueueWorldBookWrite(worldName, task) {
    const key = String(worldName || '').trim();
    if (!key) return false;
    const previous = worldBookWriteQueues.get(key) || Promise.resolve();
    const job = previous.catch(() => undefined).then(task);
    worldBookWriteQueues.set(key, job);
    try {
        return await job;
    } finally {
        if (worldBookWriteQueues.get(key) === job) worldBookWriteQueues.delete(key);
    }
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
            aliases: cleanDetectedEntities(names.flatMap((name, index) => recordAliases(records[index], name))),
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
        let worldChanged = false;
        for (const [uid, entry] of Object.entries(data.entries)) {
            const entity = parseWorldEntryComment(entry?.comment, savedProfileKey);
            if (!entity) continue;
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
    const profileText = String(record.profile || '').trim();
    const seen = new Set();
    const extracts = profileText || (record.sources || [])
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
    const scopeToken = captureScopeToken();
    const worldName = currentWorldBookName();
    if (!worldName) return false;
    return await enqueueWorldBookWrite(worldName, async () => {
        const data = await loadWorldInfo(worldName);
        if (!scopeTokenIsCurrent(scopeToken)) return false;
        if (!data?.entries) return false;
        const database = storedCanonEntities();
        const databaseChanged = sanitizeCanonDatabase(database);
        const characterFile = String(currentCharacter()?.avatar || currentCharacter()?.name || '').replace(/\.[^.]+$/, '');
        let changed = false;
        const seenEntities = new Set();
        for (const [uid, entry] of Object.entries(data.entries)) {
            const entity = parseWorldEntryComment(entry?.comment, profileKey());
            if (!entity) continue;
            const duplicate = seenEntities.has(entity);
            seenEntities.add(entity);
            if (!duplicate && cleanDetectedEntities([entity]).length && database[entity]?.sources?.length) continue;
            delete data.entries[uid];
            if (!duplicate) delete database[entity];
            changed = true;
        }
        for (const entity of cleanDetectedEntities(entities)) {
            const record = database[entity];
            if (!record?.sources?.length) continue;
            const comment = worldEntryComment(entity);
            let entry = Object.values(data.entries).find(item => parseWorldEntryComment(item?.comment, profileKey()) === entity);
            let isNew = false;
            if (!entry) {
                entry = createWorldInfoEntry(worldName, data);
                if (!entry) continue;
                isNew = true;
            }
            const desired = {
                key: recordAliases(record, entity),
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
            };
            const needsUpdate = isNew || Object.entries(desired)
                .some(([key, value]) => JSON.stringify(entry[key]) !== JSON.stringify(value));
            if (needsUpdate) {
                Object.assign(entry, desired);
                changed = true;
            }
        }
        if (changed || databaseChanged) {
            if (!scopeTokenIsCurrent(scopeToken)) return false;
            await saveWorldInfo(worldName, data, true);
            if (!scopeTokenIsCurrent(scopeToken)) return false;
            reloadEditor(worldName, false);
            profile().canonWorldBook = worldName;
            saveSettingsDebounced();
        }
        return changed;
    });
}

function formatCurrentSceneWorldEntry(snapshot) {
    const characters = cleanDetectedEntities(snapshot?.characters);
    const locations = cleanDetectedEntities(snapshot?.locations);
    const pinned = cleanDetectedEntities(snapshot?.pinned);
    const summary = stripMarkup(snapshot?.summary || '').trim();
    return `${SCENE_ENTRY_MARKER}
用途：这是当前聊天已经发生的场景状态，不是剧情提纲；续写必须从这里衔接，不得把已离场人物重新视为在场。
作品：${snapshot?.workTitle || '未确认'}
当前时间线：${snapshot?.timeline || '未确认'}
当前人物：${characters.join('、') || '无明确在场人物'}
当前地点：${locations.join('、') || '未确认'}
用户手动固定：${pinned.join('、') || '无'}
当前状态：${summary || '仅按上列人物、地点与时间线衔接'}
${SCENE_ENTRY_END_MARKER}`;
}

async function syncCurrentSceneToWorldBook(snapshot, scopeToken = captureScopeToken()) {
    const worldName = currentWorldBookName() || String(profile().canonWorldBook || '').trim();
    if (!worldName || !snapshot) return false;
    return await enqueueWorldBookWrite(worldName, async () => {
        const data = await loadWorldInfo(worldName);
        if (!scopeTokenIsCurrent(scopeToken) || !data?.entries) return false;
        const matches = Object.entries(data.entries)
            .filter(([, entry]) => isSceneEntryComment(entry?.comment, profileKey()));
        let entry = matches[0]?.[1];
        let changed = false;
        for (const [uid] of matches.slice(1)) {
            delete data.entries[uid];
            changed = true;
        }
        if (!entry) {
            entry = createWorldInfoEntry(worldName, data);
            if (!entry) return false;
            changed = true;
        }
        const characterFile = String(currentCharacter()?.avatar || currentCharacter()?.name || '').replace(/\.[^.]+$/, '');
        const desired = {
            key: [],
            keysecondary: [],
            comment: sceneEntryComment(),
            content: formatCurrentSceneWorldEntry(snapshot),
            constant: true,
            selective: false,
            addMemo: true,
            order: 110,
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
        };
        if (Object.entries(desired).some(([key, value]) => JSON.stringify(entry[key]) !== JSON.stringify(value))) {
            Object.assign(entry, desired);
            changed = true;
        }
        if (!changed) return false;
        if (!scopeTokenIsCurrent(scopeToken)) return false;
        await saveWorldInfo(worldName, data, true);
        if (!scopeTokenIsCurrent(scopeToken)) return false;
        reloadEditor(worldName, false);
        profile().canonWorldBook = worldName;
        saveSettingsDebounced();
        return true;
    });
}

async function clearCanonWorldBookEntries(targetProfileKey = profileKey(), targetWorldName = currentWorldBookName()) {
    const worldName = String(targetWorldName || '').trim();
    if (!worldName) return;
    await enqueueWorldBookWrite(worldName, async () => {
        const data = await loadWorldInfo(worldName);
        if (!data?.entries) return false;
        let changed = false;
        for (const [uid, entry] of Object.entries(data.entries)) {
            if (parseWorldEntryComment(entry?.comment, targetProfileKey) || isSceneEntryComment(entry?.comment, targetProfileKey)) {
                delete data.entries[uid];
                changed = true;
            }
        }
        if (changed) {
            await saveWorldInfo(worldName, data, true);
            reloadEditor(worldName, false);
        }
        return changed;
    });
}

async function clearProfileWorldBookEntries(cardProfile, targetProfileKey = profileKey()) {
    const worldNames = [...new Set([
        currentWorldBookName(),
        String(cardProfile?.canonWorldBook || '').trim(),
    ].filter(Boolean))];
    for (const worldName of worldNames) {
        await clearCanonWorldBookEntries(targetProfileKey, worldName);
    }
}

async function resetCurrentConversationData({ reason = '已重置当前聊天的全部同人资料' } = {}) {
    const cardProfile = profile();
    const targetProfileKey = profileKey();
    const conversationId = currentConversationId();
    clearRuntimeState();
    await clearProfileWorldBookEntries(cardProfile, targetProfileKey);
    clearConversationProfile(cardProfile, conversationId);
    saveSettingsDebounced();
    loadProfileIntoPanel();
    updateReport(reason);
}

async function ensureConversationScope() {
    if (conversationTransition) await conversationTransition;
    const conversationId = currentConversationId();
    if (!conversationId) return false;

    const cardProfile = profile();
    if (!cardProfile.conversationId) {
        cardProfile.conversationId = conversationId;
        saveSettingsDebounced();
        return false;
    }
    if (cardProfile.conversationId === conversationId) return false;

    const previousConversationId = cardProfile.conversationId;
    const targetProfileKey = profileKey();
    conversationTransition = (async () => {
        clearRuntimeState();
        await clearProfileWorldBookEntries(cardProfile, targetProfileKey);
        clearConversationProfile(cardProfile, conversationId);
        saveSettingsDebounced();
        loadProfileIntoPanel();
        updateReport(`检测到同一角色卡已切换到新聊天；旧聊天“${previousConversationId}”的插件资料已隔离并清空`);
    })().finally(() => {
        conversationTransition = null;
    });
    await conversationTransition;
    return true;
}

async function reconcileDeletedWorldBookEntries() {
    const scopeToken = captureScopeToken();
    const cardProfile = profile();
    const database = storedCanonEntities();
    const recordNames = Object.keys(database);
    const worldName = String(cardProfile.canonWorldBook || '').trim();
    if (!recordNames.length || !worldName) return false;
    const data = await loadWorldInfo(worldName);
    if (!scopeTokenIsCurrent(scopeToken)) return false;

    const presentEntities = new Set(Object.values(data?.entries || {})
        .map(entry => parseWorldEntryComment(entry?.comment, profileKey()))
        .filter(Boolean)
        .map(canonicalEntityKey));
    const removedRecords = recordNames.filter(name => !presentEntities.has(canonicalEntityKey(name)));
    if (!removedRecords.length) return false;

    const removedAliases = new Set(removedRecords
        .flatMap(name => [name, ...recordAliases(database[name], name)])
        .map(canonicalEntityKey));
    for (const name of removedRecords) delete database[name];
    const keepEntity = name => !removedAliases.has(canonicalEntityKey(name));
    cardProfile.entities = manualEntities(cardProfile.entities).filter(keepEntity).join('，');
    cardProfile.lastAutoEntities = cleanDetectedEntities(cardProfile.lastAutoEntities).filter(keepEntity);
    clearRuntimeState();
    saveSettingsDebounced();
    loadProfileIntoPanel();
    updateReport(`检测到世界书中手动删除了 ${removedRecords.join('、')}；对应插件资料已同步清除，不会再次自动重建`);
    return true;
}

function targetRecordsForChange(change, planEntities, database) {
    const normalizedChange = normalizeChangeText(change);
    const matches = Object.entries(database).filter(([name, record]) =>
        recordAliases(record, name).some(alias => normalizedChange.includes(normalizeChangeText(alias))));
    if (matches.length) return matches.map(([name]) => name);
    const planned = cleanDetectedEntities(planEntities)
        .map(entity => findCanonRecordName(entity, database) || normalizeEntityDisplay(entity))
        .filter(Boolean);
    const explicitlyMentioned = planned.filter(name => normalizedChange.includes(normalizeChangeText(name)));
    if (explicitlyMentioned.length) return explicitlyMentioned;
    return planned.length === 1 ? planned : [];
}

function novelChangesForRecord(changes, recordName, planEntities, database) {
    const existing = Array.isArray(database[recordName]?.canonChanges) ? database[recordName].canonChanges : [];
    return cleanCanonChanges(changes)
        .filter(change => targetRecordsForChange(change, planEntities, database).includes(recordName))
        .filter(change => !existing.some(saved => changesAreEquivalent(change, saved)))
        .filter((change, index, array) => !array.slice(0, index).some(saved => changesAreEquivalent(change, saved)));
}

async function persistCanonDeltas(plan) {
    const database = storedCanonEntities();
    const changedEntities = new Set();
    for (const recordName of Object.keys(database)) {
        const record = database[recordName];
        const additions = novelChangesForRecord(plan.canonChanges, recordName, plan.entities, database);
        const timelineChanged = plan.timelineChanged
            && cleanDetectedEntities(plan.entities).some(entity => findCanonRecordName(entity, database) === recordName)
            && normalizeChangeText(record.timeline) !== normalizeChangeText(plan.timeline);
        if (!additions.length && !timelineChanged) continue;
        if (additions.length) record.canonChanges = [...(Array.isArray(record.canonChanges) ? record.canonChanges : []), ...additions];
        if (timelineChanged) record.timeline = plan.timeline;
        record.updatedAt = Date.now();
        changedEntities.add(recordName);
    }
    if (!changedEntities.size) return [];
    saveSettingsDebounced();
    await syncCanonDatabaseToWorldBook([...changedEntities]);
    return [...changedEntities];
}

async function saveCanonResearch(plan, pages) {
    if (!Array.isArray(pages) || !pages.length) return;
    const database = storedCanonEntities();
    const planEntities = cleanDetectedEntities(plan.entities);
    sanitizeCanonDatabase(database);
    const replacements = new Map();
    const modifiedEntities = new Set();
    for (const entity of planEntities) {
        const matchesEntity = page => {
            const names = cleanDetectedEntities([
                page?.candidateName,
                page?.canonicalName,
                page?.originalName,
                page?.title,
                ...(Array.isArray(page?.aliases) ? page.aliases : []),
            ]);
            return names.some(name => canonicalEntityKey(name) === canonicalEntityKey(entity));
        };
        const canonicalPage = pages.find(page => page.source === '自定义搜索 AI' && page.verified !== false && matchesEntity(page));
        const canonicalName = cleanDetectedEntities([canonicalPage?.canonicalName || canonicalPage?.title])[0] || resolveCanonEntityName(entity, database);
        const previousName = findCanonRecordName(entity, database) || findCanonRecordName(canonicalName, database);
        const previous = database[previousName] || database[canonicalName];
        const aliases = cleanDetectedEntities([
            entity,
            canonicalName,
            previousName,
            ...(Array.isArray(previous?.aliases) ? previous.aliases : []),
            canonicalPage?.candidateName,
            canonicalPage?.originalName,
            ...(Array.isArray(canonicalPage?.aliases) ? canonicalPage.aliases : []),
        ]);
        const previousSources = Array.isArray(previous?.sources) ? previous.sources : [];
        const relevant = pages.filter(page => page.source !== '自定义搜索 AI' || matchesEntity(page)).map(page => ({
            ...page,
            title: page.source === '自定义搜索 AI' ? canonicalName : page.title,
            extract: extractEntitySpecificText(page.extract, canonicalName, [...planEntities, ...aliases]),
        })).filter(page => page.extract && ([
            page.title,
            page.extract,
            page.query,
        ].some(value => aliases.some(alias => String(value ?? '').toLowerCase().includes(alias.toLowerCase())))))
            .filter(page => !previousSources.some(source => changesAreEquivalent(page.extract, source.extract)));
        if (!relevant.length && !previous?.sources?.length) continue;
        const mergedSources = [...previousSources, ...relevant]
            .map(source => ({
                title: source.title,
                url: source.url,
                source: source.source,
                extract: String(source.extract || ''),
            }))
            .filter((source, index, array) => array.findIndex(other =>
                `${other.title}|${other.url}|${other.extract}` === `${source.title}|${source.url}|${source.extract}`) === index);
        const newChanges = novelChangesForRecord(plan.canonChanges, previousName || canonicalName, planEntities, database);
        const nextRecord = {
            entity: canonicalName,
            aliases,
            work: canonicalPage?.workTitle || previous?.work || plan.work || '',
            timeline: plan.timeline || previous?.timeline || '',
            profile: previous?.profile || '',
            profileHash: previous?.profileHash || '',
            updatedAt: previous?.updatedAt || Date.now(),
            canonChanges: [...new Set([
                ...(Array.isArray(previous?.canonChanges) ? previous.canonChanges : []),
                ...newChanges,
            ].map(String).filter(Boolean))],
            sources: mergedSources,
        };
        const previousComparable = previous ? { ...previous, updatedAt: 0 } : null;
        const nextComparable = { ...nextRecord, updatedAt: 0 };
        const recordChanged = previousName !== canonicalName
            || JSON.stringify(previousComparable) !== JSON.stringify(nextComparable);
        if (recordChanged) {
            nextRecord.updatedAt = Date.now();
            if (previousName && previousName !== canonicalName) delete database[previousName];
            database[canonicalName] = nextRecord;
            modifiedEntities.add(canonicalName);
        }
        replacements.set(entity, canonicalName);
    }
    if (replacements.size) {
        const replace = values => cleanDetectedEntities(values.map(name => replacements.get(name) || resolveCanonEntityName(name, database)));
        plan.entities = replace(plan.entities);
        if (Array.isArray(plan.autoEntities)) plan.autoEntities = replace(plan.autoEntities);
        const cardProfile = profile();
        cardProfile.entities = replace(manualEntities(cardProfile.entities)).join('，');
        cardProfile.lastAutoEntities = replace(Array.isArray(cardProfile.lastAutoEntities) ? cardProfile.lastAutoEntities : []);
    }
    if (modifiedEntities.size) {
        saveSettingsDebounced();
        await syncCanonDatabaseToWorldBook([...modifiedEntities]);
    }
}

function loadCanonResearch(plan) {
    const database = storedCanonEntities();
    const pages = [];
    for (const entity of cleanDetectedEntities(plan.entities)) {
        const recordName = findCanonRecordName(entity, database);
        const record = database[recordName];
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
    return cleanDetectedEntities(plan.entities).filter(entity => {
        const recordName = findCanonRecordName(entity, database);
        return !recordName || !database[recordName]?.sources?.length;
    });
}

function textHash(value) {
    const text = String(value ?? '');
    let hash = 5381;
    for (let index = 0; index < text.length; index++) {
        hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
    }
    return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function canonProfileHash(record) {
    return textHash(JSON.stringify({
        timeline: String(record?.timeline || ''),
        changes: Array.isArray(record?.canonChanges) ? record.canonChanges : [],
        sources: (Array.isArray(record?.sources) ? record.sources : [])
            .map(source => `${source?.title || ''}|${source?.extract || ''}`),
    }));
}

const PROFILE_RETRY_MINUTES = 10;

async function ensureCanonProfiles(plan) {
    const scopeToken = captureScopeToken();
    const database = storedCanonEntities();
    const pending = [];
    for (const entity of cleanDetectedEntities(plan.entities)) {
        const recordName = findCanonRecordName(entity, database);
        const record = database[recordName];
        if (!record?.sources?.length) continue;
        const hash = canonProfileHash(record);
        if (record.profile && record.profileHash === hash) continue;
        if (!record.profile && record.profileHash === hash
            && Date.now() - (record.profileAttemptedAt || 0) < PROFILE_RETRY_MINUTES * 60 * 1000) continue;
        pending.push({ record, hash });
    }
    if (!pending.length) return [];

    const limited = pending.slice(0, 8);
    const tasks = limited.map(({ record }) => ({
        name: record.entity,
        work: record.work || plan.work || '',
        timeline: record.timeline || plan.timeline || '',
        auChanges: Array.isArray(record.canonChanges) ? record.canonChanges : [],
    }));
    const materialSections = limited.map(({ record }) => `【${record.entity}】\n${(record.sources || [])
        .map(source => `${source.title}：${source.extract}`)
        .join('\n')
        .slice(0, 2800)}`);
    const prompt = `你是原作设定编辑，负责把检索到的原始资料压缩成正文模型直接可用的角色档案。只能使用资料中明确写出的事实，禁止补充资料之外的原作剧情。对每个对象输出一份 150-400 字的紧凑档案：以正式名开头；按资料覆盖情况涵盖身份、年龄、外貌身材与发型发色、典型穿着、性格与行为逻辑、能力、经历、人际关系、说话风格；已确认AU差异写成“本卡AU：…”。时间线过滤规则：当前时间线节点之后才发生的经历、关系变化、能力觉醒、身份揭露、伤亡与秘密一律不得写入；时间线标注为“用户原创世界”类时只保留身份、外貌、性格等固有设定，不写任何原作剧情经历。不写来源、网址或引用编号。\n\n对象（JSON）：\n${JSON.stringify(tasks)}\n\n各对象原始资料：\n${materialSections.join('\n\n')}\n\n只输出 JSON：{"profiles":{"正式名":"档案文本"}}，profiles 的键必须原样使用每个对象的 name。`;

    try {
        updateReport('分析模型正在按当前时间线压缩角色档案…');
        const parsed = await runJsonAnalysisPrompt(prompt, 4200);
        if (!scopeTokenIsCurrent(scopeToken)) return [];
        const profiles = parsed && typeof parsed.profiles === 'object' ? parsed.profiles : {};
        const byKey = new Map(Object.entries(profiles)
            .map(([key, value]) => [canonicalEntityKey(key), String(value ?? '').trim()]));
        const updated = [];
        for (const { record, hash } of limited) {
            const text = byKey.get(canonicalEntityKey(record.entity)) || '';
            if (text.length >= 40) {
                record.profile = text.slice(0, 1500);
                record.profileHash = hash;
                updated.push(record.entity);
            }
        }
        if (updated.length) {
            saveSettingsDebounced();
            await syncCanonDatabaseToWorldBook(updated);
        }
        return updated;
    } catch (error) {
        if (!scopeTokenIsCurrent(scopeToken)) return [];
        console.warn('[Fandom Canon] Profile compression failed; falling back to raw extracts.', error);
        const attemptedAt = Date.now();
        for (const { record, hash } of limited) {
            if (!record.profile) {
                record.profileHash = hash;
                record.profileAttemptedAt = attemptedAt;
            }
        }
        saveSettingsDebounced();
        return [];
    }
}

const REVIEW_SKIP_TYPES = new Set(['quiet', 'impersonate']);
const reviewedMessageSignatures = new Set();

function relevantCanonRecords(text, database = storedCanonEntities()) {
    const body = String(text ?? '').toLowerCase();
    if (!body) return [];
    return Object.values(database).filter(record => {
        if (!record?.sources?.length && !record?.profile) return false;
        return recordAliases(record, record.entity).some(alias => body.includes(alias.toLowerCase()));
    });
}

function reviewContextSummary(chat, messageId) {
    return (Array.isArray(chat) ? chat.slice(0, messageId) : [])
        .filter(message => message?.mes)
        .slice(-6)
        .map(message => `${message.is_user ? '用户' : (message.name || '角色')}：${stripMarkup(message.mes).slice(0, 500)}`)
        .join('\n');
}

const EXPLICIT_TIME_ANCHOR_SOURCE = '(?:\\d{3,4}|[〇○零一二三四五六七八九]{3,4})年(?:的)?(?:年初|年中|年底|年末|年尾|上半年|下半年|初|中|末|春季?|夏季?|秋季?|冬季?|深冬|冬末|[一二三四五六七八九十\\d]{1,2}月(?:上旬|中旬|下旬)?)?';

function latestUserTextBefore(chat, messageId) {
    return [...(Array.isArray(chat) ? chat.slice(0, messageId) : [])]
        .reverse()
        .find(message => message?.is_user && message?.mes)?.mes || '';
}

function normalizeExplicitTimeAnchor(value) {
    return String(value ?? '')
        .replace(/年的年(?=[初中底末尾])/, '年')
        .replace(/年年(?=[初中底末尾])/, '年')
        .replace(/年的(?=春|夏|秋|冬|深冬)/, '年')
        .trim();
}

function explicitTimeAnchorFromText(text) {
    const matches = [...stripMarkup(text).matchAll(new RegExp(EXPLICIT_TIME_ANCHOR_SOURCE, 'g'))];
    return normalizeExplicitTimeAnchor(matches.at(-1)?.[0] || '');
}

function timelineWithExplicitAnchor(timeline, explicitTimeAnchor) {
    const anchor = normalizeExplicitTimeAnchor(explicitTimeAnchor);
    const value = String(timeline ?? '').trim();
    if (!anchor) return value;
    if (!value) return anchor;
    const anchorYear = anchor.match(/^(?:\d{3,4}|[〇○零一二三四五六七八九]{3,4})年/)?.[0] || '';
    const hasQualifier = Boolean(anchorYear && anchor.length > anchorYear.length);
    const match = new RegExp(EXPLICIT_TIME_ANCHOR_SOURCE).exec(value);
    if (match && match.index <= 24) {
        if (!hasQualifier) {
            const matchedYear = match[0].match(/^(?:\d{3,4}|[〇○零一二三四五六七八九]{3,4})年/)?.[0] || '';
            if (matchedYear === anchorYear) return value;
            if (matchedYear) {
                return `${value.slice(0, match.index)}${match[0].replace(matchedYear, anchorYear)}${value.slice(match.index + match[0].length)}`;
            }
        }
        return `${value.slice(0, match.index)}${anchor}${value.slice(match.index + match[0].length)}`;
    }
    return `${anchor}，${value}`;
}

function explicitTimelineRevisions(body, explicitTimeAnchor) {
    const anchor = normalizeExplicitTimeAnchor(explicitTimeAnchor);
    if (!anchor) return [];
    const anchorYear = anchor.match(/^(?:\d{3,4}|[〇○零一二三四五六七八九]{3,4})年/)?.[0];
    if (!anchorYear || anchor.length === anchorYear.length) return [];
    const sameYearExpression = new RegExp(`${anchorYear}(?:的)?(?:年初|年中|年底|年末|年尾|上半年|下半年|初|中|末|春季?|夏季?|秋季?|冬季?|深冬|冬末|[一二三四五六七八九十\\d]{1,2}月(?:上旬|中旬|下旬)?)`, 'g');
    return [...new Set(String(body ?? '').match(sameYearExpression) || [])]
        .filter(value => normalizeExplicitTimeAnchor(value) !== anchor)
        .map(original => ({
            original,
            revised: anchor,
            entity: '时间线',
            reason: `用户已明确指定当前时间为${anchor}`,
        }));
}

function textWithExplicitTimeAnchor(text, explicitTimeAnchor) {
    let updated = String(text ?? '');
    for (const revision of explicitTimelineRevisions(updated, explicitTimeAnchor)) {
        updated = updated.replaceAll(revision.original, revision.revised);
    }
    return updated;
}

function sceneWithExplicitTimeAnchor(scene, explicitTimeAnchor) {
    const anchor = normalizeExplicitTimeAnchor(explicitTimeAnchor);
    if (!anchor) return scene || {};
    const currentTimeline = String(scene?.timeline || profile().timeline || '').trim();
    const timeline = timelineWithExplicitAnchor(currentTimeline, anchor);
    return {
        ...(scene || {}),
        timeline,
        timelineChanged: scene?.timelineChanged === true
            || normalizeChangeText(timeline) !== normalizeChangeText(profile().timeline),
        summary: textWithExplicitTimeAnchor(scene?.summary || '', anchor),
    };
}

function buildReviewPrompt(body, records, recent, overrideContext = {}, allowReview = true) {
    const cardProfile = profile();
    const profiles = records.map(record => {
        const text = String(record.profile || '').trim()
            || (record.sources || []).map(source => source.extract).join('\n').slice(0, 1200);
        const changes = Array.isArray(record.canonChanges) && record.canonChanges.length
            ? record.canonChanges.join('；') : '';
        return `【${record.entity}】（${record.work || '作品未确认'}）\n${text}${changes ? `\n已确认AU差异：${changes}` : ''}`;
    }).join('\n\n');
    const reviewRule = allowReview && records.length
        ? '同时核对正文中实际出现、且下方有档案的原作角色是否存在姓名译名、年龄身份、外貌、性格行为、能力、经历、人际关系、人物认知或时间线事实冲突。只允许替换造成 OOC 的最短连续文字片段；不得改变剧情走向、登场角色、事件、行动结果、对白轮次、因果关系或场景顺序。拿不准一律判通过。'
        : '本轮没有启用可执行的 OOC 审核。verdict 必须为 pass，revisions 必须为空数组。';
    return `你负责在正文生成完毕后提取“当前场景事实快照”，并在允许时做原作事实审核。你不是编剧，绝对不得建议、预测、补写或改变后续剧情。\n\n任务一：根据此前剧情和待处理正文，返回正文结束瞬间的当前状态。currentEntities 只能包含：①此刻仍在当前场景中或正通过电话等方式直接参与当前互动的有名人物；②此刻所在的一个具体地点。kind 只能是 character 或 location。必须移除已经离场、上一场景人物、只被谈及的人物、回忆人物、未来可能登场者、组织、物品、能力、书籍和泛称。角色卡与世界书只用于确认身份，绝不能把其中的候选人物当成当前在场。旧快照是上一轮在场状态：若正文没有换场、跳时或明确写某人离开，应保留其中仍可能在场的人物和地点，即使最新一段没有再次点名；一旦正文明确换场或离场，则按新场景重建并移除旧项。若正文开头存在 <!--NE-BANNER-->地点|时段|编号|状态|人物<!--/NE-BANNER-->，其中地点、时段与人物是本轮已经生成的场景元数据，优先级高于旧快照和代词推测；不得用旧角色替换横幅明确列出的人物。若上下文足以判断完整当前快照，sceneComplete=true；若截断严重、无法可靠判断谁仍在场，则为 false，避免误删。用户在插件里手动固定的项目由程序保留，无需你保留。summary 只压缩正文结束时已经发生、且仍影响下一轮衔接的状态，不得写预测、建议或资料来源。\n\n时间规则：timeline 是正文结束时已经明确成立的简短时间线/时间节点。只有正文明确发生日期、时段、篇章、原作事件阶段或 AU 关键状态切换时，timelineChanged 才为 true；不得因为普通对话、模型推测或为了推动故事而改时间线。没有明确变化时原样返回当前值并设为 false。作品发生明确切换或交叉作品焦点变化时才更新 workTitle。\n\n任务二：${reviewRule}\n\n角色卡设定、用户明确指示、已确认 AU 差异和此前剧情已经建立的事实优先于原作档案，不得修订。档案未写明的细节不算冲突。original 必须逐字复制正文中的最短连续原文。\n\n只输出完整 JSON：{"scene":{"sceneComplete":true,"workTitle":"当前明确作品；不变则沿用当前值","storyType":"canon_timeline|au_timeline|original_world_with_fandom_characters|original_only|unknown","timeline":"当前明确时间线或节点","timelineChanged":false,"summary":"正文结束时已经成立、用于下一轮衔接的简短状态","currentEntities":[{"candidateName":"具体人物或地点名","kind":"character|location","isOriginal":false,"workHint":"所属作品；不确定留空","evidence":"证明其此刻仍在场或为当前地点的正文短语"}]},"verdict":"pass|conflict","revisions":[{"original":"正文最短连续原文","revised":"仅修正事实后的对应短片段","entity":"角色名","reason":"简短 OOC 原因"}]}\n\n当前作品：${cardProfile.workTitle || '未填写'}\n当前时间线/AU节点：${cardProfile.timeline || '未填写'}\n上一轮自动人物/地点快照（无离场或换场证据时作为延续基线）：${cleanDetectedEntities(cardProfile.lastAutoEntities).join('、') || '无'}\n\n角色卡优先设定：\n${String(overrideContext.card || '未读取到').slice(0, 7000)}\n\n当前激活世界书优先设定：\n${String(overrideContext.worldInfo || '无').slice(0, 7000)}\n\n可用于审核的角色档案：\n${profiles || '无'}\n\n此前剧情概要：\n${recent || '无'}\n\n待处理正文：\n${body}`;
}

function parseNarrativeBanner(body) {
    const match = String(body || '').match(/<!--NE-BANNER-->([\s\S]*?)<!--\/NE-BANNER-->/i);
    if (!match) return null;
    const [location = '', time = '', sequence = '', summary = '', names = ''] = match[1]
        .split('|').map(value => stripMarkup(value).trim());
    const characters = cleanDetectedEntities(String(names).split(/[、，,]/));
    if (!location && !characters.length) return null;
    return {
        location: normalizeEntityDisplay(location),
        time: normalizeEntityDisplay(time),
        sequence: String(sequence || '').trim(),
        summary: String(summary || '').trim(),
        characters,
    };
}

function mergeSceneWithNarrativeBanner(scene, body, recent = '') {
    const banner = parseNarrativeBanner(body);
    if (!banner) return scene || {};
    const cardProfile = profile();
    const database = storedCanonEntities();
    const modelCandidates = cleanSceneEntityCandidates(scene?.currentEntities);
    const context = getContext();
    const userNames = cleanDetectedEntities([
        context.name1,
        context.userName,
        context.powerUserName,
        ...(Array.isArray(context.chat) ? context.chat.filter(message => message?.is_user).map(message => message?.name) : []),
    ]);
    const userNameKeys = new Set(userNames.map(canonicalEntityKey));
    const sanitizedCanonEntities = [];
    for (const [databaseName, record] of Object.entries(database)) {
        if (!Array.isArray(record?.aliases)) continue;
        const ownKeys = new Set([databaseName, record.entity].map(canonicalEntityKey).filter(Boolean));
        const aliases = record.aliases.filter(alias => {
            const key = canonicalEntityKey(alias);
            return !userNameKeys.has(key) || ownKeys.has(key);
        });
        if (aliases.length === record.aliases.length) continue;
        record.aliases = aliases;
        record.updatedAt = Date.now();
        sanitizedCanonEntities.push(record.entity || databaseName);
    }
    const characterCandidates = banner.characters.map(name => {
        const model = modelCandidates.find(candidate => canonicalEntityKey(candidate.candidateName) === canonicalEntityKey(name));
        const isUserName = userNameKeys.has(canonicalEntityKey(name));
        const recordName = isUserName ? '' : findCanonRecordName(name, database);
        return {
            candidateName: recordName || name,
            kind: 'character',
            isOriginal: model?.isOriginal === true || isUserName,
            workHint: model?.workHint || (recordName ? database[recordName]?.work : '') || '',
            evidence: model?.contextEvidence || `场景横幅当前人物：${name}`,
        };
    });
    const locationCandidate = banner.location ? [{
        candidateName: banner.location,
        kind: 'location',
        isOriginal: true,
        workHint: String(scene?.workTitle || cardProfile.workTitle || ''),
        evidence: `场景横幅当前地点：${banner.location}`,
    }] : [];
    let timeline = String(scene?.timeline || cardProfile.timeline || '').trim();
    let timelineChanged = scene?.timelineChanged === true;
    const currentTimeline = String(cardProfile.timeline || '').trim();
    const oldTime = currentTimeline.match(/清晨|早晨|上午|中午|午后|下午|傍晚|黄昏|夜晚|深夜/)?.[0] || '';
    if (banner.time && oldTime && banner.time !== oldTime && (!timeline || normalizeChangeText(timeline) === normalizeChangeText(currentTimeline))) {
        timeline = currentTimeline.replace(oldTime, banner.time);
        timelineChanged = true;
    }
    const elapsedEvidence = `${recent}\n${stripMarkup(body)}`;
    if (timeline && /(?:比起|距离).{0,6}(?:几天前|数日前)|(?:几天|数日)后|a few days (?:ago|later)/i.test(elapsedEvidence)
        && /后的(?:清晨|早晨|上午|中午|午后|下午|傍晚|黄昏|夜晚|深夜)/.test(timeline)
        && !/数日后|几天后/.test(timeline)) {
        timeline = timeline.replace(/后的(清晨|早晨|上午|中午|午后|下午|傍晚|黄昏|夜晚|深夜)/, `数日后的${banner.time || '$1'}`);
        timelineChanged = true;
    }
    return {
        ...(scene || {}),
        sceneComplete: true,
        timeline,
        timelineChanged,
        summary: String(scene?.summary || banner.summary || '').trim(),
        currentEntities: [...characterCandidates, ...locationCandidate],
        sanitizedCanonEntities,
    };
}

function scenePlanFromAnalysis(scene) {
    const cardProfile = profile();
    const database = storedCanonEntities();
    const candidates = cleanSceneEntityCandidates(scene?.currentEntities);
    const allCurrentEntities = cleanDetectedEntities(candidates
        .map(candidate => candidate.isOriginal
            ? normalizeEntityDisplay(candidate.candidateName)
            : resolveCanonEntityName(candidate.candidateName, database)));
    const canonCharacters = candidates
        .filter(candidate => candidate.kind === 'character' && !candidate.isOriginal);
    const canonEntities = cleanDetectedEntities(canonCharacters
        .map(candidate => resolveCanonEntityName(candidate.candidateName, database)));
    const missingEntities = canonEntities.filter(entity => {
        const recordName = findCanonRecordName(entity, database);
        return !recordName || (!database[recordName]?.sources?.length && !database[recordName]?.profile);
    });
    const work = String(scene?.workTitle || cardProfile.workTitle || '').trim();
    const queries = missingEntities.map(entity => {
        const candidate = canonCharacters.find(item => canonicalEntityKey(item.candidateName) === canonicalEntityKey(entity));
        const workHint = candidate?.workHint || (shouldAttachWorkTitle(work) ? work : '');
        return `${entity} ${workHint} 核对正式姓名及原作完整角色档案：身份、年龄、外貌身材、典型穿着、性格行为逻辑、能力、重要经历、人际关系、说话风格`.trim();
    });
    const proposedTimeline = String(scene?.timeline || cardProfile.timeline || '').trim();
    const timelineChanged = scene?.timelineChanged === true
        && Boolean(proposedTimeline)
        && normalizeChangeText(proposedTimeline) !== normalizeChangeText(cardProfile.timeline);
    return {
        work,
        timeline: timelineChanged ? proposedTimeline : cardProfile.timeline.trim(),
        entities: canonEntities,
        autoEntities: allCurrentEntities,
        entityCandidates: canonCharacters,
        canonChanges: [],
        timelineChanged,
        replaceAutoEntities: scene?.sceneComplete === true,
        researchMode: missingEntities.length ? 'new_entities' : 'none',
        queries: cleanPlannedQueries(queries, work).slice(0, settings().maxQueries),
        sceneCandidates: candidates,
        sanitizedCanonEntities: cleanDetectedEntities(scene?.sanitizedCanonEntities),
    };
}

function buildCurrentSceneSnapshot(scene, plan, pinned, messageId, body) {
    const database = storedCanonEntities();
    const candidates = cleanSceneEntityCandidates(plan.sceneCandidates || scene?.currentEntities)
        .map(candidate => ({
            ...candidate,
            candidateName: candidate.isOriginal
                ? normalizeEntityDisplay(candidate.candidateName)
                : resolveCanonEntityName(candidate.candidateName, database),
        }));
    const candidateKeys = new Set(candidates.map(candidate => canonicalEntityKey(candidate.candidateName)));
    const carried = cleanDetectedEntities(plan.autoEntities)
        .filter(name => !candidateKeys.has(canonicalEntityKey(name)));
    const characters = cleanDetectedEntities([
        ...candidates.filter(candidate => candidate.kind === 'character').map(candidate => candidate.candidateName),
        ...carried,
    ]);
    const locations = cleanDetectedEntities(candidates
        .filter(candidate => candidate.kind === 'location')
        .map(candidate => candidate.candidateName));
    return {
        workTitle: plan.work || profile().workTitle || '',
        timeline: plan.timeline || profile().timeline || '',
        summary: stripMarkup(scene?.summary || '').trim().slice(0, 2000),
        characters,
        locations,
        pinned: cleanDetectedEntities(pinned)
            .filter(name => !characters.includes(name) && !locations.includes(name)),
        entities: candidates,
        messageId: Number(messageId),
        messageHash: textHash(body),
        updatedAt: Date.now(),
    };
}

async function syncDynamicSceneState(scene, scopeToken, reviewTarget = null) {
    const plan = scenePlanFromAnalysis(scene);
    const cardProfile = profile();
    const before = cardProfile.entities;
    const previousAutoKeys = new Set(cleanDetectedEntities(cardProfile.lastAutoEntities).map(canonicalEntityKey));
    const pinned = manualEntities(cardProfile.entities)
        .filter(entity => !previousAutoKeys.has(canonicalEntityKey(entity)));
    syncProfileFromPlan(plan);
    const changed = before !== profile().entities;
    const snapshot = buildCurrentSceneSnapshot(scene, plan, pinned, reviewTarget?.messageId, reviewTarget?.body || '');
    cardProfile.currentScene = snapshot;
    saveSettingsDebounced();
    const worldBookChanged = await syncCurrentSceneToWorldBook(snapshot, scopeToken);
    const timelineUpdatedEntities = [];
    if (plan.timelineChanged && plan.timeline) {
        for (const record of Object.values(storedCanonEntities())) {
            if (!record?.entity || record.timeline === plan.timeline) continue;
            record.timeline = plan.timeline;
            record.updatedAt = Date.now();
            timelineUpdatedEntities.push(record.entity);
        }
    }
    const canonEntriesToRefresh = cleanDetectedEntities([
        ...timelineUpdatedEntities,
        ...(plan.sanitizedCanonEntities || []),
    ]);
    if (canonEntriesToRefresh.length) {
        await syncCanonDatabaseToWorldBook(canonEntriesToRefresh);
    }
    const missingEntities = missingCanonEntities(plan);
    if (scopeTokenIsCurrent(scopeToken) && missingEntities.length && plan.queries.length) {
        startCanonEnrichment(plan).then(async pages => {
            if (!scopeTokenIsCurrent(scopeToken)) return;
            await ensureCanonProfiles(plan);
            if (!scopeTokenIsCurrent(scopeToken)) return;
            updateReport(`当前场景已更新；新原作角色资料已后台写入 ${pages.length} 条`, plan, pages);
            if (!missingCanonEntities(plan).length && reviewTarget) {
                scheduleMessageReview(reviewTarget.messageId, reviewTarget.type, {
                    delayMs: 500,
                    force: true,
                    reason: '新角色档案写入后复核正文',
                });
            }
        }).catch(error => {
            if (!scopeTokenIsCurrent(scopeToken)) return;
            const message = error?.message || String(error);
            console.error('[Fandom Canon] Scene character enrichment failed.', error);
            setSceneSyncState({
                status: 'error',
                signature: '',
                messageId: reviewTarget?.messageId,
                error: `新角色资料检索失败：${message}`,
            });
            updateReport(`当前场景已写入，但新角色资料检索失败，将稍后补试：${message}`, plan);
            if (reviewTarget) {
                scheduleMessageReview(reviewTarget.messageId, reviewTarget.type, {
                    delayMs: 45000,
                    force: true,
                    reason: '新角色检索失败后补试',
                });
            }
        });
    }
    return { plan, changed, worldBookChanged, snapshot, missingEntities, timelineUpdatedEntities };
}

function applyTextRevisions(text, revisions) {
    let updated = String(text ?? '');
    const applied = [];
    for (const revision of Array.isArray(revisions) ? revisions : []) {
        const original = String(revision?.original ?? '').trim();
        const revised = String(revision?.revised ?? '').trim();
        if (original.length < 2 || !revised || original === revised) continue;
        const firstIndex = updated.indexOf(original);
        const isTimelineRevision = String(revision?.entity ?? '').trim() === '时间线';
        if (firstIndex < 0 || (!isTimelineRevision && updated.lastIndexOf(original) !== firstIndex)) continue;
        if (original.length > 600 || revised.length > 600) continue;
        const maximumLength = Math.max(original.length * 2, original.length + 120);
        if (revised.length > maximumLength) continue;
        updated = isTimelineRevision
            ? updated.replaceAll(original, revised)
            : updated.replace(original, () => revised);
        applied.push({
            original,
            revised,
            entity: String(revision?.entity ?? '').trim(),
            reason: String(revision?.reason ?? '').trim(),
        });
    }
    if (applied.length && Math.abs(updated.length - String(text ?? '').length) > Math.max(1200, String(text ?? '').length * 0.35)) {
        return { updated: String(text ?? ''), applied: [] };
    }
    return { updated, applied };
}

function sceneMessageSignature(index, body) {
    return `${scopeIdentity()}|${Number(index)}:${textHash(body)}`;
}

function setSceneSyncState(state) {
    const cardProfile = profile();
    cardProfile.sceneSync = {
        status: String(state.status || 'idle'),
        signature: String(state.signature ?? cardProfile.sceneSync?.signature ?? ''),
        messageId: Number.isFinite(Number(state.messageId)) ? Number(state.messageId) : (cardProfile.sceneSync?.messageId ?? null),
        updatedAt: Date.now(),
        error: String(state.error || ''),
        formatVersion: SCENE_SYNC_FORMAT_VERSION,
    };
    saveSettingsDebounced();
    renderReport();
}

async function reviewGeneratedMessage(messageId, type, options = {}) {
    const config = settings();
    if (REVIEW_SKIP_TYPES.has(String(type ?? ''))) return false;
    const trackScene = config.enabled && config.autoUpdateProfile;
    if (!trackScene && !config.reviewEnabled) return false;
    await ensureConversationScope();
    await reconcileDeletedWorldBookEntries();
    const scopeToken = captureScopeToken();
    const context = getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const index = Number(messageId);
    const message = chat[index];
    if (!message || message.is_user || message.is_system) return false;
    const body = String(message.mes ?? '');
    if (body.trim().length < 2) return false;
    const signature = sceneMessageSignature(index, body);
    const force = options.force === true;
    const savedSync = profile().sceneSync || {};
    if (!force && (reviewedMessageSignatures.has(signature)
        || (savedSync.status === 'synced'
            && savedSync.signature === signature
            && savedSync.formatVersion === SCENE_SYNC_FORMAT_VERSION))) return true;
    if (inFlightSceneReviews.has(signature)) return await inFlightSceneReviews.get(signature);

    const job = (async () => {
        const retryAttempt = Math.max(0, Number(options.retryAttempt) || 0);
        const database = storedCanonEntities();
        const recent = reviewContextSummary(chat, index);
        const explicitTimeAnchor = explicitTimeAnchorFromText(latestUserTextBefore(chat, index));
        const records = config.reviewEnabled ? relevantCanonRecords(body, database).slice(0, 6) : [];
        if (!trackScene && !records.length) return false;
        setSceneSyncState({ status: retryAttempt ? 'retrying' : 'syncing', signature, messageId: index });
        try {
            updateReport(records.length
                ? `正在异步更新当前场景并审核正文（涉及 ${records.map(record => record.entity).join('、')}）…`
                : '正在异步更新当前人物、地点和时间节点…');
            const overrideContext = await researchContext(chat.slice(0, index + 1));
            if (!scopeTokenIsCurrent(scopeToken)) return false;
            const parsed = await runJsonAnalysisPrompt(buildReviewPrompt(body.slice(0, 12000), records, recent, overrideContext, config.reviewEnabled), 2800);
            if (!scopeTokenIsCurrent(scopeToken)) return false;
            if (chat[index] !== message || textHash(String(message.mes ?? '')) !== textHash(body)) {
                updateReport('正文在分析期间被修改或删除，已放弃本轮状态更新与自动修订');
                return false;
            }
            const hasLaterConversation = chat.slice(index + 1).some(item => item?.mes && !item.is_system);
            const resolvedScene = sceneWithExplicitTimeAnchor(
                mergeSceneWithNarrativeBanner(parsed?.scene, body, recent),
                explicitTimeAnchor,
            );
            const sceneResult = trackScene && !hasLaterConversation
                ? await syncDynamicSceneState(resolvedScene, scopeToken, { messageId: index, type, body })
                : null;
            const sceneStatus = hasLaterConversation
                ? '当前场景已由后续消息接管，本轮旧快照未写入'
                : sceneResult
                    ? `当前场景${sceneResult.changed || sceneResult.worldBookChanged ? '已同步到世界书' : '无变化'}`
                    : '当前场景跟踪未启用';
            const timelineRevisions = explicitTimelineRevisions(body, explicitTimeAnchor);
            const revisions = [
                ...(Array.isArray(parsed?.revisions) ? parsed.revisions : []),
                ...timelineRevisions,
            ];
            let reportText = `${sceneStatus}；正文没有需要修订的未解释原作冲突`;
            if ((parsed?.verdict === 'conflict' || timelineRevisions.length) && revisions.length) {
                const { updated, applied } = applyTextRevisions(message.mes, revisions);
                if (!applied.length) {
                    reportText = `${sceneStatus}；审核发现 ${revisions.length} 处疑似冲突，但无法在正文中逐字定位，未自动修订`;
                } else {
                    if (!scopeTokenIsCurrent(scopeToken)) return false;
                    message.mes = updated;
                    message.extra ??= {};
                    if (typeof message.extra.display_text === 'string') message.extra.display_text = updated;
                    message.extra.fcr_revisions = applied;
                    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
                        message.swipes[message.swipe_id] = updated;
                    }
                    await context.saveChat();
                    if (!scopeTokenIsCurrent(scopeToken)) return false;
                    updateMessageBlock(index, message);
                    const reasons = [...new Set(applied
                        .map(item => `${item.entity || '角色'}：${item.reason || '与原作资料不符'}`))].join('；');
                    toastr.info(`已按原作资料自动修正 ${applied.length} 处冲突`, '晋阳的同人库');
                    reportText = `${sceneStatus}；已自动修正 ${applied.length} 处原作冲突（${reasons.slice(0, 300)}）`;
                    console.info('[Fandom Canon] Auto-revised canon conflicts.', applied);
                }
            }
            const finalSignature = sceneMessageSignature(index, String(message.mes ?? ''));
            reviewedMessageSignatures.add(signature);
            reviewedMessageSignatures.add(finalSignature);
            setSceneSyncState({ status: 'synced', signature: finalSignature, messageId: index });
            updateReport(reportText, sceneResult?.plan);
            return true;
        } catch (error) {
            if (!scopeTokenIsCurrent(scopeToken)) return false;
            reviewedMessageSignatures.delete(signature);
            const messageText = error?.message || String(error);
            console.warn('[Fandom Canon] Post-generation scene update/review failed.', error);
            const retryDelay = SCENE_RETRY_DELAYS_MS[retryAttempt];
            setSceneSyncState({
                status: retryDelay ? 'retrying' : 'error',
                signature,
                messageId: index,
                error: messageText,
            });
            updateReport(retryDelay
                ? `生成后同步失败，将在 ${Math.round(retryDelay / 1000)} 秒后自动重试：${messageText}`
                : `生成后同步连续失败：${messageText}`);
            if (retryDelay) {
                scheduleMessageReview(index, type, {
                    delayMs: retryDelay,
                    force: true,
                    retryAttempt: retryAttempt + 1,
                    reason: '失败自动重试',
                });
            }
            return false;
        }
    })().finally(() => {
        if (inFlightSceneReviews.get(signature) === job) inFlightSceneReviews.delete(signature);
    });
    inFlightSceneReviews.set(signature, job);
    return await job;
}

function isPageGenerating() {
    return document.body.classList.contains('generating')
        || Boolean(document.querySelector('#send_but[title="Stop"]'))
        || Boolean(document.querySelector('#mes_stop')?.offsetParent);
}

function scheduleMessageReview(messageId, type = 'normal', options = {}) {
    const index = Number(messageId);
    if (!Number.isInteger(index) || index < 0) return false;
    const scope = scopeIdentity();
    const key = `${scope}|${index}`;
    const previous = scheduledSceneReviews.get(key);
    if (previous) clearTimeout(previous);
    const delayMs = Math.max(0, Number(options.delayMs) || 0);
    const timer = setTimeout(async () => {
        scheduledSceneReviews.delete(key);
        if (scope !== scopeIdentity()) return;
        if (isPageGenerating()) {
            scheduleMessageReview(index, type, { ...options, delayMs: 1000 });
            return;
        }
        try {
            await reviewGeneratedMessage(index, type, options);
        } catch (error) {
            console.error('[Fandom Canon] Scheduled scene review failed.', error);
        }
    }, delayMs);
    scheduledSceneReviews.set(key, timer);
    console.debug(`[Fandom Canon] Scene review scheduled (${options.reason || 'message event'}).`, { index, delayMs });
    return true;
}

function reconcileLatestAssistantMessage(reason = '后台巡检', delayMs = 0) {
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    let latestVisibleIndex = -1;
    for (let index = chat.length - 1; index >= 0; index--) {
        if (!chat[index]?.mes || chat[index]?.is_system) continue;
        latestVisibleIndex = index;
        break;
    }
    if (latestVisibleIndex < 0 || chat[latestVisibleIndex]?.is_user) return false;
    const body = String(chat[latestVisibleIndex]?.mes || '');
    if (body.trim().length < 2) return false;
    const signature = sceneMessageSignature(latestVisibleIndex, body);
    const sceneSync = profile().sceneSync || {};
    if (sceneSync.status === 'synced'
        && sceneSync.signature === signature
        && sceneSync.formatVersion === SCENE_SYNC_FORMAT_VERSION) return true;
    if (sceneSync.signature === signature
        && ['retrying', 'error'].includes(sceneSync.status)
        && Date.now() - Number(sceneSync.updatedAt || 0) < 60000) return true;
    return scheduleMessageReview(latestVisibleIndex, 'normal', { delayMs, reason });
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
        const plannedCandidates = cleanEntityCandidates(plan.entityCandidates);
        const researchObjects = cleanDetectedEntities(plan.entities).map(entity => {
            const planned = plannedCandidates.find(item => canonicalEntityKey(item.candidateName) === canonicalEntityKey(entity));
            return {
                candidateName: entity,
                workHint: planned?.workHint || '',
                contextEvidence: planned?.contextEvidence || '',
            };
        });
        const deltaOnly = plan.researchMode === 'official_delta';
        const taskInstruction = deltaOnly
            ? '这些对象已经有完整基础档案。本次只核实检索问题对应的新时间线节点或官方补充设定；不得重新总结姓名、外貌、性格、经历等既有基础档案。若没有任何相对已有档案的新增事实，records 必须返回空数组。summary 只写新增事实。'
            : '这些是尚无档案的新对象。必须先确认其实际所属作品和原文正式姓名，再整理一次完整基础档案。';
        const batchQuery = `请在一次联网研究中逐个核实下列同人对象。上下文中的中文名只是候选名，可能是错译、误写或与别的角色混淆。优先使用原作官网、出版社、官方角色页和可靠资料库，并交叉核对。回答中不要写网址、参考资料列表或引用编号。\n\n${taskInstruction}\n\n只输出合法 JSON：{"records":[{"candidateName":"必须原样回填输入候选名，仅用于配对","canonicalName":"核实后的简体中文正式名；可以且应当纠正候选名","originalName":"原文姓名（如日文汉字与假名）","workTitle":"实际所属原作，不得照抄错误的总作品名","aliases":["常见译名、原文名和本次错误候选名"],"verified":true,"summary":"${deltaOnly ? '只写本次新增官方事实' : '必须以 canonicalName 开头；给正文模型使用的单人完整档案；紧凑无重复；只写确认事实；按适用情况包含身份、年龄、外貌身材、发色发型、典型穿着、性格与行为逻辑、能力、重要经历、人际关系、说话风格及不可违背的核心设定'}"}]}。每个对象单独一条，绝不能把其他对象资料混入。若候选名错误但能根据作品线索、关系和上下文确认角色，必须返回纠正后的 canonicalName，不能照抄错误候选名。\n\n研究对象（JSON）：\n${JSON.stringify(researchObjects)}\n\n检索问题：\n${plan.queries.map((query, index) => `${index + 1}. ${query}`).join('\n')}`;
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
    return `${scopeIdentity()}|${settings().searchProvider}|${settings().searchAiModel}|${(plan.queries || []).join('|')}`;
}

function startCanonEnrichment(plan) {
    const key = researchJobKey(plan);
    const existing = inFlightResearch.get(key);
    if (existing) return existing;
    const scopeToken = captureScopeToken();

    const job = (async () => {
        const pages = await retrieve(plan);
        if (!scopeTokenIsCurrent(scopeToken)) return [];
        await saveCanonResearch(plan, pages);
        return scopeTokenIsCurrent(scopeToken) ? pages : [];
    })().finally(() => inFlightResearch.delete(key));
    // Attach a rejection handler immediately so a background request can never
    // become an unhandled promise rejection after generation has continued.
    job.catch(error => console.error('[Fandom Canon] Background research failed.', error));
    inFlightResearch.set(key, job);
    return job;
}

async function waitForResearch(job, seconds) {
    const waitMs = clampInt(seconds, 0, 180, 15) * 1000;
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
    await ensureConversationScope();
    await reconcileDeletedWorldBookEntries();
    const scopeToken = captureScopeToken();
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
        const firstPrompt = `你是同人资料识别助手。必须阅读角色卡正文、世界书和最近剧情，判断是否涉及已有作品，以及剧情属于原作时间线、AU，还是仅借用了同人角色的用户原创世界。角色卡标题只是文件名，不得把标题本身当人物、作品或搜索实体。\n\n只输出 JSON：{"workTitle":"正文能明确确认的作品正式名称；多作品时写多作品交叉同人（当前涉及：作品名）","storyType":"canon_timeline|au_timeline|original_world_with_fandom_characters|original_only|unknown","timeline":"正文结束时已经明确成立的原作/AU时间节点；完全无法判断则空字符串","entities":["正文结束瞬间仍在场或正直接参与互动的具体有名人物，以及当前一个具体地点"],"queries":["带人物各自作品名和具体专有名词的全网检索词"]}。entities 是完整当前场景快照：必须排除已经离场、上一场景、只被谈及、回忆中、未来可能登场的人物，以及组织、物品、能力、书籍和泛称；角色卡和世界书里的候选人物不能算在场。用户原创人物可以进入当前快照，但不要为其生成外部检索词。不确定的字段留空，不得编造；queries 最多 ${settings().maxQueries} 条，没有具体核实对象就返回空数组。\n\n角色卡正文：\n${source.card || '未读取到'}\n\n当前触发及角色卡内置世界书：\n${source.worldInfo || '无'}\n\n最近剧情：\n${source.recent || '暂无聊天内容。'}`;
        const first = await runJsonAnalysisPrompt(firstPrompt, 2000);
        if (!scopeTokenIsCurrent(scopeToken)) return;
        const identifySeconds = secondsSince(identifyStartedAt);
        const workTitle = String(first.workTitle || cardProfile.workTitle || '').trim();
        const originalWorld = first.storyType === 'original_world_with_fandom_characters' || first.storyType === 'original_only';
        const timeline = originalWorld
            ? '用户原创世界（仅含同人角色，非原作剧情）'
            : String(first.timeline || cardProfile.timeline || '').trim();
        const entities = cleanDetectedEntities(first.entities).slice(0, 8);
        const database = storedCanonEntities();
        const missingEntities = entities.filter(entity => {
            const recordName = findCanonRecordName(entity, database);
            return !recordName || !database[recordName]?.sources?.length;
        });
        let queries = missingEntities.map(entity =>
            `${entity} ${workTitle} 原作完整角色档案：身份、年龄、外貌身材、典型穿着、性格行为逻辑、能力、重要经历、人际关系、说话风格`.trim());
        queries = cleanPlannedQueries(queries, workTitle).slice(0, settings().maxQueries);
        const provisional = {
            work: workTitle,
            timeline,
            entities,
            autoEntities: entities,
            replaceAutoEntities: true,
            queries,
        };
        // The first structured pass has already read the card, active lore and
        // recent chat. Fill the visible table now; web research enriches the
        // persistent database in the background and must not hold the UI open.
        const detectedEntities = entities;
        if (!workTitle && !timeline && !detectedEntities.length) {
            throw new Error('分析模型没有识别出任何可填写内容，已取消“成功”提示；请确认当前角色卡已打开。');
        }
        syncProfileFromPlan(provisional);
        const nextWorkTitle = cardProfile.workTitle;
        const nextTimeline = cardProfile.timeline;
        const nextEntities = cardProfile.entities;
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
            startCanonEnrichment(provisional).then(async pages => {
                if (!scopeTokenIsCurrent(scopeToken)) return;
                const searchSeconds = secondsSince(backgroundStartedAt);
                await ensureCanonProfiles(provisional);
                if (!scopeTokenIsCurrent(scopeToken)) return;
                updateReport(`后台检索完成：已保存 ${pages.length} 条资料并压缩为时间线内档案（${searchSeconds} 秒）`, provisional, pages);
            }).catch(error => updateReport(`表格已填写，但后台检索失败：${error?.message || error}`, provisional));
        }
    } catch (error) {
        if (!scopeTokenIsCurrent(scopeToken)) return;
        console.error('[Fandom Canon] Auto-fill failed.', error);
        updateReport(`自动填写失败：${error?.message || error}`);
        toastr.error(error?.message || String(error), '自动填写失败');
    }
}

function buildReference(plan) {
    const strict = settings().strictMode;
    const database = storedCanonEntities();
    const records = cleanDetectedEntities(plan.entities)
        .map(entity => database[findCanonRecordName(entity, database)])
        .filter(Boolean);
    const persistedChanges = records
        .flatMap(record => Array.isArray(record?.canonChanges) ? record.canonChanges : []);
    const nameCorrections = records.flatMap(record => recordAliases(record, record.entity)
        .filter(alias => canonicalEntityKey(alias) !== canonicalEntityKey(record.entity))
        .map(alias => `${alias} → ${record.entity}`));
    const pendingChanges = cleanCanonChanges(plan.canonChanges)
        .filter(change => !persistedChanges.some(saved => changesAreEquivalent(change, saved)));
    const allCanonChanges = [...persistedChanges, ...pendingChanges]
        .filter((change, index, array) => !array.slice(0, index).some(saved => changesAreEquivalent(change, saved)));
    const canonChanges = allCanonChanges.length
        ? allCanonChanges.join('；')
        : '本轮没有检测到正文明确声明的新差异；已有角色继续沿用原著资料和既有AU设定';
    const profiles = records.map(record => {
        const body = String(record.profile || '').trim()
            || (record.sources || [])
                .map(source => extractEntitySpecificText(source.extract, record.entity))
                .filter(Boolean).join('\n').slice(0, 1200);
        return body ? `【${record.entity}】（${record.work || plan.work || '作品未确认'}）\n${body}` : '';
    }).filter(Boolean);
    return `<fandom_canon_reference>\n用途：仅核对用户本轮已经点名对象的原作事实；这不是登场清单、剧情提纲或后续事件建议。\n作品：${plan.work || '未确认'}\n当前时间线/AU节点：${plan.timeline || '未确认；必须避免擅自假定具体集数或时期'}\n用户本轮已点名且需要核对的对象：${plan.entities.join('、') || '无'}\n姓名校正：${nameCorrections.length ? [...new Set(nameCorrections)].join('；') : '无'}\n用户本轮明确声明的原著差异：${canonChanges}\n\n${profiles.length ? `事实档案（仅在正文自行写到对应对象时用于防止 OOC）：\n\n${profiles.join('\n\n')}\n\n` : ''}边界：\n1. 不得因为档案存在而安排、暗示或推动任何角色、地点、组织、物品或原作事件登场；剧情发展、登场选择和随机性完全由正文模型依据用户输入自行决定。\n2. 只有正文自行写到上述对象时，才核对姓名、外貌、身材、发色发型、惯常服装、性格、能力、经历和人际关系。\n3. 角色卡、用户明确设定和本次 AU 高于原作；不得把剧情改回原作路线。\n4. 严守当前时间线，不得提前泄露后期事件、关系变化、伤亡、能力、秘密和人物认知。\n5. 档案没写的细节不等于不存在。${strict ? '没有证据的精确原作事实不得编造，可采用不冲突的模糊描写。' : ''}\n6. 不要在正文提及检索、Wiki、资料编号或这些规则。\n</fandom_canon_reference>`.slice(0, 16000);
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

function conversationSignature(chat) {
    const messages = Array.isArray(chat) ? chat : [];
    const lastUserMessage = [...messages].reverse().find(message => message?.is_user);
    const cardProfile = profile();
    return [
        profileKey(),
        messages.filter(message => message?.is_user).length,
        lastUserMessage?.send_date ?? '',
        cardProfile.workTitle,
        cardProfile.timeline,
        cardProfile.entities,
        settings().strictMode,
    ].join('|');
}

async function runPreflight(chat, type = 'normal', force = false) {
    setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    lastReferenceText = '';
    lastRunSignature = '';
    if (!force && type !== 'manual') {
        updateReport('正文已直接放行；生成前不调用分析 AI、不注入人物或剧情提示，OOC 核验仅在生成后异步执行');
        return;
    }
    await ensureConversationScope();
    await reconcileDeletedWorldBookEntries();
    const scopeToken = captureScopeToken();
    const startedAt = performance.now();
    const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);
    if (busy) return;
    if (type === 'quiet' || (!settings().enabled && !force)) return;
    const signature = conversationSignature(chat);
    if (!force && signature && signature === lastRunSignature) {
        if (lastReferenceText) {
            setExtensionPrompt(PROMPT_KEY, lastReferenceText, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
            updateReport('对话尚未推进，已沿用上轮核实并注入的原作资料');
        } else {
            updateReport('对话尚未推进；上轮已确认无需新增检索');
        }
        return;
    }
    if (!profile().workTitle.trim() && !profile().entities.trim() && !currentCharacter()?.name) {
        updateReport('缺少作品名或人物名，已跳过');
        return;
    }

    busy = true;
    updateReport('正在规划检索…');
    try {
        const plan = await planQueries(chat);
        if (!scopeTokenIsCurrent(scopeToken)) return;
        syncProfileFromPlan({ ...plan, updateEntities: false });
        const storedPages = loadCanonResearch(plan);
        const missingEntities = missingCanonEntities(plan);
        const locallyChangedEntities = await persistCanonDeltas(plan);
        const shouldFetch = missingEntities.length > 0 || (plan.timelineChanged && plan.queries.length > 0);
        if (!plan.queries.length && !storedPages.length) {
            updateReport(`资料表已自动检查；没有新的有效检索对象（${elapsed()} 秒）`, plan);
            lastRunSignature = signature;
            return;
        }
        updateReport(shouldFetch && plan.queries.length
            ? `检测到确实需要补充的新资料，正在增量检索…（${elapsed()} 秒）`
            : `${locallyChangedEntities.length ? `已增量写入 ${locallyChangedEntities.length} 个角色的本卡变化；` : '角色资料没有变化，不搜索、不改写世界书；'}正在读取本卡资料库…（${elapsed()} 秒）`, plan);
        let fetchedPages = [];
        let timedOut = false;
        if (shouldFetch && plan.queries.length) {
            if (missingEntities.length) {
                updateReport(`检测到新原作对象：${missingEntities.join('、')}；正在核对正式姓名与完整档案，最多等待 ${settings().newEntityWaitSeconds} 秒，超时转入后台下轮补全（${elapsed()} 秒）`, plan);
                const result = await waitForResearch(startCanonEnrichment(plan), settings().newEntityWaitSeconds);
                if (!scopeTokenIsCurrent(scopeToken)) return;
                fetchedPages = result.pages;
                timedOut = result.timedOut;
            } else {
                const result = await waitForResearch(startCanonEnrichment(plan), settings().searchWaitSeconds);
                if (!scopeTokenIsCurrent(scopeToken)) return;
                fetchedPages = result.pages;
                timedOut = result.timedOut;
            }
        }
        const freshStoredPages = loadCanonResearch(plan);
        const pages = [...freshStoredPages, ...fetchedPages, ...storedPages].filter((page, index, array) =>
            array.findIndex(other => `${other.url}|${other.title}` === `${page.url}|${page.title}`) === index,
        ).slice(0, 10);
        if (!pages.length) {
            updateReport(timedOut
                ? `增量检索超过等待上限，已转入后台；本轮沿用现有资料（${elapsed()} 秒）`
                : `没有取得可用资料；本轮仅按角色卡与上下文继续，不会把候选译名当成已核实正式名（${elapsed()} 秒）`, plan);
            if (!timedOut) lastRunSignature = signature;
            return;
        }
        await ensureCanonProfiles(plan);
        if (!scopeTokenIsCurrent(scopeToken)) return;
        const reference = buildReference(plan);
        setExtensionPrompt(PROMPT_KEY, reference, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
        lastReferenceText = reference;
        const action = shouldFetch
            ? (timedOut ? '增量资料仍在后台检索；已先复用资料库并' : '已完成必要的增量检索并')
            : (locallyChangedEntities.length ? '已保存本卡新增变化并' : '未搜索、未改写世界书；已直接复用资料库并');
        updateReport(`${action}注入 ${pages.length} 条资料的整理档案（总耗时 ${elapsed()} 秒）`, plan, pages);
        console.info('[Fandom Canon] Reference injected.', { plan, pages });
        if (!timedOut) lastRunSignature = signature;
    } catch (error) {
        if (!scopeTokenIsCurrent(scopeToken)) return;
        console.error('[Fandom Canon] Retrieval failed.', error);
        lastRunSignature = '';
        updateReport(`检索失败：${error?.message || error}`);
    } finally {
        if (scopeTokenIsCurrent(scopeToken)) busy = false;
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
                <details class="fcr-api-box fcr-release-notes">
                    <summary><i class="fa-solid fa-clock-rotate-left"></i> v${EXTENSION_VERSION} 本版更新内容</summary>
                    ${releaseHistoryHtml()}
                </details>
                <button id="fcr-enabled" class="fcr-check-row" type="button" aria-pressed="${config.enabled}"><span class="fcr-check-box" aria-hidden="true"></span><span>启用原作资料核验（生成前不阻塞正文）</span></button>
                <button id="fcr-planner" class="fcr-check-row" type="button" aria-pressed="${config.autoPlanner}"><span class="fcr-check-box" aria-hidden="true"></span><span>手动核验时识别用户明确点名的检索对象</span></button>
                <button id="fcr-auto-update-profile" class="fcr-check-row" type="button" aria-pressed="${config.autoUpdateProfile}"><span class="fcr-check-box" aria-hidden="true"></span><span>生成后随剧情更新当前人物、地点和时间节点</span></button>
                <button id="fcr-strict" class="fcr-check-row" type="button" aria-pressed="${config.strictMode}"><span class="fcr-check-box" aria-hidden="true"></span><span>严格模式：没有资料依据时不编造精确设定</span></button>
                <button id="fcr-review" class="fcr-check-row" type="button" aria-pressed="${config.reviewEnabled}"><span class="fcr-check-box" aria-hidden="true"></span><span>生成后自动审核正文，按本卡资料修订未解释的冲突（性格/经历/外貌/能力等）</span></button>
                <div class="fcr-grid">
                    <label>Wikipedia 语言<select id="fcr-language"><option value="zh">中文</option><option value="ja">日文</option><option value="en">英文</option></select></label>
                    <label>每次最多查询数<input id="fcr-max-queries" type="number" min="1" max="5" value="${config.maxQueries}"></label>
                    <label>缓存分钟<input id="fcr-cache-minutes" type="number" min="10" max="10080" value="${config.cacheMinutes}"></label>
                    <label>已有资料增量检索最多等待（秒）<input id="fcr-search-wait" type="number" min="0" max="60" value="${config.searchWaitSeconds}"></label>
                    <label>新角色完整检索最多等待（秒）<input id="fcr-new-entity-wait" type="number" min="0" max="180" value="${config.newEntityWaitSeconds}"></label>
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
                    <button id="fcr-clear-database" class="menu_button"><i class="fa-solid fa-rotate-left"></i> 重置本局全部资料</button>
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
    const sceneSync = profile().sceneSync || {};
    const sceneStatus = {
        idle: '尚未同步',
        syncing: '正在分析并同步',
        retrying: '同步失败，正在自动重试',
        synced: '已同步',
        error: '同步失败',
    }[sceneSync.status] || '尚未同步';
    const sceneError = sceneSync.error
        ? `<div class="fcr-scene-error"><b>同步错误：</b>${escapeHtml(sceneSync.error)}</div>` : '';
    const queries = lastReport.queries.length
        ? `<div><b>检索词：</b>${lastReport.queries.map(escapeHtml).join('；')}</div>` : '';
    const sources = lastReport.sources.length
        ? `<details><summary>本轮来源（${lastReport.sources.length}）</summary>${lastReport.sources.map(item =>
            `<div>${escapeHtml(item.source)}：${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</div>`,
        ).join('')}</details>` : '';
    node.innerHTML = `<div><b>状态：</b>${escapeHtml(lastReport.status)}</div><div><b>当前场景：</b>${escapeHtml(sceneStatus)}${sceneSync.updatedAt ? `（${escapeHtml(new Date(sceneSync.updatedAt).toLocaleTimeString())}）` : ''}</div>${sceneError}<div><b>本卡持久资料库：</b>${databaseCount} 个角色${worldBook ? `；同步到世界书「${escapeHtml(worldBook)}」` : '；当前角色未绑定世界书'}</div>${queries}${sources}`;
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
    bindToggle('#fcr-review', 'reviewEnabled');

    bindSetting('#fcr-language', 'language', String);
    bindSetting('#fcr-max-queries', 'maxQueries', value => clampInt(value, 1, 5, 3));
    bindSetting('#fcr-cache-minutes', 'cacheMinutes', value => clampInt(value, 10, 10080, 360));
    bindSetting('#fcr-search-wait', 'searchWaitSeconds', value => clampInt(value, 0, 60, 15));
    bindSetting('#fcr-new-entity-wait', 'newEntityWaitSeconds', value => clampInt(value, 0, 180, 60));
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
        await resetCurrentConversationData({
            reason: '当前角色卡本局的表格、资料库、注入提示和插件世界书条目已全部清空；其他角色卡的资料和缓存未受影响',
        });
        toastr.success('当前角色卡本局资料已彻底重置；其他角色卡未受影响。', '晋阳的同人库');
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

    await ensureConversationScope();
    await reconcileDeletedWorldBookEntries();
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
    await ensureConversationScope();
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
    await reconcileDeletedWorldBookEntries();
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
    setTimeout(() => showReleaseNotesOnce()
        .catch(error => console.error('[Fandom Canon] Could not show release notes.', error)), 1200);
    const context = getContext();
    context.eventSource?.on?.(context.eventTypes?.CHAT_CHANGED ?? 'chat_changed', () => setTimeout(async () => {
        clearRuntimeState();
        try {
            await ensureConversationScope();
            loadProfileIntoPanel();
            await refreshOrMigrateCanonDatabase();
            reconcileLatestAssistantMessage('切换聊天后补同步', 1200);
        } catch (error) {
            console.error('[Fandom Canon] Could not refresh canon database.', error);
        }
    }, 150));
    context.eventSource?.on?.(context.eventTypes?.MESSAGE_DELETED ?? 'message_deleted', () => setTimeout(async () => {
        try {
            await ensureConversationScope();
            const visibleMessages = (Array.isArray(getContext().chat) ? getContext().chat : [])
                .filter(message => message && !message.is_system);
            const hasUserMessage = visibleMessages.some(message => message.is_user);
            if (!hasUserMessage && visibleMessages.length <= 1 && profileHasConversationData()) {
                await resetCurrentConversationData({
                    reason: '检测到聊天记录已清空；当前角色卡本局资料已自动重置，其他角色卡未受影响',
                });
            }
        } catch (error) {
            console.error('[Fandom Canon] Could not reset data after chat deletion.', error);
        }
    }, 250));
    context.eventSource?.on?.(context.eventTypes?.MESSAGE_RECEIVED ?? 'message_received', (messageId, type) => {
        scheduleMessageReview(messageId, type, { delayMs: 500, reason: '消息接收完成' });
    });
    context.eventSource?.on?.(context.eventTypes?.CHARACTER_MESSAGE_RENDERED ?? 'character_message_rendered', (messageId, type) => {
        scheduleMessageReview(messageId, type, { delayMs: 750, reason: '消息渲染完成' });
    });
    context.eventSource?.on?.(context.eventTypes?.GENERATION_ENDED ?? 'generation_ended', () => {
        setTimeout(() => reconcileLatestAssistantMessage('生成结束兜底', 250), 500);
    });
    setTimeout(() => reconcileLatestAssistantMessage('插件启动补同步', 0), 2500);
    setInterval(() => {
        if (document.visibilityState === 'hidden' || isPageGenerating()) return;
        reconcileLatestAssistantMessage('后台巡检补同步', 0);
    }, 15000);
    console.info('[Fandom Canon] Loaded.');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}
