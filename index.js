import {
    extension_prompt_roles,
    extension_prompt_types,
    generateRaw,
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
import {
    checkWorldInfo,
    createWorldInfoEntry,
    getSortedEntries,
    loadWorldInfo,
    reloadEditor,
    saveWorldInfo,
    worldInfoCache,
    world_names,
} from '../../../world-info.js';

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
const SCENE_SYNC_FORMAT_VERSION = 7;
const CANON_DATABASE_FORMAT_VERSION = 6;
const CANON_PROFILE_FORMAT_VERSION = 2;
const EXTENSION_VERSION = '2.5.0';
// Keep this history and CHANGELOG.md in sync for every release.
const RELEASE_HISTORY = [{
    version: '2.5.0',
    notes: [
        '原著资料链升级为通用实体：人物、地点、物品、能力、组织、事件和世界规则都能分别检索、建档、注入与审核。',
        '正常出文前会从本地资料库选取当前场景及本轮点名对象，注入紧凑的原著基线与当前 AU；不调用任何 API，不增加生成前等待或 429。',
        'AU 改为按“对象＋属性”更新的结构化事实：完整保留变化历史，只把当前有效状态交给主 AI，关系句不会再串进所有被提到的人物档案。',
        '生成后先应用最小 OOC 修订，再按修订后的正文更新场景与 AU，避免错误正文先污染世界书。',
        '审核范围扩展到姓名、外貌、性格、经历、关系、地点、物品归属、能力机制与限制等全部原作事实，同时把实际出现过但本轮已离场的对象纳入核验。',
        '搜索结果必须与具体对象、实体类型和所属作品配对；严格模式只使用身份与来源均通过验证的档案，旧版 provisional 资料不能经迁移、别名合并或压缩被洗成可信。',
        '自动后台场景同步、AU 更新与生成后审校只使用独立分析 API；当前酒馆模型仅供手动操作，避免分析任务干扰流式正文。',
        '分析及 Chat Completions 搜索固定经酒馆同源代理单路径发送一次 POST；停止、重 Roll、切换回复只会作废旧任务，插件绝不会主动触发重 Roll；有限重试尊重 Retry-After。',
        '单轮联网查询严格受“每次最多查询数”限制，超出对象留到后续剧情增量补齐，不再形成多批请求和 429 峰值。',
        '世界书写入会记录全部目标并进行可验证保存；重置会清理所有曾写入的世界书，加载异常不再误删本地资料。',
        '世界书 AU 现在绑定具体书名、条目 UID 与内容版本：启用但本轮未触发的设定继续保留，真正关闭、删除或改掉依据的条目会在下次生成前撤回旧状态。',
        '用户明确要求“推进/切换到某事件、篇章或阶段”会在生成前本地覆盖旧时间线；回忆、档案、录像和假设中的年份或事件不会反向改写当前节点。',
        '自定义搜索 AI 只有服务端 web_search 引用或插件实际读取的页面才能提升为已验证来源；模型在 JSON 中自行编写的链接不能洗白严格模式档案。',
        '长角色卡和启用世界书会抽取中段的明确 AU/原著约束；单对象档案的外貌、性格、经历分段不再因每段未重复姓名而丢失。',
        '手动使用当前酒馆模型核验时会阻止重叠的正文生成，避免不可取消的旧请求造成延迟 429；停止后允许的 swipe/edit 有限重试会完整保留停止权限。',
        '自动修订必须与被审核实体出现在同一句事实中，不能借人物标签改写无关动作、剧情结果或相邻句。',
    ],
}, {
    version: '2.4.2',
    notes: [
        '修复自动场景分析丢弃 AU 差异的问题：不再把 canonChanges 硬编码为空数组。',
        '会增量记录所有有明确依据、且会影响后续写作的原著差异，包括身份、阵营、能力、装备、经历、生死、关系、外貌状态、地点势力、事件结果和时间线等，不限于固定类别。',
        '已保存的 AU 差异会同步到人物条目与当前场景，并在每次正文生成前直接注入；该步骤只读取本地资料，不增加搜索或分析请求。',
        '正常生成、立即检索和手动核验统一读取本局 AU 总表，属于物品或世界规则的差异也不会在切换入口后失效。',
        '只有角色卡、用户明确设定、已启用世界书、反复建立的上下文或正文明确发生的变化才会入库；不会把“暂时没提到”误判为 AU。',
    ],
}, {
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
let busyOwner = 0;
let lastReport = { status: '尚未检索', queries: [], sources: [], at: 0 };
let lastRunSignature = '';
let lastReferenceText = '';
let conversationTransition = null;
const scopeEpochs = new Map();
const inFlightResearch = new Map();
const inFlightSceneReviews = new Map();
const scheduledSceneReviews = new Map();
const sceneAnalysisCache = new Map();
const worldBookWriteQueues = new Map();
const worldBookRepairTimers = new Map();
const reviewEpochs = new Map();
let analysisQueue = Promise.resolve();
const activeAnalysisControllers = new Set();
const activeResearchControllers = new Set();
const profileTransactionEpochs = new WeakMap();
let runtimeEpoch = 0;
const SCENE_RETRY_DELAYS_MS = [15000, 60000];
const WORLD_BOOK_REPAIR_DELAYS_MS = [15000, 60000, 300000];
const CANON_ENTITY_KINDS = new Set(['character', 'location', 'item', 'ability', 'organization', 'event', 'world_rule']);
let foregroundGenerationEpoch = 0;
let stoppedGenerationEpoch = -1;
let foregroundGenerationActive = false;
let generationAfterCommandsEpoch = -1;
let internalAnalysisDepth = 0;
let internalMessageUpdateDepth = 0;

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

function requestTimeoutSignal(milliseconds = LLM_FETCH_TIMEOUT_MS, externalSignal = null) {
    if (!externalSignal && typeof AbortSignal?.timeout === 'function') return AbortSignal.timeout(milliseconds);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), milliseconds);
    if (externalSignal) {
        const forwardAbort = () => controller.abort(externalSignal.reason || Object.assign(new Error('分析任务已取消'), { fcrCancelled: true }));
        if (externalSignal.aborted) forwardAbort();
        else externalSignal.addEventListener('abort', forwardAbort, { once: true });
    }
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    return controller.signal;
}

async function directApiFetch(url, options, label) {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            const detail = (await response.text()).slice(0, 500);
            const error = new Error(`${label}失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
            error.fcrHttpStatus = response.status;
            error.fcrRetryAfterMs = retryAfterMilliseconds(response.headers?.get?.('retry-after'));
            error.fcrCanUseProxy = false;
            throw error;
        }
        return response;
    } catch (error) {
        if (error?.fcrCancelled || options?.signal?.reason?.fcrCancelled) {
            const cancelled = error?.fcrCancelled ? error : options.signal.reason;
            cancelled.fcrCancelled = true;
            throw cancelled;
        }
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
            const timeoutError = new Error(`${label}超时：服务器长时间无响应`);
            timeoutError.fcrCanUseProxy = false;
            throw timeoutError;
        }
        if (error instanceof TypeError) {
            const connectionError = new Error(`${label}无法从浏览器直连。请确认 API 使用 HTTPS，并允许浏览器跨域访问（CORS）。模型列表读取可改用酒馆代理；Responses 联网请求不能自动改走另一协议。`);
            connectionError.fcrCanUseProxy = true;
            throw connectionError;
        }
        throw error;
    }
}

function retryAfterMilliseconds(value) {
    const raw = String(value || '').trim();
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function customAuthorizationHeader(kind) {
    const key = readLocalCredential(kind);
    if (!key) throw new Error('尚未在此设备保存 API Key');
    return JSON.stringify({ Authorization: `Bearer ${key}` });
}

async function fetchModelsWithFallback(baseUrl, kind) {
    let directError;
    try {
        const response = await directApiFetch(apiEndpoint(baseUrl, 'models'), {
            method: 'GET',
            headers: directApiHeaders(kind),
            signal: requestTimeoutSignal(LLM_FETCH_TIMEOUT_MS),
        }, '读取模型');
        return await response.json();
    } catch (error) {
        directError = error;
    }

    if (directError?.fcrCanUseProxy !== true) throw directError;

    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: requestTimeoutSignal(LLM_FETCH_TIMEOUT_MS),
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: baseUrl,
            custom_include_headers: customAuthorizationHeader(kind),
        }),
    });
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        const error = new Error(`${directError?.message || directError}；酒馆通用代理也失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
        error.fcrHttpStatus = response.status;
        error.fcrRetryAfterMs = retryAfterMilliseconds(response.headers?.get?.('retry-after'));
        throw error;
    }
    return await response.json();
}

async function chatCompletionWithFallback(baseUrl, kind, body, label, externalSignal = null) {
    // POST generation must have exactly one upstream path.  A browser TypeError
    // can mean either "not sent" or "sent but its response was blocked by CORS";
    // retrying that same POST through the proxy can therefore create a delayed
    // duplicate request and a second 429.  SillyTavern's same-origin custom
    // backend proxy is the single path for Chat Completions.  Responses API
    // web-search calls remain direct because that route has different semantics.
    const signal = requestTimeoutSignal(LLM_FETCH_TIMEOUT_MS, externalSignal);
    let response;
    try {
        response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            signal,
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: baseUrl,
                custom_include_headers: customAuthorizationHeader(kind),
                custom_include_body: '',
                custom_exclude_body: '',
                ...body,
            }),
        });
    } catch (error) {
        if (signal?.reason?.fcrCancelled || error?.fcrCancelled) {
            const cancelled = signal?.reason?.fcrCancelled ? signal.reason : error;
            cancelled.fcrCancelled = true;
            throw cancelled;
        }
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
            throw new Error(`${label}超时：服务器长时间无响应`);
        }
        throw new Error(`${label}无法连接酒馆通用代理：${error?.message || error}`);
    }
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        const error = new Error(`${label}失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
        error.fcrHttpStatus = response.status;
        error.fcrRetryAfterMs = retryAfterMilliseconds(response.headers?.get?.('retry-after'));
        throw error;
    }
    return await response.json();
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
    cardProfile.auChanges ??= [];
    cardProfile.auFacts ??= null;
    cardProfile.auHistory ??= [];
    cardProfile.writtenWorldBooks ??= [];
    cardProfile.worldSyncPending ??= false;
    cardProfile.worldSyncRevision ??= 0;
    cardProfile.unresolvedEntities ??= [];
    cardProfile.canonDatabase ??= {};
    // Old builds used `baselineStatus=verified` before they tracked whether a
    // result actually matched the requested work/person.  Never translate that
    // historical flag into source trust: doing so can briefly expose a wrong
    // same-name result during startup and permanently launder it on migration.
    for (const record of Object.values(cardProfile.canonDatabase)) {
        if (!record || record.sourceTrust) continue;
        record.sourceTrust = 'provisional';
    }
    ensureStructuredAuState(cardProfile, cardProfile.canonDatabase);
    cardProfile.currentScene ??= null;
    cardProfile.sceneHistory ??= [];
    cardProfile.sceneSync ??= {
        status: 'idle',
        signature: '',
        messageId: null,
        updatedAt: 0,
        error: '',
        retryCount: 0,
        nextRetryAt: 0,
        formatVersion: 0,
    };
    return cardProfile;
}

function scopeIdentity(targetProfileKey = profileKey(), targetConversationId = currentConversationId()) {
    return `${targetProfileKey}\u0000${targetConversationId}`;
}

function invalidateProfileTransactions(cardProfile = profile()) {
    const next = (profileTransactionEpochs.get(cardProfile) || 0) + 1;
    profileTransactionEpochs.set(cardProfile, next);
    return next;
}

async function settleSceneTransactions(targetScope = scopeIdentity()) {
    const jobs = [...inFlightSceneReviews.entries()]
        .filter(([key]) => key.startsWith(`${targetScope}|`))
        .map(([, flight]) => flight?.promise)
        .filter(Boolean);
    if (jobs.length) await Promise.allSettled(jobs);
}

function clearRuntimeState(targetProfileKey = profileKey(), targetConversationId = currentConversationId()) {
    runtimeEpoch++;
    const targetScope = scopeIdentity(targetProfileKey, targetConversationId);
    scopeEpochs.set(targetScope, (scopeEpochs.get(targetScope) || 0) + 1);
    busyOwner++;
    busy = false;
    foregroundGenerationActive = false;
    generationAfterCommandsEpoch = -1;
    stoppedGenerationEpoch = -1;
    abortActiveAnalysisRequests('插件作用域已切换，旧分析任务已取消');
    abortActiveResearchRequests('插件作用域已切换，旧检索任务已取消');
    lastRunSignature = '';
    lastReferenceText = '';
    for (const key of inFlightResearch.keys()) {
        if (key.startsWith(`${targetScope}|`)) inFlightResearch.delete(key);
    }
    for (const key of inFlightSceneReviews.keys()) {
        if (!key.startsWith(`${targetScope}|`)) continue;
        reviewEpochs.set(key, (reviewEpochs.get(key) || 0) + 1);
    }
    for (const signature of reviewedMessageSignatures) {
        if (signature.startsWith(`${targetScope}|`)) reviewedMessageSignatures.delete(signature);
    }
    for (const signature of sceneAnalysisCache.keys()) {
        if (signature.startsWith(`${targetScope}|`)) sceneAnalysisCache.delete(signature);
    }
    for (const [key, timer] of scheduledSceneReviews) {
        if (!key.startsWith(`${targetScope}|`)) continue;
        clearTimeout(timer);
        scheduledSceneReviews.delete(key);
    }
    const repair = worldBookRepairTimers.get(targetScope);
    if (repair?.timer) clearTimeout(repair.timer);
    worldBookRepairTimers.delete(targetScope);
    setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    if (targetScope === scopeIdentity()) {
        const cardProfile = profile();
        if (cardProfile.worldSyncPending) {
            scheduleWorldBookRepair(
                cardProfile, captureScopeToken(), Number(cardProfile.worldSyncRevision) || 0,
            );
        }
    }
}

function invalidateManualOperations() {
    busyOwner++;
    busy = false;
}

function clearConversationProfile(cardProfile, conversationId = currentConversationId()) {
    invalidateProfileTransactions(cardProfile);
    cardProfile.workTitle = '';
    cardProfile.timeline = '';
    cardProfile.entities = '';
    cardProfile.customWikiApi = '';
    cardProfile.lastAutoWorkTitle = '';
    cardProfile.lastAutoTimeline = '';
    cardProfile.lastAutoEntities = [];
    cardProfile.auChanges = [];
    cardProfile.auFacts = [];
    cardProfile.auHistory = [];
    cardProfile.canonDatabase = {};
    cardProfile.canonWorldBook = '';
    cardProfile.writtenWorldBooks = [];
    cardProfile.worldSyncPending = false;
    cardProfile.worldSyncRevision = (Number(cardProfile.worldSyncRevision) || 0) + 1;
    cancelWorldBookRepair(captureScopeToken());
    cardProfile.unresolvedEntities = [];
    cardProfile.canonDatabaseFormatVersion = CANON_DATABASE_FORMAT_VERSION;
    cardProfile.currentScene = null;
    cardProfile.sceneHistory = [];
    cardProfile.sceneSync = {
        status: 'idle',
        signature: '',
        messageId: null,
        updatedAt: 0,
        error: '',
        retryCount: 0,
        nextRetryAt: 0,
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
        || activeAuFacts(cardProfile).length
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
        runtimeEpoch,
        profileKey: currentProfileKey,
        conversationId,
    };
}

function scopeTokenIsCurrent(token) {
    const currentProfileKey = profileKey();
    const conversationId = currentConversationId();
    const scope = scopeIdentity(currentProfileKey, conversationId);
    return token?.runtimeEpoch === runtimeEpoch
        && token?.epoch === (scopeEpochs.get(scope) || 0)
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
        .map(message => `${message.is_user ? '用户' : '角色'}：${balancedExcerpt(stripMarkup(message.mes), 1200)}`)
        .join('\n');
}

function contextAwareExcerpt(value, maxChars) {
    const text = String(value || '');
    const maximum = Math.max(400, Number(maxChars) || 0);
    if (text.length <= maximum) return text;

    // Preserve explicit AU/canon constraints wherever they occur.  A simple
    // head+tail slice permanently hid middle paragraphs in long cards and
    // lorebooks, so the analysis model could never discover those settings.
    const headLength = Math.floor(maximum * 0.34);
    const tailLength = Math.floor(maximum * 0.24);
    const middleBudget = maximum - headLength - tailLength;
    const ranges = [];
    const addWindow = (position, radius = 210) => {
        const start = Math.max(headLength, position - radius);
        const end = Math.min(text.length - tailLength, position + radius);
        if (end > start) ranges.push([start, end]);
    };
    const signal = /与原著|不同于原著|原作(?:中|里|设定)|本(?:世界|宇宙|卡|作|AU)|时间线|剧情节点|从未|未曾|不再|没有|并未|失去|获得|拥有|改为|变成|死亡|复活|关系|恋爱|外貌|发色|性格|身份|阵营|经历|能力|限制|物品|宝石|原创世界|alternate\s+universe|canon|timeline|never|no longer|without|instead of/gi;
    for (const match of text.matchAll(signal)) addWindow(match.index || 0);
    // Even cards without obvious cue words still get deterministic coverage
    // across their middle rather than one permanently invisible region.
    for (const ratio of [0.25, 0.5, 0.75]) addWindow(Math.floor(text.length * ratio), 100);
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range[0] <= previous[1] + 24) previous[1] = Math.max(previous[1], range[1]);
        else merged.push([...range]);
    }
    const middleParts = [];
    const maximumParts = Math.max(1, Math.floor(middleBudget / 140));
    const selectedRanges = merged.length <= maximumParts ? merged : Array.from({ length: maximumParts }, (_, index) => {
        const at = Math.round(index * (merged.length - 1) / Math.max(1, maximumParts - 1));
        return merged[at];
    }).filter((range, index, array) => index === 0 || range !== array[index - 1]);
    let remaining = middleBudget;
    for (let index = 0; index < selectedRanges.length; index++) {
        if (remaining <= 0) break;
        const [start, end] = selectedRanges[index];
        const share = Math.max(40, Math.floor(remaining / (selectedRanges.length - index)));
        const width = Math.min(end - start, share);
        const center = Math.floor((start + end) / 2);
        const partStart = Math.max(start, Math.min(end - width, center - Math.floor(width / 2)));
        const part = text.slice(partStart, partStart + width).trim();
        if (!part) continue;
        middleParts.push(part);
        remaining -= part.length;
    }
    return [
        text.slice(0, headLength),
        '…（中段按明确设定与均匀位置抽取；资料库原文未删除）…',
        middleParts.join('\n…\n'),
        '…',
        text.slice(-tailLength),
    ].filter(Boolean).join('\n');
}

function characterCardContext({ full = false } = {}) {
    const group = currentGroup();
    const characters = group ? currentGroupCharacters() : [currentCharacter()].filter(Boolean);
    if (!characters.length) return '';
    const excerpt = (value, maximum) => {
        const text = stripMarkup(value || '');
        return full ? text : contextAwareExcerpt(text, maximum);
    };
    const cards = (full ? characters : characters.slice(0, 8)).map(character => {
        const data = character.data ?? character;
        return [
            `角色卡名：${character.name || data.name || ''}`,
            `简介：${excerpt(data.description || character.description, 3000)}`,
            `性格：${excerpt(data.personality || character.personality, 1600)}`,
            `场景：${excerpt(data.scenario || character.scenario, 2200)}`,
            `首条消息：${excerpt(data.first_mes || character.first_mes, 2200)}`,
            `创作者说明：${excerpt(data.creator_notes || character.creatorcomment, 1800)}`,
            `角色深度设定：${excerpt(data.extensions?.depth_prompt?.prompt, 1200)}`,
            `系统设定：${excerpt(data.system_prompt, 1200)}`,
            `历史后指令：${excerpt(data.post_history_instructions, 1000)}`,
        ].filter(Boolean).join('\n');
    });
    return [group ? `当前群聊：${group.name || group.id}` : '', ...cards].filter(Boolean).join('\n\n');
}

function normalizeWorldInfoEntryState(entry) {
    return {
        world: String(entry?.world || '').trim(),
        uid: String(entry?.uid ?? '').trim(),
        hash: String(entry?.hash ?? textHash(String(entry?.content || ''))),
        content: stripMarkup(String(entry?.content || '')
            .replace(/<!-- FCR_CANON_DATABASE_V2 -->[\s\S]*?<!-- \/FCR_CANON_DATABASE_V2 -->/g, '')
            .replace(/<!-- FCR_CURRENT_SCENE_V1 -->[\s\S]*?<!-- \/FCR_CURRENT_SCENE_V1 -->/g, '')),
        disabled: entry?.disable === true,
    };
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
        const globalScanData = {
            personaDescription: '',
            characterDescription: values(data => data.description || ''),
            characterPersonality: values(data => data.personality || ''),
            characterDepthPrompt: values(data => data.extensions?.depth_prompt?.prompt || ''),
            scenario: values(data => data.scenario || ''),
            creatorNotes: values((data, character) => data.creator_notes || character.creatorcomment || ''),
            trigger: 'normal',
        };
        const result = await checkWorldInfo(
            chatForWorldInfo, Number(context.maxContext) || 32768, true, globalScanData,
        );
        const extraEntries = [
            ...(result.EMEntries || []),
            ...(result.WIDepthEntries || []),
            ...(result.ANBeforeEntries || []),
            ...(result.ANAfterEntries || []),
            ...Object.values(result.outletEntries || {}).flat(),
        ].map(entry => typeof entry === 'string' ? entry : entry?.content || '').filter(Boolean);
        const combined = [result.worldInfoBefore, result.worldInfoAfter, ...extraEntries].filter(Boolean).join('\n\n')
            .replace(/<!-- FCR_CANON_DATABASE_V2 -->[\s\S]*?<!-- \/FCR_CANON_DATABASE_V2 -->/g, '')
            .replace(/<!-- FCR_CURRENT_SCENE_V1 -->[\s\S]*?<!-- \/FCR_CURRENT_SCENE_V1 -->/g, '');
        const corpus = stripMarkup(combined);
        const activeEntries = [...(result.allActivatedEntries || [])]
            .map(normalizeWorldInfoEntryState).filter(entry => entry.world && entry.uid && entry.content);
        const allEntries = (await getSortedEntries()).map(normalizeWorldInfoEntryState)
            .filter(entry => entry.world && entry.uid && entry.content);
        return {
            text: contextAwareExcerpt(corpus, 18000),
            corpus,
            available: true,
            entries: activeEntries,
            entryStates: allEntries,
        };
    } catch (error) {
        console.warn('[Fandom Canon] Failed to read active World Info.', error);
        return { text: '', corpus: '', available: false, entries: [], entryStates: [] };
    }
}

function validHttpCitationUrls(values) {
    const urls = [];
    for (const value of Array.isArray(values) ? values : []) {
        try {
            const parsed = new URL(String(value || '').trim());
            if (!['http:', 'https:'].includes(parsed.protocol)) continue;
            const normalized = parsed.href;
            if (!urls.includes(normalized)) urls.push(normalized);
        } catch {
            // Model-written labels such as “官方资料” are not citations.
        }
    }
    return urls;
}

function citationSiteKey(value) {
    try {
        const hostname = new URL(String(value || '')).hostname.toLocaleLowerCase().replace(/^www\./, '');
        const parts = hostname.split('.').filter(Boolean);
        if (parts.length <= 2) return hostname;
        const publicSuffixPair = `${parts.at(-2)}.${parts.at(-1)}`;
        if (['co.uk', 'org.uk', 'com.cn', 'com.hk', 'com.au', 'co.jp'].includes(publicSuffixPair)) {
            return parts.slice(-3).join('.');
        }
        return parts.slice(-2).join('.');
    } catch {
        return '';
    }
}

async function researchContext(chat) {
    const card = characterCardContext();
    const cardEvidence = characterCardContext({ full: true });
    const active = await worldInfoContext(chat);
    return {
        card,
        cardEvidence,
        // Only use SillyTavern's dry-run activation result. This preserves the
        // user's enabled/disabled state, keys, probability, character filters,
        // recursion and current-chat activation rules instead of reading a whole book.
        worldInfo: active.text,
        worldInfoEvidence: active.corpus,
        worldInfoEntries: active.entries,
        worldInfoEntryStates: active.entryStates,
        cardAvailable: Boolean(currentGroup() || currentCharacter()),
        worldInfoAvailable: active.available,
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

function abortActiveAnalysisRequests(reason = '正文已切换，旧分析任务已取消') {
    for (const controller of activeAnalysisControllers) {
        if (controller.signal.aborted) continue;
        const error = Object.assign(new Error(reason), { fcrCancelled: true });
        controller.abort(error);
    }
}

function abortActiveResearchRequests(reason = '正文已切换，旧检索任务已取消') {
    for (const controller of activeResearchControllers) {
        if (controller.signal.aborted) continue;
        controller.abort(Object.assign(new Error(reason), { fcrCancelled: true }));
    }
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const reason = signal.reason instanceof Error
        ? signal.reason : Object.assign(new Error('检索任务已取消'), { fcrCancelled: true });
    reason.fcrCancelled = true;
    throw reason;
}

function enqueueAnalysisRequest(task, freshnessGuard = null) {
    const job = analysisQueue.catch(() => undefined).then(() => {
        if (freshnessGuard && !freshnessGuard()) {
            const error = new Error('分析任务已因正文切换或新一轮生成取消');
            error.fcrCancelled = true;
            throw error;
        }
        const controller = new AbortController();
        activeAnalysisControllers.add(controller);
        return Promise.resolve(task(controller.signal)).finally(() => {
            activeAnalysisControllers.delete(controller);
        });
    });
    analysisQueue = job.catch(() => undefined);
    return job;
}

async function runJsonAnalysisPrompt(prompt, maxTokens = 1800, freshnessGuard = null) {
    let lastRaw = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        if (freshnessGuard && !freshnessGuard()) {
            const error = new Error('分析任务已取消');
            error.fcrCancelled = true;
            throw error;
        }
        const budget = attempt === 0 ? maxTokens : Math.max(3200, maxTokens * 2);
        const retryInstruction = attempt === 0
            ? ''
            : '\n\n上一次回答被截断。请重新输出完整、紧凑的单行 JSON；必须闭合全部引号、数组和大括号，不要 Markdown。';
        lastRaw = await runAnalysisPrompt(prompt + retryInstruction, budget, freshnessGuard);
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
            .replace(/\/(?:models|chat\/completions|completions|responses)\/?$/i, '')
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

async function callCustomAnalysis(baseUrl, model, prompt, maxTokens = 500, signal = null) {
    const data = await chatCompletionWithFallback(baseUrl, 'analysis', {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: maxTokens,
        stream: false,
    }, '分析 LLM 请求', signal);
    const content = extractAssistantContent(data).trim();
    if (content) return content;
    throw new Error(`分析 LLM 返回了空内容（finish_reason: ${data?.choices?.[0]?.finish_reason || '未知'}）`);
}

async function runAnalysisPrompt(prompt, maxTokens = 500, freshnessGuard = null) {
    return await enqueueAnalysisRequest(async signal => {
        const config = settings();
        if (config.analysisSource !== 'custom') {
            internalAnalysisDepth++;
            try {
                return await generateRaw({
                    prompt: [{ role: 'user', content: prompt }],
                    responseLength: maxTokens,
                    trimNames: false,
                });
            } finally {
                internalAnalysisDepth = Math.max(0, internalAnalysisDepth - 1);
            }
        }
        if (!config.analysisBaseUrl || !config.analysisModel) {
            throw new Error('请先检测分析 LLM 并选择模型');
        }
        return await callCustomAnalysis(config.analysisBaseUrl, config.analysisModel, prompt, maxTokens, signal);
    }, freshnessGuard);
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
        .filter(value => value !== null && value !== undefined)
        .map(String)
        .map(normalizeEntityDisplay)
        .filter(value => value.length >= 2
            && !/^(?:undefined|null)$/i.test(value)
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
        // A missing model field is not evidence that an entity is a person.
        // Keep it unknown until a structured scene pass or researched identity
        // supplies a type; otherwise items such as the Time Stone become
        // permanently locked as characters after one incomplete JSON reply.
        const kind = normalizeEntityKind(raw.kind ?? raw.type, 'unknown');
        const workHint = String(raw.workHint ?? raw.work ?? '').trim();
        if (candidates.some(item => canonicalEntityKey(item.candidateName) === key
            && item.kind === kind
            && normalizeChangeText(item.workHint) === normalizeChangeText(workHint))) continue;
        candidates.push({
            candidateName,
            kind,
            // Keep the model field tri-state.  Omitting `isOriginal` is not
            // proof that a previously unseen name belongs to a fandom work.
            isOriginal: raw.isOriginal === true ? true : (raw.isOriginal === false ? false : null),
            workHint,
            contextEvidence: String(raw.contextEvidence ?? raw.evidence ?? '').trim(),
            researchMode: ['new_entities', 'official_delta'].includes(raw.researchMode)
                ? raw.researchMode : '',
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
        const kind = normalizeEntityKind(raw.kind ?? raw.type, '');
        if (!['character', 'location'].includes(kind)) continue;
        if (candidates.some(item => canonicalEntityKey(item.candidateName) === canonicalEntityKey(candidate.candidateName)
            && item.kind === kind
            && normalizeChangeText(item.workHint) === normalizeChangeText(candidate.workHint))) continue;
        candidates.push({ ...candidate, kind });
    }
    return candidates.slice(0, 40);
}

function cleanCanonSubjectCandidates(values) {
    const candidates = [];
    for (const value of Array.isArray(values) ? values : []) {
        const candidate = cleanEntityCandidates([value])[0];
        if (!candidate) continue;
        if (candidates.some(item => canonicalEntityKey(item.candidateName) === canonicalEntityKey(candidate.candidateName)
            && item.kind === candidate.kind
            && normalizeChangeText(item.workHint) === normalizeChangeText(candidate.workHint))) continue;
        candidates.push(candidate);
    }
    return candidates.slice(0, 80);
}

function canonCandidateIdentityKey(candidate) {
    return `${canonicalEntityKey(candidate?.candidateName)}|${normalizeEntityKind(candidate?.kind, 'unknown')}|${normalizeChangeText(candidate?.workHint || candidate?.work)}`;
}

function planCanonCandidates(plan = {}) {
    const candidates = cleanCanonSubjectCandidates(plan.entityCandidates);
    if (candidates.length) return candidates;
    return cleanDetectedEntities(plan.entities).map(candidateName => ({
        candidateName,
        kind: 'unknown',
        isOriginal: null,
        workHint: String(plan.work || '').trim(),
        contextEvidence: '',
    }));
}

function candidateRecordName(candidate, database = storedCanonEntities(), fallbackWork = '') {
    if (database?.[candidate?.candidateName]
        && canonRecordMatchesIdentity(database[candidate.candidateName], {
            kind: candidate?.kind, work: candidate?.workHint || fallbackWork || '',
        })) return candidate.candidateName;
    return findCanonRecordName(candidate?.candidateName, database, {
        kind: candidate?.kind,
        work: candidate?.workHint || fallbackWork || '',
    });
}

function candidateHasCanonIdentity(candidate, database = storedCanonEntities(), fallbackWork = '') {
    if (candidate?.isOriginal === true) return false;
    if (candidate?.isOriginal === false) return true;
    return Boolean(candidateRecordName(candidate, database, fallbackWork));
}

function researchFieldsForKind(kind) {
    return ({
        character: '正式姓名/译名、身份年龄、外貌身材、发色发型、典型穿着、性格行为逻辑、能力及限制、关键经历、人际关系、知识边界与说话风格',
        location: '正式名称、所属世界与地理位置、外观布局、功能、管理或所属势力、进入条件、原作时间线内状态',
        item: '正式名称、外观、来源、原作持有者与归属变化、功能、使用条件、限制、代价、损毁或存续状态',
        ability: '正式名称、来源、表现形式、作用机制、范围、条件、代价、限制、克制方式、当前时间线是否可用',
        organization: '正式名称、性质、目标、成员与层级、基地、资源能力、立场关系、当前时间线状态',
        event: '正式名称、发生时间地点、参与者、前因后果、结果、已知范围及对当前时间线的影响',
        world_rule: '规则名称、适用范围、机制、条件、例外、限制、代价及与当前时间线相关的原作事实',
    })[normalizeEntityKind(kind, 'unknown')] || '正式名称、实际实体类型与原作中不可违背的核心事实';
}

function canonResearchQuery(candidate, work) {
    const name = normalizeEntityDisplay(candidate?.candidateName ?? candidate?.entity ?? candidate);
    const kind = normalizeEntityKind(candidate?.kind, 'unknown');
    const workHint = String(candidate?.workHint || (shouldAttachWorkTitle(work) ? work : '')).trim();
    return `${name} ${workHint} 核对原作${entityKindLabel(kind)}档案：${researchFieldsForKind(kind)}`.trim();
}

function recordAliases(record, fallbackName = '') {
    return cleanDetectedEntities([
        record?.entity || fallbackName,
        ...(Array.isArray(record?.aliases) ? record.aliases : []),
    ]);
}

function recordWorkAliases(record) {
    return [...new Set([
        String(record?.work || '').trim(),
        ...(Array.isArray(record?.workAliases) ? record.workAliases : []).map(String).map(value => value.trim()),
    ].filter(Boolean))];
}

function canonRecordMatchesIdentity(record, identity = {}) {
    const expectedKind = normalizeEntityKind(identity?.kind, 'unknown');
    const actualKind = normalizeEntityKind(record?.kind, 'unknown');
    if (expectedKind !== 'unknown' && actualKind !== 'unknown' && expectedKind !== actualKind
        && record?.kindVerified === true) return false;
    const expectedWork = String(identity?.workHint || identity?.work || '').trim();
    const actualWorks = recordWorkAliases(record);
    if (expectedWork && (!actualWorks.length
        || !actualWorks.some(actualWork => fandomWorkIdentityMatches(expectedWork, actualWork)))) return false;
    return true;
}

function canonRecordKindCanBeReused(record, expectedKind) {
    const expected = normalizeEntityKind(expectedKind, 'unknown');
    const actual = normalizeEntityKind(record?.kind, 'unknown');
    return expected === 'unknown' || actual === 'unknown' || expected === actual
        || record?.kindVerified !== true;
}

function findCanonRecordNames(candidate, database = storedCanonEntities(), identity = {}) {
    const key = canonicalEntityKey(candidate);
    if (!key) return [];
    const matches = Object.entries(database).filter(([name, record]) =>
        recordAliases(record, name).some(alias => canonicalEntityKey(alias) === key));
    const scoped = matches.filter(([, record]) => canonRecordMatchesIdentity(record, identity));
    const expectedWork = String(identity?.workHint || identity?.work || '').trim();
    // Pre-2.5 rows had no work identity.  When there is exactly one alias match
    // in the whole database, it is safe to adopt that row into the newly known
    // work instead of creating a second world-book entry.  Ambiguous same-name
    // rows remain untouched and require explicit work disambiguation.
    if (!scoped.length && expectedWork && matches.length === 1) {
        const [[name, record]] = matches;
        if (!recordWorkAliases(record).length && canonRecordKindCanBeReused(record, identity?.kind)) {
            return [name];
        }
    }
    if ((identity?.workHint || identity?.work || normalizeEntityKind(identity?.kind, 'unknown') !== 'unknown') && !scoped.length) return [];
    return (scoped.length ? scoped : matches).map(([name]) => name);
}

function findCanonRecordName(candidate, database = storedCanonEntities(), identity = {}) {
    const matches = findCanonRecordNames(candidate, database, identity);
    if (matches.length === 1) return matches[0];
    if (!(identity?.workHint || identity?.work || normalizeEntityKind(identity?.kind, 'unknown') !== 'unknown')) return '';
    const exact = matches.filter(name => canonicalEntityKey(name) === canonicalEntityKey(candidate));
    return exact.length === 1 ? exact[0] : '';
}

function resolveCanonEntityName(candidate, database = storedCanonEntities(), identity = {}) {
    const recordName = findCanonRecordName(candidate, database, identity);
    return database[recordName]?.entity || normalizeEntityDisplay(candidate);
}

function canonRecordIdentityKey(record) {
    return `${canonicalEntityKey(record?.entity)}|${normalizeEntityKind(record?.kind, 'unknown')}|${normalizeChangeText(record?.work)}`;
}

function uniqueCanonStorageKey(entity, work, kind, database, reusableKey = '') {
    const display = normalizeEntityDisplay(entity);
    const identity = { work, kind };
    const reusable = reusableKey && database[reusableKey];
    if (reusable && (canonRecordMatchesIdentity(reusable, identity)
        || (!recordWorkAliases(reusable).length && canonRecordKindCanBeReused(reusable, kind)))) return reusableKey;
    if (!database[display]) return display;
    if (canonRecordMatchesIdentity(database[display], identity)) return display;
    const suffix = normalizeEntityDisplay(work || entityKindLabel(kind) || '不同作品');
    const base = `${display}〔${suffix}〕`;
    let key = base;
    let index = 2;
    while (database[key] && !canonRecordMatchesIdentity(database[key], identity)) key = `${base}#${index++}`;
    return key;
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

function normalizeEntityKind(value, fallback = 'character') {
    const raw = String(value || '').trim().toLowerCase().replaceAll('-', '_');
    const aliases = {
        person: 'character', character: 'character', role: 'character', 人物: 'character', 角色: 'character',
        place: 'location', location: 'location', 地点: 'location', 场所: 'location',
        object: 'item', item: 'item', artifact: 'item', 物品: 'item', 装备: 'item', 道具: 'item',
        power: 'ability', skill: 'ability', ability: 'ability', 能力: 'ability', 技能: 'ability',
        faction: 'organization', organisation: 'organization', organization: 'organization', 组织: 'organization', 势力: 'organization',
        event: 'event', 事件: 'event',
        rule: 'world_rule', worldrule: 'world_rule', world_rule: 'world_rule', 世界规则: 'world_rule', 规则: 'world_rule',
    };
    const normalized = aliases[raw] || raw;
    return CANON_ENTITY_KINDS.has(normalized) ? normalized : fallback;
}

function applyVerifiedEntityKinds(candidates, database = storedCanonEntities()) {
    const updated = [];
    for (const candidate of cleanCanonSubjectCandidates(candidates)) {
        if (candidate.isOriginal) continue;
        const kind = normalizeEntityKind(candidate.kind, 'unknown');
        if (!CANON_ENTITY_KINDS.has(kind)) continue;
        const recordName = candidateRecordName(candidate, database);
        const record = database[recordName];
        if (!record) continue;
        const previousKind = normalizeEntityKind(record.kind, 'unknown');
        // A structured scene/card analysis is allowed to classify legacy rows
        // that had no type. Once classified, ordinary model guesses cannot
        // silently flip a verified entity between character/item/location.
        if (previousKind === kind) continue;
        if (previousKind !== 'unknown' && record.kindVerified === true) continue;
        record.kind = kind;
        // Scene/card analysis is a useful classification hint, but it is not
        // independent identity research.  Leave the row correctable so a
        // later verified search result can fix an item/ability/person mistake.
        record.kindVerified = false;
        record.profileHash = '';
        // Keep the last compact profile active until the re-compression job
        // atomically replaces it; falling back to raw search snippets during
        // migration recreates the old mixed-entity/token-bloat bug.
        if (record.profile) record.profileFormatVersion = CANON_PROFILE_FORMAT_VERSION;
        record.updatedAt = Date.now();
        updated.push(recordName);
    }
    if (updated.length) saveSettingsDebounced();
    return cleanDetectedEntities(updated);
}

function entityKindLabel(kind) {
    return ({
        character: '人物',
        location: '地点',
        item: '物品',
        ability: '能力',
        organization: '组织',
        event: '事件',
        world_rule: '世界规则',
    })[normalizeEntityKind(kind, 'unknown')] || '实体';
}

function normalizeAuSource(value, fallback = 'legacy') {
    const raw = String(value || '').trim().toLowerCase().replaceAll('-', '_');
    const aliases = {
        card: 'card', character_card: 'card', 角色卡: 'card',
        user: 'user', 用户: 'user',
        world_info: 'world_info', worldbook: 'world_info', lorebook: 'world_info', 世界书: 'world_info',
        prior_context: 'prior_context', context: 'prior_context', 此前剧情: 'prior_context',
        assistant_event: 'assistant_event', current_body_event: 'assistant_event', 本轮正文事件: 'assistant_event',
        legacy: 'legacy', manual: 'manual', 手动: 'manual',
    };
    return aliases[raw] || fallback;
}

function changeOwnerFromText(value) {
    const text = String(value || '').trim();
    const match = text.match(/^([^：:\n]{2,80})[：:]\s*(.+)$/s);
    return match ? { owner: normalizeEntityDisplay(match[1]), current: match[2].trim() } : { owner: '', current: text };
}

function inferAuFacet(text) {
    const value = String(text || '');
    if (/姓名|译名|名字|身份|种族|年龄/.test(value)) return 'identity';
    if (/外貌|身材|发色|发型|服装|穿着|身体|受伤|伤势|疤|失明/.test(value)) return 'appearance_state';
    if (/性格|态度|行为逻辑|立场|阵营/.test(value)) return 'personality_alignment';
    if (/关系|恋爱|情侣|夫妻|结婚|分手|亲属|父|母|兄|弟|姐|妹|朋友|敌人/.test(value)) return 'relationship';
    if (/能力|魔法|技能|力量|机制|限制|代价|范围/.test(value)) return 'ability';
    if (/物品|装备|武器|宝石|持有|拥有|失去|归属/.test(value)) return 'item_state';
    if (/经历|记忆|死亡|复活|去向|发生|事件|结局/.test(value)) return 'experience_event';
    if (/地点|位置|布局|势力|组织|基地/.test(value)) return 'location_organization';
    if (/时间|年代|年初|年底|时间线|节点/.test(value)) return 'timeline';
    return 'other';
}

function normalizeAuFacet(value, change = '') {
    const raw = String(value || '').normalize('NFKC').trim().toLowerCase()
        .replace(/[\s：:]+/g, '_').replace(/[^\p{L}\p{N}_·.-]/gu, '').slice(0, 100);
    return raw || inferAuFacet(change);
}

const GENERIC_AU_FACETS = new Set([
    'relationship', 'item_state', 'ability', 'appearance_state', 'identity',
    'identity_status', 'personality_alignment', 'experience_event',
    'location_organization', 'timeline',
]);

function specializeAuFacet(facet, current, participants = []) {
    if (!GENERIC_AU_FACETS.has(facet)) return facet;
    const text = String(current || '');
    const participant = cleanDetectedEntities(participants)[0];
    const property = (() => {
        if (facet === 'relationship') return participant || text.match(/恋爱|婚姻|夫妻|情侣|亲属|朋友|敌对|师徒|上下级/)?.[0];
        if (facet === 'appearance_state') return text.match(/头发|发色|发型|眼睛|瞳色|身高|体型|服装|穿着|伤势|疤痕|失明/)?.[0];
        if (facet === 'identity' || facet === 'identity_status') return text.match(/姓名|译名|年龄|种族|身份|职业|阵营/)?.[0];
        if (facet === 'personality_alignment') return text.match(/性格|态度|行为逻辑|立场|阵营/)?.[0];
        if (facet === 'experience_event') return text.match(/记忆|失忆|死亡|复活|经历|去向|结局|事件/)?.[0];
        if (facet === 'location_organization') return participant || text.match(/位置|地点|所属|势力|组织|基地|控制权/)?.[0];
        if (facet === 'timeline') return 'current_node';
        const namedObject = text.match(/[\p{L}\p{N}·・]{1,24}(?:宝石|武器|装备|物品|魔法|能力|技能|力量)/u)?.[0]
            ?.replace(/^(?:没有|不再|失去|获得|拥有|持有|使用|施展)/, '');
        return participant || namedObject || text.match(/归属|持有|可用性|限制|代价|范围|机制/)?.[0];
    })();
    const key = normalizeChangeText(property || '');
    return key ? `${facet}.${key}` : `${facet}.unspecified`;
}

function auFactText(value) {
    if (typeof value === 'string') return value.trim();
    const owner = normalizeEntityDisplay(value?.owner ?? value?.entity ?? '');
    const current = String(value?.current ?? value?.auValue ?? value?.change ?? '').trim();
    if (!current) return '';
    const canon = String(value?.canon ?? value?.canonValue ?? '').trim();
    const participants = cleanDetectedEntities(value?.participants)
        .filter(name => canonicalEntityKey(name) !== canonicalEntityKey(owner))
        .filter(name => !textContainsEntityAlias(`${canon}\n${current}`, name));
    const work = String(value?.work || '').trim();
    const subject = `${owner || '全局世界规则'}${work ? `〔${work}〕` : ''}${participants.length ? `（关联：${participants.join('、')}）` : ''}`;
    if (canon) return `${subject}：原著为“${canon}”；本卡当前为“${current}”`;
    if (!owner || normalizeChangeText(current).startsWith(normalizeChangeText(owner))) {
        return participants.length ? `${current}（关联：${participants.join('、')}）` : current;
    }
    return `${subject}：${current}`;
}

const AU_SOURCE_PRIORITY = { manual: 6, user: 5, card: 5, world_info: 4, assistant_event: 3, prior_context: 2, legacy: 1 };
const CHAT_DERIVED_AU_SOURCES = new Set(['user', 'assistant_event', 'prior_context']);

function cleanAuProvenance(values, fallback = {}) {
    const rawValues = Array.isArray(values) && values.length ? values : [fallback];
    const origins = [];
    for (const value of rawValues) {
        const source = normalizeAuSource(value?.source, fallback.source || 'unknown');
        const messageIdValue = value?.messageId ?? fallback.messageId;
        const origin = {
            source,
            messageId: Number.isFinite(Number(messageIdValue)) ? Number(messageIdValue) : null,
            messageSignature: String(value?.messageSignature ?? fallback.messageSignature ?? '').trim(),
            evidence: String(value?.evidence ?? fallback.evidence ?? '').trim(),
            worldBook: String(value?.worldBook ?? fallback.worldBook ?? '').trim(),
            worldEntryUid: String(value?.worldEntryUid ?? fallback.worldEntryUid ?? '').trim(),
            worldEntryHash: String(value?.worldEntryHash ?? fallback.worldEntryHash ?? '').trim(),
        };
        const key = `${origin.source}|${origin.messageId ?? ''}|${origin.messageSignature}|${origin.evidence}|${origin.worldBook}|${origin.worldEntryUid}|${origin.worldEntryHash}`;
        if (!origins.some(saved => `${saved.source}|${saved.messageId ?? ''}|${saved.messageSignature}|${saved.evidence}|${saved.worldBook || ''}|${saved.worldEntryUid || ''}|${saved.worldEntryHash || ''}` === key)) {
            origins.push(origin);
        }
    }
    if (origins.length <= 24) return origins;
    const anchored = origins.filter(origin => !CHAT_DERIVED_AU_SOURCES.has(origin.source)).slice(-8);
    const dynamic = origins.filter(origin => CHAT_DERIVED_AU_SOURCES.has(origin.source)).slice(-16);
    return [...anchored, ...dynamic];
}

function normalizeAuFact(value, defaults = {}) {
    if (!value) return null;
    const rawText = typeof value === 'string' ? value : '';
    const parsedText = changeOwnerFromText(rawText);
    let owner = normalizeEntityDisplay(
        typeof value === 'string' ? parsedText.owner : (value.owner ?? value.entity ?? defaults.owner ?? ''),
    );
    const current = String(
        typeof value === 'string' ? parsedText.current : (value.current ?? value.auValue ?? value.change ?? ''),
    ).trim();
    if (!current) return null;
    let kind = normalizeEntityKind(typeof value === 'string' ? defaults.kind : (value.kind ?? value.type), defaults.kind || 'character');
    // Old free-text AU rows sometimes had no `实体：` prefix. They are global
    // setting changes, not anonymous characters; preserving them as a world
    // rule keeps them visible to the generation prompt after migration.
    if (!owner && typeof value === 'string') {
        owner = '全局世界规则';
        kind = 'world_rule';
    }
    let facet = normalizeAuFacet(typeof value === 'string' ? '' : (value.facet ?? value.aspect), current);
    // Legacy free-text facts have no reliable overwrite key. Keep them all
    // active during migration; future structured updates can supersede them
    // explicitly through `replaces`.
    if (typeof value === 'string') facet = `legacy.${facet}.${textHash(rawText).replace(':', '.')}`;
    const source = typeof value === 'string'
        ? 'legacy'
        : normalizeAuSource(value.source, defaults.source || 'unknown');
    const participants = cleanDetectedEntities(typeof value === 'string' ? [] : value.participants);
    if (typeof value !== 'string') facet = specializeAuFacet(facet, current, participants);
    const replaces = (Array.isArray(value?.replaces) ? value.replaces : [])
        .map(auFactText).map(String).map(text => text.trim()).filter(Boolean);
    const evidence = String(typeof value === 'string' ? '' : (value.evidence ?? value.evidenceText ?? '')).trim();
    const messageIdValue = value?.messageId ?? defaults.messageId;
    const messageSignature = String(value?.messageSignature ?? defaults.messageSignature ?? '').trim();
    const fact = {
        id: String(value?.id || ''),
        owner,
        ownerRecordKey: String(value?.ownerRecordKey || defaults.ownerRecordKey || ''),
        work: String(value?.work ?? value?.workTitle ?? defaults.work ?? '').trim(),
        kind,
        facet,
        canon: String(value?.canon ?? value?.canonValue ?? '').trim(),
        current,
        evidence,
        source,
        participants,
        replaces,
        eventChanged: value?.eventChanged === true,
        active: value?.active !== false && value?.status !== 'superseded',
        messageId: Number.isFinite(Number(messageIdValue)) ? Number(messageIdValue) : null,
        messageSignature,
        provenance: cleanAuProvenance(value?.provenance, {
            source,
            messageId: messageIdValue,
            messageSignature,
            evidence,
        }),
        updatedAt: Number(value?.updatedAt) || Number(defaults.updatedAt) || Date.now(),
        supersededAt: Number(value?.supersededAt) || 0,
        supersededBy: String(value?.supersededBy || ''),
    };
    fact.id ||= `${fact.ownerRecordKey || canonicalEntityKey(owner) || 'global'}|${normalizeChangeText(fact.work)}|${kind}|${facet}|${textHash(current)}`;
    return fact;
}

function sameAuOwnerIdentity(left, right) {
    if (left?.ownerRecordKey && right?.ownerRecordKey) return left.ownerRecordKey === right.ownerRecordKey;
    if (canonicalEntityKey(left?.owner) !== canonicalEntityKey(right?.owner)) return false;
    if (normalizeEntityKind(left?.kind, 'unknown') !== normalizeEntityKind(right?.kind, 'unknown')) return false;
    const leftWork = String(left?.work || '').trim();
    const rightWork = String(right?.work || '').trim();
    if (!leftWork && !rightWork) return true;
    return Boolean(leftWork && rightWork && fandomWorkIdentityMatches(leftWork, rightWork));
}

function cleanAuFacts(values, defaults = {}) {
    const facts = [];
    for (const value of Array.isArray(values) ? values : []) {
        const fact = normalizeAuFact(value, defaults);
        if (!fact) continue;
        const duplicate = facts.find(saved => sameAuOwnerIdentity(saved, fact)
            && saved.facet === fact.facet
            && changesAreEquivalent(saved.current, fact.current));
        if (duplicate) {
            duplicate.participants = cleanDetectedEntities([
                ...(duplicate.participants || []), ...(fact.participants || []),
            ]).filter(name => canonicalEntityKey(name) !== canonicalEntityKey(duplicate.owner));
            duplicate.evidence ||= fact.evidence;
            duplicate.canon ||= fact.canon;
            duplicate.provenance = cleanAuProvenance([
                ...(duplicate.provenance || []), ...(fact.provenance || []),
            ], duplicate);
            continue;
        }
        facts.push(fact);
    }
    return facts;
}

function ensureStructuredAuState(cardProfile, database = cardProfile?.canonDatabase || {}) {
    if (!cardProfile) return [];
    const existingStructured = Array.isArray(cardProfile.auFacts) ? cardProfile.auFacts : null;
    const legacyValues = [
        ...(Array.isArray(cardProfile.auChanges) ? cardProfile.auChanges : []),
        ...Object.values(database || {}).flatMap(record => Array.isArray(record?.canonChanges) ? record.canonChanges : []),
    ];
    const facts = cleanAuFacts(existingStructured ?? legacyValues);
    const historyFacts = cleanAuFacts(cardProfile.auHistory).map(fact => ({ ...fact, active: false }));
    for (const fact of [...facts, ...historyFacts]) {
        if (!fact.owner) continue;
        const recordName = findCanonRecordName(fact.owner, database, {
            kind: fact.kind,
            work: fact.work || cardProfile.workTitle || '',
        });
        if (!recordName) continue;
        fact.owner = database[recordName]?.entity || recordName;
        fact.ownerRecordKey = recordName;
        fact.kind = normalizeEntityKind(database[recordName]?.kind, fact.kind);
        // Once an owner is bound to a concrete record, persist that record's
        // stable primary work title.  A legacy translated work alias must not
        // make this fact disappear from a later Chinese-work projection.
        fact.work = database[recordName]?.work || fact.work || '';
        fact.participants = cleanDetectedEntities(fact.participants).map(name => {
            const participantRecord = findCanonRecordName(name, database, { work: fact.work });
            return participantRecord ? (database[participantRecord]?.entity || participantRecord) : name;
        }).filter(name => canonicalEntityKey(name) !== canonicalEntityKey(fact.owner));
        if (!fact.participants.length) {
            fact.participants = cleanDetectedEntities(Object.entries(database)
                .filter(([name, record]) => canonicalEntityKey(record?.entity || name) !== canonicalEntityKey(fact.owner))
                .filter(([, record]) => {
                    const works = recordWorkAliases(record);
                    return !fact.work || !works.length
                        || works.some(work => fandomWorkIdentityMatches(fact.work, work));
                })
                .filter(([name, record]) => recordAliases(record, name)
                    .some(alias => textContainsEntityAlias(fact.current, alias)))
                .map(([name, record]) => record?.entity || name));
        }
    }
    const canonicalFacts = cleanAuFacts(facts);
    cardProfile.auFacts = canonicalFacts;
    cardProfile.auHistory = cleanAuFacts(historyFacts).map(fact => ({ ...fact, active: false }));
    cardProfile.auChanges = canonicalFacts.filter(fact => fact.active !== false).map(auFactText);
    for (const [recordName, record] of Object.entries(database || {})) {
        const ownIdentity = {
            owner: record?.entity || recordName,
            ownerRecordKey: recordName,
            kind: normalizeEntityKind(record?.kind, 'unknown'),
            work: record?.work || '',
        };
        record.canonChanges = canonicalFacts
            .filter(fact => fact.active !== false && sameAuOwnerIdentity(fact, ownIdentity))
            .map(auFactText);
    }
    return canonicalFacts;
}

function activeAuFacts(cardProfile = profile()) {
    return ensureStructuredAuState(cardProfile, cardProfile.canonDatabase || {})
        .filter(fact => fact.active !== false);
}

function cleanCanonChanges(values) {
    return (Array.isArray(values) ? values : [])
        .map(auFactText)
        .map(value => String(value ?? '').trim())
        .filter(Boolean);
}

function cleanPlannedQueries(values, work = '') {
    return [...new Set((Array.isArray(values) ? values : [])
        .filter(value => value !== null && value !== undefined)
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

async function planQueries(chat, freshnessGuard = null) {
    const config = settings();
    const cardProfile = profile();
    const work = cardProfile.workTitle.trim();
    const database = storedCanonEntities();
    const latestUserText = String([...((Array.isArray(chat) ? chat : []))]
        .reverse().find(message => message?.is_user && message?.mes)?.mes ?? '');
    const explicitlyStoredRecords = relevantCanonRecords(latestUserText, database);
    const explicitlyStoredEntities = explicitlyStoredRecords.map(record => record.entity);

    if (!config.autoPlanner) {
        return {
            work,
            timeline: cardProfile.timeline.trim(),
            entities: cleanDetectedEntities(explicitlyStoredEntities),
            entityCandidates: explicitlyStoredRecords.map(record => ({
                candidateName: record.entity, kind: record.kind, workHint: record.work || work, isOriginal: false,
            })),
            timelineChanged: false,
            queries: [],
        };
    }

    const source = await researchContext(chat);
    const existingChanges = [
        ...cleanCanonChanges(cardProfile.auChanges),
        ...Object.values(database).flatMap(record => cleanCanonChanges(record?.canonChanges)),
    ].filter((change, index, array) => !array.slice(0, index).some(saved => changesAreEquivalent(change, saved)));
    const plannerPrompt = `你是同人正文的原作事实核验器，不是编剧、导演或剧情规划器。你只能识别用户最新输入中已经逐字点名的原作人物、地点、组织或物品，以便核对这些对象的姓名与设定。严禁预测、建议或选择下一位登场角色，严禁把角色卡、世界书、历史剧情或资料库里出现但用户最新输入没有点名的对象放入 entities。角色卡和世界书仅用于判断作品归属与用户明确 AU，不是候选人物清单。\n\n作品（当前表值）：${work || '未填写，请从背景判断'}\n当前时间线/AU节点（上轮表值）：${cardProfile.timeline || '未填写'}\n已经保存的 AU 差异（不得重复返回或改写复述）：\n${existingChanges.length ? existingChanges.join('\n') : '无'}\n\n用户最新输入（entities 中的 candidateName 必须是这里逐字出现的连续文本）：\n${latestUserText || '无'}\n\n角色卡背景（只能用于作品和 AU 判断）：\n${source.card || '未读取到'}\n\n本轮实际激活世界书（只能用于作品和 AU 判断）：\n${source.worldInfo || '无'}\n\n只输出 JSON，不写解释：{"work":"有明确证据的原作名，否则沿用当前作品","storyType":"canon_timeline|au_timeline|original_world_with_fandom_characters|original_only|unknown","timeline":"仅在用户最新输入明确改变时填写当前剧情线","timelineChanged":false,"entities":[{"candidateName":"必须逐字摘自用户最新输入","isOriginal":false,"workHint":"该对象实际所属作品；不确定留空","contextEvidence":"逐字摘录用户点名该对象的短语"}],"canonChanges":["仅写用户最新输入首次明确声明、且会影响后续写作的原著差异；格式为具体实体：变化。范围包括但不限于身份、阵营、能力、装备、关键物品、外貌状态、经历、生死、关系、地点势力、事件结果、人物认知、世界规则和时间线"],"queries":["仅用于用户明确点名的新对象，或用户明确改变时间线后需要补查的官方设定"]}\n规则：没有逐字点名的对象必须省略，代词、暗示、可能登场、即将发生、角色卡预设对象、世界书候选对象和历史中曾出现的对象都不得返回。逐个判断对象是否为用户原创；原创对象 isOriginal=true，不外搜。queries 最多 ${config.maxQueries} 条；不得使用“兄妹”“冒险”“OC”等泛称或角色卡标题。只有用户最新输入明确宣布篇章、原作事件阶段或 AU 关键状态跨越到不同节点时，timelineChanged 才能为 true；普通对话、日常推进、换地点、时间流逝和模型自行推断都必须为 false。你的输出只用于事实核验，绝不能参与剧情走向。`;

    const plannerPromptV2 = `你是同人正文的原作事实核验器，不是编剧。只识别用户最新输入中逐字点名的人物、地点、物品、能力、组织、事件或世界规则；不得预测登场对象，也不得把角色卡、世界书或历史中仅被提到的对象当成用户本轮点名。\n\n当前作品：${work || '未填写'}\n当前时间线：${cardProfile.timeline || '未填写'}\n已保存AU（不得重复）：${existingChanges.join('；') || '无'}\n\n用户最新输入：\n${latestUserText || '无'}\n\n角色卡与当前启用世界书只用于判断作品、原创身份和用户明确设定：\n${source.card || '无'}\n${source.worldInfo || '无'}\n\n只输出完整 JSON：{"work":"明确作品名","storyType":"canon_timeline|au_timeline|original_world_with_fandom_characters|original_only|unknown","timeline":"只在用户明确改变节点时更新","timelineChanged":false,"entities":[{"candidateName":"用户原文中的连续专名","kind":"character|location|item|ability|organization|event|world_rule","isOriginal":false,"workHint":"实际所属作品","contextEvidence":"用户原文短句"}],"canonChanges":[{"entity":"差异的唯一归属对象","work":"owner实际所属作品","kind":"实体类型","facet":"稳定且具体的属性键，如 relationship.幻视、item.时间宝石、appearance.伤势","canon":"原著状态；不确定留空","current":"本卡当前状态","source":"user","evidence":"逐字摘录用户原文","participants":["除owner外的关联对象"],"eventChanged":false,"replaces":["被此状态取代的旧差异原文"]}],"queries":["只查用户点名的新对象或明确变化后的官方节点"]}。\n没有逐字点名的对象必须省略；原创对象 isOriginal=true 且不外搜。canonChanges 此处只能来自 user，evidence 必须能在用户原文中逐字找到；同一对象同一属性的新状态必须沿用 facet，并通过 replaces 替换旧状态。queries 最多 ${config.maxQueries} 条，禁止使用兄妹、家人、冒险、OC、角色卡标题等泛词。普通对话、换地点和自然时间流逝不得把 timelineChanged 设为 true。`;

    try {
        const parsed = await runJsonAnalysisPrompt(`${plannerPromptV2}\n\n跨作品或同名对象规则：canonChanges 每项必须额外输出 work（该 owner 实际所属作品）；同名对象无法确认所属作品时省略该差异，绝不能随便归给第一个候选。`, 1800, freshnessGuard);
        const manualWork = work && work !== cardProfile.lastAutoWorkTitle ? work : '';
        const plannedWork = manualWork || String(parsed.work ?? '').trim() || work;
        const detectedCandidates = cleanEntityCandidates(parsed.entities)
            .filter(item => latestUserText.toLowerCase().includes(item.candidateName.toLowerCase()));
        const detectedCanonCandidates = detectedCandidates.filter(item =>
            candidateHasCanonIdentity(item, database, plannedWork));
        const detectedEntities = cleanDetectedEntities(detectedCanonCandidates.map(item => item.candidateName));
        const entities = [...new Set([...explicitlyStoredEntities, ...detectedEntities])].slice(0, 8);
        let deltaQueries = Array.isArray(parsed.queries)
            ? parsed.queries.filter(value => value !== null && value !== undefined).map(String) : [];
        deltaQueries = deltaQueries.map(x => x.trim()).filter(Boolean).map(x => {
            if (!shouldAttachWorkTitle(plannedWork) || x.includes(plannedWork)) return x;
            return `${x} ${plannedWork}`;
        });
        deltaQueries = cleanPlannedQueries(deltaQueries, plannedWork);
        const newCandidates = detectedCanonCandidates.filter(candidate =>
            !candidateRecordName(candidate, database, plannedWork));
        const baselineQueries = newCandidates.map(candidate => canonResearchQuery(candidate, plannedWork));
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
            entities: cleanDetectedEntities(detectedCanonCandidates.map(candidate =>
                resolveCanonEntityName(candidate.candidateName, database, {
                    kind: candidate.kind, work: candidate.workHint || plannedWork,
                }))),
            entityCandidates: detectedCanonCandidates,
            autoEntities: cleanDetectedEntities(detectedCanonCandidates.map(candidate =>
                resolveCanonEntityName(candidate.candidateName, database, {
                    kind: candidate.kind, work: candidate.workHint || plannedWork,
                }))),
            canonChanges: cleanAuFacts(parsed.canonChanges, { source: 'user', work: plannedWork }),
            auEvidenceSources: { user: latestUserText },
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

function captureTrackedProfileState(cardProfile = profile()) {
    return {
        workTitle: String(cardProfile.workTitle || ''),
        timeline: String(cardProfile.timeline || ''),
        entities: String(cardProfile.entities || ''),
        lastAutoWorkTitle: String(cardProfile.lastAutoWorkTitle || ''),
        lastAutoTimeline: String(cardProfile.lastAutoTimeline || ''),
        lastAutoEntities: cleanDetectedEntities(cardProfile.lastAutoEntities),
    };
}

function restoreTrackedProfileState(cardProfile, state) {
    if (!cardProfile || !state) return false;
    const before = JSON.stringify(captureTrackedProfileState(cardProfile));
    cardProfile.workTitle = String(state.workTitle || '');
    cardProfile.timeline = String(state.timeline || '');
    cardProfile.entities = String(state.entities || '');
    cardProfile.lastAutoWorkTitle = String(state.lastAutoWorkTitle || '');
    cardProfile.lastAutoTimeline = String(state.lastAutoTimeline || '');
    cardProfile.lastAutoEntities = cleanDetectedEntities(state.lastAutoEntities);
    return JSON.stringify(captureTrackedProfileState(cardProfile)) !== before;
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

async function fetchJson(url, timeoutMs = 10000, externalSignal = null) {
    const signal = requestTimeoutSignal(timeoutMs, externalSignal);
    const response = await fetch(url, { signal, credentials: 'omit' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
}

async function fetchWikiFallback(apiUrl, page, sourceName, query, signal = null) {
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
    const json = await fetchJson(url, 10000, signal);
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
        .replace(/\s+(?:核对正式姓名(?:及原作)?(?:完整角色档案)?|核对原作(?:人物|地点|物品|能力|组织|事件|世界规则|实体)档案|原作完整角色档案|完整角色档案|角色档案)\s*[：:]?[\s\S]*$/i, '')
        .replace(/[；;]\s*只核实截至[\s\S]*$/i, '')
        .trim();
    return [...new Set([compact, raw].filter(Boolean))];
}

async function searchWikiOnce(apiUrl, searchQuery, resultQuery, sourceName, signal = null) {
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

    const json = await fetchJson(url, 10000, signal);
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
            .map(page => fetchWikiFallback(apiUrl, page, sourceName, resultQuery, signal)));
        pages.push(...fallback.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []));
    }
    return pages;
}

async function searchWiki(apiUrl, query, sourceName, signal = null) {
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
            const pages = await searchWikiOnce(apiUrl, searchQuery, query, sourceName, signal);
            if (!pages.length) continue;
            throwIfAborted(signal);
            // Empty results can be temporary, so only successful lookups are cached.
            config.cache[key] = { at: Date.now(), pages };
            pruneCache();
            saveSettingsDebounced();
            return pages;
        } catch (error) {
            if (signal?.aborted || error?.fcrCancelled || error?.name === 'AbortError') throw error;
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
    const trustedSources = new Map();
    const addTrustedSource = (url, title = url) => {
        const valid = validHttpCitationUrls([url])[0];
        if (!valid) return;
        const source = { title: title || valid, url: valid };
        trustedSources.set(valid, source);
        sources.set(valid, source);
    };
    if (typeof data?.output_text === 'string') texts.push(data.output_text);
    for (const output of Array.isArray(data?.output) ? data.output : []) {
        for (const content of Array.isArray(output?.content) ? output.content : []) {
            if (typeof content?.text === 'string') texts.push(content.text);
            for (const annotation of Array.isArray(content?.annotations) ? content.annotations : []) {
                const url = annotation?.url || annotation?.url_citation?.url;
                const title = annotation?.title || annotation?.url_citation?.title || url;
                if (url) addTrustedSource(url, title);
            }
        }
    }
    for (const citation of Array.isArray(data?.citations) ? data.citations : []) {
        const url = typeof citation === 'string' ? citation : citation?.url;
        if (url) addTrustedSource(url, citation?.title || url);
    }
    for (const source of Array.isArray(data?.sources) ? data.sources : []) {
        const url = typeof source === 'string' ? source : source?.url;
        if (url) addTrustedSource(url, source?.title || url);
    }
    for (const citation of Array.isArray(data?.choices?.[0]?.message?.citations)
        ? data.choices[0].message.citations : []) {
        const url = typeof citation === 'string' ? citation : citation?.url;
        if (url) addTrustedSource(url, citation?.title || url);
    }
    const chatContent = extractAssistantContent(data);
    if (typeof chatContent === 'string') texts.push(chatContent);
    const answer = texts.filter(Boolean).join('\n\n').trim();
    if (!answer) throw new Error('搜索 AI 返回了空内容');
    for (const match of answer.matchAll(/https?:\/\/[^\s\]})>"']+/g)) {
        const url = match[0].replace(/[.,;:，。；：]+$/, '');
        if (url) sources.set(url, { title: url, url });
    }
    return {
        answer,
        sources: [...sources.values()],
        trustedSources: [...trustedSources.values()],
        rawModel: data?.model || model,
    };
}

async function callCustomSearchAi(query, externalSignal = null) {
    const config = settings();
    const isResponses = config.searchAiProtocol === 'responses';
    const path = isResponses ? 'responses' : 'chat/completions';
    const outputBudget = Math.min(16000, 2400 + clampInt(config.maxQueries, 1, 10, 3) * 1600);
    const researchInstruction = 'Search the live web for the following fandom canon question. Independently choose the most accurate and authoritative sources for this specific question. Sources may include official publishers or studios, creator interviews, official guides, reputable databases, encyclopedias, and high-quality specialist wikis; do not restrict the search to wikis. Cross-check conflicting claims, clearly distinguish canon facts from speculation, and include source links.';
    const body = isResponses ? {
        model: config.searchAiModel,
        input: [{ role: 'user', content: `${researchInstruction}\n\n${query}` }],
        tools: [{ type: 'web_search' }],
        max_output_tokens: outputBudget,
    } : {
        model: config.searchAiModel,
        messages: [
            { role: 'system', content: researchInstruction },
            { role: 'user', content: query },
        ],
        temperature: 0.1,
        max_tokens: outputBudget,
        stream: false,
    };
    if (!isResponses) {
        const data = await chatCompletionWithFallback(config.searchAiBaseUrl, 'search-ai', body, '搜索 AI 请求', externalSignal);
        return unpackSearchAiResponse(data, config.searchAiModel);
    }
    const response = await directApiFetch(apiEndpoint(config.searchAiBaseUrl, path), {
        method: 'POST',
        headers: directApiHeaders('search-ai'),
        body: JSON.stringify(body),
            signal: requestTimeoutSignal(180000, externalSignal),
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
        const isBatchProfileRequest = /研究对象[：:]|"records"|完整角色档案/.test(query);
        if (isBatchProfileRequest && !structured) {
            throw new Error('搜索 AI 未返回完整可读取的 JSON');
        }
        if (isBatchProfileRequest && !Array.isArray(structured?.records)) {
            throw new Error('搜索 AI JSON 缺少 records 数组');
        }
        const records = Array.isArray(structured?.records) ? structured.records : [];
        if (isBatchProfileRequest && !records.length) return [];
        items = records.length ? records.map(record => {
            const serverCitationSet = new Set(validHttpCitationUrls(
                (Array.isArray(data?.trustedSources) ? data.trustedSources : []).map(source => source?.url),
            ));
            const recordCitations = validHttpCitationUrls([
                ...(Array.isArray(record?.sourceUrls) ? record.sourceUrls : []),
                ...(Array.isArray(record?.citations) ? record.citations : []),
                // Batch-level citations cannot prove which returned object they
                // support.  Only reuse them when the response has one record;
                // multi-object research must attach sources per record.
                ...(records.length === 1 && Array.isArray(data?.sources)
                    ? data.sources.map(source => source?.url) : []),
            ]);
            const trustedCitations = recordCitations.filter(url => serverCitationSet.has(url));
            return {
            title: String(record?.canonicalName || record?.entity || '').trim(),
            url: recordCitations[0] || '',
            extract: String(record?.summary || '').trim(),
            candidateId: String(record?.candidateId || '').trim(),
            candidateName: String(record?.candidateName || record?.candidate || '').trim(),
            inputWorkHint: String(record?.inputWorkHint || '').trim(),
            canonicalName: String(record?.canonicalName || record?.entity || '').trim(),
            originalName: String(record?.originalName || '').trim(),
            workTitle: String(record?.workTitle || '').trim(),
            kind: normalizeEntityKind(record?.kind, 'unknown'),
            aliases: Array.isArray(record?.aliases) ? record.aliases.filter(value => value != null).map(String) : [],
            identityEvidence: String(record?.identityEvidence || '').trim(),
            verified: record?.verified === true,
            citations: recordCitations,
            trustedCitations,
        }}) : [{
            title: `搜索 AI 综合结果（${data?.rawModel || settings().searchAiModel}）`,
            url: data?.sources?.[0]?.url || '',
            extract: String(data?.answer || '').trim(),
        }];
    }
    const resultLimit = provider === 'custom_ai'
        ? clampInt(settings().maxQueries, 1, 10, 3)
        : 6;
    return items.filter(item => item.title && item.extract).slice(0, resultLimit).map(item => ({
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

async function searchWeb(query, signal = null) {
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
        const pages = parseWebResults(provider, await callCustomSearchAi(query, signal), query);
        throwIfAborted(signal);
        if (pages.length) {
            config.cache[key] = { at: Date.now(), pages };
            pruneCache();
            saveSettingsDebounced();
        }
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
        signal: requestTimeoutSignal(60000, signal),
    });
    if (!response.ok) {
        const message = (await response.text()).slice(0, 300);
        throw new Error(`${provider} 搜索失败（HTTP ${response.status}）${message ? `：${message}` : ''}`);
    }
    const pages = provider === 'searxng'
        ? parseSearxngResults(await response.text(), query)
        : parseWebResults(provider, await response.json(), query);
    throwIfAborted(signal);
    if (pages.length) {
        config.cache[key] = { at: Date.now(), pages };
        pruneCache();
        saveSettingsDebounced();
    }
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
    const worldFor = character => {
        const data = character?.data ?? character;
        return String(data?.extensions?.world || data?.character_book?.name || '').trim();
    };
    if (currentGroup()) {
        const worlds = [...new Set(currentGroupCharacters().map(worldFor).filter(Boolean))].sort();
        const saved = String(settings().profiles?.[profileKey()]?.canonWorldBook || '').trim();
        return worlds.includes(saved) ? saved : (worlds[0] || saved);
    }
    return worldFor(currentCharacter());
}

function knownWorldBookExists(worldName) {
    if (typeof world_names === 'undefined' || !Array.isArray(world_names)) return null;
    return world_names.includes(String(worldName || '').trim());
}

function currentCharacterFilterNames() {
    const characters = currentGroup() ? currentGroupCharacters() : [currentCharacter()].filter(Boolean);
    return [...new Set(characters.map(character =>
        String(character?.avatar || character?.name || '').replace(/\.[^.]+$/, '')).filter(Boolean))];
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

function extractEntitySpecificText(value, entity, candidateEntities = [], ownAliases = []) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const selfNames = cleanDetectedEntities([entity, ...ownAliases]);
    const selfKeys = new Set(selfNames.map(canonicalEntityKey));
    const foreignEntities = cleanDetectedEntities(candidateEntities)
        .filter(name => !selfKeys.has(canonicalEntityKey(name)));
    // A single-object dossier commonly uses the name only in its heading and
    // then puts 外貌/性格/经历 in separate paragraphs.  Keep the whole dossier
    // when there is no second object's dossier to isolate.
    if (!containsForeignEntityDossier(raw, entity, foreignEntities)) return raw;
    const chunks = raw
        .split(/(?=\*\*\s*\d+[.、．])|\n{2,}/)
        .map(chunk => chunk.trim())
        .filter(Boolean);
    const selected = [];
    let collecting = false;
    for (const chunk of chunks) {
        const selfHeading = selfNames.some(name => textContainsEntityAlias(chunk, name));
        const foreignHeading = foreignEntities.some(name => {
            if (!textContainsEntityAlias(chunk, name)) return false;
            const opening = chunk.slice(0, 100);
            return /档案|资料|设定|profile|dossier|^[^\n]{0,45}[：:]|^【/i.test(opening);
        });
        if (selfHeading) collecting = true;
        else if (foreignHeading) collecting = false;
        if (collecting) selected.push(chunk);
    }
    return selected.join('\n\n');
}

function containsForeignEntityDossier(value, entity, candidateEntities = []) {
    const selfKey = canonicalEntityKey(entity);
    const others = cleanDetectedEntities(candidateEntities)
        .filter(name => canonicalEntityKey(name) !== selfKey);
    if (!others.length) return false;
    const text = String(value || '');
    const lower = text.toLocaleLowerCase();
    const dossierFields = /身份|年龄|外貌|身材|发色|发型|穿着|性格|经历|能力|限制|关系|说话风格|appearance|personality|history|ability|relationship/gi;
    return others.some(other => {
        const needle = String(other || '').toLocaleLowerCase();
        let position = lower.indexOf(needle);
        while (position >= 0) {
            const window = text.slice(position, position + 700);
            const opening = window.slice(0, Math.min(80, window.length));
            const header = /档案|资料|人物设定|角色设定|profile|dossier|^[^\n]{0,35}[：:]|^【/i.test(opening);
            const fields = new Set((window.match(dossierFields) || []).map(value => value.toLocaleLowerCase()));
            if ((header && fields.size >= 1) || fields.size >= 3) return true;
            position = lower.indexOf(needle, position + Math.max(1, needle.length));
        }
        return false;
    });
}

function profileExplicitlyRejectsEntity(value, entity) {
    const opening = String(value || '').trim().slice(0, 420);
    if (!opening) return false;
    const namesEntity = textContainsEntityAlias(opening, entity);
    const explicitNoMatch = /无原作对应|原作中(?:并)?无此(?:人物|角色|实体|对象)|未(?:找到|查到|检索到|确认)(?:任何)?(?:与之|和它|和其)?(?:对应|匹配)?的?(?:原作)?(?:人物|角色|实体|对象)|并非(?:原作|官方)(?:人物|角色|实体|设定)|误写(?:成|为)?另一(?:人物|角色|实体)|記録対象外/i.test(opening);
    const japaneseNoMatch = /原作.*(?:登場しない|存在しない)|公式.*(?:記述|確認).*(?:ない|ず)/i.test(opening);
    return (namesEntity && explicitNoMatch) || japaneseNoMatch;
}

function consolidateCanonAliases(database, cardProfile) {
    const names = Object.keys(database);
    const parents = new Map(names.map(name => [name, name]));
    const find = name => {
        let root = name;
        while (parents.get(root) !== root) root = parents.get(root);
        while (parents.get(name) !== name) {
            const next = parents.get(name);
            parents.set(name, root);
            name = next;
        }
        return root;
    };
    const union = (left, right) => {
        const a = find(left);
        const b = find(right);
        if (a !== b) parents.set(b, a);
    };
    const aliasKeys = name => new Set(recordAliases(database[name], name)
        .map(canonicalEntityKey).filter(key => key.length >= 2));
    for (let left = 0; left < names.length; left++) {
        for (let right = left + 1; right < names.length; right++) {
            const a = database[names[left]];
            const b = database[names[right]];
            const aKind = normalizeEntityKind(a?.kind, 'unknown');
            const bKind = normalizeEntityKind(b?.kind, 'unknown');
            if (aKind !== 'unknown' && bKind !== 'unknown' && aKind !== bKind) continue;
            const aWorks = recordWorkAliases(a);
            const bWorks = recordWorkAliases(b);
            if (Boolean(aWorks.length) !== Boolean(bWorks.length)) continue;
            if (aWorks.length && !aWorks.some(aWork => bWorks.some(bWork =>
                fandomWorkIdentityMatches(aWork, bWork)))) continue;
            const aKeys = aliasKeys(names[left]);
            const bKeys = aliasKeys(names[right]);
            const aPrimary = canonicalEntityKey(a?.entity || names[left]);
            const bPrimary = canonicalEntityKey(b?.entity || names[right]);
            // A shared mantle/title (Flash, Robin, Green Lantern, etc.) is not
            // proof that two people are the same entity.  Merge only when each
            // row explicitly names the other's canonical identity (or both
            // canonical names normalize identically).
            const reciprocalCanonicalIdentity = aPrimary && bPrimary
                && aKeys.has(bPrimary) && bKeys.has(aPrimary);
            if (reciprocalCanonicalIdentity) union(names[left], names[right]);
        }
    }
    const groups = new Map();
    for (const name of names) {
        const root = find(name);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(name);
    }

    let changed = false;
    const replacements = new Map();
    for (const names of groups.values()) {
        const records = names.map(name => database[name]).filter(Boolean);
        const displayNames = records.map((record, index) => normalizeEntityDisplay(record?.entity || names[index]));
        let preferredName = displayNames[0];
        if (names.length === 1 && database[names[0]]?.entity === preferredName) continue;
        const quality = record => (record?.sources || []).reduce((total, source) => total + String(source?.extract || '').length, 0);
        const trustedRecords = records.filter(record => record?.sourceTrust === 'verified');
        const sourceRecords = trustedRecords.length ? trustedRecords : records;
        const preferredRecord = sourceRecords.find(record => String(record?.entity || '') === preferredName)
            || [...sourceRecords].sort((a, b) => quality(b) - quality(a))[0]
            || {};
        preferredName = normalizeEntityDisplay(preferredRecord.entity || preferredName);
        const preferredStorageName = names.find(name => database[name] === preferredRecord) || names[0];
        const profileRecord = [preferredRecord, ...sourceRecords]
            .filter(record => String(record?.profile || '').trim())
            .sort((a, b) => String(b.profile || '').length - String(a.profile || '').length)[0] || {};
        const sourceMap = new Map();
        // Once one member of an alias group is verified, never let a longer
        // provisional record donate its sources/profile and inherit the other
        // member's trust.  Alias names may merge; evidence trust may not.
        for (const record of sourceRecords) {
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
            kind: normalizeEntityKind(preferredRecord.kind, records.find(record => record?.kind)?.kind || 'unknown'),
            kindVerified: records.some(record => record?.kindVerified === true),
            aliases: cleanDetectedEntities(records.flatMap(record => recordAliases(record))),
            work: preferredRecord.work || sourceRecords.find(record => record?.work)?.work || '',
            workAliases: [...new Set(records.flatMap(record => recordWorkAliases(record)))]
                .filter(value => !fandomWorkIdentityMatches(
                    value, preferredRecord.work || sourceRecords.find(record => record?.work)?.work || '',
                )),
            timeline: preferredRecord.timeline || sourceRecords.find(record => record?.timeline)?.timeline || '',
            profile: profileRecord.profile || '',
            profileHash: '',
            profileFormatVersion: Number(profileRecord.profileFormatVersion) || 0,
            profileAttemptHash: '',
            profileAttemptedAt: 0,
            baselineStatus: sourceMap.size ? 'stale' : (profileRecord.baselineStatus || 'pending'),
            sourceTrust: trustedRecords.length ? 'verified' : 'provisional',
            worldSyncedAt: Math.max(0, ...records.map(record => Number(record?.worldSyncedAt) || 0)),
            updatedAt: Math.max(0, ...records.map(record => Number(record?.updatedAt) || 0)),
            canonChanges: [...new Set(records.flatMap(record => Array.isArray(record?.canonChanges) ? record.canonChanges : []).map(String).filter(Boolean))],
            sources: [...sourceMap.values()],
        };
        for (const name of names) {
            replacements.set(name, preferredName);
            for (const alias of recordAliases(database[name])) replacements.set(alias, preferredName);
            if (name !== preferredStorageName) delete database[name];
        }
        database[preferredStorageName] = merged;
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
    const displayEntities = cleanDetectedEntities(entities.map(name => database[name]?.entity || name));
    let changed = false;
    const removedEntities = new Set();
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
                if (profileExplicitlyRejectsEntity(text, record.entity || entity)) return false;
                return true;
            })
            .map(source => ({
                ...source,
                extract: extractEntitySpecificText(
                    source.extract, record.entity || entity, displayEntities,
                    recordAliases(record, entity),
                ),
            }))
            .filter(source => source.extract)
            .filter((source, index, array) => array.findIndex(other =>
                `${other.title}|${other.url}|${other.extract}` === `${source.title}|${source.url}|${source.extract}`) === index);
        if (sources.length !== (record.sources || []).length
            || sources.some((source, index) => source.extract !== record.sources?.[index]?.extract)) changed = true;
        record.sources = sources;
        record.workAliases = [...new Set((Array.isArray(record.workAliases) ? record.workAliases : [])
            .map(String).map(value => value.trim()).filter(Boolean))];
        record.kind = normalizeEntityKind(record.kind, 'unknown');
        record.kindVerified = record.kindVerified === true && CANON_ENTITY_KINDS.has(record.kind);
        record.sourceTrust ||= 'provisional';
        const hasUsefulLocalState = Boolean(String(record.profile || '').trim())
            || cleanCanonChanges(record.canonChanges).length > 0
            || activeAuFacts(cardProfile).some(fact => canonicalEntityKey(fact.owner) === canonicalEntityKey(record.entity || entity));
        if (!sources.length && !hasUsefulLocalState) {
            delete database[entity];
            removedEntities.add(entity);
            changed = true;
        } else if (!sources.length) {
            record.baselineStatus = 'pending';
        }
    }
    changed = consolidateCanonAliases(database, cardProfile) || changed;
    const preferredEntities = manualEntities(cardProfile.entities);
    const normalizeFamily = value => String(value || '').replaceAll('結', '结').slice(0, 2);
    for (const entity of Object.keys(database)) {
        const displayName = database[entity]?.entity || entity;
        if (preferredEntities.includes(displayName)) continue;
        const summary = (database[entity]?.sources || []).map(source => source.extract).join('\n');
        const looksLikeRejectedAlias = profileExplicitlyRejectsEntity(summary, displayName);
        const preferredSameFamily = preferredEntities.some(preferred =>
            normalizeFamily(preferred) && normalizeFamily(preferred) === normalizeFamily(displayName));
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
        let pendingRevision = databaseChanged ? markWorldSyncPending(cardProfile) : null;
        let worldBooksCompleted = true;
        const worldNames = [...new Set([
            String(cardProfile.canonWorldBook || '').trim(),
            ...(Array.isArray(cardProfile.writtenWorldBooks) ? cardProfile.writtenWorldBooks : []),
        ].map(String).map(value => value.trim()).filter(Boolean))];
        for (const worldName of worldNames) {
            try {
                const result = await enqueueWorldBookWrite(worldName, async () => {
                const data = await loadWorldInfo(worldName);
                if (!data?.entries) return null;
                let worldChanged = false;
                for (const [uid, entry] of Object.entries(data.entries)) {
                    const entity = parseWorldEntryComment(entry?.comment, savedProfileKey);
                    const isScene = isSceneEntryComment(entry?.comment, savedProfileKey);
                    if (!entity && !isScene) continue;
                    const record = entity ? cardProfile.canonDatabase[entity] : null;
                    if (entity && (!record || (!record.sources?.length && !record.profile
                        && !cleanCanonChanges(record.canonChanges).length))) {
                        delete data.entries[uid];
                        worldChanged = true;
                        continue;
                    }
                    if (isScene && !cardProfile.currentScene) {
                        delete data.entries[uid];
                        worldChanged = true;
                        continue;
                    }
                    const desiredContent = entity
                        ? formatCanonWorldEntry(record)
                        : formatCurrentSceneWorldEntry(cardProfile.currentScene);
                    // The world book is the durable, user-visible database.  The
                    // interceptor injects only the currently relevant subset, so
                    // these entries must stay disabled to avoid duplicate tokens
                    // and group/solo cross-scope activation by characterFilter.
                    if (entry.content !== desiredContent || entry.disable !== true) {
                        entry.content = desiredContent;
                        entry.disable = true;
                        worldChanged = true;
                    }
                }
                if (worldChanged) {
                    await saveWorldInfoChecked(worldName, data, savedProfileKey);
                    reloadEditor(worldName, false);
                }
                return worldChanged;
                });
                if (result === null) worldBooksCompleted = false;
            } catch (error) {
                worldBooksCompleted = false;
                console.warn(`[Fandom Canon] Startup world-book cleanup failed for ${worldName}.`, error);
            }
        }
        if (!worldBooksCompleted && pendingRevision === null) {
            pendingRevision = markWorldSyncPending(cardProfile);
        }
        if (cardProfile.worldSyncPending && savedProfileKey === profileKey()
            && String(cardProfile.conversationId || '') === currentConversationId()) {
            const scopeToken = captureScopeToken();
            scheduleWorldBookRepair(
                cardProfile, scopeToken, Number(cardProfile.worldSyncRevision) || pendingRevision,
            );
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
    const allowBaseline = !settings().strictMode
        || (record.baselineStatus === 'verified' && record.sourceTrust === 'verified');
    const profileText = allowBaseline && record.profileFormatVersion === CANON_PROFILE_FORMAT_VERSION
        ? String(record.profile || '').trim() : '';
    const seen = new Set();
    const extracts = profileText || (allowBaseline ? (record.sources || [])
        .map(source => extractEntitySpecificText(source.extract, record.entity))
        .map(cleanSummary)
        .filter(text => text && !/^这是搜索 AI 在本轮检索中选择/.test(text))
        .filter(text => {
            const key = text.replace(/\s+/g, ' ');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .join('\n\n') : '');
    const changes = cleanCanonChanges(record.canonChanges).length
        ? cleanCanonChanges(record.canonChanges).join('；')
        : '无正文明确声明的原著差异；沿用原著设定';
    return `<!-- FCR_CANON_DATABASE_V2 -->\n实体：${record.entity}\n类型：${entityKindLabel(record.kind)}\n作品：${record.work || '未确认'}\n当前剧情线：${record.timeline || '未确认'}\n已确认AU差异：${changes}\n\n原著基线档案：\n${extracts || (allowBaseline ? '原著资料待核实；仅采用上方已确认AU差异' : '严格模式：原著基线尚未完成可靠性复核；仅采用上方已确认AU差异')}\n<!-- /FCR_CANON_DATABASE_V2 -->`;
}

async function syncCanonDatabaseToWorldBook(entities, scopeToken = captureScopeToken(), freshnessGuard = null) {
    const cardProfile = profile();
    if (!scopeTokenIsCurrent(scopeToken) || (freshnessGuard && !freshnessGuard())) return null;
    if (!(await retryPendingWorldBookCleanup(cardProfile))) {
        cardProfile.worldSyncPending = true;
        saveSettingsDebounced();
        updateReport('旧聊天的插件世界书条目尚未清理成功；本地资料已隔离，暂停新条目落盘以防新旧聊天互相覆盖');
        return null;
    }
    if (!scopeTokenIsCurrent(scopeToken) || (freshnessGuard && !freshnessGuard())) return null;
    const worldName = currentWorldBookName() || String(cardProfile.canonWorldBook || '').trim();
    if (!worldName) {
        cardProfile.worldSyncPending = true;
        saveSettingsDebounced();
        return null;
    }
    return await enqueueWorldBookWrite(worldName, async () => {
        const data = await loadWorldInfo(worldName);
        if (!scopeTokenIsCurrent(scopeToken) || (freshnessGuard && !freshnessGuard())) return null;
        if (!data?.entries) {
            cardProfile.worldSyncPending = true;
            saveSettingsDebounced();
            return null;
        }
        const database = storedCanonEntities();
        const databaseChanged = sanitizeCanonDatabase(database);
        const characterFiles = currentCharacterFilterNames();
        let changed = false;
        const seenEntities = new Set();
        const syncedEntities = new Set();
        for (const [uid, entry] of Object.entries(data.entries)) {
            const entity = parseWorldEntryComment(entry?.comment, profileKey());
            if (!entity) continue;
            const duplicate = seenEntities.has(entity);
            seenEntities.add(entity);
            if (!duplicate && cleanDetectedEntities([entity]).length && database[entity]
                && (database[entity].sources?.length || database[entity].profile || cleanCanonChanges(database[entity].canonChanges).length)) continue;
            delete data.entries[uid];
            if (!duplicate && !database[entity]) delete database[entity];
            changed = true;
        }
        for (const entity of cleanDetectedEntities(entities)) {
            const record = database[entity];
            if (!record || (!record.sources?.length && !record.profile && !cleanCanonChanges(record.canonChanges).length)) continue;
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
                // Kept as a visible/persistent database entry.  The normal
                // preflight injects the relevant subset exactly once.
                disable: true,
                probability: 100,
                useProbability: true,
                excludeRecursion: true,
                preventRecursion: true,
                characterFilter: {
                    isExclude: false,
                    names: characterFiles,
                    tags: [],
                },
            };
            const needsUpdate = isNew || Object.entries(desired)
                .some(([key, value]) => JSON.stringify(entry[key]) !== JSON.stringify(value));
            if (needsUpdate) {
                Object.assign(entry, desired);
                changed = true;
            }
            syncedEntities.add(entity);
        }
        if (changed || databaseChanged) {
            if (!scopeTokenIsCurrent(scopeToken) || (freshnessGuard && !freshnessGuard())) return null;
            await saveWorldInfoChecked(worldName, data);
            if (!scopeTokenIsCurrent(scopeToken) || (freshnessGuard && !freshnessGuard())) return null;
            reloadEditor(worldName, false);
        }
        // A byte-identical existing entry is still a successful durable sync.
        // Preserve this ownership marker so a later user deletion can be
        // reconciled even when no disk rewrite was necessary this turn.
        profile().canonWorldBook = worldName;
        profile().writtenWorldBooks = [...new Set([...(profile().writtenWorldBooks || []), worldName])];
        const syncedAt = Date.now();
        for (const entity of syncedEntities) {
            if (database[entity]) database[entity].worldSyncedAt = syncedAt;
        }
        saveSettingsDebounced();
        return changed;
    });
}

function formatCurrentSceneWorldEntry(snapshot) {
    const characters = cleanDetectedEntities(snapshot?.characters);
    const locations = cleanDetectedEntities(snapshot?.locations);
    const subjects = cleanDetectedEntities(snapshot?.subjects)
        .filter(name => !characters.includes(name) && !locations.includes(name));
    const pinned = cleanDetectedEntities(snapshot?.pinned);
    const auChanges = cleanCanonChanges(snapshot?.auChanges);
    const summary = stripMarkup(snapshot?.summary || '').trim();
    return `${SCENE_ENTRY_MARKER}
用途：这是当前聊天已经发生的场景状态，不是剧情提纲；续写必须从这里衔接，不得把已离场人物重新视为在场。
作品：${snapshot?.workTitle || '未确认'}
当前时间线：${snapshot?.timeline || '未确认'}
当前人物：${characters.join('、') || '无明确在场人物'}
当前地点：${locations.join('、') || '未确认'}
当前相关原作实体：${subjects.join('、') || '无'}
用户手动固定：${pinned.join('、') || '无'}
本卡AU差异：${auChanges.join('；') || '尚无已确认差异'}
当前状态：${summary || '仅按上列人物、地点与时间线衔接'}
${SCENE_ENTRY_END_MARKER}`;
}

async function syncCurrentSceneToWorldBook(snapshot, scopeToken = captureScopeToken(), freshnessGuard = null) {
    const cardProfile = profile();
    if (!scopeTokenIsCurrent(scopeToken) || (freshnessGuard && !freshnessGuard())) return null;
    if (!(await retryPendingWorldBookCleanup(cardProfile))) {
        cardProfile.worldSyncPending = true;
        saveSettingsDebounced();
        updateReport('旧聊天的插件世界书条目尚未清理成功；当前场景只保存在本地，待清理成功后再落盘');
        return null;
    }
    if (!scopeTokenIsCurrent(scopeToken) || (freshnessGuard && !freshnessGuard())) return null;
    const worldName = currentWorldBookName() || String(cardProfile.canonWorldBook || '').trim();
    if (!snapshot || (freshnessGuard && !freshnessGuard())) return null;
    if (!worldName) {
        cardProfile.worldSyncPending = true;
        saveSettingsDebounced();
        return null;
    }
    return await enqueueWorldBookWrite(worldName, async () => {
        const data = await loadWorldInfo(worldName);
        if (!scopeTokenIsCurrent(scopeToken) || (freshnessGuard && !freshnessGuard())) return null;
        if (!data?.entries) {
            cardProfile.worldSyncPending = true;
            saveSettingsDebounced();
            return null;
        }
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
            if (!entry) return null;
            changed = true;
        }
        const characterFiles = currentCharacterFilterNames();
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
            // Current-scene state is injected from local storage together with
            // canon/AU.  Disabling the durable copy prevents double injection
            // and prevents a group entry leaking into a member's solo chat.
            disable: true,
            probability: 100,
            useProbability: true,
            excludeRecursion: true,
            preventRecursion: true,
            characterFilter: {
                isExclude: false,
                names: characterFiles,
                tags: [],
            },
        };
        if (Object.entries(desired).some(([key, value]) => JSON.stringify(entry[key]) !== JSON.stringify(value))) {
            Object.assign(entry, desired);
            changed = true;
        }
        if (!changed) return false;
        if (!scopeTokenIsCurrent(scopeToken) || (freshnessGuard && !freshnessGuard())) return null;
        await saveWorldInfoChecked(worldName, data);
        if (!scopeTokenIsCurrent(scopeToken) || (freshnessGuard && !freshnessGuard())) return null;
        reloadEditor(worldName, false);
        profile().canonWorldBook = worldName;
        profile().writtenWorldBooks = [...new Set([...(profile().writtenWorldBooks || []), worldName])];
        saveSettingsDebounced();
        return true;
    });
}

async function clearCurrentSceneWorldBookEntries(
    cardProfile = profile(), targetProfileKey = profileKey(),
    scopeToken = null, freshnessGuard = null,
) {
    const isFresh = () => (!scopeToken || scopeTokenIsCurrent(scopeToken))
        && (!freshnessGuard || freshnessGuard());
    if (!isFresh()) return false;
    const worldNames = [...new Set([
        currentWorldBookName(),
        String(cardProfile?.canonWorldBook || '').trim(),
        ...(Array.isArray(cardProfile?.writtenWorldBooks) ? cardProfile.writtenWorldBooks : []),
    ].map(String).map(value => value.trim()).filter(Boolean))];
    let completed = true;
    for (const worldName of worldNames) {
        if (!isFresh()) return false;
        const result = await enqueueWorldBookWrite(worldName, async () => {
            const data = await loadWorldInfo(worldName);
            if (!isFresh()) return null;
            if (!data?.entries) return knownWorldBookExists(worldName) === false ? false : null;
            let changed = false;
            for (const [uid, entry] of Object.entries(data.entries)) {
                if (!isSceneEntryComment(entry?.comment, targetProfileKey)) continue;
                delete data.entries[uid];
                changed = true;
            }
            if (changed) {
                if (!isFresh()) return null;
                await saveWorldInfoChecked(worldName, data, targetProfileKey);
                if (!isFresh()) return null;
                reloadEditor(worldName, false);
            }
            return changed;
        });
        if (result === null) completed = false;
    }
    return completed;
}

function markWorldSyncPending(cardProfile = profile()) {
    cardProfile.worldSyncRevision = (Number(cardProfile.worldSyncRevision) || 0) + 1;
    cardProfile.worldSyncPending = true;
    saveSettingsDebounced();
    const scopeToken = captureScopeToken();
    if (scopeTokenIsCurrent(scopeToken) && profile() === cardProfile) {
        scheduleWorldBookRepair(cardProfile, scopeToken, cardProfile.worldSyncRevision);
    }
    return cardProfile.worldSyncRevision;
}

async function repairWorldBookFromLocalState(
    cardProfile, scopeToken = captureScopeToken(), freshnessGuard = null, revision = null,
) {
    const expectedRevision = Number(revision ?? cardProfile.worldSyncRevision) || 0;
    const isFresh = () => scopeTokenIsCurrent(scopeToken)
        && (!freshnessGuard || freshnessGuard())
        && (Number(cardProfile.worldSyncRevision) || 0) === expectedRevision;
    if (!isFresh()) return false;
    const canonCompleted = (await syncCanonDatabaseToWorldBook(
        Object.keys(cardProfile.canonDatabase || {}), scopeToken, isFresh,
    )) !== null;
    if (!isFresh()) return false;
    const sceneCompleted = cardProfile.currentScene
        ? (await syncCurrentSceneToWorldBook(cardProfile.currentScene, scopeToken, isFresh)) !== null
        : await clearCurrentSceneWorldBookEntries(
            cardProfile, scopeToken.profileKey, scopeToken, isFresh,
        );
    if (!isFresh()) return false;
    const completed = canonCompleted && sceneCompleted;
    cardProfile.worldSyncPending = !completed;
    saveSettingsDebounced();
    if (completed) cancelWorldBookRepair(scopeToken, expectedRevision);
    else scheduleWorldBookRepair(cardProfile, scopeToken, expectedRevision);
    return completed;
}

function worldBookRepairKey(scopeToken) {
    return scopeIdentity(scopeToken?.profileKey, scopeToken?.conversationId);
}

function cancelWorldBookRepair(scopeToken = captureScopeToken(), revision = null) {
    const key = worldBookRepairKey(scopeToken);
    const pending = worldBookRepairTimers.get(key);
    if (!pending || (revision !== null && Number(pending.revision) !== Number(revision))) return;
    if (pending.timer) clearTimeout(pending.timer);
    worldBookRepairTimers.delete(key);
}

function scheduleWorldBookRepair(
    cardProfile, scopeToken = captureScopeToken(), revision = cardProfile?.worldSyncRevision,
    attempt = 0, replaceExisting = false,
) {
    if (!cardProfile?.worldSyncPending || !scopeTokenIsCurrent(scopeToken)) return false;
    const expectedRevision = Number(revision) || 0;
    if ((Number(cardProfile.worldSyncRevision) || 0) !== expectedRevision) return false;
    const key = worldBookRepairKey(scopeToken);
    const previous = worldBookRepairTimers.get(key);
    if (previous && !replaceExisting && Number(previous.revision) === expectedRevision) return true;
    if (previous?.timer) clearTimeout(previous.timer);
    worldBookRepairTimers.delete(key);
    if (attempt >= WORLD_BOOK_REPAIR_DELAYS_MS.length) return false;

    const timer = setTimeout(async () => {
        const pending = worldBookRepairTimers.get(key);
        if (!pending || pending.timer !== timer) return;
        pending.running = true;
        const currentRevision = Number(cardProfile.worldSyncRevision) || 0;
        if (!scopeTokenIsCurrent(scopeToken) || profile() !== cardProfile || !cardProfile.worldSyncPending) {
            worldBookRepairTimers.delete(key);
            return;
        }
        if (currentRevision !== expectedRevision) {
            scheduleWorldBookRepair(cardProfile, scopeToken, currentRevision, 0, true);
            return;
        }
        try {
            const completed = await repairWorldBookFromLocalState(
                cardProfile, scopeToken, null, expectedRevision,
            );
            if (completed) {
                if (cardProfile.sceneSync?.status === 'world_pending') {
                    setSceneSyncState({
                        ...cardProfile.sceneSync,
                        status: 'synced',
                        error: '',
                        retryCount: 0,
                        nextRetryAt: 0,
                    });
                }
                updateReport('本地资料与当前场景已自动补写到世界书');
                return;
            }
        } catch (error) {
            console.warn('[Fandom Canon] Deferred world-book repair failed.', error);
        }
        if (scopeTokenIsCurrent(scopeToken) && profile() === cardProfile
            && cardProfile.worldSyncPending
            && (Number(cardProfile.worldSyncRevision) || 0) === expectedRevision) {
            scheduleWorldBookRepair(cardProfile, scopeToken, expectedRevision, attempt + 1, true);
        }
    }, WORLD_BOOK_REPAIR_DELAYS_MS[attempt]);
    worldBookRepairTimers.set(key, {
        timer, revision: expectedRevision, attempt, running: false,
    });
    return true;
}

async function clearCanonWorldBookEntries(targetProfileKey = profileKey(), targetWorldName = currentWorldBookName()) {
    const worldName = String(targetWorldName || '').trim();
    if (!worldName) return true;
    const result = await enqueueWorldBookWrite(worldName, async () => {
        const data = await loadWorldInfo(worldName);
        if (!data?.entries) return knownWorldBookExists(worldName) === false ? false : null;
        let changed = false;
        for (const [uid, entry] of Object.entries(data.entries)) {
            if (parseWorldEntryComment(entry?.comment, targetProfileKey) || isSceneEntryComment(entry?.comment, targetProfileKey)) {
                delete data.entries[uid];
                changed = true;
            }
        }
        if (changed) {
            await saveWorldInfoChecked(worldName, data, targetProfileKey);
            reloadEditor(worldName, false);
        }
        return changed;
    });
    return result !== null;
}

async function clearProfileWorldBookEntries(cardProfile, targetProfileKey = profileKey()) {
    const worldNames = [...new Set([
        currentWorldBookName(),
        String(cardProfile?.canonWorldBook || '').trim(),
        ...(Array.isArray(cardProfile?.writtenWorldBooks) ? cardProfile.writtenWorldBooks : []),
    ].filter(Boolean))];
    const errors = [];
    for (const worldName of worldNames) {
        try {
            const completed = await clearCanonWorldBookEntries(targetProfileKey, worldName);
            if (!completed) errors.push(`${worldName}：世界书无法读取，清理尚未完成`);
        } catch (error) {
            errors.push(`${worldName}：${error?.message || error}`);
        }
    }
    if (errors.length) throw new Error(errors.join('；'));
}

async function resetCurrentConversationData({ reason = '已重置当前聊天的全部同人资料' } = {}) {
    const cardProfile = profile();
    const targetProfileKey = profileKey();
    const conversationId = currentConversationId();
    const previousCleanup = cardProfile.cleanupPending;
    const cleanupProfileKeys = [...new Set([
        targetProfileKey,
        previousCleanup?.profileKey,
        ...(Array.isArray(previousCleanup?.profileKeys) ? previousCleanup.profileKeys : []),
    ].map(String).filter(Boolean))];
    const cleanupWorldBooks = [...new Set([
        currentWorldBookName(),
        cardProfile.canonWorldBook,
        ...(cardProfile.writtenWorldBooks || []),
        ...(Array.isArray(previousCleanup?.worldBooks) ? previousCleanup.worldBooks : []),
    ].filter(Boolean))];
    clearRuntimeState();
    // Reset is an immediate isolation boundary: local injection state must be
    // gone before slow world-book I/O starts, otherwise a generation clicked
    // during cleanup can still receive the old chat's canon/AU prompt.
    clearConversationProfile(cardProfile, conversationId);
    saveSettingsDebounced();
    loadProfileIntoPanel();
    let cleanupError = '';
    try {
        const errors = [];
        for (const cleanupProfileKey of cleanupProfileKeys) {
            for (const worldName of cleanupWorldBooks) {
                try {
                    const completed = await clearCanonWorldBookEntries(cleanupProfileKey, worldName);
                    if (!completed) errors.push(`${worldName}：世界书无法读取，清理尚未完成`);
                } catch (error) {
                    errors.push(`${worldName}：${error?.message || error}`);
                }
            }
        }
        if (errors.length) throw new Error([...new Set(errors)].join('；'));
    } catch (error) {
        cleanupError = error?.message || String(error);
        console.error('[Fandom Canon] World-book cleanup failed during reset.', error);
    } finally {
        cardProfile.cleanupPending = cleanupError ? {
            profileKey: targetProfileKey,
            profileKeys: cleanupProfileKeys,
            worldBooks: cleanupWorldBooks,
            error: cleanupError,
            at: Date.now(),
            nextRetryAt: Date.now() + 30000,
        } : null;
        saveSettingsDebounced();
        loadProfileIntoPanel();
        updateReport(cleanupError ? `${reason}；本地数据已清空，但世界书清理失败：${cleanupError}` : reason);
    }
}

async function retryPendingWorldBookCleanup(cardProfile = profile(), { force = false } = {}) {
    const pending = cardProfile?.cleanupPending;
    if (!pending?.profileKey || !Array.isArray(pending.worldBooks) || !pending.worldBooks.length) return true;
    if (!force && Number(pending.nextRetryAt || 0) > Date.now()) return false;
    const errors = [];
    const profileKeys = [...new Set([
        pending.profileKey,
        ...(Array.isArray(pending.profileKeys) ? pending.profileKeys : []),
    ].map(String).filter(Boolean))];
    for (const cleanupProfileKey of profileKeys) {
        for (const worldName of [...new Set(pending.worldBooks.map(String).filter(Boolean))]) {
            try {
                const completed = await clearCanonWorldBookEntries(cleanupProfileKey, worldName);
                if (!completed) errors.push(`${worldName}：世界书无法读取，清理尚未完成`);
            } catch (error) {
                errors.push(`${worldName}：${error?.message || error}`);
            }
        }
    }
    if (errors.length) {
        pending.error = errors.join('；');
        pending.attempts = (Number(pending.attempts) || 0) + 1;
        pending.nextRetryAt = Date.now() + Math.min(10 * 60 * 1000, 30000 * (2 ** Math.min(pending.attempts, 4)));
        saveSettingsDebounced();
        return false;
    }
    cardProfile.cleanupPending = null;
    saveSettingsDebounced();
    return true;
}

async function ensureConversationScope() {
    if (conversationTransition) await conversationTransition;
    const conversationId = currentConversationId();
    if (!conversationId) return false;

    const cardProfile = profile();
    await retryPendingWorldBookCleanup(cardProfile);
    if (!cardProfile.conversationId) {
        cardProfile.conversationId = conversationId;
        saveSettingsDebounced();
        return false;
    }
    if (cardProfile.conversationId === conversationId) return false;

    const previousConversationId = cardProfile.conversationId;
    conversationTransition = (async () => {
        await resetCurrentConversationData({
            reason: `检测到同一角色卡已切换到新聊天；旧聊天“${previousConversationId}”的插件资料已隔离并清空`,
        });
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
    const recordNames = Object.keys(database).filter(name => Number(database[name]?.worldSyncedAt) > 0);
    const worldNames = [...new Set([
        currentWorldBookName(),
        String(cardProfile.canonWorldBook || '').trim(),
        ...(Array.isArray(cardProfile.writtenWorldBooks) ? cardProfile.writtenWorldBooks : []),
    ].filter(Boolean))];
    if (!recordNames.length || !worldNames.length || cardProfile.cleanupPending || cardProfile.worldSyncPending) return false;
    const presentEntities = new Set();
    for (const worldName of worldNames) {
        const data = await loadWorldInfo(worldName);
        // A missing/unreadable book is not evidence that the user deleted an
        // entity. Abort the reconciliation instead of deleting local data.
        if (!scopeTokenIsCurrent(scopeToken)) return false;
        if (!data?.entries) {
            if (knownWorldBookExists(worldName) === false) continue;
            return false;
        }
        for (const entry of Object.values(data.entries)) {
            const entity = parseWorldEntryComment(entry?.comment, profileKey());
            if (entity) presentEntities.add(canonicalEntityKey(entity));
        }
    }
    const removedRecords = recordNames.filter(name => !presentEntities.has(canonicalEntityKey(name)));
    if (!removedRecords.length) return false;

    invalidateProfileTransactions(cardProfile);
    const removedOwnerKeys = new Set(removedRecords
        .map(name => canonicalEntityKey(database[name]?.entity || name)));
    const removedRecordKeys = new Set(removedRecords);
    const removedAliases = new Set(removedRecords
        .flatMap(name => [name, ...recordAliases(database[name], name)])
        .map(canonicalEntityKey));
    for (const name of removedRecords) delete database[name];
    const remainingAliases = new Set(Object.entries(database)
        .flatMap(([name, record]) => recordAliases(record, name)).map(canonicalEntityKey));
    const keepEntity = name => !removedAliases.has(canonicalEntityKey(name))
        || remainingAliases.has(canonicalEntityKey(name));
    cardProfile.entities = manualEntities(cardProfile.entities).filter(keepEntity).join('，');
    cardProfile.lastAutoEntities = cleanDetectedEntities(cardProfile.lastAutoEntities).filter(keepEntity);
    const keepAuFact = fact => {
        if (fact.ownerRecordKey) return !removedRecordKeys.has(fact.ownerRecordKey);
        if (!removedOwnerKeys.has(canonicalEntityKey(fact.owner))) return true;
        if (!fact.work) return false;
        return Object.values(database).some(record =>
            canonicalEntityKey(record?.entity) === canonicalEntityKey(fact.owner)
            && recordWorkAliases(record).some(work => fandomWorkIdentityMatches(work, fact.work)));
    };
    cardProfile.auFacts = activeAuFacts(cardProfile).filter(keepAuFact);
    cardProfile.auHistory = cleanAuFacts(cardProfile.auHistory)
        .filter(keepAuFact).map(fact => ({ ...fact, active: false }));
    ensureStructuredAuState(cardProfile, database);
    clearRuntimeState();
    saveSettingsDebounced();
    loadProfileIntoPanel();
    updateReport(`检测到所有已记录世界书中均已删除 ${removedRecords.join('、')}；只清除了这些对象自身的插件档案与AU，不影响句中提到的其他对象`);
    return true;
}

function evidenceDescribesStateChange(value) {
    return /(?:获得|拿到|取走|交给|归还|失去|丢失|摧毁|损坏|修复|恢复|觉醒|封印|解除|加入|退出|背叛|结盟|分手|结婚|确认(?:关系|恋爱)|开始交往|收养|被收养|死亡|复活|受伤|治愈|抵达|离开|搬迁|占领|释放|吸收|耗尽|夺走|改变|变成|成为|发生|完成|阻止|杀死|救下|送回|剪短|剪掉|染(?:成|了)?|失忆|忘记|想起|恢复记忆|学会|掌握|继承|承袭|接手|继任|接任|就职|入职|离职|辞职|卸任|辞去|脱离|obtained|acquired|lost|destroyed|restored|awakened|joined|left|betrayed|married|adopted|forgot|remembered|learned|mastered|inherited|resigned|depleted|died|revived|injured|healed|arrived|departed|changed|became|returned)/i.test(String(value || ''));
}

function worldInfoEntryContainsEvidence(entry, evidence) {
    const content = String(entry?.content || '');
    const exact = String(evidence || '').trim();
    if (!content || exact.length < 2) return false;
    return content.includes(exact)
        || normalizeChangeText(content).includes(normalizeChangeText(exact));
}

function worldInfoOriginsForEvidence(entries, evidence) {
    if (!Array.isArray(entries)) return null;
    return entries.filter(entry => !entry?.disabled && worldInfoEntryContainsEvidence(entry, evidence))
        .slice(0, 8).map(entry => ({
            source: 'world_info',
            messageId: null,
            messageSignature: `world_info|${entry.world}|${entry.uid}|${entry.hash}`,
            evidence: String(evidence || '').trim(),
            worldBook: String(entry.world || ''),
            worldEntryUid: String(entry.uid || ''),
            worldEntryHash: String(entry.hash || ''),
        }));
}

function auEvidenceGroundsFact(fact, evidence, database = storedCanonEntities()) {
    if ((fact?.source === 'assistant_event' || fact?.source === 'prior_context')
        && fact?.eventChanged === true && evidenceDescribesStateChange(evidence)) return true;
    const record = fact?.ownerRecordKey ? database?.[fact.ownerRecordKey] : null;
    const identityAnchors = cleanDetectedEntities([
        fact?.owner,
        ...recordAliases(record, fact?.owner),
        ...(Array.isArray(fact?.participants) ? fact.participants : []),
    ]);
    const genericFacetParts = new Set([
        'identity', 'status', 'relationship', 'item', 'item_state', 'ability',
        'appearance', 'appearance_state', 'personality', 'alignment', 'experience',
        'event', 'location', 'organization', 'timeline', 'current', 'node', 'other',
        'unspecified', 'ownership', 'availability', 'state', 'rule',
    ]);
    const facetAnchors = String(fact?.facet || '').split(/[._·:/-]+/)
        .map(value => value.trim()).filter(value => value.length >= 2 && !genericFacetParts.has(value));
    const hasIdentityAnchor = identityAnchors.some(name => textContainsEntityAlias(evidence, name));
    const hasFacetAnchor = facetAnchors.some(value => textContainsEntityAlias(evidence, value));
    const normalizedEvidence = normalizeChangeText(evidence);
    const hasValueAnchor = [fact?.current, fact?.canon].filter(Boolean).some(value => {
        const normalized = normalizeChangeText(value);
        if (normalized.length >= 4 && normalizedEvidence.includes(normalized)) return true;
        const terms = String(value).match(/[\p{L}\p{N}·・]{2,16}/gu) || [];
        return terms.some(term => textContainsEntityAlias(evidence, term));
    });
    if (!hasIdentityAnchor && !hasFacetAnchor && !hasValueAnchor) return false;

    const assertion = evidenceDescribesStateChange(evidence)
        || /(?:是|为|属于|拥有|持有|具备|能够|不能|无法|没有|并无|从未|未曾|不再|仍然|依旧|已经|关系|身份|性格|外貌|发色|发型|能力|限制|经历|死亡|存活|存在|不存在|位于|控制|负责|恋爱|结婚|分手|放回|取走|封印|换成|穿着?|is|was|has|have|without|never|no longer|cannot|belongs to)/i.test(evidence)
        || [fact?.current, fact?.canon].filter(Boolean).some(value => {
            const terms = String(value).match(/[\p{L}\p{N}·・]{2,24}/gu) || [];
            return terms.some(term => textContainsEntityAlias(evidence, term));
        });
    return assertion;
}

function auEvidenceMatches(fact, sourceTexts = {}, database = storedCanonEntities()) {
    if (fact.source === 'legacy' || fact.source === 'manual') return true;
    const sourceText = String(sourceTexts[fact.source] || '');
    const evidence = String(fact.evidence || '').trim();
    if (!sourceText || evidence.length < 2) return false;
    const exact = sourceText.includes(evidence);
    const normalized = normalizeChangeText(sourceText).includes(normalizeChangeText(evidence));
    if (!exact && !normalized) return false;
    if (!auEvidenceGroundsFact(fact, evidence, database)) return false;
    if (fact.source === 'assistant_event' || fact.source === 'prior_context') {
        if (fact.eventChanged !== true) return false;
        if (!evidenceDescribesStateChange(evidence)) return false;
    }
    const rejected = Array.isArray(sourceTexts.rejected) ? sourceTexts.rejected : [];
    return !rejected.some(text => text && (String(text).includes(evidence) || evidence.includes(String(text))));
}

function pluginWorldEntryFingerprint(data, targetProfileKey = profileKey()) {
    const normalizedStrings = values => (Array.isArray(values) ? values : [])
        .map(value => String(value ?? '').trim()).filter(Boolean).sort();
    return Object.values(data?.entries || {})
        .filter(entry => parseWorldEntryComment(entry?.comment, targetProfileKey)
            || isSceneEntryComment(entry?.comment, targetProfileKey))
        .map(entry => JSON.stringify({
            comment: String(entry.comment || ''),
            contentHash: textHash(String(entry.content || '')),
            key: normalizedStrings(entry.key),
            keysecondary: normalizedStrings(entry.keysecondary),
            constant: entry.constant === true,
            selective: entry.selective === true,
            addMemo: entry.addMemo === true,
            order: Number(entry.order) || 0,
            position: Number(entry.position) || 0,
            disable: entry.disable === true,
            probability: Number(entry.probability) || 0,
            useProbability: entry.useProbability === true,
            excludeRecursion: entry.excludeRecursion === true,
            preventRecursion: entry.preventRecursion === true,
            characterFilter: {
                isExclude: entry.characterFilter?.isExclude === true,
                names: normalizedStrings(entry.characterFilter?.names),
                tags: normalizedStrings(entry.characterFilter?.tags),
            },
        }))
        .sort();
}

async function saveWorldInfoChecked(worldName, data, targetProfileKey = profileKey()) {
    const snapshot = structuredClone(data);
    const expected = pluginWorldEntryFingerprint(snapshot, targetProfileKey);
    await saveWorldInfo(worldName, snapshot, true);
    worldInfoCache?.delete?.(worldName);
    const persisted = await loadWorldInfo(worldName);
    if (!persisted?.entries) throw new Error(`世界书同步失败：保存后无法从磁盘重新读取“${worldName}”`);
    const actual = pluginWorldEntryFingerprint(persisted, targetProfileKey);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`世界书同步失败：磁盘复核不一致（${worldName}）`);
    }
    return persisted;
}

function canonicalizeAuFactOwner(fact, database, plan = {}) {
    const candidates = cleanCanonSubjectCandidates([
        ...(Array.isArray(plan.entityCandidates) ? plan.entityCandidates : []),
        ...(Array.isArray(plan.sceneCandidates) ? plan.sceneCandidates : []),
    ]);
    const ownerKey = canonicalEntityKey(fact.owner);
    const sameNameCandidates = candidates.filter(item =>
        canonicalEntityKey(item.candidateName) === ownerKey);
    // An explicitly original current-scene entity owns its own state.  Never
    // fall through to a stale same-name canon row merely because the model
    // supplied that row's work title.
    if (sameNameCandidates.some(item => item.isOriginal)) return null;
    const sameNameRecordKeys = findCanonRecordNames(fact.owner, database, {});
    const selectUniqueWork = (values, work, readWork) => {
        const expected = String(work || '').trim();
        if (!expected) return null;
        const matches = values.filter(value => {
            const actualValues = Array.isArray(readWork(value)) ? readWork(value) : [readWork(value)];
            return actualValues.map(String).map(actual => actual.trim()).filter(Boolean)
                .some(actual => fandomWorkIdentityMatches(expected, actual));
        });
        return matches.length === 1 ? matches[0] : null;
    };
    let candidate = null;
    let recordName = '';
    if (fact.ownerRecordKey && database[fact.ownerRecordKey]
        && recordAliases(database[fact.ownerRecordKey], fact.ownerRecordKey)
            .some(alias => canonicalEntityKey(alias) === ownerKey)
        && canonRecordMatchesIdentity(database[fact.ownerRecordKey], {
            work: fact.work || plan.work || '', kind: fact.kind,
        })) {
        recordName = fact.ownerRecordKey;
    }

    if (fact.work) {
        candidate = selectUniqueWork(sameNameCandidates, fact.work, item => item.workHint);
        if (!recordName) recordName = selectUniqueWork(
            sameNameRecordKeys, fact.work, key => recordWorkAliases(database[key]),
        ) || '';
        const knownCandidateWorks = sameNameCandidates.some(item => String(item.workHint || '').trim());
        const knownRecordWorks = sameNameRecordKeys.some(key => String(database[key]?.work || '').trim());
        if (!candidate && !recordName && (knownCandidateWorks || knownRecordWorks)) return null;
    }

    if (!candidate && plan.work) {
        candidate = selectUniqueWork(sameNameCandidates, plan.work, item => item.workHint);
    }
    if (!recordName && plan.work) {
        recordName = selectUniqueWork(sameNameRecordKeys, plan.work, key => recordWorkAliases(database[key])) || '';
    }
    if (!candidate && sameNameCandidates.length === 1) candidate = sameNameCandidates[0];
    if (!recordName && sameNameRecordKeys.length === 1) recordName = sameNameRecordKeys[0];

    if (!candidate && sameNameCandidates.length > 1) {
        const kindMatches = sameNameCandidates.filter(item =>
            normalizeEntityKind(item.kind, 'unknown') === normalizeEntityKind(fact.kind, 'unknown'));
        if (kindMatches.length === 1) candidate = kindMatches[0];
    }
    if (!recordName && !candidate && sameNameRecordKeys.length > 1) {
        const kindMatches = sameNameRecordKeys.filter(key =>
            normalizeEntityKind(database[key]?.kind, 'unknown') === normalizeEntityKind(fact.kind, 'unknown'));
        if (kindMatches.length === 1) recordName = kindMatches[0];
    }
    // A naked same-name AU fact in a crossover cannot be safely assigned to the
    // first candidate.  Dropping an ambiguous model proposal is preferable to
    // overwriting the other work's persistent state.
    if (!candidate && !recordName && (sameNameCandidates.length > 1 || sameNameRecordKeys.length > 1)) return null;
    if (candidate?.isOriginal) return null;
    if (!recordName && candidate) recordName = candidateRecordName(candidate, database, plan.work);
    const record = database[recordName];
    const expectedWork = record?.work || candidate?.workHint || fact.work || plan.work || '';
    if (!recordName) {
        recordName = findCanonRecordName(fact.owner, database, { work: expectedWork });
    }
    const participants = cleanDetectedEntities(fact.participants).map(name => {
        const participantRecord = findCanonRecordName(name, database, { work: expectedWork });
        return participantRecord ? (database[participantRecord]?.entity || participantRecord) : name;
    });
    if (recordName) {
        const owner = database[recordName]?.entity || recordName;
        return {
            ...fact,
            owner,
            ownerRecordKey: recordName,
            kind: normalizeEntityKind(database[recordName]?.kind, fact.kind),
            work: database[recordName]?.work || expectedWork,
            participants: participants.filter(name => canonicalEntityKey(name) !== canonicalEntityKey(owner)),
        };
    }
    if (fact.kind !== 'world_rule' && (!candidate || candidate.isOriginal !== false)) return null;
    return {
        ...fact,
        owner: normalizeEntityDisplay(fact.owner),
        ownerRecordKey: '',
        kind: normalizeEntityKind(candidate?.kind, fact.kind),
        work: expectedWork,
        participants: participants.filter(name => canonicalEntityKey(name) !== canonicalEntityKey(fact.owner)),
    };
}

function upsertActiveAuFact(cardProfile, incoming) {
    const facts = activeAuFacts(cardProfile);
    const history = Array.isArray(cardProfile.auHistory) ? cardProfile.auHistory : [];
    const explicitReplacements = facts.filter(saved =>
        sameAuOwnerIdentity(saved, incoming)
        && incoming.replaces.some(text => changesAreEquivalent(text, auFactText(saved))
            || changesAreEquivalent(text, saved.current)));
    const sameFacet = incoming.facet.startsWith('legacy.') || incoming.facet === 'other'
        || incoming.facet.endsWith('.unspecified')
        ? []
        : facts.filter(saved => sameAuOwnerIdentity(saved, incoming)
            && saved.facet === incoming.facet);
    const superseded = [...new Set([...explicitReplacements, ...sameFacet])];
    const incomingPriority = AU_SOURCE_PRIORITY[incoming.source] || 0;
    const verifiedEventSuccessor = incoming.source === 'assistant_event'
        && incoming.eventChanged === true
        && evidenceDescribesStateChange(incoming.evidence);
    const protectedFacts = superseded.filter(saved =>
        (AU_SOURCE_PRIORITY[saved.source] || 0) > incomingPriority
        && !verifiedEventSuccessor);
    // A lower-trust assistant inference must never turn a conflicting prose
    // mistake into an AU by replacing a user/card/world-book fact.
    if (protectedFacts.length) return { changed: false, superseded: [] };
    const equivalent = facts.find(saved => sameAuOwnerIdentity(saved, incoming)
        && saved.facet === incoming.facet
        && changesAreEquivalent(saved.current, incoming.current));
    if (equivalent && !superseded.some(item => item !== equivalent)) {
        const before = JSON.stringify({ ...equivalent, updatedAt: 0 });
        const mayPromote = incomingPriority >= (AU_SOURCE_PRIORITY[equivalent.source] || 0);
        if (mayPromote) equivalent.evidence = incoming.evidence || equivalent.evidence;
        equivalent.provenance = cleanAuProvenance([
            ...(equivalent.provenance || []), ...(incoming.provenance || []),
        ], equivalent);
        if (mayPromote) {
            equivalent.source = incoming.source || equivalent.source;
            equivalent.messageId = incoming.messageId;
            equivalent.messageSignature = incoming.messageSignature;
        }
        equivalent.participants = cleanDetectedEntities([
            ...(equivalent.participants || []), ...(incoming.participants || []),
        ]).filter(name => canonicalEntityKey(name) !== canonicalEntityKey(equivalent.owner));
        equivalent.canon ||= incoming.canon;
        const changed = JSON.stringify({ ...equivalent, updatedAt: 0 }) !== before;
        if (changed) equivalent.updatedAt = Date.now();
        return { changed, superseded: [] };
    }
    const supersededIds = new Set(superseded.map(fact => fact.id));
    if (superseded.length) {
        for (const old of superseded) {
            history.push({
                ...old,
                active: false,
                supersededAt: Date.now(),
                supersededBy: incoming.id,
            });
        }
    }
    cardProfile.auFacts = facts.filter(fact => !supersededIds.has(fact.id));
    if (!cardProfile.auFacts.some(saved => sameAuOwnerIdentity(saved, incoming)
        && saved.facet === incoming.facet && changesAreEquivalent(saved.current, incoming.current))) {
        cardProfile.auFacts.push({ ...incoming, active: true, updatedAt: Date.now() });
    }
    cardProfile.auHistory = history;
    return { changed: true, superseded };
}

function rollbackAuFactsByProvenance(cardProfile, shouldRemoveOrigin) {
    if (!cardProfile || typeof shouldRemoveOrigin !== 'function') return { changed: false, owners: [], recordKeys: [] };
    ensureStructuredAuState(cardProfile, cardProfile.canonDatabase || {});
    const removedActive = [];
    let changed = false;
    const stripOrigins = fact => {
        const normalized = normalizeAuFact(fact);
        if (!normalized) return null;
        const previous = normalized.provenance || [];
        const kept = previous.filter(origin => !shouldRemoveOrigin(origin, normalized));
        if (kept.length === previous.length) return normalized;
        changed = true;
        if (!kept.length) return null;
        const best = [...kept].sort((a, b) => (AU_SOURCE_PRIORITY[b.source] || 0) - (AU_SOURCE_PRIORITY[a.source] || 0))[0];
        normalized.provenance = kept;
        normalized.source = best?.source || normalized.source;
        normalized.messageId = best?.messageId ?? null;
        normalized.messageSignature = best?.messageSignature || '';
        return normalized;
    };

    const active = [];
    for (const fact of cleanAuFacts(cardProfile.auFacts)) {
        const kept = stripOrigins(fact);
        if (kept) active.push(kept);
        else removedActive.push(fact);
    }
    let history = [];
    const removedHistory = new Map();
    for (const fact of cleanAuFacts(cardProfile.auHistory)) {
        const kept = stripOrigins(fact);
        if (kept) history.push({ ...kept, active: false });
        else removedHistory.set(fact.id, fact);
    }

    // Preserve the replacement graph when an intermediate historical value
    // loses its only provenance.  For A→B→C, deleting B must rewire A→C so a
    // later deletion of C can still restore A.
    const replacementTargetAfterRemovedHistory = (target, seen = new Set()) => {
        if (!target || seen.has(target)) return '';
        const removed = removedHistory.get(target);
        if (!removed) return target;
        seen.add(target);
        return replacementTargetAfterRemovedHistory(removed.supersededBy, seen);
    };
    for (const fact of history) {
        const target = replacementTargetAfterRemovedHistory(fact.supersededBy);
        if (target !== fact.supersededBy) {
            fact.supersededBy = target;
            changed = true;
        }
    }

    // If the invalidated message had replaced an older value, restore the
    // newest still-supported value for each affected owner/facet.  This makes
    // changing a swipe a true rollback instead of permanently erasing the
    // state that existed before that swipe.
    for (const removed of removedActive) {
        let candidates = history
            .filter(old => old.supersededBy === removed.id)
            .sort((a, b) => (b.supersededAt || b.updatedAt || 0) - (a.supersededAt || a.updatedAt || 0));
        if (!candidates.length) {
            // Repair legacy/broken chains conservatively: one owner/kind/facet
            // can have only one active value, so its newest surviving history is
            // the only valid predecessor.
            candidates = history.filter(old => sameAuOwnerIdentity(old, removed)
                && old.facet === removed.facet)
                .sort((a, b) => (b.supersededAt || b.updatedAt || 0) - (a.supersededAt || a.updatedAt || 0));
        }
        for (const candidate of candidates) {
            const occupied = active.some(saved => sameAuOwnerIdentity(saved, candidate)
                && saved.facet === candidate.facet);
            if (occupied) continue;
            active.push({
                ...candidate,
                active: true,
                supersededAt: 0,
                supersededBy: '',
                updatedAt: Date.now(),
            });
            history = history.filter(saved => saved.id !== candidate.id);
        }
    }
    if (!changed) return { changed: false, owners: [], recordKeys: [] };
    cardProfile.auFacts = active;
    cardProfile.auHistory = history;
    ensureStructuredAuState(cardProfile, cardProfile.canonDatabase || {});
    const owners = cleanDetectedEntities([
        ...removedActive.map(fact => fact.owner),
        ...active.map(fact => fact.owner),
    ]);
    const recordKeys = [...new Set([...removedActive, ...active]
        .map(fact => String(fact.ownerRecordKey || '')).filter(key => cardProfile.canonDatabase?.[key]))];
    return { changed: true, owners, recordKeys };
}

function rollbackMessageDerivedAuFacts(cardProfile, messageId, validMessageSignature = '') {
    const index = Number(messageId);
    if (!Number.isInteger(index) || index < 0) return { changed: false, owners: [], recordKeys: [] };
    return rollbackAuFactsByProvenance(cardProfile, origin =>
        CHAT_DERIVED_AU_SOURCES.has(origin.source)
        && Number(origin.messageId) === index
        && (!validMessageSignature || origin.messageSignature !== validMessageSignature));
}

function reconcileMessageDerivedAuFacts(cardProfile, chat) {
    const signatureToIndex = new Map((Array.isArray(chat) ? chat : [])
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message && !message.is_system && message.mes)
        .map(({ message, index }) => [messageProvenanceSignature(message), index]));
    let rebased = false;
    const rebasedOwners = [];
    const rebasedRecordKeys = [];
    const normalizedActive = cleanAuFacts(cardProfile.auFacts);
    const normalizedHistory = cleanAuFacts(cardProfile.auHistory).map(fact => ({ ...fact, active: false }));
    for (const fact of [...normalizedActive, ...normalizedHistory]) {
        for (const origin of fact.provenance || []) {
            if (!CHAT_DERIVED_AU_SOURCES.has(origin.source) || !signatureToIndex.has(origin.messageSignature)) continue;
            const nextIndex = signatureToIndex.get(origin.messageSignature);
            if (origin.messageId === nextIndex) continue;
            origin.messageId = nextIndex;
            rebased = true;
            rebasedOwners.push(fact.owner);
            if (fact.ownerRecordKey) rebasedRecordKeys.push(fact.ownerRecordKey);
        }
        if (CHAT_DERIVED_AU_SOURCES.has(fact.source) && signatureToIndex.has(fact.messageSignature)) {
            fact.messageId = signatureToIndex.get(fact.messageSignature);
        }
    }
    cardProfile.auFacts = normalizedActive;
    cardProfile.auHistory = normalizedHistory;
    const rolledBack = rollbackAuFactsByProvenance(cardProfile, origin =>
        CHAT_DERIVED_AU_SOURCES.has(origin.source)
        && (!origin.messageSignature || !signatureToIndex.has(origin.messageSignature)));
    if (rebased && !rolledBack.changed) {
        ensureStructuredAuState(cardProfile, cardProfile.canonDatabase || {});
    }
    return {
        changed: rebased || rolledBack.changed,
        owners: cleanDetectedEntities([...(rolledBack.owners || []), ...rebasedOwners]),
        recordKeys: [...new Set([...(rolledBack.recordKeys || []), ...rebasedRecordKeys])],
    };
}

function ensureAuOwnerRecord(fact, plan, database) {
    if (!fact.owner || fact.kind === 'world_rule') return '';
    const work = fact.work || plan.work || '';
    const existing = findCanonRecordName(fact.owner, database, { kind: fact.kind, work });
    if (existing) return existing;
    const storageName = uniqueCanonStorageKey(fact.owner, work, fact.kind, database);
    database[storageName] = {
        entity: fact.owner,
        kind: fact.kind,
        kindVerified: false,
        aliases: [fact.owner],
        work,
        timeline: plan.timeline || '',
        baselineStatus: 'pending',
        sourceTrust: 'provisional',
        profile: '',
        profileHash: '',
        updatedAt: Date.now(),
        canonChanges: [],
        sources: [],
    };
    return storageName;
}

function novelChangesForRecord(changes, recordName, planEntities, database) {
    const record = database[recordName];
    const ownerIdentity = {
        owner: record?.entity || recordName,
        kind: normalizeEntityKind(record?.kind, 'unknown'),
        work: record?.work || '',
    };
    return cleanAuFacts(changes)
        .filter(fact => sameAuOwnerIdentity(fact, ownerIdentity))
        .map(auFactText)
        .filter(change => !(record?.canonChanges || []).some(saved => changesAreEquivalent(change, saved)));
}

async function persistCanonDeltas(plan, { syncScene = true, syncCanon = true } = {}) {
    if (typeof plan?.freshnessGuard === 'function' && !plan.freshnessGuard()) return [];
    const database = storedCanonEntities();
    const cardProfile = profile();
    if (syncScene || syncCanon) invalidateProfileTransactions(cardProfile);
    const reclassifiedEntities = applyVerifiedEntityKinds(planCanonCandidates(plan), database);
    plan.reclassifiedEntities = cleanDetectedEntities([
        ...(plan.reclassifiedEntities || []), ...reclassifiedEntities,
    ]);
    ensureStructuredAuState(cardProfile, database);
    const sourceTexts = plan.auEvidenceSources || {};
    const sourceAvailability = plan.auEvidenceAvailability || {};
    const activeWorldEntries = plan.auEvidenceWorldEntries;
    const worldEntryStates = plan.auEvidenceWorldEntryStates;
    // Re-reviewing the same assistant message replaces that message's derived
    // event state. Remove its previous proposal first; the freshly revised
    // scene can then re-add only facts that still exist in the final prose.
    const reviewedMessageRollback = plan.messageSignature
        ? rollbackAuFactsByProvenance(cardProfile, origin =>
            origin.source === 'assistant_event'
            && origin.messageSignature === plan.messageSignature)
        : { changed: false, owners: [], recordKeys: [] };
    const externalRollback = rollbackAuFactsByProvenance(cardProfile, (origin, fact) => {
        if (origin.source === 'world_info') {
            if (sourceAvailability.world_info !== true || !Array.isArray(worldEntryStates)) return false;
            const evidence = String(origin.evidence || fact.evidence || '').trim();
            if (origin.worldBook && origin.worldEntryUid) {
                const state = worldEntryStates.find(entry => String(entry?.world || '') === origin.worldBook
                    && String(entry?.uid ?? '') === origin.worldEntryUid);
                if (!state || state.disabled === true) return true;
                // An edited entry keeps its fact only when the supporting text
                // is still present.  Merely not triggering this turn is not a
                // deletion, because enabled inactive entries remain in states.
                return !worldInfoEntryContainsEvidence(state, evidence);
            }
            // Safe migration for old facts without entry ids: distinguish an
            // enabled-but-inactive entry from a disabled/deleted one by looking
            // through every currently selected entry, not only the dry-run set.
            const matches = worldEntryStates.filter(entry => worldInfoEntryContainsEvidence(entry, evidence));
            return !matches.some(entry => entry.disabled !== true);
        }
        if (origin.source !== 'card' || sourceAvailability.card !== true) return false;
        const sourceText = String(sourceTexts[origin.source] || '');
        const evidence = String(origin.evidence || fact.evidence || '').trim();
        return !evidence || (!sourceText.includes(evidence)
            && !normalizeChangeText(sourceText).includes(normalizeChangeText(evidence)));
    });
    const incomingFacts = cleanAuFacts(plan.canonChanges, {
        messageId: plan.messageId,
        messageSignature: plan.messageSignature,
    })
        // ownerRecordKey is an internal storage handle.  Never trust a key
        // supplied by an analysis model, especially in same-name crossovers.
        .map(fact => ({ ...fact, ownerRecordKey: '' }))
        .map(fact => {
            const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
            if (fact.source === 'card' || fact.source === 'world_info') {
                const sourceText = String(sourceTexts[fact.source] || '');
                fact.messageId = null;
                if (fact.source === 'world_info') {
                    const origins = worldInfoOriginsForEvidence(activeWorldEntries, fact.evidence);
                    // When entry metadata is available, a fact must bind to an
                    // actually activated entry.  Do not let the model assign a
                    // sentence from some other source to world_info.
                    if (origins && !origins.length) return null;
                    fact.messageSignature = origins?.[0]?.messageSignature
                        || (sourceText ? `${fact.source}|${textHash(sourceText)}` : '');
                    fact.provenance = cleanAuProvenance(origins, fact);
                } else {
                    fact.messageSignature = sourceText ? `${fact.source}|${textHash(sourceText)}` : '';
                    fact.provenance = cleanAuProvenance(null, fact);
                }
                return fact;
            }
            if (!CHAT_DERIVED_AU_SOURCES.has(fact.source)) return fact;
            if (fact.source === 'assistant_event') {
                const sourceIndex = Number(plan.messageId);
                const sourceMessage = chat[sourceIndex];
                if (!Number.isInteger(sourceIndex) || !sourceMessage || sourceMessage.is_user || sourceMessage.is_system) return null;
                fact.messageId = sourceIndex;
                fact.messageSignature = messageProvenanceSignature(sourceMessage);
                fact.provenance = cleanAuProvenance(null, fact);
                return fact;
            }
            const maximum = Number.isInteger(Number(plan.messageId)) ? Number(plan.messageId) : chat.length;
            const wantsUser = fact.source === 'user';
            let sourceIndex = -1;
            for (let index = Math.min(maximum - 1, chat.length - 1); index >= 0; index--) {
                const message = chat[index];
                if (!message || message.is_system || !message.mes || message.is_user !== wantsUser) continue;
                const text = stripMarkup(message.mes);
                if (fact.evidence && (text.includes(fact.evidence)
                    || normalizeChangeText(text).includes(normalizeChangeText(fact.evidence)))) {
                    sourceIndex = index;
                    break;
                }
            }
            if (sourceIndex < 0) return null;
            const sourceMessage = chat[sourceIndex];
            fact.messageId = sourceIndex;
            fact.messageSignature = messageProvenanceSignature(sourceMessage);
            fact.provenance = cleanAuProvenance(null, fact);
            return fact;
        })
        .filter(Boolean)
        .map(fact => canonicalizeAuFactOwner(fact, database, plan))
        .filter(Boolean)
        .filter(fact => auEvidenceMatches(fact, sourceTexts, database));
    const changedEntities = new Set([
        ...cleanDetectedEntities(plan?.reclassifiedEntities)
            .filter(recordKey => database[recordKey]),
        ...(reviewedMessageRollback.recordKeys || []).filter(recordKey => database[recordKey]),
        ...(reviewedMessageRollback.owners || [])
            .map(owner => findCanonRecordName(owner, database, { work: plan.work || '' })).filter(Boolean),
        ...(externalRollback.recordKeys || []).filter(recordKey => database[recordKey]),
        ...(externalRollback.owners || [])
            .map(owner => findCanonRecordName(owner, database, { work: plan.work || '' })).filter(Boolean),
    ]);
    const timelineChangedEntities = [];
    let factsChanged = reviewedMessageRollback.changed || externalRollback.changed;
    for (const incoming of incomingFacts) {
        const recordName = ensureAuOwnerRecord(incoming, plan, database);
        if (recordName) {
            incoming.ownerRecordKey = recordName;
            incoming.work ||= database[recordName]?.work || plan.work || '';
        }
        const result = upsertActiveAuFact(cardProfile, incoming);
        factsChanged ||= result.changed;
        if (recordName && result.changed) changedEntities.add(recordName);
    }
    ensureStructuredAuState(cardProfile, database);
    const planRecordKeys = new Set(planCanonCandidates(plan)
        .map(candidate => candidateRecordName(candidate, database, plan.work)).filter(Boolean));
    for (const recordName of Object.keys(database)) {
        const record = database[recordName];
        const timelineChanged = plan.timelineChanged
            && planRecordKeys.has(recordName)
            && normalizeChangeText(record.timeline) !== normalizeChangeText(plan.timeline);
        if (!timelineChanged) continue;
        record.timeline = plan.timeline;
        record.profileHash = '';
        record.baselineStatus = record.sources?.length ? 'stale' : record.baselineStatus;
        record.updatedAt = Date.now();
        changedEntities.add(recordName);
        timelineChangedEntities.push(recordName);
    }
    plan.timelineUpdatedEntities = cleanDetectedEntities(timelineChangedEntities);
    if (!changedEntities.size && !factsChanged) return [];
    const needsCanonWorldSync = syncCanon && changedEntities.size > 0;
    const needsSceneWorldSync = syncScene && factsChanged && Boolean(cardProfile.currentScene);
    const needsWorldSync = needsCanonWorldSync || needsSceneWorldSync;
    const syncRevision = needsWorldSync ? markWorldSyncPending(cardProfile) : null;
    saveSettingsDebounced();
    if (needsSceneWorldSync) {
        cardProfile.currentScene.auChanges = relevantAuFactsForNames([
            ...(cardProfile.currentScene.characters || []),
            ...(cardProfile.currentScene.locations || []),
            ...(cardProfile.currentScene.subjects || []),
            ...(cardProfile.currentScene.pinned || []),
        ]).map(auFactText);
    }
    if (needsWorldSync) {
        await repairWorldBookFromLocalState(
            cardProfile, captureScopeToken(), plan.freshnessGuard, syncRevision,
        );
    }
    return [...changedEntities, ...(factsChanged ? ['本卡AU差异'] : [])];
}

async function reconcileWorldInfoAuLifecycle(freshnessGuard = null) {
    const cardProfile = profile();
    const hasWorldInfoFacts = [...cleanAuFacts(cardProfile.auFacts), ...cleanAuFacts(cardProfile.auHistory)]
        .some(fact => (fact.provenance || []).some(origin => origin.source === 'world_info'));
    if (!hasWorldInfoFacts) return false;
    const states = (await getSortedEntries()).map(normalizeWorldInfoEntryState)
        .filter(entry => entry.world && entry.uid && entry.content);
    if (typeof freshnessGuard === 'function' && !freshnessGuard()) return false;
    const changed = await persistCanonDeltas({
        work: cardProfile.workTitle || '',
        timeline: cardProfile.timeline || '',
        entities: [],
        entityCandidates: [],
        canonChanges: [],
        auEvidenceSources: { world_info: '' },
        auEvidenceAvailability: { world_info: true },
        auEvidenceWorldEntries: [],
        auEvidenceWorldEntryStates: states,
        freshnessGuard,
    }, { syncScene: true, syncCanon: true });
    return changed.length > 0;
}

function fandomWorkIdentityMatches(expectedValue, returnedValue) {
    const expected = String(expectedValue || '').normalize('NFKC').toLocaleLowerCase().trim();
    const returned = String(returnedValue || '').normalize('NFKC').toLocaleLowerCase().trim();
    if (!expected || !returned) return false;
    const compact = value => value.replace(/[^\p{L}\p{N}]+/gu, '');
    const a = compact(expected);
    const b = compact(returned);
    if (a && b && a === b) return true;
    const withoutTrailingAcronym = value => value
        .replace(/\s*[（(](?:[a-z]{2,5}|[a-z]{1,4}\d)[)）]\s*$/i, '').trim();
    const acronymA = compact(withoutTrailingAcronym(expected));
    const acronymB = compact(withoutTrailingAcronym(returned));
    if (acronymA && acronymB && acronymA === acronymB) return true;
    // Do not use general substring containment here.  Batman/The Batman and
    // Superman/Superman & Lois are different works despite one title containing
    // the other; genuine translations belong in explicit workAliases.
    return false;
}

function identityEvidenceExplicitlyLinks(evidence, leftValue, rightValue) {
    const text = String(evidence || '');
    const left = String(leftValue || '').trim();
    const right = String(rightValue || '').trim();
    if (!left || !right || !textContainsEntityAlias(text, left)
        || !textContainsEntityAlias(text, right)) return false;
    const lower = text.toLocaleLowerCase();
    const leftAt = lower.indexOf(left.toLocaleLowerCase());
    const rightAt = lower.indexOf(right.toLocaleLowerCase());
    const start = Math.max(0, Math.min(leftAt, rightAt) - 40);
    const end = Math.min(text.length, Math.max(leftAt + left.length, rightAt + right.length) + 40);
    const window = text.slice(start, end);
    if (/(?:不是|并非|不等于|不同(?:作品|人物|角色|实体)?|无关|不属于|不能对应|not\s+(?:the\s+)?same|not\s+an?\s+alias|different|distinct|unrelated)/i.test(window)) return false;
    return /(?:即|就是|同一(?:作品|人物|角色|实体)?|译名|翻译名|别名|又名|原名|英文名|日文名|对应|same|alias|translation|translated|also known as|refers to)/i.test(window);
}

function customPageIdentityIsVerified(page, candidate, plan = {}) {
    if (page?.source !== '自定义搜索 AI' || page?.verified !== true || !candidate) return false;
    if (canonicalEntityKey(page.candidateName) !== canonicalEntityKey(candidate.candidateName)) return false;
    if (candidate.candidateId && page.candidateId !== candidate.candidateId) return false;
    if (String(page.inputWorkHint || '').trim() !== String(candidate.workHint || '').trim()) return false;
    const returnedKind = normalizeEntityKind(page.kind, 'unknown');
    if (!CANON_ENTITY_KINDS.has(returnedKind)) return false;
    const expectedWork = String(candidate.workHint || plan.work || '').trim();
    const returnedWork = String(page.workTitle || '').trim();
    const workIdentityLinked = !expectedWork || fandomWorkIdentityMatches(expectedWork, returnedWork)
        || (returnedWork && identityEvidenceExplicitlyLinks(
            page.identityEvidence, expectedWork, returnedWork,
        ));
    if (!workIdentityLinked) return false;
    const citations = validHttpCitationUrls([...(page.citations || []), page.url]);
    if (!citations.length) return false;
    const identityNames = cleanDetectedEntities([
        page.canonicalName, page.originalName, page.title, ...(page.aliases || []),
    ]);
    if (!identityNames.length || !identityNames.some(name => textContainsEntityAlias(page.extract, name))) return false;
    const candidateKey = canonicalEntityKey(candidate.candidateName);
    const directIdentityLink = identityNames.some(name => canonicalEntityKey(name) === candidateKey);
    const correctedIdentityLink = textContainsEntityAlias(page.extract, candidate.candidateName)
        && identityNames.some(name => textContainsEntityAlias(page.extract, name))
        && identityNames.some(name => identityEvidenceExplicitlyLinks(
            page.identityEvidence, candidate.candidateName, name,
        ));
    if (!directIdentityLink && !correctedIdentityLink) return false;
    return true;
}

async function saveCanonResearch(plan, pages) {
    if (!Array.isArray(pages) || !pages.length
        || (typeof plan?.freshnessGuard === 'function' && !plan.freshnessGuard())) return [];
    const database = storedCanonEntities();
    const cardProfile = profile();
    invalidateProfileTransactions(cardProfile);
    const planEntities = cleanDetectedEntities(plan.entities);
    const planCandidates = planCanonCandidates(plan).map((candidate, index) => ({
        ...candidate,
        candidateId: `${index}:${canonCandidateIdentityKey(candidate)}`,
    }));
    sanitizeCanonDatabase(database);
    const invalidCustomPages = new Set();
    const customPages = pages.filter(page => page?.source === '自定义搜索 AI' && page?.verified === true);
    for (const page of customPages) {
        const sameNameCandidates = planCandidates.filter(item =>
            canonicalEntityKey(item.candidateName) === canonicalEntityKey(page.candidateName));
        const exactCandidate = sameNameCandidates.find(item => page.candidateId
            && page.candidateId === item.candidateId
            && String(page.inputWorkHint || '') === String(item.workHint || ''));
        const candidate = exactCandidate || sameNameCandidates.find(item => {
            const expectedWork = item.workHint || plan.work || '';
            return !expectedWork || fandomWorkIdentityMatches(expectedWork, page.workTitle);
        }) || (sameNameCandidates.length === 1 ? sameNameCandidates[0] : null);
        if (!customPageIdentityIsVerified(page, candidate, plan)) invalidCustomPages.add(page);
    }
    for (let left = 0; left < customPages.length; left++) {
        for (let right = left + 1; right < customPages.length; right++) {
            const a = customPages[left];
            const b = customPages[right];
            if (a.candidateId && a.candidateId === b.candidateId
                && String(a.inputWorkHint || '') === String(b.inputWorkHint || '')) continue;
            const aText = String(a.extract || '').trim();
            const bText = String(b.extract || '').trim();
            const ratio = Math.min(aText.length, bText.length) / Math.max(1, Math.max(aText.length, bText.length));
            if (ratio >= 0.7 && changesAreEquivalent(aText, bText)) {
                invalidCustomPages.add(a);
                invalidCustomPages.add(b);
            }
        }
    }
    const replacements = new Map();
    const modifiedEntities = new Set();
    const planSubjects = planCandidates.length ? planCandidates : planEntities.map(candidateName => ({
        candidateName, kind: 'character', workHint: plan.work || '', isOriginal: false,
    }));
    for (const candidate of planSubjects) {
        const entity = candidate.candidateName;
        if (typeof plan?.freshnessGuard === 'function' && !plan.freshnessGuard()) {
            return cleanDetectedEntities([...modifiedEntities]);
        }
        const matchesEntity = page => {
            if (page?.source === '自定义搜索 AI') {
                return customPageIdentityIsVerified(page, candidate, plan);
            }
            // Ordinary Wiki/web pages inherit the exact candidate identity of
            // the query that produced them.  Alias-only matching would attach
            // both result sets to both records when two works share a name.
            if (page?.candidateId) {
                return page.candidateId === candidate.candidateId
                    && String(page.inputWorkHint || '') === String(candidate.workHint || '')
                    && normalizeEntityKind(page.kind, 'unknown') === normalizeEntityKind(candidate.kind, 'unknown');
            }
            const expectedQuery = canonResearchQuery(candidate, plan.work);
            const actualQuery = String(page?.query || '').trim();
            if (actualQuery === expectedQuery || actualQuery.startsWith(`${expectedQuery}；`)) return true;
            const sameNameCount = planSubjects.filter(item =>
                canonicalEntityKey(item.candidateName) === canonicalEntityKey(candidate.candidateName)
                && normalizeEntityKind(item.kind, 'unknown') === normalizeEntityKind(candidate.kind, 'unknown')).length;
            const expectedWork = String(candidate.workHint || plan.work || '').trim();
            return textContainsEntityAlias(actualQuery, candidate.candidateName)
                && (expectedWork
                    ? textContainsEntityAlias(actualQuery, expectedWork)
                    : sameNameCount === 1);
        };
        const canonicalPage = pages.find(page => page.source === '自定义搜索 AI'
            && page.verified === true && !invalidCustomPages.has(page) && matchesEntity(page));
        const expectedIdentity = { kind: candidate.kind, work: candidate.workHint || plan.work || '' };
        const canonicalName = cleanDetectedEntities([canonicalPage?.canonicalName || canonicalPage?.title])[0]
            || resolveCanonEntityName(entity, database, expectedIdentity);
        const returnedWork = canonicalPage?.workTitle || '';
        const requestedWork = candidate.workHint || plan.work || '';
        const returnedKind = normalizeEntityKind(canonicalPage?.kind, candidate.kind || 'character');
        const previousName = findCanonRecordName(entity, database, expectedIdentity)
            || (returnedWork
                ? findCanonRecordName(canonicalName, database, { kind: returnedKind, work: returnedWork })
                : '');
        const previous = database[previousName];
        const targetWork = previous?.work || requestedWork || returnedWork;
        const storageName = uniqueCanonStorageKey(canonicalName, targetWork, returnedKind, database, previousName);
        const aliases = cleanDetectedEntities([
            entity,
            canonicalName,
            ...recordAliases(previous),
            canonicalPage?.candidateName,
            canonicalPage?.originalName,
            ...(Array.isArray(canonicalPage?.aliases) ? canonicalPage.aliases : []),
        ]);
        const previousSources = Array.isArray(previous?.sources) ? previous.sources : [];
        const relevant = pages
            .filter(page => page.source === '自定义搜索 AI'
                ? (page.verified === true && !invalidCustomPages.has(page) && matchesEntity(page))
                : matchesEntity(page))
            .map(page => ({
            ...page,
            title: page.source === '自定义搜索 AI' ? canonicalName : page.title,
            extract: extractEntitySpecificText(page.extract, canonicalName, planEntities, aliases),
        })).filter(page => page.extract && ([
            page.title,
            page.extract,
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
        const newChanges = novelChangesForRecord(plan.canonChanges, previousName || storageName, planEntities, database);
        const targetWorkAliases = [...new Set([
            ...recordWorkAliases(previous), requestedWork, returnedWork,
        ].map(String).map(value => value.trim()).filter(Boolean))];
        const identitySources = mergedSources.filter(source => {
            const text = `${source.title || ''}\n${source.extract || ''}`;
            const namesMatch = aliases.some(alias => textContainsEntityAlias(text, alias));
            const workMatch = !targetWork || textContainsEntityAlias(text, targetWork);
            return namesMatch && workMatch;
        });
        const trustedWiki = identitySources.some(source => /(?:wikipedia|专属 wiki)/i.test(String(source.source || ''))
            && aliases.some(alias => canonicalEntityKey(alias) === canonicalEntityKey(source.title)));
        // URLs typed inside the model's JSON are claims, not proof that its web
        // tool actually opened those pages.  Only provider-side citation
        // metadata (or pages fetched directly by this plugin, such as Wiki)
        // can promote a custom result to verified.
        const independentSites = new Set(validHttpCitationUrls(relevant.flatMap(source =>
            Array.isArray(source.trustedCitations) ? source.trustedCitations : [],
        )).map(citationSiteKey).filter(Boolean));
        const sourceTrust = previous?.sourceTrust === 'verified'
            || trustedWiki || independentSites.size >= 2
            ? 'verified' : 'provisional';
        const directProfileMixed = canonicalPage && containsForeignEntityDossier(
            canonicalPage.extract, canonicalName, [...planEntities, ...aliases],
        );
        const directProfile = candidate.researchMode !== 'official_delta'
            && canonicalPage?.verified === true && !directProfileMixed
            ? String(extractEntitySpecificText(
                canonicalPage.extract, canonicalName, planEntities, aliases,
            )).trim() : '';
        const directProfileUsable = directProfile.length >= 40
            && sourceTrust === 'verified'
            && aliases.some(alias => textContainsEntityAlias(directProfile, alias));
        const baselineStatus = directProfileUsable
            ? sourceTrust : (relevant.length ? 'stale' : (previous?.baselineStatus || sourceTrust));
        const nextRecord = {
            entity: canonicalName,
            kind: returnedKind,
            kindVerified: (previous?.kindVerified === true
                && normalizeEntityKind(previous?.kind, 'unknown') === returnedKind)
                || (sourceTrust === 'verified' && canonicalPage?.verified === true
                    && CANON_ENTITY_KINDS.has(returnedKind)),
            aliases,
            work: targetWork,
            workAliases: targetWorkAliases.filter(value => !fandomWorkIdentityMatches(value, targetWork)),
            timeline: plan.timeline || previous?.timeline || '',
            profile: directProfileUsable ? directProfile : (previous?.profile || ''),
            profileHash: directProfileUsable ? '' : (previous?.profileHash || ''),
            profileFormatVersion: directProfileUsable
                ? CANON_PROFILE_FORMAT_VERSION : (previous?.profileFormatVersion || 0),
            profileAttemptHash: directProfileUsable ? '' : (previous?.profileAttemptHash || ''),
            profileAttemptedAt: directProfileUsable ? 0 : (Number(previous?.profileAttemptedAt) || 0),
            baselineStatus,
            sourceTrust,
            worldSyncedAt: Number(previous?.worldSyncedAt) || 0,
            updatedAt: previous?.updatedAt || Date.now(),
            canonChanges: [...new Set([
                ...(Array.isArray(previous?.canonChanges) ? previous.canonChanges : []),
                ...newChanges,
            ].map(String).filter(Boolean))],
            sources: mergedSources,
        };
        if (directProfileUsable) nextRecord.profileHash = canonProfileHash(nextRecord);
        const previousComparable = previous ? { ...previous, updatedAt: 0 } : null;
        const nextComparable = { ...nextRecord, updatedAt: 0 };
        const recordChanged = previousName !== storageName
            || JSON.stringify(previousComparable) !== JSON.stringify(nextComparable);
        if (recordChanged) {
            nextRecord.updatedAt = Date.now();
            if (previousName && previousName !== storageName) delete database[previousName];
            database[storageName] = nextRecord;
            modifiedEntities.add(storageName);
        }
        replacements.set(entity, canonicalName);
    }
    if (replacements.size) {
        const replace = values => cleanDetectedEntities(values.map(name => replacements.get(name) || resolveCanonEntityName(name, database)));
        plan.entities = replace(plan.entities);
        if (Array.isArray(plan.autoEntities)) plan.autoEntities = replace(plan.autoEntities);
        cardProfile.entities = replace(manualEntities(cardProfile.entities)).join('，');
        cardProfile.lastAutoEntities = replace(Array.isArray(cardProfile.lastAutoEntities) ? cardProfile.lastAutoEntities : []);
        ensureStructuredAuState(cardProfile, database);
    }
    if (modifiedEntities.size) {
        const syncRevision = markWorldSyncPending(cardProfile);
        saveSettingsDebounced();
        // The durable database already changed.  Even if the originating scene
        // became stale in this exact turn, retain a pending full repair instead
        // of leaving the world book silently behind.
        if (typeof plan?.freshnessGuard === 'function' && !plan.freshnessGuard()) {
            return cleanDetectedEntities([...modifiedEntities]);
        }
        await repairWorldBookFromLocalState(
            cardProfile, captureScopeToken(), plan.freshnessGuard, syncRevision,
        );
    }
    return cleanDetectedEntities([...modifiedEntities]);
}

function loadCanonResearch(plan) {
    const database = storedCanonEntities();
    const pages = [];
    for (const candidate of planCanonCandidates(plan)) {
        const recordName = candidateRecordName(candidate, database, plan.work);
        const record = database[recordName];
        if (!record || !Array.isArray(record.sources)) continue;
        for (const source of record.sources) {
            pages.push({
                ...source,
                source: `本卡资料库 / ${source.source || '原始来源'}`,
                query: candidate.candidateName,
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
    return cleanDetectedEntities(missingCanonCandidates(plan).map(candidate => candidate.candidateName));
}

function missingCanonCandidates(plan) {
    const database = storedCanonEntities();
    return planCanonCandidates(plan).filter(candidate => {
        const recordName = candidateRecordName(candidate, database, plan.work);
        const record = database[recordName];
        if (!recordName || (!record?.sources?.length && !record?.profile)) return true;
        return settings().strictMode && record.sourceTrust !== 'verified';
    });
}

function usableCanonEntities(plan) {
    const database = storedCanonEntities();
    return cleanDetectedEntities(planCanonCandidates(plan).filter(candidate =>
        recordHasUsableBaseline(database[candidateRecordName(candidate, database, plan.work)]))
        .map(candidate => candidate.candidateName));
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
        formatVersion: CANON_PROFILE_FORMAT_VERSION,
        kind: normalizeEntityKind(record?.kind, 'unknown'),
        timeline: String(record?.timeline || ''),
        sources: (Array.isArray(record?.sources) ? record.sources : [])
            .map(source => `${source?.title || ''}|${source?.extract || ''}`),
    }));
}

const PROFILE_RETRY_MINUTES = 10;

function canonProfileNeedsRefresh(record, now = Date.now()) {
    if (!record?.sources?.length) return false;
    const hash = canonProfileHash(record);
    if (record.profile && record.profileHash === hash
        && record.profileFormatVersion === CANON_PROFILE_FORMAT_VERSION) return false;
    if (record.profileAttemptHash === hash
        && now - (Number(record.profileAttemptedAt) || 0) < PROFILE_RETRY_MINUTES * 60 * 1000) return false;
    return true;
}

function canonProfileMaterial(record, maxChars = 3200) {
    const sources = (Array.isArray(record?.sources) ? record.sources : [])
        .map(source => `${source?.title || '资料'}：${String(source?.extract || '').trim()}`)
        .filter(text => text.replace(/^.*?：/, '').trim());
    const parts = [];
    const maximum = Math.max(800, Number(maxChars) || 3200);
    const compactExcerpt = (value, allowance) => {
        const text = String(value || '').trim();
        const limit = Math.max(12, allowance);
        if (text.length <= limit) return text;
        const head = Math.max(5, Math.floor((limit - 1) * 0.6));
        return `${text.slice(0, head)}…${text.slice(-(limit - head - 1))}`;
    };

    const profile = String(record?.profile || '').trim();
    const profileAllowance = profile ? Math.min(900, Math.floor(maximum * 0.28)) : 0;
    if (profileAllowance) {
        parts.push(`现有基线（保留未被新资料推翻的事实）：${compactExcerpt(profile, profileAllowance)}`);
    }
    // Give every stored source a slice of this compression request.  Hashing
    // all sources while omitting a middle group would mark unseen facts as
    // permanently processed; equal allocation keeps both old identity pages
    // and newly appended official deltas visible without extra API calls.
    const sourceBudget = Math.max(100, maximum - parts.join('\n').length - 1);
    const perSource = sources.length
        ? Math.max(20, Math.floor((sourceBudget - (sources.length * 10)) / sources.length)) : 0;
    for (let index = 0; index < sources.length; index++) {
        parts.push(`资料${index + 1}：${compactExcerpt(sources[index], perSource)}`);
    }
    return parts.join('\n');
}

async function ensureCanonProfiles(plan) {
    const scopeToken = captureScopeToken();
    const cardProfile = profile();
    const isFresh = () => typeof plan?.freshnessGuard !== 'function' || plan.freshnessGuard();
    if (!isFresh()) return [];
    const database = storedCanonEntities();
    const pending = [];
    for (const candidate of planCanonCandidates(plan)) {
        const recordName = candidateRecordName(candidate, database, plan.work);
        const record = database[recordName];
        if (!canonProfileNeedsRefresh(record)) continue;
        pending.push({ recordName, record, hash: canonProfileHash(record) });
    }
    if (!pending.length) return [];

    const limited = pending.slice(0, 8);
    const tasks = limited.map(({ recordName, record }) => ({
        id: recordName,
        name: record.entity,
        kind: normalizeEntityKind(record.kind, 'character'),
        work: record.work || plan.work || '',
        timeline: record.timeline || plan.timeline || '',
        requiredFields: researchFieldsForKind(record.kind),
    }));
    const materialSections = limited.map(({ recordName, record }) =>
        `【ID:${recordName}｜${record.entity}｜${record.work || '作品未确认'}】\n${canonProfileMaterial(record)}`);
    const prompt = `你是原作设定编辑，把检索材料压缩成正文模型直接可用的“原著基线档案”。对象可能是人物、地点、物品、能力、组织、事件或世界规则。每个对象必须单独处理，只能写材料明确支持的事实；不能混入其他对象的整份资料，不能写本卡 AU、来源、网址或引用编号。按对象 requiredFields 覆盖真正有材料的项目，不要求凑字段。时间线过滤：当前节点之后才发生的经历、关系变化、身份揭露、能力变化、物品归属变化、地点毁损、伤亡、秘密及事件结果一律不写；“用户原创世界”只保留不依赖原作剧情进度的固有基线。文本紧凑但要足够用于准确写作，不设字符截断。\n\n对象（JSON）：\n${JSON.stringify(tasks)}\n\n各对象原始资料：\n${materialSections.join('\n\n')}\n\n只输出完整 JSON：{"profiles":[{"id":"逐字回填对象 id","profile":"以该对象 name 开头的单对象原著基线档案"}]}。同名对象也必须按不同 id 分开。`;

    try {
        updateReport('分析模型正在按当前时间线压缩通用原作档案…');
        const parsed = await runJsonAnalysisPrompt(prompt, 4200, isFresh);
        if (!scopeTokenIsCurrent(scopeToken) || !isFresh()) return [];
        const profiles = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
        const byKey = new Map(profiles.map(item => [String(item?.id || ''), String(item?.profile || '').trim()]));
        const invalidProfileKeys = new Set();
        const profileEntries = [...byKey.entries()].filter(([, text]) => text.length >= 40);
        for (let left = 0; left < profileEntries.length; left++) {
            for (let right = left + 1; right < profileEntries.length; right++) {
                const [aKey, aText] = profileEntries[left];
                const [bKey, bText] = profileEntries[right];
                const ratio = Math.min(aText.length, bText.length) / Math.max(aText.length, bText.length);
                if (ratio >= 0.7 && changesAreEquivalent(aText, bText)) {
                    invalidProfileKeys.add(aKey);
                    invalidProfileKeys.add(bKey);
                }
            }
        }
        const updated = [];
        const attemptedAt = Date.now();
        const committable = limited.filter(({ recordName, record, hash }) =>
            database[recordName] === record && canonProfileHash(record) === hash);
        if (!committable.length) return [];
        invalidateProfileTransactions(cardProfile);
        for (const { recordName, record, hash } of committable) {
            const text = byKey.get(recordName) || '';
            const mentionsSelf = recordAliases(record, record.entity)
                .some(alias => normalizeChangeText(text).includes(normalizeChangeText(alias)));
            const foreignEntities = limited
                .filter(item => item.recordName !== recordName)
                .flatMap(item => recordAliases(item.record, item.recordName));
            const containsForeignDossier = containsForeignEntityDossier(
                text, record.entity, foreignEntities,
            );
            if (text.length >= 40 && mentionsSelf
                && !containsForeignDossier && !invalidProfileKeys.has(recordName)) {
                record.profile = text;
                record.profileHash = hash;
                record.profileFormatVersion = CANON_PROFILE_FORMAT_VERSION;
                record.profileAttemptHash = '';
                record.profileAttemptedAt = 0;
                record.baselineStatus = record.sourceTrust === 'verified' ? 'verified' : 'provisional';
                updated.push(recordName);
            } else {
                // A syntactically valid but unusable response (wrong key, empty,
                // duplicated across entities, or missing the entity itself) is
                // still a failed attempt.  Remember the exact source/timeline
                // hash so every following message cannot hammer the analysis API.
                record.profileAttemptHash = hash;
                record.profileAttemptedAt = attemptedAt;
            }
        }
        const syncRevision = updated.length ? markWorldSyncPending(cardProfile) : null;
        saveSettingsDebounced();
        if (!isFresh()) return [];
        if (updated.length) {
            await repairWorldBookFromLocalState(
                cardProfile, scopeToken, isFresh, syncRevision,
            );
        }
        return updated;
    } catch (error) {
        if (!scopeTokenIsCurrent(scopeToken) || !isFresh()) return [];
        console.warn('[Fandom Canon] Profile compression failed; falling back to raw extracts.', error);
        const attemptedAt = Date.now();
        const committable = limited.filter(({ recordName, record, hash }) =>
            database[recordName] === record && canonProfileHash(record) === hash);
        if (!committable.length) return [];
        invalidateProfileTransactions(cardProfile);
        for (const { record, hash } of committable) {
            record.profileAttemptHash = hash;
            record.profileAttemptedAt = attemptedAt;
        }
        saveSettingsDebounced();
        return [];
    }
}

const REVIEW_SKIP_TYPES = new Set(['quiet', 'impersonate']);
const reviewedMessageSignatures = new Set();

function recordHasUsableBaseline(record) {
    if (!record) return false;
    if (settings().strictMode
        && (record.baselineStatus !== 'verified' || record.sourceTrust !== 'verified')) return false;
    return Boolean(canonBaselineText(record));
}

function canonBaselineText(record) {
    if (record?.profileFormatVersion === CANON_PROFILE_FORMAT_VERSION && String(record.profile || '').trim()) {
        return String(record.profile).trim();
    }
    return (record?.sources || [])
        .map(source => extractEntitySpecificText(source.extract, record.entity))
        .filter(Boolean)
        .join('\n\n')
        .trim();
}

function textContainsEntityAlias(text, alias) {
    const body = String(text ?? '').toLocaleLowerCase();
    const needle = String(alias ?? '').toLocaleLowerCase().trim();
    if (!body || needle.length < 2) return false;
    if (!/^[a-z0-9 _.'-]+$/i.test(needle)) return body.includes(needle);
    let start = body.indexOf(needle);
    while (start >= 0) {
        const before = start > 0 ? body[start - 1] : '';
        const after = body[start + needle.length] || '';
        if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) return true;
        start = body.indexOf(needle, start + 1);
    }
    return false;
}

function relevantCanonRecords(text, database = storedCanonEntities()) {
    const body = String(text ?? '');
    if (!body) return [];
    return Object.values(database)
        .filter(record => recordHasUsableBaseline(record))
        .map(record => ({
            record,
            position: Math.min(...recordAliases(record, record.entity)
                .filter(alias => textContainsEntityAlias(body, alias))
                .map(alias => body.toLocaleLowerCase().indexOf(alias.toLocaleLowerCase()))),
        }))
        .filter(item => Number.isFinite(item.position))
        .sort((a, b) => a.position - b.position)
        .map(item => item.record);
}

function canonRecordStorageKey(record, database = storedCanonEntities()) {
    return Object.entries(database).find(([, saved]) => saved === record)?.[0] || '';
}

function disambiguateMentionedCanonRecords(text, records, preferredRecords = [], expectedWork = '') {
    const body = String(text || '');
    const candidates = records.filter((record, index, array) => array.findIndex(other =>
        canonRecordIdentityKey(other) === canonRecordIdentityKey(record)) === index);
    const aliasesByRecord = new Map(candidates.map(record => [record, new Set(recordAliases(record, record.entity)
        .filter(alias => textContainsEntityAlias(body, alias)).map(canonicalEntityKey))]));
    const preferredKeys = new Set(preferredRecords.map(canonRecordIdentityKey));
    const visited = new Set();
    const selected = [];
    for (const record of candidates) {
        if (visited.has(record)) continue;
        const component = [];
        const queue = [record];
        visited.add(record);
        while (queue.length) {
            const current = queue.shift();
            component.push(current);
            const currentAliases = aliasesByRecord.get(current) || new Set();
            for (const other of candidates) {
                if (visited.has(other)) continue;
                const otherAliases = aliasesByRecord.get(other) || new Set();
                if ([...currentAliases].some(alias => otherAliases.has(alias))) {
                    visited.add(other);
                    queue.push(other);
                }
            }
        }
        if (component.length === 1) {
            selected.push(component[0]);
            continue;
        }
        const preferred = component.filter(item => preferredKeys.has(canonRecordIdentityKey(item)));
        if (preferred.length) {
            selected.push(...preferred);
            continue;
        }
        const scoped = expectedWork ? component.filter(item => recordWorkAliases(item)
            .some(work => fandomWorkIdentityMatches(expectedWork, work))) : [];
        if (scoped.length === 1) selected.push(scoped[0]);
        // Multiple same-name/same-alias records without one current-scene/work
        // identity are intentionally omitted.  Mixing both baselines is worse
        // than making no claim until the scene analysis supplies a workHint.
    }
    return selected;
}

function currentOriginalSceneKeys(cardProfile = profile()) {
    return new Set(cleanCanonSubjectCandidates([
        ...(Array.isArray(cardProfile.currentScene?.entities) ? cardProfile.currentScene.entities : []),
        ...(Array.isArray(cardProfile.currentScene?.subjectEntities) ? cardProfile.currentScene.subjectEntities : []),
    ]).filter(candidate => candidate.isOriginal)
        .map(candidate => canonicalEntityKey(candidate.candidateName)));
}

function recordMatchesAnyEntityKey(record, keys) {
    return recordAliases(record, record?.entity)
        .some(alias => keys.has(canonicalEntityKey(alias)));
}

function currentSceneCanonRecords(cardProfile = profile(), database = storedCanonEntities()) {
    const sceneCandidates = cleanCanonSubjectCandidates([
        ...(Array.isArray(cardProfile.currentScene?.entities) ? cardProfile.currentScene.entities : []),
        ...(Array.isArray(cardProfile.currentScene?.subjectEntities) ? cardProfile.currentScene.subjectEntities : []),
    ]);
    const originalKeys = currentOriginalSceneKeys(cardProfile);
    const records = sceneCandidates.filter(candidate => !candidate.isOriginal).map(candidate =>
        database[candidateRecordName(candidate, database, cardProfile.workTitle)]).filter(Boolean);
    const legacyNames = cleanDetectedEntities([
        ...(cardProfile.currentScene?.characters || []),
        ...(cardProfile.currentScene?.locations || []),
        ...(cardProfile.currentScene?.subjects || []),
        ...(cardProfile.currentScene?.pinned || []),
    ]);
    for (const name of legacyNames) {
        if (originalKeys.has(canonicalEntityKey(name))) continue;
        const recordName = findCanonRecordName(name, database, { work: cardProfile.workTitle || '' });
        if (recordName && database[recordName]) records.push(database[recordName]);
    }
    return records.filter((record, index, array) => array.findIndex(other =>
        canonRecordIdentityKey(other) === canonRecordIdentityKey(record)) === index);
}

function currentSceneRecordNames(cardProfile = profile()) {
    const records = currentSceneCanonRecords(cardProfile);
    const originalKeys = currentOriginalSceneKeys(cardProfile);
    return cleanDetectedEntities([
        ...records.map(record => record.entity),
        ...(cardProfile.currentScene?.characters || []),
        ...(cardProfile.currentScene?.locations || []),
        ...(cardProfile.currentScene?.subjects || []),
        ...(cardProfile.currentScene?.pinned || []),
    ]).filter(name => !originalKeys.has(canonicalEntityKey(name)));
}

function recordsForReview(text, database = storedCanonEntities()) {
    const active = currentSceneCanonRecords(profile(), database).filter(recordHasUsableBaseline);
    const originalKeys = currentOriginalSceneKeys(profile());
    const mentioned = disambiguateMentionedCanonRecords(
        text,
        relevantCanonRecords(text, database),
        active,
        profile().workTitle || '',
    ).filter(record => !recordMatchesAnyEntityKey(record, originalKeys));
    const records = [...mentioned, ...active]
        .filter((record, index, array) => array.findIndex(other => other === record
            || canonRecordIdentityKey(other) === canonRecordIdentityKey(record)) === index);
    const selected = [];
    let budget = 0;
    for (const record of records) {
        const size = canonBaselineText(record).length;
        if (selected.length && budget + Math.min(size, 1500) > 10000) continue;
        selected.push(record);
        budget += Math.min(size, 1500);
    }
    return selected;
}

function relevantAuFactsForNames(names, text = '', identity = {}) {
    const keys = new Set(cleanDetectedEntities(names).map(canonicalEntityKey));
    const body = String(text || '');
    const database = storedCanonEntities();
    const recordKeys = new Set((Array.isArray(identity?.recordKeys) ? identity.recordKeys : [])
        .map(String).filter(Boolean));
    const expectedWorks = cleanDetectedEntities([
        ...(Array.isArray(identity?.works) ? identity.works : []),
        identity?.work,
        recordKeys.size ? '' : profile().workTitle,
    ]);
    return activeAuFacts().filter(fact => {
        const exactOwnerRecord = Boolean(fact.ownerRecordKey && recordKeys.has(fact.ownerRecordKey));
        const factWorks = [...new Set([
            String(fact.work || '').trim(),
            ...recordWorkAliases(database[fact.ownerRecordKey]),
        ].filter(Boolean))];
        if (!exactOwnerRecord && expectedWorks.length && factWorks.length
            && !expectedWorks.some(work => factWorks.some(factWork =>
                fandomWorkIdentityMatches(work, factWork)))) return false;
        if (fact.kind === 'world_rule') return true;
        if (keys.has(canonicalEntityKey(fact.owner))) {
            if (!fact.ownerRecordKey || !recordKeys.size || recordKeys.has(fact.ownerRecordKey)) return true;
        }
        if (cleanDetectedEntities(fact.participants)
            .some(name => keys.has(canonicalEntityKey(name)))) return true;
        return (fact.owner && textContainsEntityAlias(body, fact.owner)
                && (!fact.ownerRecordKey || !recordKeys.size || recordKeys.has(fact.ownerRecordKey)))
            || cleanDetectedEntities(fact.participants).some(name => textContainsEntityAlias(body, name));
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
    const plain = stripMarkup(text);
    const strongSegments = plain.split(/(?<=[。！？!?\n])/)
        .filter(segment => /(?:现在|当前|此时|本轮|时间(?:设定|节点)?|故事发生|剧情发生|截至|设定为)/.test(segment));
    const shortDirect = plain.length <= 32 && new RegExp(`^\\s*${EXPLICIT_TIME_ANCHOR_SOURCE}\\s*$`).test(plain)
        ? [plain] : [];
    const matches = [...[...strongSegments, ...shortDirect].join('\n').matchAll(new RegExp(EXPLICIT_TIME_ANCHOR_SOURCE, 'g'))];
    return normalizeExplicitTimeAnchor(matches.at(-1)?.[0] || '');
}

function explicitTimelineDirectiveFromText(text) {
    const plain = stripMarkup(text);
    const segments = plain.split(/(?<=[。！？!?])/).map(value => value.trim()).filter(Boolean);
    for (const segment of segments.reverse()) {
        if (/(?:回忆|想起|记得|曾经|当年|往事|提起|谈起|讲述|档案|历史|录像|梦境|做梦|如果|假如|倘若)/.test(segment)) continue;
        const direct = segment.match(/(?:把|将)?(?:当前|现在)?(?:的)?(?:时间线|剧情线|剧情节点|故事节点|篇章|阶段)\s*(?:推进|切换|设定|调整|改(?:到|为)?|移动|回到|来到|定在)\s*(?:到|为|至|在)?\s*([^，。！？!?]{2,100})/i);
        const currentEvent = segment.match(/(?:现在|当前|本轮)(?:时间线|剧情|故事)?(?:是|处于|来到|位于)\s*([^，。！？!?]{2,100}?(?:结束后|开始前|期间|阶段|篇章|结局后|事件后))/i);
        const target = String(direct?.[1] || currentEvent?.[1] || '').trim()
            .replace(/(?:再|然后)?(?:继续)?(?:写|续写|开始)(?:正文|剧情)?$/i, '').trim();
        if (!target || !/(?:结束后|开始前|期间|阶段|篇章|结局后|事件后|大战|战役|事件|纪元|时代|第.{0,8}[章节幕部季])/i.test(target)) continue;
        return { target: target.slice(0, 120), evidence: segment.slice(0, 180) };
    }
    return null;
}

function timelineAnchorRank(value) {
    const match = String(value || '').match(new RegExp(EXPLICIT_TIME_ANCHOR_SOURCE));
    if (!match) return null;
    const anchor = normalizeExplicitTimeAnchor(match[0]);
    const yearText = anchor.match(/^(?:\d{3,4}|[〇○零一二三四五六七八九]{3,4})/)?.[0] || '';
    const digitMap = { '〇': '0', '○': '0', '零': '0', '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };
    const year = Number([...yearText].map(char => digitMap[char] ?? char).join(''));
    if (!Number.isFinite(year)) return null;
    const month = Number(anchor.match(/(\d{1,2})月/)?.[1])
        || ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[anchor.match(/([一二三四五六七八九十])月/)?.[1]])
        || 0;
    let phase = month || 6;
    if (/年初|年春|春季|上半年/.test(anchor)) phase = 2;
    if (/年中|夏季/.test(anchor)) phase = 6;
    if (/秋季|下半年/.test(anchor)) phase = 9;
    if (/年底|年末|年尾|冬季|深冬|冬末/.test(anchor)) phase = 12;
    if (/上旬/.test(anchor)) phase -= 0.2;
    if (/下旬/.test(anchor)) phase += 0.2;
    return year * 20 + phase;
}

function timelineMovesBackward(previousTimeline, nextAnchor) {
    const previous = timelineAnchorRank(previousTimeline);
    const next = timelineAnchorRank(nextAnchor);
    return previous != null && next != null && next < previous;
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
    const text = String(body ?? '');
    const candidates = [...text.matchAll(sameYearExpression)]
        .filter(match => normalizeExplicitTimeAnchor(match[0]) !== anchor)
        .filter(match => match.index < 320
            || /(?:现在|当前|此时|时间|日期|NE-BANNER)[\s\S]{0,28}$/.test(text.slice(Math.max(0, match.index - 40), match.index)));
    return candidates.slice(0, 1)
        .map(match => ({
            original: match[0],
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
        _fcrExplicitTimeAnchor: anchor,
        timelineChanged: scene?.timelineChanged === true
            || normalizeChangeText(timeline) !== normalizeChangeText(profile().timeline),
        summary: textWithExplicitTimeAnchor(scene?.summary || '', anchor),
    };
}

function sceneWithExplicitTimelineDirective(scene, directive) {
    if (!directive?.target) return scene || {};
    return {
        ...(scene || {}),
        timeline: directive.target,
        timelineChanged: normalizeChangeText(directive.target)
            !== normalizeChangeText(profile().timeline),
        timelineEvidence: directive.evidence,
        _fcrExplicitTimelineDirective: directive,
        summary: String(scene?.summary || '').trim(),
    };
}

function balancedExcerpt(value, maxChars) {
    const text = String(value || '');
    if (text.length <= maxChars) return text;
    const head = Math.floor(maxChars * 0.58);
    const tail = maxChars - head;
    return `${text.slice(0, head)}\n…（中段仅因本轮审核上下文预算省略，资料库原文未删除）…\n${text.slice(-tail)}`;
}

function buildReviewPrompt(body, records, recent, overrideContext = {}, allowReview = true) {
    const cardProfile = profile();
    const database = storedCanonEntities();
    const currentMessageSignature = String(overrideContext?.reviewMessageSignature || '');
    const allRelevantFacts = relevantAuFactsForNames([
        ...records.map(record => record.entity),
        ...currentSceneRecordNames(cardProfile),
    ], body, {
        recordKeys: records.map(record => canonRecordStorageKey(record, database)).filter(Boolean),
        works: records.map(record => record.work).filter(Boolean),
    }).filter(fact => {
        if (fact.source !== 'assistant_event' || !currentMessageSignature) return true;
        if (fact.messageSignature === currentMessageSignature) return false;
        return !(fact.provenance || []).some(origin => origin.source === 'assistant_event'
            && origin.messageSignature === currentMessageSignature);
    });
    const relevantFacts = [];
    let reviewFactBudget = 5000;
    for (const fact of [...allRelevantFacts].sort((a, b) =>
        ((AU_SOURCE_PRIORITY[b.source] || 0) - (AU_SOURCE_PRIORITY[a.source] || 0))
        || ((Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)))) {
        const size = Math.min(800, auFactText(fact).length);
        if (size > reviewFactBudget) continue;
        relevantFacts.push(fact);
        reviewFactBudget -= size;
    }
    const profiles = records.map(record => {
        const text = balancedExcerpt(canonBaselineText(record), 1500);
        const recordIdentity = {
            owner: record.entity,
            ownerRecordKey: canonRecordStorageKey(record, database),
            kind: record.kind,
            work: record.work,
        };
        const changes = relevantFacts.filter(fact => sameAuOwnerIdentity(fact, recordIdentity));
        return `【${record.entity}｜${entityKindLabel(record.kind)}｜${record.work || '作品未确认'}】\n原著基线：${text}${changes.length ? `\n本卡当前差异：${changes.map(fact => balancedExcerpt(auFactText(fact), 800)).join('；')}` : ''}`;
    }).join('\n\n');
    let reviewRule = allowReview && records.length
        ? `逐项核对正文实际涉及且下方有档案的原作实体：人物检查正式姓名/译名、身份年龄、外貌服装、性格与说话逻辑、能力限制、经历、关系和知识边界；地点检查名称、地理、外观布局、所属、进入条件和当前状态；物品检查外观、来源、持有者、功能、条件、限制和状态；能力检查机制、表现、范围、代价、限制和当前可用性；组织、事件与世界规则检查其原作核心事实。只修正有明确档案证据、且未被角色卡/用户/启用世界书/已确认AU覆盖的冲突。通常只替换最短连续原文，不改变剧情目标、登场对象、角色意图、对白轮次或场景顺序；但档案若明确证明某个能力、物品或世界机制不可能产生正文所写的局部结果，必须把该动作的最小结果片段改为机制上成立的结果，不得新增事件或扩写剧情。拿不准必须 pass。`
        : '本轮没有可执行审核档案；verdict 必须为 pass，revisions 必须为空。';
    reviewRule += ' canonChanges 若是关系、归属、转移或多人共同状态，另输出 participants 数组，只列除 owner 外需要用这条差异进行索引的具体对象；事实仍只归 owner 一份，绝不能复制到每个参与者档案。每项 canonChanges 必须输出 work（owner 实际所属作品）；跨作品同名且无法确认 work 时必须省略，不能猜测归属。facet 必须细分到具体对象与属性，例如 relationship.幻视.恋爱、item.时间宝石.ownership、ability.混沌魔法.availability、appearance.hair，不能只写 relationship、item_state、ability 或 appearance_state。';
    return `你是同人正文的原作事实审核与场景状态整理器，不是编剧。一次完成四项工作，不能建议、预测、补写或推进后续剧情。scene 与 canonChanges 必须描述“revisions 已经应用后的最终正文”，避免把待修错误写进数据库。\n\n一、currentEntities 是正文结束瞬间仍在场/直接参与互动的有名人物，以及当前具体地点；kind 仅 character/location。换场或离场要移除旧项，未明确变化则延续旧快照。NE-BANNER 的地点、时段和人物优先。\n\n二、canonSubjects 是本轮正文中实际出现、使用、施展、抵达或被断言具体原作事实的所有对象，即使它在本轮结束前已离场；支持 character/location/item/ability/organization/event/world_rule。仅被闲谈、回忆但没有任何具体事实需要审核的对象不要加入。逐个判断 isOriginal；原创对象不外搜。\n\n三、AU 候选只能来自强证据：角色卡(card)、用户明确陈述(user)、本轮实际启用世界书(world_info)、此前剧情已明确建立的状态(prior_context)，或本轮正文中具有明确动作—结果、确实改变了状态的在场事件(assistant_event)。助手对姓名、外貌、性格、关系、物品归属、能力或原著历史的一次静态断言绝不能当 AU；应先按原著审核。assistant_event 必须 eventChanged=true 且 evidence 是正文逐字短句。每项用唯一 owner、细粒度稳定 facet；同属性新状态用同一 facet，并在 replaces 写旧状态。\n\n四、${reviewRule}\n\n角色卡、用户明确指示、启用世界书和已确认当前AU高于原著。档案没写的细节不构成冲突。错名在同一正文重复出现时可令 replaceAll=true；除此之外 replaceAll=false。original 必须逐字复制最短原文。timelineChanged=true 时 timelineEvidence 必须逐字摘录本轮正文中已经发生的跨篇章、跨重大事件或明确年月变化；普通对话、换地点和自然时间流逝必须留空。\n\n只输出完整 JSON：{"scene":{"sceneComplete":true,"workTitle":"当前作品","storyType":"canon_timeline|au_timeline|original_world_with_fandom_characters|original_only|unknown","timeline":"当前时间线/节点","timelineChanged":false,"timelineEvidence":"节点确已改变时的正文逐字短句，否则空字符串","summary":"修订后正文结束时的状态","canonChanges":[{"entity":"唯一归属对象","work":"owner实际所属作品","kind":"character|location|item|ability|organization|event|world_rule","facet":"稳定细粒度属性键","canon":"原著状态；未知留空","current":"本卡当前状态","source":"card|user|world_info|prior_context|assistant_event","evidence":"对应来源中的逐字短句","participants":["除owner外的关联对象"],"eventChanged":false,"replaces":["被替换的旧状态原文"]}],"currentEntities":[{"candidateName":"当前人物或地点","kind":"character|location","isOriginal":false,"workHint":"所属作品","evidence":"当前在场证据"}],"canonSubjects":[{"candidateName":"本轮实际涉及的具体原作对象","kind":"character|location|item|ability|organization|event|world_rule","isOriginal":false,"workHint":"所属作品","evidence":"正文中的具体涉及证据"}]},"verdict":"pass|conflict","revisions":[{"original":"最短连续原文","revised":"只修正事实的对应短片段","entity":"对象名","aspect":"冲突属性","reason":"档案支持的简短原因","replaceAll":false}]}。\n\n当前作品：${cardProfile.workTitle || '未填写'}\n当前时间线：${cardProfile.timeline || '未填写'}\n当前有效AU：${relevantFacts.map(fact => balancedExcerpt(auFactText(fact), 800)).join('；') || '无'}\n上一轮当前场景：${currentSceneRecordNames(cardProfile).join('、') || '无'}\n\n角色卡优先设定：\n${balancedExcerpt(overrideContext.card || '未读取到', 5000)}\n\n本轮实际启用世界书：\n${balancedExcerpt(overrideContext.worldInfo || '无', 5000)}\n\n可用于审核的原著档案：\n${profiles || '无'}\n\n此前剧情：\n${balancedExcerpt(recent || '无', 3000)}\n\n待处理正文：\n${balancedExcerpt(body, 18000)}`;
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
    const canonAliasSanitizations = [];
    for (const [databaseName, record] of Object.entries(database)) {
        if (!Array.isArray(record?.aliases)) continue;
        const ownKeys = new Set([databaseName, record.entity].map(canonicalEntityKey).filter(Boolean));
        const aliases = record.aliases.filter(alias => {
            const key = canonicalEntityKey(alias);
            return !userNameKeys.has(key) || ownKeys.has(key);
        });
        if (aliases.length === record.aliases.length) continue;
        sanitizedCanonEntities.push(databaseName);
        canonAliasSanitizations.push({ recordName: databaseName, aliases });
    }
    const characterCandidates = banner.characters.map(name => {
        const model = modelCandidates.find(candidate => canonicalEntityKey(candidate.candidateName) === canonicalEntityKey(name));
        const isUserName = userNameKeys.has(canonicalEntityKey(name));
        const recordName = isUserName ? '' : findCanonRecordName(name, database, {
            kind: 'character',
            work: model?.workHint || scene?.workTitle || cardProfile.workTitle || '',
        });
        return {
            candidateName: recordName ? (database[recordName]?.entity || name) : name,
            kind: 'character',
            // A banner proves presence, not fandom identity.  Unknown names
            // fail closed as original until structured analysis or an existing
            // canon record identifies them.
            isOriginal: isUserName || (model ? model.isOriginal === true : !recordName),
            workHint: model?.workHint || (recordName ? database[recordName]?.work : '') || '',
            evidence: model?.contextEvidence || `场景横幅当前人物：${name}`,
        };
    });
    const locationModel = modelCandidates.find(candidate => candidate.kind === 'location'
        && canonicalEntityKey(candidate.candidateName) === canonicalEntityKey(banner.location));
    const locationRecordName = banner.location && !locationModel
        ? findCanonRecordName(banner.location, database, {
            kind: 'location', work: scene?.workTitle || cardProfile.workTitle || '',
        }) : '';
    const locationCandidate = banner.location ? [{
        candidateName: locationRecordName
            ? (database[locationRecordName]?.entity || banner.location) : banner.location,
        kind: 'location',
        isOriginal: locationModel ? locationModel.isOriginal === true : !locationRecordName,
        workHint: locationModel?.workHint
            || (locationRecordName ? database[locationRecordName]?.work : '')
            || String(scene?.workTitle || cardProfile.workTitle || ''),
        evidence: `场景横幅当前地点：${banner.location}`,
    }] : [];
    let timeline = String(scene?.timeline || cardProfile.timeline || '').trim();
    let timelineChanged = scene?.timelineChanged === true;
    let sceneClockChanged = scene?.sceneClockChanged === true;
    const currentTimeline = String(cardProfile.timeline || '').trim();
    const oldTime = currentTimeline.match(/清晨|早晨|上午|中午|午后|下午|傍晚|黄昏|夜晚|深夜/)?.[0] || '';
    if (banner.time && oldTime && banner.time !== oldTime && (!timeline || normalizeChangeText(timeline) === normalizeChangeText(currentTimeline))) {
        timeline = currentTimeline.replace(oldTime, banner.time);
        sceneClockChanged = true;
    }
    const elapsedEvidence = `${recent}\n${stripMarkup(body)}`;
    if (timeline && /(?:比起|距离).{0,6}(?:几天前|数日前)|(?:几天|数日)后|a few days (?:ago|later)/i.test(elapsedEvidence)
        && /后的(?:清晨|早晨|上午|中午|午后|下午|傍晚|黄昏|夜晚|深夜)/.test(timeline)
        && !/数日后|几天后/.test(timeline)) {
        timeline = timeline.replace(/后的(清晨|早晨|上午|中午|午后|下午|傍晚|黄昏|夜晚|深夜)/, `数日后的${banner.time || '$1'}`);
        sceneClockChanged = true;
    }
    return {
        ...(scene || {}),
        sceneComplete: true,
        timeline,
        timelineChanged,
        sceneClockChanged,
        summary: String(scene?.summary || banner.summary || '').trim(),
        currentEntities: [...characterCandidates, ...locationCandidate],
        canonSubjects: cleanCanonSubjectCandidates([
            ...(Array.isArray(scene?.canonSubjects) ? scene.canonSubjects : []),
            ...characterCandidates,
            ...locationCandidate,
        ]),
        sanitizedCanonEntities,
        canonAliasSanitizations,
    };
}

function canonTimelineCore(value) {
    return normalizeChangeText(String(value || '')
        .replace(/(?:数日|几天|若干天|一两天|次日|翌日)(?:之后|以后|后)?/g, '')
        .replace(/清晨|早晨|上午|中午|午后|下午|傍晚|黄昏|夜晚|深夜|白天|日间/g, ''));
}

function sceneTimelineEvidenceIsValid(scene) {
    if (scene?.timelineChanged !== true) return false;
    const evidence = String(scene?.timelineEvidence || '').trim();
    const body = stripMarkup(scene?._fcrFinalBody || '');
    if (evidence.length < 2 || !body.includes(evidence)) return false;
    const at = body.indexOf(evidence);
    const sentenceStart = Math.max(
        body.lastIndexOf('。', at - 1), body.lastIndexOf('！', at - 1),
        body.lastIndexOf('？', at - 1), body.lastIndexOf('\n', at - 1),
    ) + 1;
    const endings = ['。', '！', '？', '\n'].map(mark => body.indexOf(mark, at + evidence.length))
        .filter(index => index >= 0);
    const sentenceEnd = endings.length ? Math.min(...endings) + 1 : body.length;
    const sentence = body.slice(sentenceStart, sentenceEnd);
    if (/(?:回忆|想起|记得|曾经|当年|往事|提起|谈起|讲述|档案|历史|录像|梦境|做梦|如果|假如|倘若|recalled|remembered|flashback|if\b)/i.test(sentence)) return false;
    return /(?:\d{4}\s*年|年初|年底|月份|春季|夏季|秋季|冬季|数月后|数年后|多年后|篇章|阶段|时代|战役|大战|事件).{0,24}(?:开始|结束|发生|过去|完成|落幕|爆发|进入|跨过|跨越|之后|以前)|(?:开始|结束|完成|经历|跨过|跨越|进入).{0,24}(?:篇章|阶段|时代|战役|大战|事件)/i.test(evidence);
}

function scenePlanFromAnalysis(scene) {
    const cardProfile = profile();
    const database = storedCanonEntities();
    const manualWorkLocked = Boolean(cardProfile.workTitle)
        && cardProfile.workTitle !== cardProfile.lastAutoWorkTitle;
    const manualTimelineLocked = Boolean(cardProfile.timeline)
        && cardProfile.timeline !== cardProfile.lastAutoTimeline;
    const explicitTimeAnchor = normalizeExplicitTimeAnchor(scene?._fcrExplicitTimeAnchor || '');
    const explicitTimelineDirective = scene?._fcrExplicitTimelineDirective?.target
        ? scene._fcrExplicitTimelineDirective : null;
    const evidencedTimelineChange = Boolean(explicitTimelineDirective) || sceneTimelineEvidenceIsValid(scene);
    const work = String(manualWorkLocked
        ? cardProfile.workTitle : (scene?.workTitle || cardProfile.workTitle || '')).trim();
    const finalBody = String(scene?._fcrFinalBody || '');
    const finalBodyPlain = stripMarkup(finalBody);
    const previousSceneKeys = new Set(cleanDetectedEntities([
        ...(cardProfile.currentScene?.characters || []),
        ...(cardProfile.currentScene?.locations || []),
        ...(Array.isArray(cardProfile.currentScene?.entities)
            ? cardProfile.currentScene.entities.map(item => item?.candidateName) : []),
    ]).map(canonicalEntityKey));
    const candidateGroundedInBody = candidate => {
        if (!finalBody) return true;
        if (textContainsEntityAlias(finalBody, candidate.candidateName)
            || textContainsEntityAlias(finalBodyPlain, candidate.candidateName)) return true;
        const evidence = String(candidate.contextEvidence || '').trim();
        return previousSceneKeys.has(canonicalEntityKey(candidate.candidateName))
            && evidence.length >= 2
            && (finalBody.includes(evidence) || finalBodyPlain.includes(evidence));
    };
    const candidates = cleanSceneEntityCandidates(scene?.currentEntities)
        .filter(candidateGroundedInBody);
    const allCurrentEntities = cleanDetectedEntities(candidates
        .map(candidate => candidate.isOriginal
            ? normalizeEntityDisplay(candidate.candidateName)
            : resolveCanonEntityName(candidate.candidateName, database, {
                kind: candidate.kind, work: candidate.workHint || work,
            })));
    const subjectGroundedInBody = candidate => {
        if (!finalBody) return true;
        if (textContainsEntityAlias(finalBody, candidate.candidateName)
            || textContainsEntityAlias(finalBodyPlain, candidate.candidateName)) return true;
        const evidence = String(candidate.contextEvidence || '').trim();
        // Evidence such as “她继续喝咖啡” cannot prove that a model-selected
        // Batman was present.  A correction/alias still has to quote the input
        // proper name itself; pure pronouns never create research subjects.
        return evidence.length >= 2
            && textContainsEntityAlias(evidence, candidate.candidateName)
            && (finalBody.includes(evidence) || finalBodyPlain.includes(evidence));
    };
    const canonSubjects = cleanCanonSubjectCandidates([
        ...(Array.isArray(scene?.canonSubjects) ? scene.canonSubjects : []),
        ...candidates,
    ]).filter(candidate => candidateHasCanonIdentity(candidate, database, work)
        && subjectGroundedInBody(candidate));
    const canonEntities = cleanDetectedEntities(canonSubjects
        .map(candidate => resolveCanonEntityName(candidate.candidateName, database, {
            kind: candidate.kind, work: candidate.workHint || work,
        })));
    const missingCandidates = canonSubjects.filter(candidate => {
        const recordName = candidateRecordName(candidate, database, work);
        return !recordName || (!database[recordName]?.sources?.length && !database[recordName]?.profile);
    });
    const missingEntities = cleanDetectedEntities(missingCandidates.map(candidate => candidate.candidateName));
    const queries = missingCandidates.map(candidate => canonResearchQuery(candidate, work));
    const proposedTimeline = String(explicitTimelineDirective?.target || (explicitTimeAnchor
        ? timelineWithExplicitAnchor(scene?.timeline || cardProfile.timeline, explicitTimeAnchor)
        : (manualTimelineLocked && !evidencedTimelineChange
            ? cardProfile.timeline : (scene?.timeline || cardProfile.timeline || '')))).trim();
    const anyTimelineDifference = Boolean(proposedTimeline)
        && normalizeChangeText(proposedTimeline) !== normalizeChangeText(cardProfile.timeline);
    const timelineChanged = (explicitTimeAnchor || explicitTimelineDirective || evidencedTimelineChange)
        && anyTimelineDifference
        && canonTimelineCore(proposedTimeline) !== canonTimelineCore(cardProfile.timeline);
    const sceneClockChanged = (!manualTimelineLocked && scene?.sceneClockChanged === true)
        || (anyTimelineDifference && !timelineChanged
            && canonTimelineCore(proposedTimeline) === canonTimelineCore(cardProfile.timeline));
    return {
        work,
        timeline: (timelineChanged || sceneClockChanged)
            ? proposedTimeline : cardProfile.timeline.trim(),
        entities: canonEntities,
        autoEntities: allCurrentEntities,
        entityCandidates: canonSubjects,
        canonChanges: cleanAuFacts(scene?.canonChanges, { work }),
        timelineChanged,
        sceneClockChanged,
        replaceAutoEntities: scene?.sceneComplete === true,
        researchMode: missingEntities.length ? 'new_entities' : 'none',
        queries: cleanPlannedQueries(queries, work).slice(0, settings().maxQueries),
        sceneCandidates: candidates,
        canonSubjects,
        sanitizedCanonEntities: cleanDetectedEntities(
            Array.isArray(scene?.sanitizedCanonEntities) ? scene.sanitizedCanonEntities : [],
        ),
        canonAliasSanitizations: (Array.isArray(scene?.canonAliasSanitizations)
            ? scene.canonAliasSanitizations : []).map(item => ({
            recordName: String(item?.recordName || ''),
            aliases: cleanDetectedEntities(item?.aliases),
        })).filter(item => item.recordName),
    };
}

function buildCurrentSceneSnapshot(scene, plan, pinned, messageId, body) {
    const database = storedCanonEntities();
    const candidates = cleanSceneEntityCandidates(plan.sceneCandidates || scene?.currentEntities)
        .map(candidate => {
            const knownRecord = candidateRecordName(candidate, database, plan.work || '');
            const preserveLiteral = candidate.isOriginal === true
                || (candidate.isOriginal !== false && !knownRecord);
            return {
                ...candidate,
                candidateName: preserveLiteral
                    ? normalizeEntityDisplay(candidate.candidateName)
                    : resolveCanonEntityName(candidate.candidateName, database, {
                        kind: candidate.kind, work: candidate.workHint || plan.work || '',
                    }),
            };
        });
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
    const subjectEntities = cleanCanonSubjectCandidates(plan.canonSubjects).map(candidate => ({
        ...candidate,
        candidateName: resolveCanonEntityName(candidate.candidateName, database, {
            kind: candidate.kind, work: candidate.workHint || plan.work || '',
        }),
    }));
    const subjects = cleanDetectedEntities([
        ...subjectEntities.map(candidate => candidate.candidateName),
        ...cleanDetectedEntities(plan.entities),
    ]);
    const relevantRecords = planCanonCandidates(plan)
        .map(candidate => database[candidateRecordName(candidate, database, plan.work)])
        .filter(Boolean);
    const auChanges = relevantAuFactsForNames([...characters, ...locations, ...pinned], body, {
        recordKeys: relevantRecords.map(record => canonRecordStorageKey(record, database)).filter(Boolean),
        works: relevantRecords.map(record => record.work).filter(Boolean),
    })
        .filter(fact => fact.kind === 'world_rule' || !fact.ownerRecordKey)
        .map(auFactText);
    return {
        workTitle: plan.work || profile().workTitle || '',
        timeline: plan.timeline || profile().timeline || '',
        summary: stripMarkup(scene?.summary || '').trim().slice(0, 2000),
        characters,
        locations,
        subjects,
        pinned: cleanDetectedEntities(pinned)
            .filter(name => !characters.includes(name) && !locations.includes(name)),
        auChanges,
        entities: candidates,
        subjectEntities,
        messageId: Number(messageId),
        messageSignature: String(plan.messageSignature || ''),
        messageHash: textHash(body),
        updatedAt: Date.now(),
    };
}

async function syncDynamicSceneState(scene, scopeToken, reviewTarget = null) {
    const freshnessGuard = typeof reviewTarget?.freshnessGuard === 'function'
        ? reviewTarget.freshnessGuard : () => true;
    if (!scopeTokenIsCurrent(scopeToken) || !freshnessGuard()) return { aborted: true };
    const plan = scenePlanFromAnalysis(scene);
    plan.freshnessGuard = freshnessGuard;
    plan.messageId = reviewTarget?.messageId;
    plan.messageSignature = reviewTarget?.messageSignature || '';
    plan.auEvidenceSources = reviewTarget?.auEvidenceSources || {};
    plan.auEvidenceAvailability = reviewTarget?.auEvidenceAvailability || {};
    plan.auEvidenceWorldEntries = reviewTarget?.auEvidenceWorldEntries;
    plan.auEvidenceWorldEntryStates = reviewTarget?.auEvidenceWorldEntryStates;
    const cardProfile = profile();
    const transactionEpoch = invalidateProfileTransactions(cardProfile);
    const previousProfileState = captureTrackedProfileState(cardProfile);
    const previousRecordTimelines = Object.fromEntries(planCanonCandidates(plan).flatMap(candidate => {
        const recordName = candidateRecordName(candidate, storedCanonEntities(), plan.work);
        const record = storedCanonEntities()[recordName];
        return recordName && record ? [[recordName, {
            kind: String(record.kind || 'unknown'),
            kindVerified: record.kindVerified === true,
            timeline: String(record.timeline || ''),
            profile: String(record.profile || ''),
            profileHash: String(record.profileHash || ''),
            profileFormatVersion: Number(record.profileFormatVersion) || 0,
            profileAttemptHash: String(record.profileAttemptHash || ''),
            profileAttemptedAt: Number(record.profileAttemptedAt) || 0,
            baselineStatus: String(record.baselineStatus || ''),
            sourceTrust: String(record.sourceTrust || ''),
            updatedAt: Number(record.updatedAt) || 0,
        }]] : [];
    }));
    const transactionState = structuredClone({
        workTitle: cardProfile.workTitle,
        timeline: cardProfile.timeline,
        entities: cardProfile.entities,
        lastAutoWorkTitle: cardProfile.lastAutoWorkTitle,
        lastAutoTimeline: cardProfile.lastAutoTimeline,
        lastAutoEntities: cardProfile.lastAutoEntities,
        canonDatabase: cardProfile.canonDatabase,
        auFacts: cardProfile.auFacts,
        auHistory: cardProfile.auHistory,
        auChanges: cardProfile.auChanges,
        currentScene: cardProfile.currentScene,
        sceneHistory: cardProfile.sceneHistory,
        worldSyncPending: cardProfile.worldSyncPending,
    });
    const assertTransactionFresh = () => {
        if (profileTransactionEpochs.get(cardProfile) === transactionEpoch
            && scopeTokenIsCurrent(scopeToken) && freshnessGuard()) return;
        throw Object.assign(new Error('场景版本已切换，当前事务已取消'), { fcrCancelled: true });
    };
    try {
    for (const sanitization of plan.canonAliasSanitizations || []) {
        const record = storedCanonEntities()[sanitization.recordName];
        if (!record || !Array.isArray(record.aliases)) continue;
        const allowedKeys = new Set(cleanDetectedEntities(sanitization.aliases).map(canonicalEntityKey));
        const aliases = record.aliases.filter(alias => allowedKeys.has(canonicalEntityKey(alias)));
        if (aliases.length === record.aliases.length) continue;
        record.aliases = aliases;
        record.updatedAt = Date.now();
    }
    const before = cardProfile.entities;
    const previousAutoKeys = new Set(cleanDetectedEntities(cardProfile.lastAutoEntities).map(canonicalEntityKey));
    const pinned = manualEntities(cardProfile.entities)
        .filter(entity => !previousAutoKeys.has(canonicalEntityKey(entity)));
    syncProfileFromPlan(plan);
    const changed = before !== profile().entities;
    const canonChangedEntities = await persistCanonDeltas(plan, { syncScene: false, syncCanon: false });
    assertTransactionFresh();
    const snapshot = buildCurrentSceneSnapshot(scene, plan, pinned, reviewTarget?.messageId, reviewTarget?.body || '');
    snapshot.previousProfileState = previousProfileState;
    snapshot.previousRecordTimelines = previousRecordTimelines;
    const previousScene = cardProfile.currentScene;
    if (previousScene?.messageSignature && previousScene.messageSignature !== snapshot.messageSignature) {
        cardProfile.sceneHistory = [...(cardProfile.sceneHistory || []), structuredClone(previousScene)].slice(-30);
    }
    cardProfile.currentScene = snapshot;
    const syncRevision = markWorldSyncPending(cardProfile);
    let worldBookChanged = false;
    let worldBookCompleted = false;
    assertTransactionFresh();
    const timelineUpdatedEntities = cleanDetectedEntities(plan.timelineUpdatedEntities);
    if (plan.timelineChanged && plan.timeline) {
        const relatedRecordKeys = new Set(planCanonCandidates(plan)
            .map(candidate => candidateRecordName(candidate, storedCanonEntities(), plan.work))
            .filter(Boolean));
        for (const [recordName, record] of Object.entries(storedCanonEntities())) {
            if (!relatedRecordKeys.has(recordName)) continue;
            if (!record?.entity || record.timeline === plan.timeline) continue;
            record.timeline = plan.timeline;
            record.profileHash = '';
            record.baselineStatus = record.sources?.length ? 'stale' : record.baselineStatus;
            record.updatedAt = Date.now();
            timelineUpdatedEntities.push(recordName);
        }
    }
    worldBookCompleted = await repairWorldBookFromLocalState(
        cardProfile, scopeToken, freshnessGuard, syncRevision,
    );
    worldBookChanged = worldBookCompleted;
    assertTransactionFresh();
    if (!plan.timelineChanged) {
        const profileRefreshCandidates = planCanonCandidates(plan).filter(candidate => {
            const recordName = candidateRecordName(candidate, storedCanonEntities(), plan.work);
            const record = storedCanonEntities()[recordName];
            return canonProfileNeedsRefresh(record);
        });
        if (profileRefreshCandidates.length) {
            const refreshPlan = {
                ...plan,
                entities: cleanDetectedEntities(profileRefreshCandidates.map(candidate => candidate.candidateName)),
                entityCandidates: profileRefreshCandidates,
            };
            ensureCanonProfiles(refreshPlan).then(updated => {
                if (updated.length && freshnessGuard() && reviewTarget
                    && isLatestAssistantMessage(reviewTarget.messageId)) {
                    scheduleMessageReview(reviewTarget.messageId, reviewTarget.type, {
                        delayMs: 300,
                        force: true,
                        reason: '实体档案完成时间线过滤后复核正文',
                    });
                }
            }).catch(error => {
                if (freshnessGuard()) console.warn('[Fandom Canon] Entity profile refresh deferred.', error);
            });
        }
    }
    const previouslyReviewedKeys = new Set(Array.isArray(reviewTarget?.reviewedRecordKeys)
        ? reviewTarget.reviewedRecordKeys.map(String) : []);
    const newlyRelevantStoredRecords = planCanonCandidates(plan)
        .map(candidate => candidateRecordName(candidate, storedCanonEntities(), plan.work))
        .filter(recordName => recordName && !previouslyReviewedKeys.has(recordName)
            && recordHasUsableBaseline(storedCanonEntities()[recordName]));
    if (newlyRelevantStoredRecords.length && reviewTarget && isLatestAssistantMessage(reviewTarget.messageId)) {
        scheduleMessageReview(reviewTarget.messageId, reviewTarget.type, {
            delayMs: 250,
            force: true,
            reason: '场景识别出已有原作档案后复核正文',
        });
    }
    const missingCandidates = missingCanonCandidates(plan);
    const missingEntities = cleanDetectedEntities(missingCandidates.map(candidate => candidate.candidateName));
    const database = storedCanonEntities();
    const deltaCandidates = timelineUpdatedEntities.map(recordName => ({
        candidateName: database[recordName]?.entity || recordName,
        kind: normalizeEntityKind(database[recordName]?.kind, 'character'),
        workHint: database[recordName]?.work || plan.work || '',
        contextEvidence: `当前时间线已明确切换为：${plan.timeline}`,
        researchMode: 'official_delta',
    }));
    const newCandidates = missingCandidates.map(candidate => ({
        ...candidate,
        researchMode: 'new_entities',
    }));
    // One scene owns one aggregate query budget.  Interleave new objects with
    // timeline deltas so neither branch can independently burst maxQueries.
    let sceneResearchBudget = Math.max(1, clampInt(settings().maxQueries, 1, 10, 3));
    const selectedResearchCandidates = [];
    const researchQueues = [newCandidates, deltaCandidates]
        .map(values => [...values].filter((candidate, index, array) => array.findIndex(other =>
            canonCandidateIdentityKey(other) === canonCandidateIdentityKey(candidate)) === index));
    while (sceneResearchBudget > 0 && researchQueues.some(queue => queue.length)) {
        for (const queue of researchQueues) {
            if (!queue.length || sceneResearchBudget <= 0) continue;
            const candidate = queue.shift();
            if (selectedResearchCandidates.some(saved =>
                canonCandidateIdentityKey(saved) === canonCandidateIdentityKey(candidate))) continue;
            selectedResearchCandidates.push(candidate);
            sceneResearchBudget -= 1;
        }
    }
    if (scopeTokenIsCurrent(scopeToken) && freshnessGuard() && selectedResearchCandidates.length) {
        const previouslyMissingKeys = new Set(newCandidates.map(canonCandidateIdentityKey));
        const hasNewResearch = selectedResearchCandidates.some(candidate => candidate.researchMode === 'new_entities');
        const hasDeltaResearch = selectedResearchCandidates.some(candidate => candidate.researchMode === 'official_delta');
        const researchPlan = {
            ...plan,
            entities: cleanDetectedEntities(selectedResearchCandidates.map(candidate => candidate.candidateName)),
            entityCandidates: selectedResearchCandidates,
            researchMode: hasNewResearch && hasDeltaResearch
                ? 'mixed' : (hasNewResearch ? 'new_entities' : 'official_delta'),
            queries: selectedResearchCandidates.map(candidate => candidate.researchMode === 'official_delta'
                ? `${canonResearchQuery(candidate, plan.work)}；只核实截至“${plan.timeline}”已经成立的状态与变化`
                : canonResearchQuery(candidate, plan.work)),
        };
        startCanonEnrichment(researchPlan).then(async pages => {
            if (!scopeTokenIsCurrent(scopeToken) || !freshnessGuard()) return;
            const updated = await ensureCanonProfiles(researchPlan);
            if (!scopeTokenIsCurrent(scopeToken) || !freshnessGuard()) return;
            const refreshedDatabase = storedCanonEntities();
            const acceptedCount = Array.isArray(pages.acceptedEntities)
                ? pages.acceptedEntities.length : 0;
            const newlyUsable = planCanonCandidates(researchPlan).filter(candidate =>
                previouslyMissingKeys.has(canonCandidateIdentityKey(candidate))
                && recordHasUsableBaseline(refreshedDatabase[candidateRecordName(candidate, refreshedDatabase, plan.work)]));
            updateReport(acceptedCount
                ? `当前场景已更新；${hasNewResearch ? '新对象' : ''}${hasNewResearch && hasDeltaResearch ? '及' : ''}${hasDeltaResearch ? '时间线' : ''}资料已写入 ${acceptedCount} 个对象（检索返回 ${pages.length} 条）`
                : `当前场景已更新；检索返回 ${pages.length} 条，但没有资料通过对象、作品与来源校验，未写入世界书`, researchPlan, pages);
            if ((newlyUsable.length || updated.length) && reviewTarget && isLatestAssistantMessage(reviewTarget.messageId)) {
                scheduleMessageReview(reviewTarget.messageId, reviewTarget.type, {
                    delayMs: 500,
                    force: true,
                    reason: '新对象或时间线档案真正可用后复核正文',
                });
            }
        }).catch(error => {
            if (!scopeTokenIsCurrent(scopeToken)) return;
            const message = error?.message || String(error);
            console.error('[Fandom Canon] Scene enrichment failed.', error);
            setSceneSyncState({
                status: 'error',
                signature: '',
                messageId: reviewTarget?.messageId,
                error: `增量资料检索失败：${message}`,
            });
            updateReport(`当前场景已写入；增量资料检索已暂停并记录，稍后随新剧情或手动核验再试：${message}`, researchPlan);
        });
    }
    return {
        plan, changed, worldBookChanged, worldBookCompleted, snapshot,
        missingEntities, timelineUpdatedEntities, canonChangedEntities,
    };
    } catch (error) {
        const ownsTransaction = profileTransactionEpochs.get(cardProfile) === transactionEpoch;
        let rollbackRevision = null;
        if (ownsTransaction) {
            Object.assign(cardProfile, structuredClone(transactionState));
            // worldSyncRevision is deliberately not part of transactionState:
            // it is a monotonic ownership token and must never roll backwards.
            rollbackRevision = markWorldSyncPending(cardProfile);
        }
        if (ownsTransaction && scopeTokenIsCurrent(scopeToken)) {
            try {
                await repairWorldBookFromLocalState(
                    cardProfile, scopeToken, null, rollbackRevision,
                );
            } catch (rollbackError) {
                cardProfile.worldSyncPending = true;
                scheduleWorldBookRepair(cardProfile, scopeToken, rollbackRevision);
                console.error('[Fandom Canon] Could not restore the previous world-book transaction.', rollbackError);
            }
        } else if (ownsTransaction) {
            // The old book cannot be safely opened through helpers while a
            // different chat is current.  Mark it for an identity-scoped full
            // resync as soon as that profile is opened again.
            cardProfile.worldSyncPending = true;
        }
        if (ownsTransaction) saveSettingsDebounced();
        if (error?.fcrCancelled) return { aborted: true };
        throw error;
    }
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
        const replaceEveryName = revision?.replaceAll === true
            && /(?:name|姓名|名字|译名|正式名)/i.test(String(revision?.aspect ?? revision?.reason ?? ''))
            && original.length <= 80 && revised.length <= 80;
        if (firstIndex < 0 || (!isTimelineRevision && !replaceEveryName && updated.lastIndexOf(original) !== firstIndex)) continue;
        if (original.length > 600 || revised.length > 600) continue;
        const maximumLength = Math.max(original.length * 2, original.length + 120);
        if (revised.length > maximumLength) continue;
        updated = isTimelineRevision || replaceEveryName
            ? updated.replaceAll(original, revised)
            : updated.replace(original, () => revised);
        applied.push({
            original,
            revised,
            entity: String(revision?.entity ?? '').trim(),
            aspect: String(revision?.aspect ?? '').trim(),
            reason: String(revision?.reason ?? '').trim(),
            replaceAll: revision?.replaceAll === true,
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

function modelRevisionIsGrounded(revision, body, records) {
    const entityKey = canonicalEntityKey(revision?.entity);
    const record = (Array.isArray(records) ? records : []).find(item =>
        recordAliases(item, item?.entity).some(alias => canonicalEntityKey(alias) === entityKey));
    if (!record) return false;
    const original = String(revision?.original || '').trim();
    const revised = String(revision?.revised || '').trim();
    const aspect = String(revision?.aspect || revision?.reason || '').trim();
    if (!original || !revised) return false;
    const aliases = recordAliases(record, record.entity);
    if (/(?:name|姓名|名字|译名|正式名)/i.test(aspect)) {
        return aliases.some(alias => canonicalEntityKey(alias) === canonicalEntityKey(revised));
    }
    if (!/(?:身份|年龄|种族|职业|外貌|身材|发色|发型|服装|穿着|性格|态度|行为逻辑|立场|阵营|能力|魔法|技能|力量|机制|限制|代价|范围|关系|恋爱|亲属|朋友|敌人|经历|记忆|生死|死亡|复活|物品|装备|武器|归属|持有|地点|位置|组织|事件|identity|appearance|personality|ability|power|relationship|history|experience|item|location|organization)/i.test(aspect)) return false;
    const source = String(body || '');
    const at = source.indexOf(original);
    if (at < 0) return false;
    const starts = ['。', '！', '？', '!', '?', '\n'].map(mark => source.lastIndexOf(mark, at - 1));
    const start = Math.max(...starts) + 1;
    const endings = ['。', '！', '？', '!', '?', '\n'].map(mark => source.indexOf(mark, at + original.length))
        .filter(index => index >= 0);
    const end = endings.length ? Math.min(...endings) + 1 : source.length;
    const sentence = source.slice(start, end);
    if (!aliases.some(alias => textContainsEntityAlias(sentence, alias))) return false;
    if (/(?:经历|历史|事件|experience|history)/i.test(aspect)
        && !/(?:曾|从未|过去|此前|当年|出生|加入|退出|担任|成为|获得|失去|学会|掌握|死亡|复活|经历|记忆|失忆|拥有|持有|\d{3,4}年|formerly|previously|once|never|joined|became|died|revived)/i.test(`${original}\n${revision?.reason || ''}`)) return false;
    return true;
}

function messageProvenanceSignature(message, body = message?.mes) {
    const stableTime = String(message?.send_date ?? message?.gen_started ?? message?.gen_finished ?? '');
    return `${stableTime}|${textHash(String(body ?? ''))}`;
}

function setSceneSyncState(state) {
    const cardProfile = profile();
    cardProfile.sceneSync = {
        status: String(state.status || 'idle'),
        signature: String(state.signature ?? cardProfile.sceneSync?.signature ?? ''),
        messageId: Number.isFinite(Number(state.messageId)) ? Number(state.messageId) : (cardProfile.sceneSync?.messageId ?? null),
        updatedAt: Date.now(),
        error: String(state.error || ''),
        retryCount: Number.isFinite(Number(state.retryCount))
            ? Number(state.retryCount) : Number(cardProfile.sceneSync?.retryCount || 0),
        nextRetryAt: Number.isFinite(Number(state.nextRetryAt))
            ? Number(state.nextRetryAt) : Number(cardProfile.sceneSync?.nextRetryAt || 0),
        allowStopped: state.allowStopped === true
            || (state.allowStopped === undefined && cardProfile.sceneSync?.allowStopped === true),
        formatVersion: SCENE_SYNC_FORMAT_VERSION,
    };
    saveSettingsDebounced();
    renderReport();
}

async function reviewGeneratedMessage(messageId, type, options = {}) {
    const config = settings();
    // Explicit manual recognition/verification owns the shared analysis and
    // world-book lane.  Do not let a 15-second patrol wake a second automatic
    // reviewer behind it and recreate duplicate requests/429 races.
    if (busy) return false;
    if (REVIEW_SKIP_TYPES.has(String(type ?? ''))) return false;
    const trackScene = config.enabled && config.autoUpdateProfile;
    if (!trackScene && !config.reviewEnabled) return false;
    const taskGenerationEpoch = Number.isFinite(Number(options.generationEpoch))
        ? Number(options.generationEpoch) : foregroundGenerationEpoch;
    if (taskGenerationEpoch !== foregroundGenerationEpoch
        || (!options.allowStopped && stoppedGenerationEpoch === taskGenerationEpoch)) return false;
    await ensureConversationScope();
    // Scope cleanup can await world-book I/O.  A stop or a new generation may
    // happen during that gap before this review owns an epoch/controller, so
    // repeat every launch guard before starting analysis.
    if (busy || taskGenerationEpoch !== foregroundGenerationEpoch
        || (!options.allowStopped && stoppedGenerationEpoch === taskGenerationEpoch)
        || isPageGenerating()) return false;
    const scopeToken = captureScopeToken();
    const context = getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const index = Number(messageId);
    const message = chat[index];
    if (!message || message.is_user || message.is_system) return false;
    const body = String(message.mes ?? '');
    if (body.trim().length < 2) return false;
    const signature = sceneMessageSignature(index, body);
    const flightKey = `${scopeIdentity()}|${index}`;
    const flightEpoch = reviewEpochs.get(flightKey) || 0;
    const swipeId = Number.isInteger(message.swipe_id) ? message.swipe_id : -1;
    const force = options.force === true;
    if (options.allowHistorical !== true && chat.slice(index + 1)
        .some(item => item?.mes && !item.is_system)) return false;
    const savedSync = profile().sceneSync || {};
    if (!force && (reviewedMessageSignatures.has(signature)
        || (savedSync.status === 'synced'
            && savedSync.signature === signature
            && savedSync.formatVersion === SCENE_SYNC_FORMAT_VERSION))) return true;
    if (inFlightSceneReviews.has(flightKey)) {
        const existingFlight = inFlightSceneReviews.get(flightKey);
        const result = await existingFlight.promise;
        const current = getContext().chat?.[index];
        const currentSignature = current && !current.is_user && !current.is_system
            ? sceneMessageSignature(index, String(current.mes || '')) : '';
        const currentEpoch = reviewEpochs.get(flightKey) || 0;
        const waiterStillCurrent = scopeTokenIsCurrent(scopeToken)
            && currentEpoch === flightEpoch
            && taskGenerationEpoch === foregroundGenerationEpoch
            && (options.allowStopped === true || stoppedGenerationEpoch !== taskGenerationEpoch);
        if (!waiterStillCurrent) return result;
        if (currentSignature && (currentSignature !== existingFlight.signature
            || currentEpoch !== existingFlight.flightEpoch)) {
            const currentSync = profile().sceneSync || {};
            if (!(currentSync.status === 'synced' && currentSync.signature === currentSignature
                && currentSync.formatVersion === SCENE_SYNC_FORMAT_VERSION)) {
                scheduleMessageReview(index, type, {
                    ...options,
                    delayMs: 50,
                    force,
                    reason: '同消息上一版本审核退出后继续当前版本',
                });
            }
        }
        return result;
    }

    let flight;
    const job = (async () => {
        const retryAttempt = Math.max(0, Number(options.retryAttempt) || 0);
        const database = storedCanonEntities();
        const recent = reviewContextSummary(chat, index);
        const latestUserText = latestUserTextBefore(chat, index);
        const explicitTimeAnchor = explicitTimeAnchorFromText(latestUserText);
        const explicitTimelineDirective = explicitTimelineDirectiveFromText(latestUserText);
        const records = config.reviewEnabled ? recordsForReview(body, database) : [];
        if (!trackScene && !records.length) return false;
        setSceneSyncState({
            status: retryAttempt ? 'retrying' : 'syncing',
            signature,
            messageId: index,
            retryCount: retryAttempt,
            nextRetryAt: 0,
            allowStopped: options.allowStopped === true,
        });
        try {
            updateReport(records.length
                ? `正在异步更新当前场景并审核正文（涉及 ${records.map(record => record.entity).join('、')}）…`
                : '正在异步更新当前人物、地点和时间节点…');
            let cached = force && options.reuseAnalysis !== true ? null : sceneAnalysisCache.get(signature);
            let overrideContext = cached?.overrideContext;
            let parsed = cached?.resolvedScene
                ? { ...(cached?.parsed || {}), verdict: 'pass', revisions: [], scene: cached.resolvedScene }
                : cached?.parsed;
            const analysisFresh = () => reviewTargetIsCurrent(
                scopeToken, index, message, body, swipeId, flightKey, flightEpoch,
            ) && !(getContext().chat || []).slice(index + 1).some(item => item?.mes && !item.is_system);
            if (!parsed) {
                overrideContext = await researchContext(chat.slice(0, index + 1));
                if (!reviewTargetIsCurrent(scopeToken, index, message, body, swipeId, flightKey, flightEpoch)) {
                    abandonSceneSync(index, [signature]);
                    return false;
                }
                parsed = await runJsonAnalysisPrompt(
                    buildReviewPrompt(body, records, recent, {
                        ...overrideContext,
                        reviewMessageSignature: messageProvenanceSignature(message, body),
                    }, config.reviewEnabled),
                    3200,
                    analysisFresh,
                );
                if (!reviewTargetIsCurrent(scopeToken, index, message, body, swipeId, flightKey, flightEpoch)) {
                    abandonSceneSync(index, [signature]);
                    return false;
                }
            }
            if (!reviewTargetIsCurrent(scopeToken, index, message, body, swipeId, flightKey, flightEpoch)) {
                abandonSceneSync(index, [signature]);
                updateReport('正文在分析期间被修改或删除，已放弃本轮状态更新与自动修订');
                return false;
            }
            let hasLaterConversation = (getContext().chat || []).slice(index + 1)
                .some(item => item?.mes && !item.is_system);
            const timelineRevisions = explicitTimelineRevisions(body, explicitTimeAnchor);
            const reviewedAliasKeys = new Set(records.flatMap(record => recordAliases(record, record.entity))
                .map(canonicalEntityKey).filter(Boolean));
            const modelRevisions = config.reviewEnabled && records.length
                ? (Array.isArray(parsed?.revisions) ? parsed.revisions : []).filter(revision => {
                    const entity = canonicalEntityKey(revision?.entity);
                    return entity && reviewedAliasKeys.has(entity)
                        && modelRevisionIsGrounded(revision, body, records);
                })
                : [];
            const revisions = [
                ...modelRevisions,
                ...timelineRevisions,
            ];
            let applied = [];
            let expectedFinalBody = body;
            if (!hasLaterConversation && (parsed?.verdict === 'conflict' || timelineRevisions.length) && revisions.length) {
                const revisionResult = applyTextRevisions(message.mes, revisions);
                applied = revisionResult.applied;
                if (applied.length) {
                    if (!scopeTokenIsCurrent(scopeToken)) return false;
                    message.mes = revisionResult.updated;
                    expectedFinalBody = revisionResult.updated;
                    message.extra ??= {};
                    if (typeof message.extra.display_text === 'string') message.extra.display_text = revisionResult.updated;
                    message.extra.fcr_revisions = applied;
                    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
                        message.swipes[message.swipe_id] = revisionResult.updated;
                    }
                    internalMessageUpdateDepth++;
                    try {
                        await context.saveChat();
                        if (!scopeTokenIsCurrent(scopeToken)) return false;
                        updateMessageBlock(index, message);
                    } finally {
                        internalMessageUpdateDepth = Math.max(0, internalMessageUpdateDepth - 1);
                    }
                    toastr.info(`已按原作资料自动修正 ${applied.length} 处冲突`, '晋阳的同人库');
                    console.info('[Fandom Canon] Auto-revised canon conflicts.', applied);
                }
            }
            const finalBody = String(message.mes ?? '');
            const finalSignature = sceneMessageSignature(index, finalBody);
            hasLaterConversation = (getContext().chat || []).slice(index + 1)
                .some(item => item?.mes && !item.is_system);
            if (textHash(finalBody) !== textHash(expectedFinalBody)
                || !reviewTargetIsCurrent(scopeToken, index, message, expectedFinalBody, swipeId, flightKey, flightEpoch)) {
                abandonSceneSync(index, [signature, finalSignature]);
                updateReport('正文在保存修订期间被切换或修改，已放弃旧版本的场景、AU 与世界书写入');
                return false;
            }
            if (hasLaterConversation) {
                reviewedMessageSignatures.add(signature);
                abandonSceneSync(index, [signature, finalSignature]);
                updateReport('审核完成时已有后续消息：未修改旧回复、未覆盖当前场景；资料会在最新消息中继续核对');
                return true;
            }
            const originalScene = parsed?.scene || {};
            const nameRevisions = applied.filter(revision => revision.replaceAll
                && /(?:name|姓名|名字|译名|正式名)/i.test(`${revision.aspect} ${revision.reason}`));
            const correctNameMetadata = value => nameRevisions.reduce((text, revision) =>
                String(text ?? '').replaceAll(revision.original, revision.revised), String(value ?? ''));
            const safeCanonChanges = cleanAuFacts(originalScene.canonChanges).flatMap(fact => {
                const evidenceText = [fact.current, fact.evidence, fact.canon].filter(Boolean).join('\n');
                if (applied.some(revision => revision.original && evidenceText.includes(revision.original))) return [];
                return [{
                    ...fact,
                    owner: correctNameMetadata(fact.owner),
                    facet: correctNameMetadata(fact.facet),
                    participants: cleanDetectedEntities(fact.participants).map(correctNameMetadata),
                    replaces: (fact.replaces || []).map(correctNameMetadata),
                }];
            });
            // A conflict revision may repair the prose, but it must never
            // rewrite the analysis model's old evidence into a seemingly valid
            // AU fact.  Any fact touched by the rejected text is discarded;
            // unaffected facts keep their original verbatim evidence.
            const revisedScene = applyRevisionsToStructuredValue({
                ...originalScene,
                canonChanges: [],
            }, applied);
            revisedScene.canonChanges = safeCanonChanges;
            const mergedScene = mergeSceneWithNarrativeBanner(revisedScene, finalBody, recent);
            mergedScene._fcrFinalBody = finalBody;
            const resolvedScene = sceneWithExplicitTimelineDirective(
                sceneWithExplicitTimeAnchor(mergedScene, explicitTimeAnchor),
                explicitTimelineDirective,
            );
            // Cache the post-revision, time-anchored scene.  If only the
            // world-book transaction fails, the retry must not replay the old
            // conflicting analysis or restore pre-revision names/timeline.
            sceneAnalysisCache.set(finalSignature, {
                parsed: { ...parsed, verdict: 'pass', revisions: [], scene: resolvedScene },
                resolvedScene,
                overrideContext,
            });
            while (sceneAnalysisCache.size > 30) sceneAnalysisCache.delete(sceneAnalysisCache.keys().next().value);
            const freshnessGuard = () => reviewTargetIsCurrent(
                scopeToken, index, message, finalBody, swipeId, flightKey, flightEpoch,
            ) && !(getContext().chat || []).slice(index + 1).some(item => item?.mes && !item.is_system)
                && settings().enabled === config.enabled
                && settings().autoUpdateProfile === config.autoUpdateProfile
                && settings().reviewEnabled === config.reviewEnabled;
            const sceneResult = trackScene
                ? await syncDynamicSceneState(resolvedScene, scopeToken, {
                    messageId: index,
                    messageSignature: messageProvenanceSignature(message, finalBody),
                    type,
                    body: finalBody,
                    freshnessGuard,
                    reviewedRecordKeys: records.map(record => canonRecordStorageKey(record, database)).filter(Boolean),
                    auEvidenceSources: {
                        card: overrideContext?.cardEvidence || overrideContext?.card || '',
                        user: latestUserTextBefore(chat, index),
                        world_info: overrideContext?.worldInfoEvidence || overrideContext?.worldInfo || '',
                        prior_context: recent,
                        assistant_event: finalBody,
                        rejected: applied.map(item => item.original),
                    },
                    auEvidenceAvailability: {
                        card: overrideContext?.cardAvailable === true,
                        world_info: overrideContext?.worldInfoAvailable === true,
                    },
                    auEvidenceWorldEntries: overrideContext?.worldInfoEntries,
                    auEvidenceWorldEntryStates: overrideContext?.worldInfoEntryStates,
                })
                : null;
            if (sceneResult?.aborted || !freshnessGuard()) {
                abandonSceneSync(index, [signature, finalSignature]);
                return false;
            }
            const sceneStatus = sceneResult
                ? (sceneResult.worldBookCompleted
                    ? `当前场景${sceneResult.changed || sceneResult.worldBookChanged ? '已同步到世界书' : '无变化'}`
                    : '当前场景已保存到本地；世界书正在等待自动重试')
                : '当前场景跟踪未启用';
            let reportText = `${sceneStatus}；正文没有需要修订的未解释原作冲突`;
            if (revisions.length && !applied.length && parsed?.verdict === 'conflict') {
                reportText = `${sceneStatus}；发现 ${revisions.length} 处疑似冲突，但无法安全逐字定位，未自动改写`;
            } else if (applied.length) {
                const reasons = [...new Set(applied
                    .map(item => `${item.entity || '实体'}：${item.reason || '与原作资料不符'}`))].join('；');
                reportText = `${sceneStatus}；已自动修正 ${applied.length} 处原作冲突（${reasons.slice(0, 300)}）`;
            }
            reviewedMessageSignatures.add(signature);
            reviewedMessageSignatures.add(finalSignature);
            setSceneSyncState({
                status: sceneResult && !sceneResult.worldBookCompleted ? 'world_pending' : 'synced',
                signature: finalSignature,
                messageId: index,
                retryCount: 0,
                nextRetryAt: 0,
            });
            sceneAnalysisCache.delete(signature);
            sceneAnalysisCache.delete(finalSignature);
            updateReport(reportText, sceneResult?.plan);
            return true;
        } catch (error) {
            const current = getContext().chat?.[index];
            const staleOrStopped = !scopeTokenIsCurrent(scopeToken)
                || current !== message
                || (Number.isInteger(current?.swipe_id) ? current.swipe_id : -1) !== swipeId
                || (reviewEpochs.get(flightKey) || 0) !== flightEpoch
                || (!options.allowStopped && stoppedGenerationEpoch === taskGenerationEpoch)
                || (getContext().chat || []).slice(index + 1).some(item => item?.mes && !item.is_system);
            const cancelled = error?.fcrCancelled || error?.name === 'AbortError'
                || /cancelled by|canceled by|aborted|已取消|用户停止/i.test(String(error?.message || ''));
            if (staleOrStopped || cancelled) {
                abandonSceneSync(index, [signature]);
                return false;
            }
            reviewedMessageSignatures.delete(signature);
            const messageText = error?.message || String(error);
            console.warn('[Fandom Canon] Post-generation scene update/review failed.', error);
            const retryDelay = sceneRetryDelay(error, retryAttempt);
            setSceneSyncState({
                status: retryDelay ? 'retrying' : 'error',
                signature,
                messageId: index,
                error: messageText,
                retryCount: retryAttempt + 1,
                nextRetryAt: retryDelay ? Date.now() + retryDelay : 0,
                allowStopped: options.allowStopped === true,
            });
            updateReport(retryDelay
                ? `生成后同步失败，将在 ${Math.round(retryDelay / 1000)} 秒后自动重试：${messageText}`
                : `生成后同步连续失败：${messageText}`);
            if (retryDelay) {
                scheduleMessageReview(index, type, {
                    ...options,
                    delayMs: retryDelay,
                    force: true,
                    reuseAnalysis: true,
                    retryAttempt: retryAttempt + 1,
                    reason: '失败自动重试',
                });
            }
            return false;
        }
    })().finally(() => {
        if (inFlightSceneReviews.get(flightKey) === flight) inFlightSceneReviews.delete(flightKey);
    });
    flight = { promise: job, signature, flightEpoch };
    inFlightSceneReviews.set(flightKey, flight);
    return await job;
}

function applyRevisionsToStructuredValue(value, revisions) {
    if (typeof value === 'string') {
        return (Array.isArray(revisions) ? revisions : []).reduce((text, revision) => {
            const original = String(revision?.original || '');
            const revised = String(revision?.revised || '');
            return original && revised ? text.replaceAll(original, revised) : text;
        }, value);
    }
    if (Array.isArray(value)) return value.map(item => applyRevisionsToStructuredValue(item, revisions));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .map(([key, item]) => [key, applyRevisionsToStructuredValue(item, revisions)]));
    }
    return value;
}

function abandonSceneSync(messageId, signatures = []) {
    const state = profile().sceneSync || {};
    const allowed = new Set(signatures.filter(Boolean));
    if (Number(state.messageId) !== Number(messageId)
        || (allowed.size && !allowed.has(String(state.signature || '')))
        || !['syncing', 'retrying'].includes(state.status)) return;
    setSceneSyncState({
        status: 'idle', signature: '', messageId, error: '', retryCount: 0, nextRetryAt: 0,
    });
}

function reviewTargetIsCurrent(scopeToken, index, message, expectedBody, swipeId, flightKey, flightEpoch) {
    const current = getContext().chat?.[index];
    return scopeTokenIsCurrent(scopeToken)
        && current === message
        && textHash(String(current?.mes ?? '')) === textHash(expectedBody)
        && (Number.isInteger(current?.swipe_id) ? current.swipe_id : -1) === swipeId
        && (reviewEpochs.get(flightKey) || 0) === flightEpoch;
}

function sceneRetryDelay(error, attempt) {
    if (attempt >= SCENE_RETRY_DELAYS_MS.length) return 0;
    const status = Number(error?.fcrHttpStatus)
        || Number(String(error?.message || '').match(/(?:HTTP|status)\D{0,12}(\d{3})/i)?.[1])
        || Number(String(error?.message || '').match(/\b(429|5\d{2})\b/)?.[1]) || 0;
    if ([400, 401, 403, 404].includes(status)) return 0;
    const transient = status === 429 || status >= 500
        || /(?:超时|timeout|network|网络|fetch|连接|世界书同步失败)/i.test(String(error?.message || ''));
    if (!transient) return 0;
    const base = Math.max(Number(error?.fcrRetryAfterMs) || 0, SCENE_RETRY_DELAYS_MS[attempt] || 0);
    return base ? Math.round(base + Math.random() * Math.min(5000, base * 0.2)) : 0;
}

function isLatestAssistantMessage(messageId) {
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    for (let index = chat.length - 1; index >= 0; index--) {
        if (!chat[index]?.mes || chat[index]?.is_system) continue;
        return index === Number(messageId) && !chat[index].is_user;
    }
    return false;
}

function coreUiIsGenerating() {
    return document.body.classList.contains('generating')
        || Boolean(document.querySelector('#send_but[title="Stop"]'))
        || Boolean(document.querySelector('#mes_stop')?.offsetParent);
}

function isPageGenerating() {
    return foregroundGenerationActive || coreUiIsGenerating();
}

function scheduleGenerationStateWatchdog(epoch, phase = 'started') {
    const delay = phase === 'started' ? 1800 : 15000;
    setTimeout(() => {
        if (epoch !== foregroundGenerationEpoch || !foregroundGenerationActive) return;
        if (coreUiIsGenerating()) {
            scheduleGenerationStateWatchdog(epoch, 'after_commands');
            return;
        }
        if (phase === 'started' && generationAfterCommandsEpoch === epoch) {
            scheduleGenerationStateWatchdog(epoch, 'after_commands');
            return;
        }
        foregroundGenerationActive = false;
        console.debug('[Fandom Canon] Cleared stale generation state after an upstream early return.', { epoch, phase });
    }, delay);
}

function invalidateMessageReview(messageId) {
    const index = Number(messageId);
    if (!Number.isInteger(index) || index < 0) return;
    abortActiveAnalysisRequests('回复版本已改变，旧分析任务已取消');
    abortActiveResearchRequests('回复版本已改变，旧检索任务已取消');
    const key = `${scopeIdentity()}|${index}`;
    reviewEpochs.set(key, (reviewEpochs.get(key) || 0) + 1);
    const timer = scheduledSceneReviews.get(key);
    if (timer) clearTimeout(timer);
    scheduledSceneReviews.delete(key);
    const signaturePrefix = `${scopeIdentity()}|${index}:`;
    for (const signature of reviewedMessageSignatures) {
        if (signature.startsWith(signaturePrefix)) reviewedMessageSignatures.delete(signature);
    }
    const sceneSync = profile().sceneSync;
    if (Number(sceneSync?.messageId) === index) {
        sceneSync.status = 'idle';
        sceneSync.signature = '';
        sceneSync.updatedAt = Date.now();
        saveSettingsDebounced();
    }
}

function reconcileLocalMessageState(chat, { invalidateFromMessageId = null } = {}) {
    const cardProfile = profile();
    const hadCurrentScene = Boolean(cardProfile.currentScene);
    const messages = Array.isArray(chat) ? chat : [];
    const signatureToIndex = new Map(messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message && !message.is_system && message.mes)
        .map(({ message, index }) => [messageProvenanceSignature(message), index]));
    const auResult = reconcileMessageDerivedAuFacts(cardProfile, messages);
    const journal = [...(Array.isArray(cardProfile.sceneHistory) ? cardProfile.sceneHistory : [])];
    if (cardProfile.currentScene) journal.push(cardProfile.currentScene);
    const invalidFrom = Number(invalidateFromMessageId);
    const hasInvalidFrom = Number.isInteger(invalidFrom) && invalidFrom >= 0;
    const invalidTransactions = journal.filter(snapshot => {
        const oldIndex = Number(snapshot?.messageId);
        return !snapshot?.messageSignature
            || !signatureToIndex.has(snapshot.messageSignature)
            || (hasInvalidFrom && Number.isInteger(oldIndex) && oldIndex >= invalidFrom);
    }).sort((a, b) => (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0));
    let changed = auResult.changed;
    const restoredRecordKeys = new Set();
    for (const snapshot of invalidTransactions) {
        changed = restoreTrackedProfileState(cardProfile, snapshot.previousProfileState) || changed;
        for (const [recordName, previous] of Object.entries(snapshot.previousRecordTimelines || {})) {
            const record = cardProfile.canonDatabase?.[recordName];
            if (!record) continue;
            if (previous && Object.hasOwn(previous, 'kind')) {
                record.kind = normalizeEntityKind(previous.kind, 'unknown');
                record.kindVerified = previous.kindVerified === true;
            }
            record.timeline = String(previous?.timeline || '');
            record.profile = String(previous?.profile || '');
            record.profileHash = String(previous?.profileHash || '');
            record.profileFormatVersion = Number(previous?.profileFormatVersion) || 0;
            record.profileAttemptHash = String(previous?.profileAttemptHash || '');
            record.profileAttemptedAt = Number(previous?.profileAttemptedAt) || 0;
            record.baselineStatus = String(previous?.baselineStatus || record.baselineStatus || 'pending');
            record.sourceTrust = String(previous?.sourceTrust || record.sourceTrust || 'provisional');
            record.updatedAt = Number(previous?.updatedAt) || Date.now();
            restoredRecordKeys.add(recordName);
            changed = true;
        }
    }
    const invalidSet = new Set(invalidTransactions);
    const retained = journal.filter(snapshot => !invalidSet.has(snapshot));
    for (const snapshot of retained) {
        const nextIndex = signatureToIndex.get(snapshot.messageSignature);
        if (Number.isInteger(nextIndex) && snapshot.messageId !== nextIndex) {
            snapshot.messageId = nextIndex;
            changed = true;
        }
    }
    retained.sort((a, b) => (Number(a?.updatedAt) || 0) - (Number(b?.updatedAt) || 0));
    const restoredCurrent = retained.pop() || null;
    const sceneChanged = cardProfile.currentScene !== restoredCurrent;
    if (sceneChanged) {
        cardProfile.currentScene = restoredCurrent;
        cardProfile.sceneHistory = retained.slice(-30);
        cardProfile.sceneSync = {
            status: 'idle', signature: '', messageId: restoredCurrent?.messageId ?? null,
            updatedAt: Date.now(), error: '', retryCount: 0, nextRetryAt: 0,
            formatVersion: SCENE_SYNC_FORMAT_VERSION,
        };
        changed = true;
    } else {
        cardProfile.sceneHistory = retained.slice(-30);
    }
    if (invalidTransactions.length && !invalidTransactions.some(snapshot => snapshot.previousProfileState)) {
        const previousAutoKeys = new Set(cleanDetectedEntities(cardProfile.lastAutoEntities).map(canonicalEntityKey));
        cardProfile.entities = manualEntities(cardProfile.entities)
            .filter(name => !previousAutoKeys.has(canonicalEntityKey(name))).join('，');
        cardProfile.lastAutoEntities = [];
        changed = true;
    }
    const databaseChanged = sanitizeCanonDatabase(cardProfile.canonDatabase || {}, cardProfile);
    changed ||= databaseChanged;
    if (changed) saveSettingsDebounced();
    return {
        changed,
        sceneChanged,
        sceneCleared: hadCurrentScene && !restoredCurrent,
        owners: cleanDetectedEntities(auResult.owners),
        // Timeline-only snapshots have no AU owner.  Returning their exact
        // storage keys ensures rollbackMessageDerivedState also rewrites the
        // corresponding durable world-book entries to the restored timeline.
        recordKeys: [...new Set([...(auResult.recordKeys || []), ...restoredRecordKeys])],
    };
}

async function rollbackMessageDerivedState(messageId, { reconcileAll = false } = {}) {
    const index = Number(messageId);
    const cardProfile = profile();
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    invalidateProfileTransactions(cardProfile);
    const result = reconcileLocalMessageState(chat, {
        invalidateFromMessageId: Number.isInteger(index) ? index : null,
    });
    if (!result.changed) return false;
    if (cardProfile.currentScene) {
        cardProfile.currentScene.auChanges = relevantAuFactsForNames([
            ...(cardProfile.currentScene.characters || []),
            ...(cardProfile.currentScene.locations || []),
            ...(cardProfile.currentScene.subjects || []),
            ...(cardProfile.currentScene.pinned || []),
        ]).map(auFactText);
    }
    const scopeToken = captureScopeToken();
    const syncRevision = markWorldSyncPending(cardProfile);
    try {
        await repairWorldBookFromLocalState(cardProfile, scopeToken, null, syncRevision);
    } catch (error) {
        scheduleWorldBookRepair(cardProfile, scopeToken, syncRevision);
        console.warn('[Fandom Canon] Message rollback world-book repair deferred.', error);
    }
    return true;
}

function invalidateScopeReviews() {
    abortActiveAnalysisRequests('新一轮生成或用户停止已使旧分析任务失效');
    abortActiveResearchRequests('新一轮生成或用户停止已使旧检索任务失效');
    const prefix = `${scopeIdentity()}|`;
    for (const key of new Set([...scheduledSceneReviews.keys(), ...inFlightSceneReviews.keys(), ...reviewEpochs.keys()])) {
        if (!key.startsWith(prefix)) continue;
        reviewEpochs.set(key, (reviewEpochs.get(key) || 0) + 1);
        const timer = scheduledSceneReviews.get(key);
        if (timer) clearTimeout(timer);
        scheduledSceneReviews.delete(key);
    }
    const sceneSync = profile().sceneSync || {};
    if (['syncing', 'retrying'].includes(sceneSync.status)) {
        setSceneSyncState({
            status: 'idle', signature: '', messageId: sceneSync.messageId,
            error: '', retryCount: 0, nextRetryAt: 0,
        });
    }
}

function scheduleMessageReview(messageId, type = 'normal', options = {}) {
    const index = Number(messageId);
    if (!Number.isInteger(index) || index < 0) return false;
    // The current chat model shares SillyTavern's global generation state and
    // cannot be independently aborted.  Automatic background work must use the
    // separately configured API so it cannot race, stop, or rate-limit the main
    // reply.  "Current model" remains available for explicit manual actions.
    if (settings().analysisSource !== 'custom') return false;
    const scope = scopeIdentity();
    const key = `${scope}|${index}`;
    const generationEpoch = Number.isFinite(Number(options.generationEpoch))
        ? Number(options.generationEpoch) : foregroundGenerationEpoch;
    if (!options.allowStopped && stoppedGenerationEpoch === generationEpoch) return false;
    const previous = scheduledSceneReviews.get(key);
    if (previous) clearTimeout(previous);
    const delayMs = Math.max(0, Number(options.delayMs) || 0);
    const timer = setTimeout(async () => {
        scheduledSceneReviews.delete(key);
        if (scope !== scopeIdentity()) return;
        if (generationEpoch !== foregroundGenerationEpoch) return;
        if (!options.allowStopped && stoppedGenerationEpoch === generationEpoch) return;
        if (busy) {
            scheduleMessageReview(index, type, { ...options, delayMs: 1000, generationEpoch });
            return;
        }
        if (isPageGenerating()) {
            scheduleMessageReview(index, type, { ...options, delayMs: 1000, generationEpoch });
            return;
        }
        try {
            await reviewGeneratedMessage(index, type, { ...options, generationEpoch });
        } catch (error) {
            console.error('[Fandom Canon] Scheduled scene review failed.', error);
        }
    }, delayMs);
    scheduledSceneReviews.set(key, timer);
    console.debug(`[Fandom Canon] Scene review scheduled (${options.reason || 'message event'}).`, { index, delayMs, generationEpoch });
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
    const flightKey = `${scopeIdentity()}|${latestVisibleIndex}`;
    const activeFlight = inFlightSceneReviews.get(flightKey);
    if (activeFlight?.signature === signature) return true;
    const sceneSync = profile().sceneSync || {};
    if (sceneSync.status === 'synced'
        && sceneSync.signature === signature
        && sceneSync.formatVersion === SCENE_SYNC_FORMAT_VERSION) return true;
    if (sceneSync.signature === signature && sceneSync.status === 'error') return true;
    if (sceneSync.signature === signature && sceneSync.status === 'retrying') {
        const nextRetryAt = Number(sceneSync.nextRetryAt || 0);
        if (nextRetryAt > Date.now()) return true;
        return scheduleMessageReview(latestVisibleIndex, 'normal', {
            delayMs: 0,
            force: true,
            reuseAnalysis: true,
            retryAttempt: Number(sceneSync.retryCount || 0),
            allowStopped: sceneSync.allowStopped === true,
            reason: '恢复尚未完成的有限重试',
        });
    }
    return scheduleMessageReview(latestVisibleIndex, 'normal', { delayMs, reason });
}

async function retrieve(plan, signal = null) {
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
    const plannedCandidates = planCanonCandidates(plan).map((candidate, index) => ({
        ...candidate,
        candidateId: `${index}:${canonCandidateIdentityKey(candidate)}`,
    }));
    const bindCandidateIdentity = (job, candidate) => Promise.resolve(job).then(pages =>
        (Array.isArray(pages) ? pages : []).map(page => candidate ? ({
            ...page,
            candidateId: candidate.candidateId,
            candidateName: candidate.candidateName,
            inputWorkHint: candidate.workHint || '',
            kind: candidate.kind,
        }) : page));
    const batchCustomAi = useWeb && config.searchProvider === 'custom_ai';
    for (const query of plan.queries) {
        const exactCandidates = plannedCandidates.filter(candidate => {
            const expected = canonResearchQuery(candidate, plan.work);
            return query === expected || query.startsWith(`${expected}；`);
        });
        const contextualCandidates = plannedCandidates.filter(candidate => {
            const expectedWork = String(candidate.workHint || plan.work || '').trim();
            return textContainsEntityAlias(query, candidate.candidateName)
                && (!expectedWork || textContainsEntityAlias(query, expectedWork));
        });
        const queryCandidate = exactCandidates.length === 1
            ? exactCandidates[0]
            : (contextualCandidates.length === 1 ? contextualCandidates[0] : null);
        if (useWiki) {
            for (const api of apis) {
                jobs.push(bindCandidateIdentity(searchWiki(api.url, query, api.name, signal), queryCandidate));
            }
        }
        if (useWeb && !batchCustomAi) {
            jobs.push(bindCandidateIdentity(searchWeb(query, signal), queryCandidate));
        }
    }
    if (batchCustomAi && plan.queries.length) {
        const researchObjects = plannedCandidates.map((planned, candidateIndex) => {
            const entity = planned.candidateName;
            return {
                candidateId: planned.candidateId || `${candidateIndex}:${canonCandidateIdentityKey(planned)}`,
                candidateName: entity,
                kind: normalizeEntityKind(planned?.kind, 'character'),
                workHint: planned?.workHint || '',
                timeline: plan.timeline || '',
                contextEvidence: planned?.contextEvidence || '',
                requiredFields: researchFieldsForKind(planned?.kind),
                researchMode: planned?.researchMode
                    || (plan.researchMode === 'official_delta' ? 'official_delta' : 'new_entities'),
            };
        });
        const deltaOnly = plan.researchMode === 'official_delta';
        const mixedResearch = plan.researchMode === 'mixed';
        const taskInstruction = deltaOnly
            ? '这些对象已经有完整基础档案。本次只核实检索问题对应的新时间线节点或官方补充设定；不得重新总结姓名、外貌、性格、经历等既有基础档案。若没有任何相对已有档案的新增事实，records 必须返回空数组。summary 只写新增事实。'
            : (mixedResearch
                ? '逐项遵守 researchMode：new_entities 必须确认身份并按 requiredFields 整理完整原著基线；official_delta 已有基础档案，只写截至新时间线新增成立的官方事实，没有新增事实时省略该对象。'
                : '这些是尚无档案的新对象。必须先确认实际所属作品、实体类型和正式名称，再按 requiredFields 整理完整原著基线档案。');
        const summaryRule = deltaOnly
            ? '只写本次新增官方事实'
            : (mixedResearch
                ? 'researchMode=new_entities 时写完整单对象原著基线；researchMode=official_delta 时只写本次新增官方事实'
                : '必须以 canonicalName 开头；若纠正候选名，开头先明确候选名与正式名的对应；随后写给正文模型用的单对象原著基线档案，只写确认事实并覆盖该对象 requiredFields 中有资料的项目');
        const batchQuery = `请在一次联网研究中逐个核实下列同人对象。候选名可能错译、误写或与其他对象混淆。对象可能是人物、地点、物品、能力、组织、事件或世界规则。优先使用原作官网、出版社/制作方、官方指南与可靠资料库，并交叉核对；不能只因为搜索摘要声称某事就视为已证实。每个对象必须附上直接支持该对象身份与事实的实际网页 URL，不能把整批通用引用复制给每条。每个对象若给出 timeline，只能写截至该节点已经成立的原著事实；节点之后的死亡、关系、身份揭露、能力变化、物品归属、地点状态、事件结果和秘密一律不得写入 summary。\n\n${taskInstruction}\n\n只输出合法 JSON：{"records":[{"candidateId":"必须逐字回填输入 candidateId","candidateName":"必须原样回填输入候选名","inputWorkHint":"必须逐字回填输入 workHint","kind":"character|location|item|ability|organization|event|world_rule","canonicalName":"核实后的简体中文正式名，可纠正候选名","originalName":"原文正式名","workTitle":"实际所属原作","aliases":["常见译名、原文名、错误候选名"],"identityEvidence":"一句话说明输入候选名为何确实对应 canonicalName；若纠正名字，必须同时写出两个名字；若 workTitle 与 inputWorkHint 写法不同，必须逐字同时包含两种作品名并明确说明它们是同一作品或互为译名","sourceUrls":["直接支持本对象的网页URL"],"verified":true,"summary":"${summaryRule}"}]}。candidateId 与 inputWorkHint 是输入身份回执，不得改写。verified 只有在身份配对和事实均已由权威来源或至少两个独立可靠来源交叉确认时才能为 true，否则必须 false。每个对象单独一条，绝不能把其他对象的整份资料混入。若无法证明候选名与正式名是同一对象，verified 必须 false。\n\n研究对象（JSON）：\n${JSON.stringify(researchObjects)}\n\n检索问题：\n${plan.queries.map((query, index) => `${index + 1}. ${query}`).join('\n')}`;
        jobs.push(searchWeb(batchQuery, signal));
    }
    const settled = await Promise.allSettled(jobs);
    throwIfAborted(signal);
    const failures = settled.filter(result => result.status === 'rejected').map(result => result.reason);
    const pages = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    if (!pages.length && failures.length) throw failures[0];
    const unique = [];
    const seen = new Set();
    for (const page of pages) {
        const key = `${page.candidateId || ''}|${page.inputWorkHint || ''}|${page.kind || ''}|${page.source}|${page.url || ''}|${page.title}|${page.candidateId ? '' : (page.query || '')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(page);
    }
    // Keep at least one result for every candidate before giving any one
    // candidate a second page.  A global first-10 slice let the first query's
    // Wiki variants starve later objects completely.
    const groups = new Map();
    for (const page of unique) {
        const groupKey = page.candidateId
            || `${page.inputWorkHint || ''}|${page.kind || ''}|${page.query || page.title || ''}`;
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push(page);
    }
    const fair = [];
    const maximum = Math.max(10, Math.min(20, clampInt(config.maxQueries, 1, 10, 3) * 2));
    while (fair.length < maximum && [...groups.values()].some(group => group.length)) {
        for (const group of groups.values()) {
            if (!group.length || fair.length >= maximum) continue;
            fair.push(group.shift());
        }
    }
    return fair;
}

function researchJobKey(plan) {
    const config = settings();
    const scope = scopeIdentity();
    return `${scope}|${runtimeEpoch}|${scopeEpochs.get(scope) || 0}|${plan?.messageId ?? ''}|${plan?.messageSignature || ''}|${plan?.work || ''}|${plan?.timeline || ''}|${config.searchProvider}|${config.sourceStrategy}|${config.searchAiBaseUrl}|${config.searchAiProtocol}|${config.searchAiModel}|${(plan.queries || []).join('|')}|${planCanonCandidates(plan).map(canonCandidateIdentityKey).join('|')}`;
}

function recordUnresolvedResearch(candidates, error = '', cardProfile = profile()) {
    const previous = Array.isArray(cardProfile.unresolvedEntities) ? cardProfile.unresolvedEntities : [];
    const byKey = new Map(previous.map(item => [canonCandidateIdentityKey({
        candidateName: item.entity, kind: item.kind, workHint: item.workHint,
    }), item]));
    for (const candidate of cleanCanonSubjectCandidates(candidates)) {
        const key = canonCandidateIdentityKey(candidate);
        const old = byKey.get(key) || {};
        const attempts = (Number(old.attempts) || 0) + 1;
        byKey.set(key, {
            entity: candidate.candidateName,
            kind: candidate.kind,
            workHint: candidate.workHint || old.workHint || '',
            attempts,
            lastError: String(error || '未找到可验证资料').slice(0, 500),
            lastAttemptAt: Date.now(),
            nextRetryAt: Date.now() + Math.min(30 * 60 * 1000, 60 * 1000 * (2 ** Math.min(attempts - 1, 4))),
        });
    }
    cardProfile.unresolvedEntities = [...byKey.values()];
    saveSettingsDebounced();
}

function clearResolvedResearch(candidates, cardProfile = profile()) {
    const keys = new Set(cleanCanonSubjectCandidates(candidates)
        .map(canonCandidateIdentityKey));
    cardProfile.unresolvedEntities = (Array.isArray(cardProfile.unresolvedEntities) ? cardProfile.unresolvedEntities : [])
        .filter(item => !keys.has(canonCandidateIdentityKey({
            candidateName: item.entity, kind: item.kind, workHint: item.workHint,
        })));
}

async function enrichPlanInBatches(plan, scopeToken, signal = null) {
    const isFresh = () => typeof plan?.freshnessGuard !== 'function' || plan.freshnessGuard();
    if (!isFresh()) return [];
    const config = settings();
    const cardProfile = profile();
    const allCandidates = cleanCanonSubjectCandidates(
        Array.isArray(plan.entityCandidates) && plan.entityCandidates.length
            ? plan.entityCandidates
            : cleanDetectedEntities(plan.entities).map(candidateName => ({ candidateName, kind: 'character' })),
    );
    const missingCandidates = missingCanonCandidates(plan);
    const now = Date.now();
    const retryState = new Map((cardProfile.unresolvedEntities || [])
        .map(item => [canonCandidateIdentityKey({
            candidateName: item.entity, kind: item.kind, workHint: item.workHint,
        }), item]));
    const missingKeys = new Set(missingCandidates.map(canonCandidateIdentityKey));
    const eligibleCandidates = allCandidates.filter(candidate => missingKeys.has(canonCandidateIdentityKey(candidate)))
        .filter(candidate => {
            if (plan.ignoreResearchBackoff === true) return true;
            const retry = retryState.get(canonCandidateIdentityKey(candidate));
            return !retry || Number(retry.nextRetryAt || 0) <= now;
        });
    const queryLimit = Math.max(1, clampInt(config.maxQueries, 1, 10, 3));
    const candidates = eligibleCandidates.slice(0, queryLimit);
    if (plan.researchMode === 'new_entities' && !candidates.length) return [];
    if (plan.researchMode !== 'new_entities') {
        const boundedCandidates = allCandidates.slice(0, queryLimit);
        const boundedPlan = {
            ...plan,
            entities: boundedCandidates.length
                ? boundedCandidates.map(item => item.candidateName)
                : cleanDetectedEntities(plan.entities).slice(0, queryLimit),
            entityCandidates: boundedCandidates,
            queries: (Array.isArray(plan.queries) ? plan.queries : []).slice(0, queryLimit),
        };
        const pages = await retrieve(boundedPlan, signal);
        if (!scopeTokenIsCurrent(scopeToken) || !isFresh()) return [];
        const acceptedEntities = await saveCanonResearch(boundedPlan, pages);
        pages.acceptedEntities = acceptedEntities;
        return pages;
    }

    const allPages = [];
    const acceptedEntities = new Set();
    let lastBatchError = null;
    // maxQueries is a hard per-run budget, not merely a batch size.  The old
    // loop could process dozens of batches from one reply and was responsible
    // for multi-minute updates and bursts of 429s.  Deferred entities remain
    // missing and are picked up incrementally by later scene turns.
    const batchSize = queryLimit;
    for (let start = 0; start < candidates.length; start += batchSize) {
        if (!scopeTokenIsCurrent(scopeToken) || !isFresh()) return allPages;
        const batchCandidates = candidates.slice(start, start + batchSize);
        const batchPlan = {
            ...plan,
            entities: batchCandidates.map(item => item.candidateName),
            entityCandidates: batchCandidates,
            queries: batchCandidates.map(candidate => canonResearchQuery(candidate, plan.work)),
        };
        try {
            const pages = await retrieve(batchPlan, signal);
            if (!scopeTokenIsCurrent(scopeToken) || !isFresh()) return allPages;
            const savedEntities = await saveCanonResearch(batchPlan, pages);
            savedEntities.forEach(entity => acceptedEntities.add(entity));
            const unresolved = missingCanonCandidates(batchPlan);
            if (unresolved.length) {
                recordUnresolvedResearch(batchCandidates.filter(candidate => unresolved
                    .some(item => canonCandidateIdentityKey(item) === canonCandidateIdentityKey(candidate))), '', cardProfile);
            } else {
                clearResolvedResearch(batchCandidates, cardProfile);
            }
            allPages.push(...pages);
        } catch (error) {
            if (signal?.aborted || error?.fcrCancelled || error?.name === 'AbortError'
                || !scopeTokenIsCurrent(scopeToken) || !isFresh()) return allPages;
            lastBatchError = error;
            recordUnresolvedResearch(batchCandidates, error?.message || String(error), cardProfile);
            console.warn('[Fandom Canon] Canon research batch deferred.', error);
        }
    }
    saveSettingsDebounced();
    if (!allPages.length && lastBatchError) throw lastBatchError;
    allPages.acceptedEntities = cleanDetectedEntities([...acceptedEntities]);
    return allPages;
}

function startCanonEnrichment(plan) {
    const key = researchJobKey(plan);
    const existing = inFlightResearch.get(key);
    if (existing) return existing;
    const scopeToken = captureScopeToken();
    const controller = new AbortController();
    activeResearchControllers.add(controller);

    const job = (async () => {
        const pages = await enrichPlanInBatches(plan, scopeToken, controller.signal);
        if (!scopeTokenIsCurrent(scopeToken)
            || (typeof plan?.freshnessGuard === 'function' && !plan.freshnessGuard())) return [];
        return pages;
    })().finally(() => {
        activeResearchControllers.delete(controller);
        if (inFlightResearch.get(key) === job) inFlightResearch.delete(key);
    });
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
    if (isPageGenerating()) {
        toastr.warning('请先等待当前正文生成结束或按停止，再执行手动识别；这样不会让分析请求与正文模型争用连接。', '晋阳的同人库');
        updateReport('手动识别未启动：当前正文仍在生成');
        return;
    }
    if (busy) {
        toastr.info('已有一项识别或核验任务在运行，本次重复点击已忽略。', '晋阳的同人库');
        return;
    }
    const taskBusyOwner = ++busyOwner;
    busy = true;
    let scopeToken = null;
    const operationFresh = () => busyOwner === taskBusyOwner
        && (!scopeToken || scopeTokenIsCurrent(scopeToken));
    try {
    await ensureConversationScope();
    if (!operationFresh()) return;
    // A deliberate manual rebuild supersedes any delayed automatic review or
    // research for the same chat.  Cancel it before waiting so we neither sit
    // behind a 150-second request nor launch a second search for the same
    // entity under a different job key.
    invalidateScopeReviews();
    await settleSceneTransactions();
    if (!operationFresh()) return;
    await reconcileDeletedWorldBookEntries();
    if (!operationFresh()) return;
    invalidateProfileTransactions(profile());
    scopeToken = captureScopeToken();
    const startedAt = performance.now();
    const secondsSince = mark => ((performance.now() - mark) / 1000).toFixed(1);
    const cardProfile = profile();
    const context = getContext();
    const source = await researchContext(context.chat);
    if (!operationFresh()) return;
    const contextSeconds = secondsSince(startedAt);
    if (!source.card && !source.worldInfo && !source.recent) {
        toastr.error('没有识别到当前角色卡或聊天内容。请先打开一个角色聊天，再执行自动填写。', '无法自动填写');
        updateReport('自动填写已停止：没有识别到当前角色卡或聊天内容');
        return;
    }
    updateReport('AI 正在识别角色卡与剧情…');
    try {
        const identifyStartedAt = performance.now();
        const firstPrompt = `你是同人资料识别助手。必须阅读角色卡正文、当前实际启用的世界书条目和最近剧情，判断是否涉及已有作品，以及剧情属于原作时间线、AU，还是仅借用了同人角色的用户原创世界。角色卡标题只是文件名，不得把标题本身当人物、作品或搜索实体。\n\n同时提取已经明确成立、会影响后续写作的全部原著差异。范围包括但不限于身份、年龄、阵营、能力、装备或关键物品、外貌与身体状态、经历与记忆、生死去向、人际关系、地点势力、事件结果、人物认知、世界规则和时间线。只能依据角色卡明确设定、用户明确陈述、当前启用世界书明确设定或剧情反复一致建立的事实；不得因为某事没被提到就推断它不存在，也不得把一次疑似助手写错登记为 AU。\n\n只输出 JSON：{"workTitle":"正文能明确确认的作品正式名称；多作品时写多作品交叉同人（当前涉及：作品名）","storyType":"canon_timeline|au_timeline|original_world_with_fandom_characters|original_only|unknown","timeline":"正文结束时已经明确成立的原作/AU时间节点；完全无法判断则空字符串","canonChanges":[{"entity":"发生差异的具体实体或世界规则","change":"与原著不同且已经明确成立的事实","evidence":"简短依据"}],"entities":["正文结束瞬间仍在场或正直接参与互动的具体有名人物，以及当前一个具体地点"],"queries":["带人物各自作品名和具体专有名词的全网检索词"]}。entities 是完整当前场景快照：必须排除已经离场、上一场景、只被谈及、回忆中、未来可能登场的人物，以及组织、物品、能力、书籍和泛称；角色卡和世界书里的候选人物不能算在场。用户原创人物可以进入当前快照，但不要为其生成外部检索词。不确定的字段留空，不得编造；queries 最多 ${settings().maxQueries} 条，没有具体核实对象就返回空数组。\n\n角色卡正文：\n${source.card || '未读取到'}\n\n当前触发及角色卡内置世界书：\n${source.worldInfo || '无'}\n\n最近剧情：\n${source.recent || '暂无聊天内容。'}`;
        const firstPromptV2 = `你是同人资料初始化助手。完整阅读角色卡、当前实际启用的世界书和最近剧情；角色卡文件名绝不能当作人物或检索词。识别作品、故事类型、当前时间线，并分别输出：currentEntities（正文结束瞬间仍在场的人物和当前地点）与 canonSubjects（角色卡/启用世界书/最近剧情里已经实际使用、需要原著基线的具体人物、地点、物品、能力、组织、事件、世界规则）。逐个标记原创对象，原创对象不得外搜。\n\nAU 只接受角色卡、用户、启用世界书明确设定，或此前剧情明确发生且持续成立的状态变化；助手一次静态写错不能洗成 AU。每项用唯一 owner 和细粒度稳定 facet，同属性新状态通过 replaces 取代旧状态，evidence 必须逐字来自标注来源。\n\n只输出完整 JSON：{"workTitle":"明确作品名","storyType":"canon_timeline|au_timeline|original_world_with_fandom_characters|original_only|unknown","timeline":"当前明确时间线；未知留空","canonChanges":[{"entity":"唯一归属对象","work":"owner实际所属作品","kind":"character|location|item|ability|organization|event|world_rule","facet":"稳定属性键","canon":"原著状态","current":"本卡当前状态","source":"card|user|world_info|prior_context","evidence":"来源逐字短句","participants":["除owner外的关联对象"],"eventChanged":false,"replaces":["被替换旧状态"]}],"currentEntities":[{"candidateName":"当前人物或地点","kind":"character|location","isOriginal":false,"workHint":"所属作品","contextEvidence":"在场依据"}],"canonSubjects":[{"candidateName":"需原著基线的具体对象","kind":"character|location|item|ability|organization|event|world_rule","isOriginal":false,"workHint":"所属作品","contextEvidence":"实际涉及依据"}]}。不得把仅被闲谈、未来可能登场、卡名或泛称放进 canonSubjects。\n\n角色卡：\n${source.card || '无'}\n\n当前启用世界书：\n${source.worldInfo || '无'}\n\n最近剧情：\n${source.recent || '无'}`;
        const first = await runJsonAnalysisPrompt(`${firstPromptV2}\n\n补充规则：canonChanges 每项必须包含 work（owner 实际所属作品），还可包含 participants（关系另一方、物品转移双方等）和 eventChanged。跨作品同名且无法确认 work 时省略该差异，不得归给第一个同名候选。facet 必须具体到对象与属性，例如 relationship.幻视.恋爱、item.时间宝石.ownership、ability.混沌魔法.availability、appearance.hair。source=prior_context 只有 evidence 是此前正文逐字动作—结果、且确实改变并持续了状态时才能 eventChanged=true；此前助手的一次静态断言必须省略。最近剧情中“用户：”明确设定优先标 source=user。`, 2600, operationFresh);
        if (!operationFresh()) return;
        const identifySeconds = secondsSince(identifyStartedAt);
        const manualWorkLocked = Boolean(cardProfile.workTitle)
            && cardProfile.workTitle !== cardProfile.lastAutoWorkTitle;
        const manualTimelineLocked = Boolean(cardProfile.timeline)
            && cardProfile.timeline !== cardProfile.lastAutoTimeline;
        const workTitle = String(manualWorkLocked
            ? cardProfile.workTitle : (first.workTitle || cardProfile.workTitle || '')).trim();
        const originalWorld = first.storyType === 'original_world_with_fandom_characters' || first.storyType === 'original_only';
        const timeline = String(manualTimelineLocked
            ? cardProfile.timeline
            : (originalWorld
                ? '用户原创世界（仅含同人角色，非原作剧情）'
                : (first.timeline || cardProfile.timeline || ''))).trim();
        const initializationCorpus = [
            source.cardEvidence || source.card,
            source.worldInfoEvidence || source.worldInfo,
            source.recent,
        ].filter(Boolean).join('\n');
        const initializationCandidateIsGrounded = candidate => {
            if (textContainsEntityAlias(initializationCorpus, candidate.candidateName)) return true;
            const evidence = String(candidate.contextEvidence || '').trim();
            return evidence.length >= 2
                && textContainsEntityAlias(evidence, candidate.candidateName)
                && initializationCorpus.includes(evidence);
        };
        const currentCandidates = cleanSceneEntityCandidates(first.currentEntities ?? first.entities)
            .filter(initializationCandidateIsGrounded);
        const entities = cleanDetectedEntities(currentCandidates.map(item => item.candidateName)).slice(0, 20);
        const subjectCandidates = cleanCanonSubjectCandidates(first.canonSubjects ?? first.entities)
            .filter(initializationCandidateIsGrounded);
        const database = storedCanonEntities();
        const canonCandidates = subjectCandidates.filter(item =>
            candidateHasCanonIdentity(item, database, workTitle));
        const researchEntities = cleanDetectedEntities(canonCandidates.map(item => item.candidateName));
        const canonChanges = cleanAuFacts(first.canonChanges, { work: workTitle });
        const missingCandidates = canonCandidates.filter(candidate => {
            const recordName = candidateRecordName(candidate, database, workTitle);
            const record = database[recordName];
            return !recordName || (!record?.sources?.length && !record?.profile)
                || (settings().strictMode && record.sourceTrust !== 'verified');
        });
        const missingEntities = cleanDetectedEntities(missingCandidates.map(candidate => candidate.candidateName));
        let queries = missingCandidates.map(candidate => canonResearchQuery(candidate, workTitle));
        queries = cleanPlannedQueries(queries, workTitle).slice(0, settings().maxQueries);
        const provisional = {
            work: workTitle,
            timeline,
            entities: researchEntities,
            entityCandidates: canonCandidates,
            autoEntities: entities,
            replaceAutoEntities: true,
            canonChanges,
            auEvidenceSources: {
                card: source.cardEvidence || source.card,
                user: (context.chat || []).filter(message => message?.is_user && message?.mes)
                    .slice(-12).map(message => String(message.mes)).join('\n'),
                world_info: source.worldInfoEvidence || source.worldInfo,
                prior_context: source.recent,
            },
            auEvidenceAvailability: {
                card: source.cardAvailable === true,
                world_info: source.worldInfoAvailable === true,
            },
            auEvidenceWorldEntries: source.worldInfoEntries,
            auEvidenceWorldEntryStates: source.worldInfoEntryStates,
            researchMode: missingEntities.length ? 'new_entities' : 'none',
            queries,
            freshnessGuard: operationFresh,
        };
        // The first structured pass has already read the card, active lore and
        // recent chat. Fill the visible table now; web research enriches the
        // persistent database in the background and must not hold the UI open.
        const detectedEntities = entities;
        if (!workTitle && !timeline && !detectedEntities.length && !canonChanges.length) {
            throw new Error('分析模型没有识别出任何可填写内容，已取消“成功”提示；请确认当前角色卡已打开。');
        }
        syncProfileFromPlan(provisional);
        const changedAuRecords = await persistCanonDeltas(provisional);
        if (!operationFresh()) return;
        const nextWorkTitle = cardProfile.workTitle;
        const nextTimeline = cardProfile.timeline;
        const nextEntities = cardProfile.entities;
        const suggestedWiki = normalizeApiUrl(first.customWikiApi || '');
        if (suggestedWiki) cardProfile.customWikiApi = suggestedWiki;
        saveSettingsDebounced();
        loadProfileIntoPanel();
        const filled = [nextWorkTitle && '作品名', nextTimeline && '时间线/AU', nextEntities && '人物/地点', canonChanges.length && `AU差异${canonChanges.length}条`].filter(Boolean);
        const totalSeconds = secondsSince(startedAt);
        const storedPages = loadCanonResearch(provisional);
        const missingResearchEntities = missingCanonEntities(provisional);
        const needsResearch = queries.length && (missingResearchEntities.length > 0 || storedPages.length === 0);
        updateReport(`已实际填写：${filled.join('、')}；耗时 ${totalSeconds} 秒（读取 ${contextSeconds} / 识别 ${identifySeconds}）。${changedAuRecords.length ? `已同步 ${canonChanges.length} 条 AU 差异。` : ''}${needsResearch ? '新资料正在后台检索，不再阻塞页面。' : `已复用本卡资料库 ${storedPages.length} 条资料。`}`, provisional, storedPages);
        toastr.success(`已写入：${filled.join('、')}。${needsResearch ? '原作资料会在后台继续补入世界书。' : ''}`, '晋阳的同人库');
        if (needsResearch) {
            const backgroundStartedAt = performance.now();
            startCanonEnrichment(provisional).then(async pages => {
                if (!operationFresh()) return;
                const searchSeconds = secondsSince(backgroundStartedAt);
                await ensureCanonProfiles(provisional);
                if (!operationFresh()) return;
                const acceptedCount = Array.isArray(pages.acceptedEntities)
                    ? pages.acceptedEntities.length : 0;
                updateReport(acceptedCount
                    ? `后台检索完成：已写入 ${acceptedCount} 个对象（检索返回 ${pages.length} 条），并压缩为时间线内档案（${searchSeconds} 秒）`
                    : `后台检索返回 ${pages.length} 条，但没有资料通过对象、作品与来源校验，因此未写入世界书（${searchSeconds} 秒）`, provisional, pages);
            }).catch(error => updateReport(`表格已填写，但后台检索失败：${error?.message || error}`, provisional));
        }
    } catch (error) {
        if (!scopeTokenIsCurrent(scopeToken)) return;
        console.error('[Fandom Canon] Auto-fill failed.', error);
        updateReport(`自动填写失败：${error?.message || error}`);
        toastr.error(error?.message || String(error), '自动填写失败');
    }
    } finally {
        // This operation owns the global single-flight lock.  Always release
        // it, including after a chat/card switch invalidates its scope token.
        if (busyOwner === taskBusyOwner) busy = false;
    }
}

function buildReference(plan) {
    const strict = settings().strictMode;
    const database = storedCanonEntities();
    const records = planCanonCandidates(plan)
        .map(candidate => database[candidateRecordName(candidate, database, plan.work)])
        .filter(recordHasUsableBaseline)
        .filter((record, index, array) => array.findIndex(other =>
            canonRecordIdentityKey(other) === canonRecordIdentityKey(record)) === index);
    const persistedChanges = relevantAuFactsForNames([
        ...cleanDetectedEntities(plan.entities),
        ...records.map(record => record.entity),
    ], '', {
        recordKeys: records.map(record => canonRecordStorageKey(record, database)).filter(Boolean),
        works: records.map(record => record.work).filter(Boolean),
        work: plan.work || '',
    }).map(auFactText)
        .filter((change, index, array) => !array.slice(0, index)
            .some(saved => changesAreEquivalent(change, saved)));
    const nameCorrections = records.flatMap(record => recordAliases(record, record.entity)
        .filter(alias => canonicalEntityKey(alias) !== canonicalEntityKey(record.entity))
        .map(alias => `${alias} → ${record.entity}`));
    // `plan.canonChanges` is model output and may have failed evidence
    // validation in persistCanonDeltas().  Never inject those rejected
    // candidates for even one generation; only the persisted active state is
    // authoritative here.
    const allCanonChanges = persistedChanges
        .filter((change, index, array) => !array.slice(0, index).some(saved => changesAreEquivalent(change, saved)));
    const canonChanges = allCanonChanges.length
        ? allCanonChanges.join('；')
        : '本轮没有检测到正文明确声明的新差异；已有对象继续沿用原著资料和既有AU设定';
    const profiles = records.map(record => {
        const body = balancedExcerpt(canonBaselineText(record), 1200);
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

function localGenerationRecords(chat) {
    const database = storedCanonEntities();
    const cardProfile = profile();
    const latestUser = String([...(Array.isArray(chat) ? chat : [])]
        .reverse().find(message => message?.is_user && message?.mes)?.mes || '');
    const activeScene = currentSceneCanonRecords(cardProfile, database);
    const originalSceneKeys = currentOriginalSceneKeys(cardProfile);
    const latestMentioned = disambiguateMentionedCanonRecords(
        latestUser,
        relevantCanonRecords(latestUser, database),
        activeScene,
        cardProfile.workTitle || '',
    ).filter(record => !recordMatchesAnyEntityKey(record, originalSceneKeys));
    // A character-card filename/title is metadata, not an entity mention.  It
    // must never select a same-named canon row in a fresh chat.
    const names = cleanDetectedEntities(manualEntities(cardProfile.entities))
        .filter(name => !originalSceneKeys.has(canonicalEntityKey(name)));
    const namedRecords = names.flatMap(name => {
        const scoped = findCanonRecordNames(name, database, { work: cardProfile.workTitle || '' });
        return scoped.map(recordName => database[recordName]).filter(Boolean);
    });
    const selected = [
        // The newest user request is the highest-priority context.  It must not
        // be pushed past the prompt budget by stale scene/manual rows.
        ...latestMentioned,
        ...activeScene,
        ...namedRecords,
    ].filter(recordHasUsableBaseline)
        .filter((record, index, array) => array.findIndex(other =>
            canonRecordIdentityKey(other) === canonRecordIdentityKey(record)) === index);
    return { selected, latestUser };
}

function buildStoredGenerationReference(chat) {
    const cardProfile = profile();
    const cleanupWarning = cardProfile.cleanupPending
        ? '提示：旧聊天的禁用档案条目正在等待磁盘清理；它们不得作为当前聊天事实。'
        : '';
    const { selected, latestUser } = localGenerationRecords(chat);
    const explicitTimeAnchor = explicitTimeAnchorFromText(latestUser);
    const explicitTimelineDirective = explicitTimelineDirectiveFromText(latestUser);
    const effectiveTimeline = explicitTimelineDirective?.target || (explicitTimeAnchor
        ? timelineWithExplicitAnchor(cardProfile.timeline, explicitTimeAnchor)
        : cardProfile.timeline);
    const movedBackward = explicitTimeAnchor
        && timelineMovesBackward(cardProfile.timeline, explicitTimeAnchor);
    const selectedNames = selected.map(record => record.entity);
    const sceneRecords = currentSceneCanonRecords(cardProfile);
    const targetRecords = [...selected, ...sceneRecords].filter((record, index, array) => array.findIndex(other =>
        canonRecordIdentityKey(other) === canonRecordIdentityKey(record)) === index);
    const database = storedCanonEntities();
    const projectedFacts = relevantAuFactsForNames([
        ...selectedNames,
        ...currentSceneRecordNames(cardProfile),
    ], latestUser, {
        recordKeys: targetRecords.map(record => canonRecordStorageKey(record, database)).filter(Boolean),
        works: targetRecords.map(record => record.work).filter(Boolean),
    });
    // Persistent AU storage is intentionally unlimited.  Only the per-turn
    // relevant projection is bounded so a long-running card cannot make every
    // generation slower forever.
    const factProjectionText = fact => balancedExcerpt(auFactText(fact), 1200);
    const facts = [];
    let factProjectionBudget = 6000;
    const timelineSafeFacts = (movedBackward || explicitTimelineDirective)
        ? projectedFacts.filter(fact => !CHAT_DERIVED_AU_SOURCES.has(fact.source))
        : projectedFacts;
    for (const fact of [...timelineSafeFacts].sort((a, b) =>
        ((AU_SOURCE_PRIORITY[b.source] || 0) - (AU_SOURCE_PRIORITY[a.source] || 0))
        || ((Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)))) {
        const text = factProjectionText(fact);
        if (!text || text.length > factProjectionBudget) continue;
        facts.push(fact);
        factProjectionBudget -= text.length;
    }
    const scene = cardProfile.currentScene;
    const sceneText = scene && !movedBackward && !explicitTimelineDirective ? [
        `当前在场人物：${cleanDetectedEntities(scene.characters).join('、') || '无明确在场人物'}`,
        `当前地点：${cleanDetectedEntities(scene.locations).join('、') || '未确认'}`,
        `当前相关原作实体：${cleanDetectedEntities(scene.subjects).join('、') || '无'}`,
        `当前状态：${balancedExcerpt(stripMarkup(scene.summary || ''), 1200) || '按最近正文继续'}`,
    ].join('\n') : '';
    if (!selected.length && !facts.length && !sceneText && !cleanupWarning && !explicitTimelineDirective) return '';
    const sections = [];
    const emittedRecords = [];
    let used = 0;
    for (const record of selected) {
        if (explicitTimeAnchor && timelineMovesBackward(record.timeline || cardProfile.timeline, explicitTimeAnchor)) continue;
        const raw = canonBaselineText(record);
        if (!raw) continue;
        const text = balancedExcerpt(raw, 2200);
        const recordIdentity = {
            owner: record.entity,
            kind: record.kind,
            work: record.work,
            ownerRecordKey: canonRecordStorageKey(record, database),
        };
        const ownFacts = facts.filter(fact => sameAuOwnerIdentity(fact, recordIdentity));
        const sectionSize = text.length + ownFacts.reduce((total, fact) => total + factProjectionText(fact).length, 0);
        if (sections.length && used + sectionSize > 14000) continue;
        sections.push(`【${record.entity}｜${entityKindLabel(record.kind)}｜${record.work || '作品未确认'}】\n原著基线：${text}${ownFacts.length ? `\n本卡当前状态覆盖：${ownFacts.map(factProjectionText).join('；')}` : ''}`);
        emittedRecords.push(recordIdentity);
        used += sectionSize;
    }
    const unattachedFacts = facts.filter(fact => !emittedRecords.some(record => sameAuOwnerIdentity(fact, record)));
    return `<fandom_canon_reference>
这是当前续写实际相关的本地原著事实，不是登场清单或剧情提纲。只能在正文自行涉及对应对象时用于防止 OOC，不得据此安排对象登场或把 AU 拉回原作。
${cleanupWarning}
作品：${cardProfile.workTitle || '未确认'}
当前时间线：${effectiveTimeline || '未确认；不得擅自采用后期事实'}${movedBackward ? '\n用户本轮把时间锚点移到更早阶段；旧档案可能含未来事实，本轮已暂停注入这些基线和旧场景摘要，待后台按新节点重建。' : ''}
${explicitTimelineDirective ? `用户本轮明确时间线指令（最高优先，逐字依据）：${explicitTimelineDirective.evidence}\n旧场景摘要与聊天推导状态已暂停；不得沿用和该节点冲突的后期事实。` : ''}
${sceneText ? `当前聊天场景（只用于衔接，不代表必须让其中对象继续登场）：\n${sceneText}` : ''}
${sections.length ? `\n相关对象原著基线：\n${sections.join('\n\n')}` : ''}
 ${unattachedFacts.length ? `\n本卡当前有效的全局/未建档差异：\n${unattachedFacts.map(fact => `- ${factProjectionText(fact)}`).join('\n')}` : ''}

执行边界：
1. 角色卡、用户明确设定、启用世界书和“本卡当前状态覆盖”优先于原著基线。
2. 人物核对姓名、外貌、性格、经历、关系、能力和知识边界；地点、物品、能力、组织、事件与世界规则按各自档案核对名称、外观、归属、机制、限制和当前状态。
3. 严守当前时间线，不提前使用后期关系、能力、物品归属、伤亡、秘密或事件结果。
4. 档案未写明的细节不等于不存在；${settings().strictMode ? '严格模式下不得编造精确原作事实，可使用不冲突的模糊描写。' : '没有资料支持的细节应保持与已知原著和本卡设定不冲突。'}
5. 不要在正文提及插件、检索、资料库或这些规则。
</fandom_canon_reference>`;
}

function buildStoredAuReference(chat = getContext().chat ?? []) {
    return buildStoredGenerationReference(chat);
}

async function runPreflight(chat, type = 'normal', force = false, _abortGeneration = null) {
    const requestedScope = scopeIdentity();
    const requestedGenerationEpoch = foregroundGenerationEpoch;
    const isAutomaticGeneration = !force && type !== 'manual';
    const invocationFresh = () => requestedScope === scopeIdentity()
        && (!isAutomaticGeneration || (requestedGenerationEpoch === foregroundGenerationEpoch
            && stoppedGenerationEpoch !== requestedGenerationEpoch));
    if (String(type || '') === 'quiet') return;
    if ((force || type === 'manual') && isPageGenerating()) {
        toastr.warning('请先等待当前正文生成结束或按停止，再进行手动核验。', '晋阳的同人库');
        updateReport('手动核验未启动：当前正文仍在生成');
        return;
    }
    if ((force || type === 'manual') && busy) {
        toastr.info('已有一项识别或核验任务在运行，本次重复点击已忽略。', '晋阳的同人库');
        return;
    }
    if (isAutomaticGeneration && busy && settings().analysisSource === 'current') {
        // SillyTavern's generateRaw owns a private AbortController, so a manual
        // current-model analysis cannot actually be cancelled from here.  If
        // the main generation were allowed through, both requests would share
        // the same channel and its real START/STOP events would also be hidden
        // by internalAnalysisDepth.  Fail visibly before any upstream request.
        if (typeof _abortGeneration === 'function') _abortGeneration();
        toastr.warning('当前酒馆模型仍在执行手动核验；请等核验结束后再生成正文。', '晋阳的同人库');
        updateReport('本次正文生成已阻止：当前酒馆模型的手动核验尚未结束，避免并发请求、延迟 429 和半截正文误入库');
        return;
    }
    setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    lastReferenceText = '';
    lastRunSignature = '';
    if (!force && type !== 'manual') {
        // The generation interceptor is the earliest reliable boundary.  Stop
        // any queued/manual helper operation before the main model starts so a
        // stale analysis request cannot wake up behind it and compete for the
        // same upstream connection.
        invalidateManualOperations();
        invalidateScopeReviews();
        await ensureConversationScope();
        if (!invocationFresh()) return;
        // SillyTavern passes the interceptor a cloned, regex-processed coreChat.
        // Provenance and rollback must use the live messages with their real
        // swipe ids, send dates and unmodified text, or a normal generation can
        // look like a deletion/edit and roll valid scene state backwards.
        const activeChat = Array.isArray(getContext().chat) ? getContext().chat : chat;
        await reconcileDeletedWorldBookEntries();
        if (!invocationFresh()) return;
        await reconcileWorldInfoAuLifecycle(invocationFresh);
        if (!invocationFresh()) return;
        const reconciledProfile = profile();
        invalidateProfileTransactions(reconciledProfile);
        const reconciled = reconcileLocalMessageState(activeChat);
        if (reconciled.changed) {
            const repairScope = captureScopeToken();
            const repairRevision = markWorldSyncPending(reconciledProfile);
            repairWorldBookFromLocalState(
                reconciledProfile, repairScope, null, repairRevision,
            ).catch(error => {
                scheduleWorldBookRepair(reconciledProfile, repairScope, repairRevision);
                console.warn('[Fandom Canon] Deferred message-state world-book repair failed.', error);
            });
        } else if (reconciledProfile.worldSyncPending) {
            scheduleWorldBookRepair(
                reconciledProfile, captureScopeToken(),
                Number(reconciledProfile.worldSyncRevision) || 0,
            );
        }
        if (!invocationFresh()) return;
        const auReference = settings().enabled ? buildStoredGenerationReference(activeChat) : '';
        if (auReference) {
            setExtensionPrompt(PROMPT_KEY, auReference, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
            lastReferenceText = auReference;
            updateReport('正文已直接放行；已从本地资料注入当前相关原著基线与有效 AU，不调用分析 AI 或搜索 API');
        } else {
            updateReport('正文已直接放行；暂无当前相关的已核实本地档案，生成前不调用分析 AI 或搜索 API');
        }
        return;
    }
    const taskBusyOwner = ++busyOwner;
    busy = true;
    let scopeToken = null;
    const operationFresh = () => busyOwner === taskBusyOwner
        && invocationFresh()
        && (!scopeToken || scopeTokenIsCurrent(scopeToken));
    const startedAt = performance.now();
    const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1);
    try {
        await ensureConversationScope();
        if (!operationFresh()) return;
        // Manual verification is authoritative for this moment.  Abort and
        // settle any automatic post-review/research before reading or writing
        // the same profile, otherwise two independent searches can overlap.
        invalidateScopeReviews();
        await settleSceneTransactions();
        if (!operationFresh()) return;
        invalidateProfileTransactions(profile());
        const activeChat = Array.isArray(getContext().chat) ? getContext().chat : chat;
        const manualReconciled = reconcileLocalMessageState(activeChat);
        if (manualReconciled.changed) {
            const reconciledProfile = profile();
            const repairScope = captureScopeToken();
            const repairRevision = markWorldSyncPending(reconciledProfile);
            await repairWorldBookFromLocalState(
                reconciledProfile, repairScope, operationFresh, repairRevision,
            );
        }
        await reconcileDeletedWorldBookEntries();
        if (!operationFresh()) return;
        scopeToken = captureScopeToken();
        if (type === 'quiet' || (!settings().enabled && !force)) return;
        const signature = conversationSignature(activeChat);
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
            updateReport('缺少作品名或核验对象，已跳过');
            return;
        }

        updateReport('正在规划检索…');
        const plan = await planQueries(activeChat, operationFresh);
        if (!operationFresh()) return;
        plan.ignoreResearchBackoff = force === true;
        plan.freshnessGuard = operationFresh;
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
            : `${locallyChangedEntities.length ? `已增量写入 ${locallyChangedEntities.length} 个对象的本卡变化；` : '对象资料没有变化，不搜索、不改写世界书；'}正在读取本卡资料库…（${elapsed()} 秒）`, plan);
        let fetchedPages = [];
        let timedOut = false;
        if (shouldFetch && plan.queries.length) {
            if (missingEntities.length) {
                updateReport(`检测到新原作对象：${missingEntities.join('、')}；正在核对正式姓名与完整档案，最多等待 ${settings().newEntityWaitSeconds} 秒，超时转入后台下轮补全（${elapsed()} 秒）`, plan);
                const result = await waitForResearch(startCanonEnrichment(plan), settings().newEntityWaitSeconds);
                if (!operationFresh()) return;
                fetchedPages = result.pages;
                timedOut = result.timedOut;
            } else {
                const result = await waitForResearch(startCanonEnrichment(plan), settings().searchWaitSeconds);
                if (!operationFresh()) return;
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
        if (!operationFresh()) return;
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
        if (scopeToken && !scopeTokenIsCurrent(scopeToken)) return;
        console.error('[Fandom Canon] Retrieval failed.', error);
        lastRunSignature = '';
        updateReport(`检索失败：${error?.message || error}`);
    } finally {
        // No other manual task can acquire the lock while this task owns it.
        // Releasing it must not depend on the old chat scope still being live.
        if (busyOwner === taskBusyOwner) busy = false;
    }
}

globalThis.fandomCanonPreflight = async (chat, _contextSize, abortGeneration, type) =>
    runPreflight(chat, type, false, abortGeneration);

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
                <button id="fcr-auto-update-profile" class="fcr-check-row" type="button" aria-pressed="${config.autoUpdateProfile}"><span class="fcr-check-box" aria-hidden="true"></span><span>生成后自动更新场景、通用原作对象、时间节点与 AU（需独立分析 API）</span></button>
                <button id="fcr-strict" class="fcr-check-row" type="button" aria-pressed="${config.strictMode}"><span class="fcr-check-box" aria-hidden="true"></span><span>严格模式：没有资料依据时不编造精确设定</span></button>
                <button id="fcr-review" class="fcr-check-row" type="button" aria-pressed="${config.reviewEnabled}"><span class="fcr-check-box" aria-hidden="true"></span><span>生成后自动审核并最小修订原作冲突（人物/地点/物品/能力/规则等；需独立分析 API）</span></button>
                <div class="fcr-grid">
                    <label>Wikipedia 语言<select id="fcr-language"><option value="zh">中文</option><option value="ja">日文</option><option value="en">英文</option></select></label>
                    <label>每次最多查询数<input id="fcr-max-queries" type="number" min="1" max="10" value="${config.maxQueries}"></label>
                    <label>缓存分钟<input id="fcr-cache-minutes" type="number" min="10" max="10080" value="${config.cacheMinutes}"></label>
                    <label>已有资料增量检索最多等待（秒）<input id="fcr-search-wait" type="number" min="0" max="60" value="${config.searchWaitSeconds}"></label>
                    <label>新原作对象完整检索最多等待（秒）<input id="fcr-new-entity-wait" type="number" min="0" max="180" value="${config.newEntityWaitSeconds}"></label>
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
                        <div class="fcr-help">搜索 AI 会自主选择权威来源并返回引用；“智能选择”不会强制它先查 Wiki。模型列表先直连、跨域失败时才读取酒馆代理；分析与 Chat Completions 搜索只经同源代理发送一次 POST。Responses 联网模式须使用 HTTPS 并允许浏览器跨域访问（CORS）。</div>
                    </div>
                    <div class="fcr-help">搜索 Key 不写入插件设置或聊天记录。</div>
                </details>
                <details class="fcr-api-box fcr-llm-box" open>
                    <summary><i class="fa-solid fa-brain"></i> 分析 LLM 配置</summary>
                    <label>分析模型来源<select id="fcr-analysis-source">
                        <option value="current">当前酒馆模型（仅手动操作）</option>
                        <option value="custom">独立 OpenAI 兼容 API（自动后台必需）</option>
                    </select></label>
                    <div id="fcr-analysis-mode-state" class="fcr-help"></div>
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
                    <div class="fcr-help">独立 LLM 负责检索规划、资料核对、自动场景/AU 更新和生成后正文审校，不会改变角色回复使用的模型。Key 按酒馆账号隔离，仅保存在当前浏览器；换手机或电脑需要重新填写。</div>
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
        $('#fcr-analysis-mode-state').text('当前模型仅供“AI识别并填写 / 立即检索”等手动操作；自动场景同步、AU 更新与生成后审校已暂停，配置独立分析 API 后才会运行。');
    } else if (config.analysisModels.length && config.analysisModel && readLocalCredential('analysis')) {
        $('#fcr-llm-state').text(`已选择：${config.analysisModel}`).addClass('fcr-key-ok');
        $('#fcr-analysis-mode-state').text('独立分析 API 已选择；自动场景同步、AU 更新与生成后审校可以在正文完成后运行。');
    } else {
        $('#fcr-llm-state').text(readLocalCredential('analysis') ? '请检测地址并选择模型' : '请填写此设备的 Key，然后检测模型').removeClass('fcr-key-ok');
        $('#fcr-analysis-mode-state').text('自动后台功能尚未就绪：请填写独立分析 API 地址与 Key，并检测选择模型。');
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
        world_pending: '本地已保存，世界书正在自动补写',
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
    const analysisNotice = settings().analysisSource === 'custom'
        ? '' : '<div><b>自动后台：</b>已暂停（当前酒馆模型仅供手动操作；需配置独立分析 API）</div>';
    node.innerHTML = `<div><b>状态：</b>${escapeHtml(lastReport.status)}</div>${analysisNotice}<div><b>当前场景：</b>${escapeHtml(sceneStatus)}${sceneSync.updatedAt ? `（${escapeHtml(new Date(sceneSync.updatedAt).toLocaleTimeString())}）` : ''}</div>${sceneError}<div><b>本卡持久资料库：</b>${databaseCount} 个对象${worldBook ? `；同步到世界书「${escapeHtml(worldBook)}」` : '；当前角色未绑定世界书'}</div>${queries}${sources}`;
}

function invalidateCanonProfilesForManualEdit(cardProfile, key, previousValue, nextValue) {
    if (!['workTitle', 'timeline'].includes(key)) return [];
    const database = cardProfile.canonDatabase || {};
    const affected = [];
    if (key === 'timeline') {
        const activeWork = String(cardProfile.workTitle || '').trim();
        for (const [recordName, record] of Object.entries(database)) {
            if (!record?.entity) continue;
            if (activeWork && !recordWorkAliases(record)
                .some(work => fandomWorkIdentityMatches(activeWork, work))) continue;
            record.timeline = String(nextValue || '').trim();
            record.profileHash = '';
            record.baselineStatus = record.profile ? 'stale' : (record.baselineStatus || 'pending');
            record.updatedAt = Date.now();
            affected.push(recordName);
        }
    } else {
        // Profiles for the old work remain valid in storage, but clearing the
        // scene prevents them from leaking into the newly selected work.  Any
        // legacy row without a work identity is unsafe under the new scope.
        for (const [recordName, record] of Object.entries(database)) {
            if (String(record?.work || '').trim()) continue;
            record.profileHash = '';
            record.baselineStatus = record.profile ? 'stale' : (record.baselineStatus || 'pending');
            record.updatedAt = Date.now();
            affected.push(recordName);
        }
    }
    lastRunSignature = '';
    lastReferenceText = '';
    return affected;
}

function bindPanel() {
    const runtimeSensitiveSettings = new Set([
        'enabled', 'autoUpdateProfile', 'strictMode', 'reviewEnabled',
        'searchProvider', 'searchAiBaseUrl', 'searchAiModel', 'searchAiProtocol',
        'analysisSource', 'analysisBaseUrl', 'analysisModel',
    ]);
    const afterSettingChange = key => {
        if (runtimeSensitiveSettings.has(key)) clearRuntimeState();
        if (key === 'strictMode') {
            const cardProfile = profile();
            const scopeToken = captureScopeToken();
            const syncRevision = markWorldSyncPending(cardProfile);
            repairWorldBookFromLocalState(cardProfile, scopeToken, null, syncRevision)
                .catch(error => {
                    scheduleWorldBookRepair(cardProfile, scopeToken, syncRevision);
                    console.error('[Fandom Canon] Could not refresh strict-mode world-book entries.', error);
                });
        }
    };
    const bindSetting = (selector, key, transform = value => value) => {
        $(selector).on('change input', function () {
            settings()[key] = transform(this.type === 'checkbox' ? this.checked : this.value);
            afterSettingChange(key);
            saveSettingsDebounced();
        });
    };
    const bindToggle = (selector, key) => {
        const button = document.querySelector(selector);
        if (!(button instanceof HTMLButtonElement)) return;
        const render = () => button.setAttribute('aria-pressed', String(Boolean(settings()[key])));
        button.addEventListener('click', () => {
            settings()[key] = !Boolean(settings()[key]);
            afterSettingChange(key);
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
    bindSetting('#fcr-max-queries', 'maxQueries', value => clampInt(value, 1, 10, 3));
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
        $(selector).on('change input', async function () {
            const expectedValue = this.value;
            const expectedScope = scopeIdentity();
            invalidateScopeReviews();
            await settleSceneTransactions(expectedScope);
            if (expectedScope !== scopeIdentity() || this.value !== expectedValue) return;
            const cardProfile = profile();
            const previousValue = cardProfile[key];
            if (String(previousValue ?? '') === String(expectedValue ?? '')) return;
            const transactionEpoch = invalidateProfileTransactions(cardProfile);
            cardProfile[key] = expectedValue;
            if (['workTitle', 'timeline'].includes(key)) {
                cardProfile.currentScene = null;
                cardProfile.sceneHistory = [];
                cardProfile.sceneSync = {
                    status: 'idle', signature: '', messageId: null, updatedAt: Date.now(),
                    error: '', retryCount: 0, nextRetryAt: 0,
                    formatVersion: SCENE_SYNC_FORMAT_VERSION,
                };
                invalidateCanonProfilesForManualEdit(
                    cardProfile, key, previousValue, expectedValue,
                );
            }
            saveSettingsDebounced();
            if (!['workTitle', 'timeline'].includes(key)) return;
            const syncRevision = markWorldSyncPending(cardProfile);
            const editScopeToken = captureScopeToken();
            const editFresh = () => scopeTokenIsCurrent(editScopeToken)
                && profileTransactionEpochs.get(cardProfile) === transactionEpoch;
            try {
                await repairWorldBookFromLocalState(
                    cardProfile, editScopeToken, editFresh, syncRevision,
                );
            } catch (error) {
                if (!editFresh()) return;
                cardProfile.worldSyncPending = true;
                scheduleWorldBookRepair(cardProfile, editScopeToken, syncRevision);
                saveSettingsDebounced();
                console.error('[Fandom Canon] Manual work/timeline edit could not refresh the world book.', error);
                updateReport(`手动修改已保存，但旧场景世界书清理暂未完成：${error?.message || error}`);
            }
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
    if (!currentCharacter() && !currentGroup()) return;
    await ensureConversationScope();
    const cardProfile = profile();
    if (!(await retryPendingWorldBookCleanup(cardProfile, { force: true }))) {
        const syncRevision = markWorldSyncPending(cardProfile);
        scheduleWorldBookRepair(cardProfile, captureScopeToken(), syncRevision);
        return;
    }
    if ((cardProfile.canonDatabaseFormatVersion || 0) < 4) {
        const legacyWorldBooks = [...new Set([
            currentWorldBookName(), cardProfile.canonWorldBook,
            ...(cardProfile.writtenWorldBooks || []),
        ].map(String).filter(Boolean))];
        try {
            await clearProfileWorldBookEntries(cardProfile, profileKey());
        } catch (error) {
            cardProfile.cleanupPending = {
                profileKey: profileKey(),
                profileKeys: [profileKey()],
                worldBooks: legacyWorldBooks,
                error: error?.message || String(error),
                at: Date.now(),
                nextRetryAt: Date.now() + 30000,
            };
            const syncRevision = markWorldSyncPending(cardProfile);
            scheduleWorldBookRepair(cardProfile, captureScopeToken(), syncRevision);
            updateReport(`旧版世界书条目暂时无法安全清理，已延后迁移：${error?.message || error}`);
            return;
        }
        cardProfile.canonDatabase = {};
        cardProfile.canonDatabaseFormatVersion = CANON_DATABASE_FORMAT_VERSION;
        cardProfile.entities = cleanDetectedEntities(manualEntities(cardProfile.entities)).join('，');
        cardProfile.lastAutoEntities = cleanDetectedEntities(cardProfile.lastAutoEntities);
        saveSettingsDebounced();
        loadProfileIntoPanel();
        updateReport('已清除旧版错误混合资料，正在按对象分别重建完整基础档案…');
        runPreflight(getContext().chat ?? [], 'manual', true)
            .catch(error => console.error('[Fandom Canon] Could not rebuild canon database.', error));
        return;
    }
    if ((cardProfile.canonDatabaseFormatVersion || 0) < CANON_DATABASE_FORMAT_VERSION) {
        invalidateProfileTransactions(cardProfile);
        const database = storedCanonEntities();
        ensureStructuredAuState(cardProfile, database);
        rollbackAuFactsByProvenance(cardProfile, origin =>
            CHAT_DERIVED_AU_SOURCES.has(origin.source) && !origin.messageSignature);
        applyVerifiedEntityKinds(cardProfile.currentScene?.entities || [], database);
        for (const record of Object.values(database)) {
            const migratedKind = normalizeEntityKind(record.kind, 'unknown');
            record.kind = migratedKind;
            record.kindVerified = record.kindVerified === true
                && CANON_ENTITY_KINDS.has(migratedKind);
            const hasBaselineMaterial = Boolean(record.profile) || Boolean(record.sources?.length);
            // `baselineStatus` in pre-2.5 data did not prove that a same-name
            // page belonged to this exact work/entity.  Preserve explicit new
            // sourceTrust only; legacy rows must be revalidated before strict
            // mode can use them.
            record.sourceTrust = record.sourceTrust === 'verified' ? 'verified' : 'provisional';
            record.baselineStatus = hasBaselineMaterial ? 'stale' : 'pending';
            record.profileHash = '';
            record.profileFormatVersion = record.profile ? CANON_PROFILE_FORMAT_VERSION : 0;
        }
        cardProfile.canonDatabaseFormatVersion = CANON_DATABASE_FORMAT_VERSION;
        const migrationRevision = markWorldSyncPending(cardProfile);
        await repairWorldBookFromLocalState(
            cardProfile, captureScopeToken(), null, migrationRevision,
        );
        updateReport('已升级为通用实体与结构化 AU 数据库；旧资料已保留并修正归属');
        const activeNames = currentSceneRecordNames(cardProfile).filter(name => findCanonRecordName(name, database));
        if (activeNames.length) {
            const warmPlan = {
                work: cardProfile.workTitle,
                timeline: cardProfile.timeline,
                entities: activeNames,
                freshnessGuard: () => profile() === cardProfile && currentConversationId() === cardProfile.conversationId,
            };
            ensureCanonProfiles(warmPlan).then(updated => {
                if (updated.length) reconcileLatestAssistantMessage('升级后活动实体档案复核', 300);
            }).catch(error => console.warn('[Fandom Canon] Active legacy profiles will be refreshed on demand.', error));
        }
    }
    if (cardProfile.worldSyncPending) {
        const scopeToken = captureScopeToken();
        const syncRevision = Number(cardProfile.worldSyncRevision) > 0
            ? Number(cardProfile.worldSyncRevision) : markWorldSyncPending(cardProfile);
        try {
            await repairWorldBookFromLocalState(
                cardProfile, scopeToken, null, syncRevision,
            );
        } catch (error) {
            scheduleWorldBookRepair(cardProfile, scopeToken, syncRevision);
            console.warn('[Fandom Canon] Deferred world-book transaction repair will retry later.', error);
        }
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
    setTimeout(async () => {
        try {
            await sanitizePersistedProfiles();
            await refreshOrMigrateCanonDatabase();
        } catch (error) {
            console.error('[Fandom Canon] Could not sanitize or migrate canon database.', error);
        }
    }, 1200);
    installMainEntries();
    const entryTimer = setInterval(() => {
        if (installMainEntries()) clearInterval(entryTimer);
    }, 500);
    setTimeout(() => clearInterval(entryTimer), 15000);
    setTimeout(() => showReleaseNotesOnce()
        .catch(error => console.error('[Fandom Canon] Could not show release notes.', error)), 1200);
    const context = getContext();
    context.eventSource?.on?.(context.eventTypes?.CHAT_CHANGED ?? 'chat_id_changed', () => {
        const expectedScope = scopeIdentity();
        setTimeout(async () => {
            if (expectedScope !== scopeIdentity()) return;
            // Invalidate requests from the old chat immediately.  A same-card
            // chat switch can make ensureConversationScope() clear runtime
            // state once more, so capture the usable token only afterwards.
            clearRuntimeState();
            try {
                await ensureConversationScope();
                if (expectedScope !== scopeIdentity()) return;
                const scopeToken = captureScopeToken();
                loadProfileIntoPanel();
                await refreshOrMigrateCanonDatabase();
                if (!scopeTokenIsCurrent(scopeToken)) return;
                reconcileLatestAssistantMessage('切换聊天后补同步', 1200);
            } catch (error) {
                console.error('[Fandom Canon] Could not refresh canon database.', error);
            }
        }, 150);
    });
    context.eventSource?.on?.(context.eventTypes?.MESSAGE_DELETED ?? 'message_deleted', detail => {
        const deletedMessageId = Number(detail?.messageId ?? detail);
        const eventScopeToken = captureScopeToken();
        invalidateScopeReviews();
        setTimeout(async () => {
        if (!scopeTokenIsCurrent(eventScopeToken)) return;
        try {
            await ensureConversationScope();
            if (!scopeTokenIsCurrent(eventScopeToken)) return;
            await rollbackMessageDerivedState(deletedMessageId, { reconcileAll: true });
            if (!scopeTokenIsCurrent(eventScopeToken)) return;
            const visibleMessages = (Array.isArray(getContext().chat) ? getContext().chat : [])
                .filter(message => message && !message.is_system);
            const hasUserMessage = visibleMessages.some(message => message.is_user);
            if (!hasUserMessage && visibleMessages.length <= 1 && profileHasConversationData()) {
                await resetCurrentConversationData({
                    reason: '检测到聊天记录已清空；当前角色卡本局资料已自动重置，其他角色卡未受影响',
                });
            } else {
                reconcileLatestAssistantMessage('删除消息后回滚当前场景', 300);
            }
        } catch (error) {
            console.error('[Fandom Canon] Could not reset data after chat deletion.', error);
        }
        }, 250);
    });
    context.eventSource?.on?.(context.eventTypes?.MESSAGE_RECEIVED ?? 'message_received', (messageId, type) => {
        foregroundGenerationActive = false;
        const delayMs = settings().analysisSource === 'custom' ? 650 : 1800;
        scheduleMessageReview(messageId, type, { delayMs, reason: '消息接收完成', generationEpoch: foregroundGenerationEpoch });
    });
    context.eventSource?.on?.(context.eventTypes?.CHARACTER_MESSAGE_RENDERED ?? 'character_message_rendered', (messageId, type) => {
        foregroundGenerationActive = false;
        const delayMs = settings().analysisSource === 'custom' ? 900 : 2100;
        scheduleMessageReview(messageId, type, { delayMs, reason: '消息渲染完成', generationEpoch: foregroundGenerationEpoch });
    });
    context.eventSource?.on?.(context.eventTypes?.GENERATION_STARTED ?? 'generation_started', (type, options, dryRun) => {
        if (internalAnalysisDepth > 0) return;
        if (dryRun === true || String(type || '') === 'quiet') return;
        foregroundGenerationActive = true;
        foregroundGenerationEpoch++;
        invalidateManualOperations();
        generationAfterCommandsEpoch = -1;
        stoppedGenerationEpoch = -1;
        invalidateScopeReviews();
        scheduleGenerationStateWatchdog(foregroundGenerationEpoch, 'started');
    });
    context.eventSource?.on?.(context.eventTypes?.GENERATION_AFTER_COMMANDS ?? 'GENERATION_AFTER_COMMANDS', (type, options, dryRun) => {
        if (internalAnalysisDepth > 0) return;
        if (dryRun === true || String(type || '') === 'quiet') return;
        generationAfterCommandsEpoch = foregroundGenerationEpoch;
    });
    context.eventSource?.on?.(context.eventTypes?.GENERATION_ENDED ?? 'generation_ended', () => {
        if (internalAnalysisDepth > 0) return;
        foregroundGenerationActive = false;
        const epoch = foregroundGenerationEpoch;
        const eventScopeToken = captureScopeToken();
        setTimeout(() => {
            if (!scopeTokenIsCurrent(eventScopeToken)
                || epoch !== foregroundGenerationEpoch || stoppedGenerationEpoch === epoch) return;
            reconcileLatestAssistantMessage('生成结束兜底', 500);
        }, 900);
    });
    context.eventSource?.on?.(context.eventTypes?.GENERATION_STOPPED ?? 'generation_stopped', () => {
        if (internalAnalysisDepth > 0) return;
        foregroundGenerationActive = false;
        stoppedGenerationEpoch = foregroundGenerationEpoch;
        invalidateScopeReviews();
        updateReport('检测到用户停止生成：已取消本轮待执行的资料审核，半截正文不会写入 AU 或世界书');
    });
    context.eventSource?.on?.(context.eventTypes?.MESSAGE_SWIPED ?? 'message_swiped', messageId => {
        const eventScopeToken = captureScopeToken();
        invalidateMessageReview(messageId);
        setTimeout(async () => {
            if (!scopeTokenIsCurrent(eventScopeToken)) return;
            const message = getContext().chat?.[Number(messageId)];
            if (!message || message.is_user || message.is_system) return;
            try {
                await rollbackMessageDerivedState(messageId);
                if (!scopeTokenIsCurrent(eventScopeToken)) return;
            } catch (error) {
                console.error('[Fandom Canon] Could not roll back the previous swipe state.', error);
            }
            if (Number.isInteger(message.swipe_id) && Array.isArray(message.swipes)
                && message.swipe_id >= message.swipes.length) return;
            scheduleMessageReview(messageId, 'swipe', {
                delayMs: 750,
                reason: '切换回复版本',
                allowStopped: true,
                generationEpoch: foregroundGenerationEpoch,
            });
        }, 150);
    });
    for (const [eventName, fallback] of [
        ['MESSAGE_UPDATED', 'message_updated'],
        ['MESSAGE_EDITED', 'message_edited'],
    ]) {
        context.eventSource?.on?.(context.eventTypes?.[eventName] ?? fallback, messageId => {
            if (internalMessageUpdateDepth > 0) return;
            const eventScopeToken = captureScopeToken();
            invalidateMessageReview(messageId);
            setTimeout(async () => {
                if (!scopeTokenIsCurrent(eventScopeToken)) return;
                try {
                    await rollbackMessageDerivedState(messageId);
                    if (!scopeTokenIsCurrent(eventScopeToken)) return;
                } catch (error) {
                    console.error('[Fandom Canon] Could not roll back the edited message state.', error);
                }
                const updated = getContext().chat?.[Number(messageId)];
                if (updated && !updated.is_user && !updated.is_system && isLatestAssistantMessage(messageId)) {
                    scheduleMessageReview(messageId, 'normal', {
                        delayMs: 900,
                        reason: '消息内容更新',
                        allowStopped: true,
                        generationEpoch: foregroundGenerationEpoch,
                    });
                } else {
                    reconcileLatestAssistantMessage('较早消息修改后重建最新场景', 900);
                }
            }, 100);
        });
    }
    context.eventSource?.on?.(context.eventTypes?.MESSAGE_SWIPE_DELETED ?? 'message_swipe_deleted', detail => {
        const messageId = Number(detail?.messageId);
        const eventScopeToken = captureScopeToken();
        invalidateMessageReview(messageId);
        setTimeout(async () => {
            if (!scopeTokenIsCurrent(eventScopeToken)) return;
            try {
                await rollbackMessageDerivedState(messageId);
                if (!scopeTokenIsCurrent(eventScopeToken)) return;
            } catch (error) {
                console.error('[Fandom Canon] Could not roll back the deleted swipe state.', error);
            }
            scheduleMessageReview(messageId, 'swipe', {
                delayMs: 750,
                reason: '回复版本删除后同步',
                allowStopped: true,
                generationEpoch: foregroundGenerationEpoch,
            });
        }, 100);
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
