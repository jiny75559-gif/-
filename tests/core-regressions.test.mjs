import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sourcePath = new URL('../index.js', import.meta.url);

function loadCore() {
    let source = readFileSync(sourcePath, 'utf8')
        .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];\s*/g, '');
    const initializeAt = source.indexOf("if (document.readyState === 'loading')");
    source = source.slice(0, initializeAt);
    const prefix = `
        const extension_settings = {};
        const saveSettingsDebounced = () => {};
        const setExtensionPrompt = () => {};
        const updateMessageBlock = () => {};
        const getRequestHeaders = () => ({});
        const getCurrentUserHandle = () => 'test-user';
        const getContext = () => globalThis.__fcrTestContext;
        const extension_prompt_types = { IN_PROMPT: 0 };
        const extension_prompt_roles = { SYSTEM: 0 };
        const SECRET_KEYS = { TAVILY: 'tavily', SERPER: 'serper', SERPAPI: 'serpapi' };
        const secret_state = {};
        const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
        const setTimeout = (callback, delay, ...args) => {
            const timer = globalThis.setTimeout(callback, delay, ...args);
            timer?.unref?.();
            return timer;
        };
        const document = {
            body: { classList: { contains: () => false } },
            querySelector: () => null,
            createElement: () => ({
                _html: '',
                textContent: '',
                set innerHTML(value) {
                    this._html = String(value);
                    this.textContent = this._html.replace(/<[^>]+>/g, ' ');
                },
                get innerHTML() { return this._html; },
            }),
        };
    `;
    const expose = `
        globalThis.__fcrCore = {
            settings, profile, storedCanonEntities, ensureStructuredAuState, activeAuFacts,
            persistCanonDeltas, cleanCanonChanges, cleanCanonSubjectCandidates,
            buildStoredGenerationReference, applyTextRevisions, explicitTimeAnchorFromText,
            explicitTimelineDirectiveFromText, sceneWithExplicitTimelineDirective,
            normalizeEntityKind, researchFieldsForKind, auFactText, cleanDetectedEntities,
            wikiQueryVariants, sceneRetryDelay, canonTimelineCore, scenePlanFromAnalysis,
            applyVerifiedEntityKinds, relevantAuFactsForNames, saveCanonResearch,
            recordHasUsableBaseline, formatCanonWorldEntry,
            canonProfileHash, canonProfileNeedsRefresh,
            rollbackAuFactsByProvenance, reconcileMessageDerivedAuFacts,
            sanitizeCanonDatabase, findCanonRecordName, findCanonRecordNames,
            fandomWorkIdentityMatches, customPageIdentityIsVerified,
            canonCandidateIdentityKey, researchJobKey, pluginWorldEntryFingerprint,
            evidenceDescribesStateChange, auEvidenceMatches, syncProfileFromPlan,
            sceneWithExplicitTimeAnchor, timelineMovesBackward, timelineWithExplicitAnchor,
            reconcileLocalMessageState, messageProvenanceSignature,
            recordWorkAliases, disambiguateMentionedCanonRecords,
            candidateRecordName, localGenerationRecords, recordsForReview,
            mergeSceneWithNarrativeBanner, canonProfileMaterial, buildReviewPrompt,
            modelRevisionIsGrounded, contextAwareExcerpt,
        };
    `;
    globalThis.__fcrTestContext = {
        characters: [{ name: 'DC', avatar: 'DC.png', data: {} }],
        characterId: 0,
        chatId: 'chat-a',
        chat: [],
        groups: [],
    };
    // The extension has no top-level side effects before initialize(). This
    // evaluates its real pure/data functions with only the browser imports stubbed.
    new Function(`${prefix}\n${source}\n${expose}`)();
    return globalThis.__fcrCore;
}

function freshProfile(core) {
    const config = core.settings();
    config.profiles = {};
    const cardProfile = core.profile();
    cardProfile.canonDatabase = {};
    cardProfile.auFacts = [];
    cardProfile.auHistory = [];
    cardProfile.auChanges = [];
    return cardProfile;
}

test('legacy relationship text is owned only by the entity before the colon', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase = {
        '史蒂芬·斯特兰奇': {
            entity: '史蒂芬·斯特兰奇', kind: 'character', aliases: ['斯特兰奇'],
            sources: [{ title: 'Doctor Strange', extract: '史蒂芬·斯特兰奇是至尊法师。' }],
            canonChanges: ['彼得·帕克：未前往外星，而是被斯特兰奇送回纽约。'],
        },
        '彼得·帕克': {
            entity: '彼得·帕克', kind: 'character', aliases: ['彼得'],
            sources: [{ title: 'Peter Parker', extract: '彼得·帕克是蜘蛛侠。' }],
            canonChanges: [],
        },
    };
    cardProfile.auFacts = null;
    cardProfile.auChanges = ['彼得·帕克：未前往外星，而是被斯特兰奇送回纽约。'];
    core.ensureStructuredAuState(cardProfile, cardProfile.canonDatabase);
    assert.deepEqual(cardProfile.canonDatabase['史蒂芬·斯特兰奇'].canonChanges, []);
    assert.equal(cardProfile.canonDatabase['彼得·帕克'].canonChanges.length, 1);
});

test('same owner and facet replaces active AU while preserving history', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase['史蒂芬·斯特兰奇'] = {
        entity: '史蒂芬·斯特兰奇', kind: 'character', work: '漫威电影宇宙',
        aliases: ['斯特兰奇'], sources: [], canonChanges: [],
    };
    globalThis.__fcrTestContext.chat = [
        { is_user: true, mes: '这个世界没有时间宝石', send_date: 'user-a' },
        { is_user: false, mes: '知道了。', send_date: 'assistant-a' },
    ];
    const basePlan = {
        work: '漫威电影宇宙', timeline: '2017年初', entities: ['史蒂芬·斯特兰奇'],
        entityCandidates: [{ candidateName: '史蒂芬·斯特兰奇', kind: 'character', workHint: '漫威电影宇宙', isOriginal: false }],
    };
    await core.persistCanonDeltas({
        ...basePlan,
        messageId: 1,
        canonChanges: [{
            entity: '史蒂芬·斯特兰奇', kind: 'character', facet: 'item.时间宝石',
            current: '这个世界没有时间宝石', source: 'user', evidence: '这个世界没有时间宝石',
        }],
        auEvidenceSources: { user: '这个世界没有时间宝石' },
    }, { syncScene: false, syncCanon: false });
    globalThis.__fcrTestContext.chat.push(
        { is_user: true, mes: '时间宝石已经重新获得', send_date: 'user-b' },
        { is_user: false, mes: '状态已更新。', send_date: 'assistant-b' },
    );
    await core.persistCanonDeltas({
        ...basePlan,
        messageId: 3,
        canonChanges: [{
            entity: '史蒂芬·斯特兰奇', kind: 'character', facet: 'item.时间宝石',
            current: '时间宝石已经重新获得', source: 'user', evidence: '时间宝石已经重新获得',
            replaces: ['史蒂芬·斯特兰奇：这个世界没有时间宝石'],
        }],
        auEvidenceSources: { user: '时间宝石已经重新获得' },
    }, { syncScene: false, syncCanon: false });
    assert.equal(core.activeAuFacts(cardProfile).length, 1);
    assert.match(core.auFactText(core.activeAuFacts(cardProfile)[0]), /重新获得/);
    assert.equal(cardProfile.auHistory.length, 1);
    assert.match(core.auFactText(cardProfile.auHistory[0]), /没有时间宝石/);
});

test('assistant static assertion is rejected but an explicit state-changing event is accepted', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    globalThis.__fcrTestContext.chat = [
        { is_user: false, mes: '神器归主角所有', send_date: 'assistant-static' },
    ];
    const plan = {
        work: '测试作品', timeline: '', entities: ['神器'],
        messageId: 0,
        entityCandidates: [{ candidateName: '神器', kind: 'item', workHint: '测试作品', isOriginal: false }],
        canonChanges: [{
            entity: '神器', kind: 'item', facet: 'owner', current: '归主角所有',
            source: 'assistant_event', evidence: '神器归主角所有', eventChanged: false,
        }],
        auEvidenceSources: { assistant_event: '神器归主角所有' },
    };
    await core.persistCanonDeltas(plan, { syncScene: false, syncCanon: false });
    assert.equal(core.activeAuFacts(cardProfile).length, 0);
    globalThis.__fcrTestContext.chat.push({
        is_user: false, mes: '主角夺走了神器', send_date: 'assistant-event',
    });
    await core.persistCanonDeltas({
        ...plan,
        messageId: 1,
        canonChanges: [{
            entity: '神器', kind: 'item', facet: 'owner', current: '被主角夺走并持有',
            source: 'assistant_event', evidence: '主角夺走了神器', eventChanged: true,
        }],
        auEvidenceSources: { assistant_event: '主角夺走了神器' },
    }, { syncScene: false, syncCanon: false });
    assert.equal(core.activeAuFacts(cardProfile).length, 1);
});

test('deleting the middle and newest messages restores an A→B→C AU chain back to A', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase['时间宝石'] = {
        entity: '时间宝石', kind: 'item', work: '测试作品', aliases: ['时间宝石'],
        sources: [], canonChanges: [],
    };
    const messages = [
        { is_user: true, mes: '时间宝石现在封印在神殿', send_date: 'chain-user-a' },
        { is_user: false, mes: '继续。', send_date: 'chain-assistant-a' },
        { is_user: true, mes: '时间宝石被斯特兰奇取走了', send_date: 'chain-user-b' },
        { is_user: false, mes: '继续。', send_date: 'chain-assistant-b' },
        { is_user: true, mes: '时间宝石又被放回了神殿', send_date: 'chain-user-c' },
        { is_user: false, mes: '继续。', send_date: 'chain-assistant-c' },
    ];
    globalThis.__fcrTestContext.chat = messages;
    const basePlan = {
        work: '测试作品', timeline: '', entities: ['时间宝石'],
        entityCandidates: [{ candidateName: '时间宝石', kind: 'item', workHint: '测试作品', isOriginal: false }],
    };
    const states = [
        { messageId: 1, current: '封印在神殿', evidence: '时间宝石现在封印在神殿' },
        { messageId: 3, current: '被斯特兰奇取走', evidence: '时间宝石被斯特兰奇取走了' },
        { messageId: 5, current: '放回神殿', evidence: '时间宝石又被放回了神殿' },
    ];
    for (const state of states) {
        await core.persistCanonDeltas({
            ...basePlan,
            messageId: state.messageId,
            canonChanges: [{
                entity: '时间宝石', kind: 'item', facet: 'location', current: state.current,
                source: 'user', evidence: state.evidence,
            }],
            auEvidenceSources: { user: state.evidence },
        }, { syncScene: false, syncCanon: false });
    }
    assert.match(core.auFactText(core.activeAuFacts(cardProfile)[0]), /放回神殿/);
    assert.equal(cardProfile.auHistory.length, 2);

    const withoutB = messages.filter(message => message.send_date !== 'chain-user-b');
    core.reconcileMessageDerivedAuFacts(cardProfile, withoutB);
    assert.match(core.auFactText(core.activeAuFacts(cardProfile)[0]), /放回神殿/);
    assert.equal(cardProfile.auHistory.length, 1);
    assert.match(core.auFactText(cardProfile.auHistory[0]), /封印在神殿/);

    const withoutBOrC = withoutB.filter(message => message.send_date !== 'chain-user-c');
    core.reconcileMessageDerivedAuFacts(cardProfile, withoutBOrC);
    assert.equal(core.activeAuFacts(cardProfile).length, 1);
    assert.match(core.auFactText(core.activeAuFacts(cardProfile)[0]), /封印在神殿/);
    assert.equal(cardProfile.auHistory.length, 0);
});

test('all supported canon entity kinds survive normalization', () => {
    const core = loadCore();
    const values = ['character', 'location', 'item', 'ability', 'organization', 'event', 'world_rule']
        .map((kind, index) => ({ candidateName: `对象${index}`, kind, isOriginal: false }));
    assert.deepEqual(core.cleanCanonSubjectCandidates(values).map(item => item.kind),
        ['character', 'location', 'item', 'ability', 'organization', 'event', 'world_rule']);
    assert.match(core.researchFieldsForKind('item'), /持有者|功能/);
    assert.match(core.researchFieldsForKind('ability'), /机制|限制/);
});

test('normal preflight reference includes active scene canon without a literal mention', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.workTitle = '漫威电影宇宙';
    cardProfile.timeline = '2017年初';
    cardProfile.currentScene = { characters: ['史蒂芬·斯特兰奇'], locations: [], pinned: [] };
    cardProfile.canonDatabase['史蒂芬·斯特兰奇'] = {
        entity: '史蒂芬·斯特兰奇', kind: 'character', work: '漫威电影宇宙', aliases: ['斯特兰奇'],
        profile: '史蒂芬·斯特兰奇是克制、理性而自负的法师。', profileFormatVersion: 2,
        baselineStatus: 'verified', sourceTrust: 'verified', sources: [], canonChanges: [],
    };
    const reference = core.buildStoredGenerationReference([{ is_user: true, mes: '他接下来会怎么做？' }]);
    assert.match(reference, /史蒂芬·斯特兰奇/);
    assert.match(reference, /克制、理性/);
});

test('an isOriginal scene entity never pulls in a same-name canon profile', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.workTitle = '用户原创世界';
    cardProfile.timeline = '用户原创世界（仅含同人角色，非原作剧情）';
    cardProfile.currentScene = {
        characters: ['爱丽丝'], locations: [], subjects: [], pinned: [], summary: '原创角色正在房间里。',
        entities: [{ candidateName: '爱丽丝', kind: 'character', isOriginal: true, workHint: '' }],
        subjectEntities: [],
    };
    cardProfile.canonDatabase['爱丽丝'] = {
        entity: '爱丽丝', kind: 'character', work: '某原作', aliases: ['爱丽丝'],
        profile: '原作爱丽丝的秘密档案标记，原创同名角色绝不得读取。',
        profileFormatVersion: 2, baselineStatus: 'verified', sourceTrust: 'verified', sources: [], canonChanges: [],
    };
    const reference = core.buildStoredGenerationReference([{ is_user: true, mes: '继续写。' }]);
    assert.match(reference, /原创角色正在房间里/);
    assert.doesNotMatch(reference, /原作爱丽丝的秘密档案标记/);
});

test('repeated wrong proper name can be corrected in every occurrence', () => {
    const core = loadCore();
    const result = core.applyTextRevisions('朝美走进来。朝美坐下。', [{
        original: '朝美', revised: '结城朝美', entity: '结城朝美', aspect: '姓名译名', replaceAll: true,
    }]);
    assert.equal(result.updated, '结城朝美走进来。结城朝美坐下。');
    assert.equal(result.applied.length, 1);
});

test('a year in a recollection is not treated as the current timeline anchor', () => {
    const core = loadCore();
    assert.equal(core.explicitTimeAnchorFromText('她回忆起2017年初发生的事情。'), '');
    assert.equal(core.explicitTimeAnchorFromText('当前时间设定是2017年初。'), '2017年初');
});

test('automatic analysis preserves manually edited work and timeline while explicit user anchors can move either way', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.workTitle = '用户手填作品';
    cardProfile.lastAutoWorkTitle = '之前自动识别的作品';
    cardProfile.timeline = '2019年底，用户手工节点';
    cardProfile.lastAutoTimeline = '2018年初';
    core.syncProfileFromPlan({
        work: 'AI误判作品', timeline: '2022年底', entities: [], updateEntities: false,
    });
    assert.equal(cardProfile.workTitle, '用户手填作品');
    assert.equal(cardProfile.timeline, '2019年底，用户手工节点');

    const forwardAnchor = core.explicitTimeAnchorFromText('当前时间设定为2020年初。');
    const forwardScene = core.sceneWithExplicitTimeAnchor({ workTitle: 'AI误判作品' }, forwardAnchor);
    const forwardPlan = core.scenePlanFromAnalysis(forwardScene);
    assert.equal(forwardPlan.work, '用户手填作品');
    assert.match(forwardPlan.timeline, /^2020年初/);
    assert.equal(forwardPlan.timelineChanged, true);

    const backwardAnchor = core.explicitTimeAnchorFromText('本轮时间节点回到2017年初。');
    const backwardScene = core.sceneWithExplicitTimeAnchor({ workTitle: 'AI误判作品' }, backwardAnchor);
    const backwardPlan = core.scenePlanFromAnalysis(backwardScene);
    assert.equal(backwardPlan.work, '用户手填作品');
    assert.match(backwardPlan.timeline, /^2017年初/);
    assert.equal(backwardPlan.timelineChanged, true);
    assert.equal(core.timelineMovesBackward(cardProfile.timeline, backwardAnchor), true);
});

test('an explicit user rollback suppresses later scene summaries and later-timeline canon profiles before generation', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.workTitle = '漫威电影宇宙';
    cardProfile.lastAutoWorkTitle = '漫威电影宇宙';
    cardProfile.timeline = '2019年底，终局之战后';
    cardProfile.lastAutoTimeline = cardProfile.timeline;
    cardProfile.entities = '托尼·斯塔克';
    cardProfile.lastAutoEntities = ['托尼·斯塔克'];
    cardProfile.canonDatabase['托尼·斯塔克'] = {
        entity: '托尼·斯塔克', kind: 'character', work: '漫威电影宇宙',
        timeline: '2019年底，终局之战后', aliases: ['托尼', '钢铁侠'],
        profile: '托尼在2019年终局之战中牺牲，这是明确的后期档案。',
        profileFormatVersion: 2, baselineStatus: 'verified', sourceTrust: 'verified', sources: [], canonChanges: [],
    };
    cardProfile.auFacts = [{
        owner: '托尼·斯塔克', ownerRecordKey: '托尼·斯塔克', kind: 'character', work: '漫威电影宇宙',
        facet: 'life.status', current: '已牺牲', source: 'user', evidence: '托尼已经牺牲', active: true,
        updatedAt: Date.now(),
    }];
    cardProfile.currentScene = {
        workTitle: '漫威电影宇宙', timeline: '2019年底，终局之战后',
        characters: ['托尼·斯塔克'], locations: ['终局战场'], subjects: [], pinned: [],
        summary: '灭霸已被消灭，托尼已经牺牲，众人正在举行葬礼。',
        entities: [{ candidateName: '托尼·斯塔克', kind: 'character', workHint: '漫威电影宇宙', isOriginal: false }],
        subjectEntities: [],
    };
    const reference = core.buildStoredGenerationReference([
        { is_user: true, mes: '当前时间设定为2017年初，继续写。' },
    ]);
    assert.match(reference, /当前时间线：2017年初/);
    assert.match(reference, /旧档案可能含未来事实/);
    assert.doesNotMatch(reference, /灭霸已被消灭/);
    assert.doesNotMatch(reference, /托尼已经牺牲/);
    assert.doesNotMatch(reference, /托尼在2019年终局之战中牺牲/);
    assert.doesNotMatch(reference, /终局战场/);
    assert.doesNotMatch(reference, /已牺牲/,
        '显式回到 2017 年时，不得从 2019 年的 active AU 泄漏后期生死状态');
});

test('source contains the stop/swipe single-flight and checked-save guards', () => {
    const source = readFileSync(sourcePath, 'utf8');
    assert.match(source, /GENERATION_STOPPED/);
    assert.match(source, /MESSAGE_SWIPED/);
    assert.match(source, /inFlightSceneReviews\.set\(flightKey/);
    assert.match(source, /worldInfoCache\?\.delete/);
    assert.match(source, /fcrCanUseProxy !== true/);
});

test('manual identification and verification share an early single-task lock', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const autoFill = source.slice(
        source.indexOf('async function autoFillCurrentProfile()'),
        source.indexOf('\nfunction buildReference', source.indexOf('async function autoFillCurrentProfile()')),
    );
    const preflight = source.slice(
        source.indexOf('async function runPreflight('),
        source.indexOf('\nglobalThis.fandomCanonPreflight', source.indexOf('async function runPreflight(')),
    );
    const autoGuard = autoFill.indexOf('if (busy)');
    const autoClaim = autoFill.indexOf('busy = true;');
    const autoFirstAwait = autoFill.indexOf('await ensureConversationScope();');
    assert.ok(autoGuard >= 0 && autoClaim > autoGuard && autoClaim < autoFirstAwait);
    assert.match(autoFill, /finally\s*\{[\s\S]*?busy\s*=\s*false;/);

    const manualGuard = preflight.indexOf("if ((force || type === 'manual') && busy)");
    const manualPathStart = preflight.indexOf('\n    busy = true;', manualGuard);
    const manualPath = preflight.slice(manualPathStart);
    const manualClaim = manualPath.indexOf('busy = true;');
    const manualFirstAwait = manualPath.indexOf('await ensureConversationScope();');
    assert.ok(manualGuard >= 0 && manualPathStart > manualGuard
        && manualClaim >= 0 && manualFirstAwait > manualClaim,
        '手动核验必须在第一个 await 之前占有与自动识别共用的 busy 锁');
    assert.match(preflight, /finally\s*\{[\s\S]*?busy\s*=\s*false;/);
});

test('CHAT_CHANGED captures its usable scope token only after conversation scope is ensured', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const start = source.indexOf("context.eventSource?.on?.(context.eventTypes?.CHAT_CHANGED");
    const end = source.indexOf("context.eventSource?.on?.(context.eventTypes?.MESSAGE_DELETED", start);
    const handler = source.slice(start, end);
    const ensureAt = handler.indexOf('await ensureConversationScope();');
    const tokenAt = handler.indexOf('const scopeToken = captureScopeToken();');
    assert.ok(start >= 0 && end > start);
    assert.ok(ensureAt >= 0 && tokenAt > ensureAt,
        'CHAT_CHANGED 不能在 ensureConversationScope 再次清理作用域之前捕获过期 token');
    assert.match(handler, /if \(expectedScope !== scopeIdentity\(\)\) return;[\s\S]*?await ensureConversationScope\(\);/);
});

test('post-review model revisions are gated by both reviewEnabled and non-empty canon records', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const start = source.indexOf('async function reviewGeneratedMessage(');
    const end = source.indexOf('\nfunction applyRevisionsToStructuredValue', start);
    const review = source.slice(start, end);
    const revisionStart = review.indexOf('let hasLaterConversation');
    const revisionEnd = review.indexOf('let applied = []', revisionStart);
    const revisionPlanning = review.slice(revisionStart, revisionEnd);
    assert.match(revisionPlanning, /parsed\?\.revisions/);
    assert.match(revisionPlanning, /config\.reviewEnabled/,
        '关闭审核时，分析模型即使返回 revisions 也不得修改正文');
    assert.match(revisionPlanning, /records\.length/,
        '没有任何原作档案参与审核时，模型 revisions 不得修改正文');
});

test('retrieval propagates a real failure and deduplicates by candidate work identity', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const start = source.indexOf('async function retrieve(');
    const end = source.indexOf('\nfunction researchJobKey', start);
    const retrieve = source.slice(start, end);
    assert.match(retrieve, /const failures = settled\.filter\([\s\S]*?result\.reason/);
    assert.match(retrieve, /if \(!pages\.length && failures\.length\) throw failures\[0\]/,
        '全部检索任务失败时不得吞错并伪装成空结果');
    assert.match(retrieve, /page\.candidateId/);
    assert.match(retrieve, /page\.inputWorkHint/,
        '同名对象的去重键必须包含作品身份');

    const core = loadCore();
    assert.notEqual(
        core.canonCandidateIdentityKey({ candidateName: '亚瑟', kind: 'character', workHint: '作品甲' }),
        core.canonCandidateIdentityKey({ candidateName: '亚瑟', kind: 'character', workHint: '作品乙' }),
    );
});

test('post-review retries cache the resolved scene instead of replaying stale parsed output', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const start = source.indexOf('async function reviewGeneratedMessage(');
    const end = source.indexOf('\nfunction applyRevisionsToStructuredValue', start);
    const review = source.slice(start, end);
    const resolvedAt = review.indexOf('const resolvedScene =');
    assert.ok(resolvedAt >= 0);
    assert.doesNotMatch(review.slice(0, resolvedAt), /sceneAnalysisCache\.set\(/,
        '修订和时间锚尚未应用时不得缓存旧 parsed');
    const finalCache = review.slice(review.indexOf('sceneAnalysisCache.set(finalSignature', resolvedAt),
        review.indexOf('while (sceneAnalysisCache.size', resolvedAt));
    assert.match(finalCache, /scene:\s*resolvedScene/,
        '最终消息签名必须缓存正文修订和时间锚已落实的场景');
    assert.match(finalCache, /revisions:\s*\[\]/,
        '重试不得再次播放旧 revisions');
    assert.match(review, /reuseAnalysis:\s*true/);
});

test('manual work or timeline edits invalidate stale scene and canon profile state', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const start = source.indexOf('const profileFields = {');
    const end = source.indexOf("$('#fcr-save-search-key')", start);
    const binding = source.slice(start, end);
    assert.match(binding, /key === ['"]workTitle['"][\s\S]*?key === ['"]timeline['"]|\[['"]workTitle['"],\s*['"]timeline['"]\]\.includes\(key\)/);
    assert.match(binding, /currentScene\s*=\s*null/,
        '手改作品或时间线后，旧场景摘要不得继续注入');
    const invalidatesProfiles = /profileHash\s*=\s*['"]{2}/.test(binding)
        || /canonDatabase\s*=\s*\{\s*\}/.test(binding)
        || /invalidate\w*Canon\w*\(/.test(binding);
    assert.equal(invalidatesProfiles, true,
        '手改作品或时间线后，旧节点的压缩档案必须失效或清空');
});

test('one scene turn shares one maxQueries budget across timeline deltas and new entities', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const start = source.indexOf('async function syncDynamicSceneState(');
    const end = source.indexOf('\nfunction buildReviewPrompt', start);
    const sync = source.slice(start, end);
    const enrichmentCalls = [...sync.matchAll(/startCanonEnrichment\(/g)].length;
    const budgetDeclaration = sync.match(/(?:let|const)\s+(\w*(?:Research|Query)Budget\w*)\s*=\s*[^;]*maxQueries/i);
    const hasSharedBudget = Boolean(budgetDeclaration) && (() => {
        const name = budgetDeclaration[1];
        const uses = [...sync.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
        return uses >= 3 && new RegExp(`${name}\\s*(?:-=|=\\s*Math\\.max)`).test(sync);
    })();
    assert.ok(enrichmentCalls <= 1 || hasSharedBudget,
        '时间线增量和新对象不得各自消耗一整个 maxQueries 预算');
});

test('nullish optional fields never become entity names or aliases', () => {
    const core = loadCore();
    assert.deepEqual(core.cleanDetectedEntities([undefined, null, 'undefined', 'null', '卡玛泰姬']), ['卡玛泰姬']);
});

test('generic canon queries are reduced to usable MediaWiki search terms', () => {
    const core = loadCore();
    const variants = core.wikiQueryVariants('卡玛泰姬 漫威电影宇宙 核对原作地点档案：正式名称、地理位置、布局');
    assert.equal(variants[0], '卡玛泰姬 漫威电影宇宙');
    assert.ok(!variants[0].includes('核对原作地点档案'));
});

test('Wiki research without a custom canonical page keeps the requested entity and kind', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    await core.saveCanonResearch({
        work: '漫威电影宇宙', timeline: '2017年初', entities: ['卡玛泰姬'], researchMode: 'new_entities',
        entityCandidates: [{ candidateName: '卡玛泰姬', kind: 'location', isOriginal: false }],
        canonChanges: [],
    }, [{
        title: '卡玛泰姬', query: '卡玛泰姬 漫威电影宇宙', source: 'ZH Wikipedia',
        url: 'https://example.test/wiki/kamar-taj', extract: '卡玛泰姬是位于尼泊尔的神秘艺术训练地点。',
    }]);
    assert.ok(cardProfile.canonDatabase['卡玛泰姬']);
    assert.equal(cardProfile.canonDatabase['卡玛泰姬'].kind, 'location');
    assert.ok(!cardProfile.canonDatabase.undefined);
});

test('same display name from two works survives save, sanitize, and identity-aware lookup', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    const saveWork = async (work, detail) => core.saveCanonResearch({
        work, timeline: '', entities: ['亚瑟'], researchMode: 'new_entities', canonChanges: [],
        entityCandidates: [{ candidateName: '亚瑟', kind: 'character', workHint: work, isOriginal: false }],
    }, [{
        title: '亚瑟', query: `亚瑟 ${work}`, source: 'ZH Wikipedia',
        url: `https://example.test/${encodeURIComponent(work)}/arthur`,
        extract: `亚瑟是${work}中的${detail}。`,
    }]);
    await saveWork('作品甲', '骑士');
    await saveWork('作品乙', '侦探');
    core.sanitizeCanonDatabase(cardProfile.canonDatabase, cardProfile);

    const keys = Object.keys(cardProfile.canonDatabase);
    assert.equal(keys.length, 2);
    assert.deepEqual(new Set(keys.map(key => cardProfile.canonDatabase[key].work)), new Set(['作品甲', '作品乙']));
    assert.equal(core.findCanonRecordName('亚瑟', cardProfile.canonDatabase), '');
    const workA = core.findCanonRecordName('亚瑟', cardProfile.canonDatabase, { kind: 'character', work: '作品甲' });
    const workB = core.findCanonRecordName('亚瑟', cardProfile.canonDatabase, { kind: 'character', work: '作品乙' });
    assert.ok(workA && workB && workA !== workB);
    assert.match(cardProfile.canonDatabase[workA].sources[0].extract, /骑士/);
    assert.match(cardProfile.canonDatabase[workB].sources[0].extract, /侦探/);
});

test('same-name AU facts from different works coexist and update independently', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase = {
        '亚瑟': {
            entity: '亚瑟', kind: 'character', work: '作品甲', aliases: ['亚瑟'], sources: [], canonChanges: [],
        },
        '亚瑟〔作品乙〕': {
            entity: '亚瑟', kind: 'character', work: '作品乙', aliases: ['亚瑟'], sources: [], canonChanges: [],
        },
    };
    const messages = [
        { is_user: true, mes: '作品甲的亚瑟现在穿黑色外套', send_date: 'cross-user-a' },
        { is_user: false, mes: '继续。', send_date: 'cross-assistant-a' },
        { is_user: true, mes: '作品乙的亚瑟现在穿白色制服', send_date: 'cross-user-b' },
        { is_user: false, mes: '继续。', send_date: 'cross-assistant-b' },
        { is_user: true, mes: '作品甲的亚瑟换成了红色风衣', send_date: 'cross-user-c' },
        { is_user: false, mes: '继续。', send_date: 'cross-assistant-c' },
    ];
    globalThis.__fcrTestContext.chat = messages;
    const writeFact = async (work, messageId, current, evidence) => core.persistCanonDeltas({
        work, timeline: '', entities: ['亚瑟'], messageId,
        entityCandidates: [{ candidateName: '亚瑟', kind: 'character', workHint: work, isOriginal: false }],
        canonChanges: [{
            entity: '亚瑟', kind: 'character', work, facet: 'appearance.clothing', current,
            source: 'user', evidence,
        }],
        auEvidenceSources: { user: evidence },
    }, { syncScene: false, syncCanon: false });
    await writeFact('作品甲', 1, '穿黑色外套', messages[0].mes);
    await writeFact('作品乙', 3, '穿白色制服', messages[2].mes);
    assert.equal(core.activeAuFacts(cardProfile).length, 2);
    assert.equal(core.relevantAuFactsForNames(['亚瑟'], '', { work: '作品甲' }).length, 1);
    assert.match(core.auFactText(core.relevantAuFactsForNames(['亚瑟'], '', { work: '作品甲' })[0]), /黑色外套/);
    assert.match(core.auFactText(core.relevantAuFactsForNames(['亚瑟'], '', { work: '作品乙' })[0]), /白色制服/);

    await writeFact('作品甲', 5, '穿红色风衣', messages[4].mes);
    assert.equal(core.activeAuFacts(cardProfile).length, 2);
    assert.match(core.auFactText(core.relevantAuFactsForNames(['亚瑟'], '', { work: '作品甲' })[0]), /红色风衣/);
    assert.match(core.auFactText(core.relevantAuFactsForNames(['亚瑟'], '', { work: '作品乙' })[0]), /白色制服/);
});

test('fine-grained AU facets for one owner coexist until an explicit replacement targets one', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase['测试角色'] = {
        entity: '测试角色', kind: 'character', work: '测试作品', aliases: ['测试角色'],
        sources: [], canonChanges: [],
    };
    const basePlan = {
        work: '测试作品', timeline: '', entities: ['测试角色'],
        entityCandidates: [{ candidateName: '测试角色', kind: 'character', workHint: '测试作品', isOriginal: false }],
    };
    const initialFacts = [
        { facet: 'relationship.幻视.恋爱', current: '未与幻视交往' },
        { facet: 'relationship.皮特罗.亲情', current: '与皮特罗保持兄妹关系' },
        { facet: 'item.时间宝石.availability', current: '本世界没有时间宝石' },
        { facet: 'item.悬浮斗篷.ownership', current: '仍持有悬浮斗篷' },
        { facet: 'appearance.hair', current: '现在是黑色短发' },
        { facet: 'appearance.clothing', current: '现在穿红色大衣' },
    ].map(fact => ({
        entity: '测试角色', kind: 'character', source: 'manual', evidence: '', ...fact,
    }));
    await core.persistCanonDeltas({ ...basePlan, canonChanges: initialFacts }, { syncScene: false, syncCanon: false });
    assert.equal(core.activeAuFacts(cardProfile).length, 6);
    assert.equal(cardProfile.auHistory.length, 0);

    const target = core.activeAuFacts(cardProfile)
        .find(fact => fact.facet === 'relationship.幻视.恋爱');
    await core.persistCanonDeltas({
        ...basePlan,
        canonChanges: [{
            entity: '测试角色', kind: 'character', facet: 'relationship',
            current: '现在与幻视开始交往', participants: ['幻视'], source: 'manual', evidence: '',
            replaces: [core.auFactText(target)],
        }],
    }, { syncScene: false, syncCanon: false });
    const active = core.activeAuFacts(cardProfile);
    assert.equal(active.length, 6);
    assert.equal(cardProfile.auHistory.length, 1);
    assert.ok(!active.some(fact => fact.facet === 'relationship.幻视.恋爱'));
    assert.ok(active.some(fact => fact.facet === 'relationship.幻视' && /开始交往/.test(fact.current)));
    assert.ok(active.some(fact => fact.facet === 'relationship.皮特罗.亲情'));
    assert.ok(active.some(fact => fact.facet === 'item.时间宝石.availability'));
    assert.ok(active.some(fact => fact.facet === 'item.悬浮斗篷.ownership'));
    assert.ok(active.some(fact => fact.facet === 'appearance.hair'));
    assert.ok(active.some(fact => fact.facet === 'appearance.clothing'));
});

test('assistant assertions cannot override card or user facts, but verified action results become successors', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase['测试角色'] = {
        entity: '测试角色', kind: 'character', work: '测试作品', aliases: ['测试角色'],
        sources: [], canonChanges: [],
    };
    const basePlan = {
        work: '测试作品', timeline: '', entities: ['测试角色'],
        entityCandidates: [{ candidateName: '测试角色', kind: 'character', workHint: '测试作品', isOriginal: false }],
    };
    await core.persistCanonDeltas({
        ...basePlan,
        canonChanges: [{
            entity: '测试角色', kind: 'character', facet: 'appearance.hair',
            current: '角色卡固定为白色长发', source: 'card', evidence: '角色卡固定为白色长发',
        }],
        auEvidenceSources: { card: '角色卡固定为白色长发' },
        auEvidenceAvailability: { card: true },
    }, { syncScene: false, syncCanon: false });

    globalThis.__fcrTestContext.chat = [
        { is_user: true, mes: '用户明确她仍持有时间宝石', send_date: 'priority-user' },
        { is_user: false, mes: '明白。', send_date: 'priority-ack' },
    ];
    await core.persistCanonDeltas({
        ...basePlan,
        messageId: 1,
        canonChanges: [{
            entity: '测试角色', kind: 'character', facet: 'item.时间宝石.ownership',
            current: '仍持有时间宝石', source: 'user', evidence: '用户明确她仍持有时间宝石',
        }],
        auEvidenceSources: { user: '用户明确她仍持有时间宝石' },
    }, { syncScene: false, syncCanon: false });

    const staticBody = '她现在是黑色短发，而且时间宝石现在已经丢失。';
    globalThis.__fcrTestContext.chat.push({
        is_user: false, mes: staticBody, send_date: 'priority-assistant-static',
    });
    await core.persistCanonDeltas({
        ...basePlan,
        messageId: 2,
        canonChanges: [
            {
                entity: '测试角色', kind: 'character', facet: 'appearance.hair', current: '现在是黑色短发',
                source: 'assistant_event', evidence: '她现在是黑色短发', eventChanged: false,
            },
            {
                entity: '测试角色', kind: 'character', facet: 'item.时间宝石.ownership', current: '时间宝石已丢失',
                source: 'assistant_event', evidence: '时间宝石现在已经丢失', eventChanged: false,
            },
        ],
        auEvidenceSources: { assistant_event: staticBody },
    }, { syncScene: false, syncCanon: false });

    let active = core.activeAuFacts(cardProfile);
    assert.equal(active.length, 2);
    assert.match(active.find(fact => fact.facet === 'appearance.hair').current, /白色长发/);
    assert.equal(active.find(fact => fact.facet === 'appearance.hair').source, 'card');
    assert.match(active.find(fact => fact.facet === 'item.时间宝石.ownership').current, /仍持有/);
    assert.equal(active.find(fact => fact.facet === 'item.时间宝石.ownership').source, 'user');
    assert.equal(cardProfile.auHistory.length, 0,
        'a static assistant assertion must not supersede either durable fact');

    const actionBody = '她抓起染发剂，把白色长发染成黑色。洛基随即夺走了她的时间宝石，宝石从此归洛基持有。';
    globalThis.__fcrTestContext.chat.push({
        is_user: false, mes: actionBody, send_date: 'priority-assistant-action',
    });
    await core.persistCanonDeltas({
        ...basePlan,
        messageId: 3,
        canonChanges: [
            {
                entity: '测试角色', kind: 'character', facet: 'appearance.hair', current: '头发已经染成黑色',
                source: 'assistant_event', evidence: '把白色长发染成黑色', eventChanged: true,
            },
            {
                entity: '测试角色', kind: 'character', facet: 'item.时间宝石.ownership',
                current: '时间宝石已被洛基夺走并持有', participants: ['洛基'],
                source: 'assistant_event', evidence: '洛基随即夺走了她的时间宝石', eventChanged: true,
            },
        ],
        auEvidenceSources: { assistant_event: actionBody },
    }, { syncScene: false, syncCanon: false });

    active = core.activeAuFacts(cardProfile);
    assert.equal(active.length, 2);
    assert.match(active.find(fact => fact.facet === 'appearance.hair').current, /染成黑色/);
    assert.match(active.find(fact => fact.facet === 'item.时间宝石.ownership').current, /洛基夺走/);
    assert.ok(active.every(fact => fact.source === 'assistant_event'
        && fact.eventChanged === true && fact.messageId === 3));
    assert.equal(cardProfile.auHistory.length, 2);
    assert.ok(cardProfile.auHistory.some(fact => fact.source === 'card'
        && fact.facet === 'appearance.hair' && /白色长发/.test(fact.current)));
    assert.ok(cardProfile.auHistory.some(fact => fact.source === 'user'
        && fact.facet === 'item.时间宝石.ownership' && /仍持有/.test(fact.current)));
    assert.ok(cardProfile.auHistory.every(fact => fact.active === false && fact.supersededBy));
});

test('generic relationship facets specialize by participant and opposite states supersede', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase['旺达·马克西莫夫'] = {
        entity: '旺达·马克西莫夫', kind: 'character', work: '漫威电影宇宙',
        aliases: ['旺达·马克西莫夫'], sources: [], canonChanges: [],
    };
    const basePlan = {
        work: '漫威电影宇宙', timeline: '', entities: ['旺达·马克西莫夫'],
        entityCandidates: [{
            candidateName: '旺达·马克西莫夫', kind: 'character',
            workHint: '漫威电影宇宙', isOriginal: false,
        }],
    };
    await core.persistCanonDeltas({
        ...basePlan,
        canonChanges: [{
            entity: '旺达·马克西莫夫', kind: 'character', facet: 'relationship',
            current: '当前与幻视保持恋爱关系', participants: ['幻视'], source: 'manual',
        }],
    }, { syncScene: false, syncCanon: false });

    let active = core.activeAuFacts(cardProfile);
    assert.equal(active.length, 1);
    assert.equal(active[0].facet, 'relationship.幻视');
    assert.deepEqual(active[0].participants, ['幻视']);

    await core.persistCanonDeltas({
        ...basePlan,
        canonChanges: [{
            entity: '旺达·马克西莫夫', kind: 'character', facet: 'relationship',
            current: '已经与幻视分手，不再是恋人', participants: ['幻视'], source: 'manual',
        }],
    }, { syncScene: false, syncCanon: false });

    active = core.activeAuFacts(cardProfile);
    assert.equal(active.length, 1, 'opposite states for one participant-specific relationship cannot both stay active');
    assert.equal(active[0].facet, 'relationship.幻视');
    assert.match(active[0].current, /分手/);
    assert.equal(cardProfile.auHistory.length, 1);
    assert.match(cardProfile.auHistory[0].current, /恋爱关系/);
    assert.equal(cardProfile.auHistory[0].active, false);
});

test('AU facts without kind bind to one existing non-character record and fail closed across same-name works', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase = {
        '时间宝石': { entity: '时间宝石', kind: 'item', work: '测试作品', aliases: ['时间宝石'], sources: [], canonChanges: [] },
        '卡玛泰姬': { entity: '卡玛泰姬', kind: 'location', work: '测试作品', aliases: ['卡玛泰姬'], sources: [], canonChanges: [] },
        '混沌魔法': { entity: '混沌魔法', kind: 'ability', work: '测试作品', aliases: ['混沌魔法'], sources: [], canonChanges: [] },
    };
    const candidates = [
        { candidateName: '时间宝石', kind: 'item', workHint: '测试作品', isOriginal: false },
        { candidateName: '卡玛泰姬', kind: 'location', workHint: '测试作品', isOriginal: false },
        { candidateName: '混沌魔法', kind: 'ability', workHint: '测试作品', isOriginal: false },
    ];
    await core.persistCanonDeltas({
        work: '测试作品', timeline: '', entities: candidates.map(item => item.candidateName), entityCandidates: candidates,
        canonChanges: [
            { entity: '时间宝石', facet: 'item.availability', current: '本世界不存在', source: 'manual' },
            { entity: '卡玛泰姬', facet: 'location.status', current: '已被封闭', source: 'manual' },
            { entity: '混沌魔法', facet: 'ability.availability', current: '目前无法使用', source: 'manual' },
        ],
    }, { syncScene: false, syncCanon: false });
    assert.deepEqual(Object.keys(cardProfile.canonDatabase).sort(), ['卡玛泰姬', '时间宝石', '混沌魔法'].sort());
    assert.deepEqual(new Set(core.activeAuFacts(cardProfile).map(fact => fact.kind)), new Set(['item', 'location', 'ability']));
    assert.ok(core.activeAuFacts(cardProfile).every(fact => cardProfile.canonDatabase[fact.ownerRecordKey]));

    const ambiguousCore = loadCore();
    const ambiguousProfile = freshProfile(ambiguousCore);
    ambiguousProfile.canonDatabase = {
        '圣杯': { entity: '圣杯', kind: 'item', work: '作品甲', aliases: ['圣杯'], sources: [], canonChanges: [] },
        '圣杯〔作品乙〕': { entity: '圣杯', kind: 'item', work: '作品乙', aliases: ['圣杯'], sources: [], canonChanges: [] },
    };
    await ambiguousCore.persistCanonDeltas({
        work: '交叉同人', timeline: '', entities: ['圣杯'],
        entityCandidates: [
            { candidateName: '圣杯', kind: 'item', workHint: '作品甲', isOriginal: false },
            { candidateName: '圣杯', kind: 'item', workHint: '作品乙', isOriginal: false },
        ],
        canonChanges: [{ entity: '圣杯', facet: 'item.status', current: '已被破坏', source: 'manual' }],
    }, { syncScene: false, syncCanon: false });
    assert.equal(ambiguousCore.activeAuFacts(ambiguousProfile).length, 0);
    assert.deepEqual(Object.keys(ambiguousProfile.canonDatabase).sort(), ['圣杯', '圣杯〔作品乙〕'].sort());
});

test('assistant-event evidence accepts durable hairstyle, memory, family, relationship, inheritance, and employment changes', () => {
    const core = loadCore();
    const evidenceSamples = [
        '她把长发剪短了',
        '他在事故后失忆了',
        '她终于恢复了记忆',
        '他们正式收养了这个孩子',
        '她已经与幻视分手',
        '他继承了家族产业',
        '她从神盾局离职了',
    ];
    for (const evidence of evidenceSamples) {
        assert.equal(core.evidenceDescribesStateChange(evidence), true, evidence);
        assert.equal(core.auEvidenceMatches({
            source: 'assistant_event', evidence, eventChanged: true,
        }, { assistant_event: evidence }), true, evidence);
    }
});

test('a world-info AU fact is retained when that entry is simply inactive on the next turn', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase['神殿'] = {
        entity: '神殿', kind: 'location', work: '测试作品', aliases: ['神殿'], sources: [], canonChanges: [],
    };
    const basePlan = {
        work: '测试作品', timeline: '', entities: ['神殿'],
        entityCandidates: [{ candidateName: '神殿', kind: 'location', workHint: '测试作品', isOriginal: false }],
    };
    const evidence = '此世界的神殿已被摧毁';
    await core.persistCanonDeltas({
        ...basePlan,
        canonChanges: [{
            entity: '神殿', kind: 'location', facet: 'location.status', current: '已被摧毁',
            source: 'world_info', evidence,
        }],
        auEvidenceSources: { world_info: evidence },
        auEvidenceAvailability: { world_info: true },
    }, { syncScene: false, syncCanon: false });
    assert.equal(core.activeAuFacts(cardProfile).length, 1);

    await core.persistCanonDeltas({
        ...basePlan,
        canonChanges: [],
        auEvidenceSources: { world_info: '' },
        auEvidenceAvailability: { world_info: false },
    }, { syncScene: false, syncCanon: false });
    assert.equal(core.activeAuFacts(cardProfile).length, 1);
    assert.match(core.auFactText(core.activeAuFacts(cardProfile)[0]), /已被摧毁/);
});

test('ordinary time-of-day progress does not invalidate canon timelines or trigger research', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.timeline = '2018年春，瓦坎达战役后次日上午';
    cardProfile.lastAutoTimeline = cardProfile.timeline;
    const plan = core.scenePlanFromAnalysis({
        sceneComplete: true,
        timeline: '2018年春，瓦坎达战役后次日下午',
        timelineChanged: true,
        currentEntities: [],
        canonSubjects: [],
    });
    assert.equal(plan.timelineChanged, false);
    assert.equal(plan.sceneClockChanged, true);
    assert.match(plan.timeline, /下午/);
    assert.deepEqual(plan.queries, []);
});

test('legacy unknown records are classified without exposing raw sources in place of the compact profile', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase['黑暗之书'] = {
        entity: '黑暗之书', kind: 'unknown', kindVerified: false, aliases: ['黑暗之书'],
        profile: '黑暗之书是会腐化使用者的危险魔法书。', profileFormatVersion: 2,
        profileHash: 'legacy', baselineStatus: 'verified', sourceTrust: 'verified',
        sources: [{ title: '原始页', extract: '很长的原始摘要。' }],
        canonChanges: [],
    };
    const updated = core.applyVerifiedEntityKinds([{ candidateName: '黑暗之书', kind: 'item', isOriginal: false }]);
    assert.deepEqual(updated, ['黑暗之书']);
    assert.equal(cardProfile.canonDatabase['黑暗之书'].kind, 'item');
    assert.equal(cardProfile.canonDatabase['黑暗之书'].profileFormatVersion, 2);
    assert.match(core.formatCanonWorldEntry(cardProfile.canonDatabase['黑暗之书']), /会腐化使用者/);
});

test('strict mode blocks provisional baselines in both local reference selection and worldbook text', () => {
    const core = loadCore();
    freshProfile(core);
    core.settings().strictMode = true;
    const record = {
        entity: '待核实对象', kind: 'character', profile: '待核实对象的未经交叉验证摘要。',
        profileFormatVersion: 2, baselineStatus: 'provisional', sources: [], canonChanges: [],
    };
    assert.equal(core.recordHasUsableBaseline(record), false);
    const worldText = core.formatCanonWorldEntry(record);
    assert.doesNotMatch(worldText, /未经交叉验证摘要/);
    assert.match(worldText, /严格模式/);
});

test('strict mode requires both a verified baseline status and verified source trust', () => {
    const core = loadCore();
    freshProfile(core);
    core.settings().strictMode = true;
    const record = (baselineStatus, sourceTrust) => ({
        entity: '核验对象', kind: 'character', profile: '核验对象的紧凑原著档案。',
        profileFormatVersion: 2, baselineStatus, sourceTrust, sources: [], canonChanges: [],
    });
    assert.equal(core.recordHasUsableBaseline(record('verified', 'verified')), true);
    assert.equal(core.recordHasUsableBaseline(record('verified', 'provisional')), false);
    assert.equal(core.recordHasUsableBaseline(record('stale', 'verified')), false);
    assert.equal(core.recordHasUsableBaseline(record('provisional', 'provisional')), false);
});

test('database sanitization never launders explicit provisional trust through a verified status', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    core.settings().strictMode = true;
    cardProfile.canonDatabase['待核验对象'] = {
        entity: '待核验对象', kind: 'character', aliases: ['待核验对象'],
        work: '测试作品', profile: '待核验对象的旧档案。', profileFormatVersion: 2,
        baselineStatus: 'verified', sourceTrust: 'provisional', canonChanges: [],
        sources: [{ title: '普通搜索摘要', source: '普通搜索', url: '', extract: '待核验对象的未交叉核实资料。' }],
    };
    core.sanitizeCanonDatabase(cardProfile.canonDatabase, cardProfile);
    assert.equal(cardProfile.canonDatabase['待核验对象'].sourceTrust, 'provisional');
    assert.equal(core.recordHasUsableBaseline(cardProfile.canonDatabase['待核验对象']), false);
});

test('AU relationship participants make one owned fact visible from either side', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.auFacts = [{
        owner: '旺达·马克西莫夫', kind: 'character', facet: 'relationship.幻视',
        current: '本世界未与幻视发展为恋人', source: 'user', evidence: '未与幻视发展为恋人',
        participants: ['幻视'], active: true,
    }];
    const facts = core.relevantAuFactsForNames(['幻视']);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].owner, '旺达·马克西莫夫');
});

test('Retry-After cannot bypass the finite post-review retry limit', () => {
    const core = loadCore();
    const error = Object.assign(new Error('Got response status 429'), { fcrRetryAfterMs: 120000 });
    assert.ok(core.sceneRetryDelay(error, 0) >= 120000);
    assert.equal(core.sceneRetryDelay(error, 2), 0);
});

test('failed profile refresh backs off even when an older compact profile still exists', () => {
    const core = loadCore();
    const record = {
        entity: '测试对象', kind: 'character', timeline: '节点甲',
        profile: '测试对象的上一版紧凑原著档案，仍可作为非严格模式下的临时回退。',
        profileHash: 'old-hash', profileFormatVersion: 2,
        sources: [{ title: '资料页', extract: '测试对象在节点甲的原著资料。' }],
    };
    const currentHash = core.canonProfileHash(record);
    assert.equal(core.canonProfileNeedsRefresh(record, 1_000_000), true);
    record.profileAttemptHash = currentHash;
    record.profileAttemptedAt = 1_000_000;
    assert.equal(core.canonProfileNeedsRefresh(record, 1_000_001), false);
    assert.equal(core.canonProfileNeedsRefresh(record, 1_000_000 + 10 * 60 * 1000 + 1), true);
});

test('duplicated multi-entity custom summaries are rejected before entering the database', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    const shared = '甲与乙的全部人物资料被错误地复制到同一个长摘要中，包含两人的外貌、性格、经历、关系、能力与说话方式。';
    const candidates = [
        { candidateName: '甲', kind: 'character', workHint: '', isOriginal: false },
        { candidateName: '乙', kind: 'character', workHint: '', isOriginal: false },
    ];
    await core.saveCanonResearch({
        work: '测试作品', timeline: '', entities: ['甲', '乙'], researchMode: 'new_entities', canonChanges: [],
        entityCandidates: candidates,
    }, [
        {
            source: '自定义搜索 AI', verified: true, candidateName: '甲', canonicalName: '甲', title: '甲',
            candidateId: `0:${core.canonCandidateIdentityKey(candidates[0])}`, inputWorkHint: '',
            kind: 'character', workTitle: '测试作品', extract: shared, aliases: [],
            citations: ['https://example.test/a'],
        },
        {
            source: '自定义搜索 AI', verified: true, candidateName: '乙', canonicalName: '乙', title: '乙',
            candidateId: `1:${core.canonCandidateIdentityKey(candidates[1])}`, inputWorkHint: '',
            kind: 'character', workTitle: '测试作品', extract: shared, aliases: [],
            citations: ['https://example.test/b'],
        },
    ]);
    assert.deepEqual(Object.keys(cardProfile.canonDatabase), []);
});

test('work identity matching rejects lookalike franchises instead of merging them', () => {
    const core = loadCore();
    assert.equal(core.fandomWorkIdentityMatches('Star Wars', 'Star Trek'), false);
    assert.equal(core.fandomWorkIdentityMatches('Fate', 'Fate/Grand Order'), false);
    assert.equal(core.fandomWorkIdentityMatches('Marvel Cinematic Universe', 'Marvel Universe'), false);
    assert.equal(core.fandomWorkIdentityMatches('Attack on Titan', 'Attack on Titan Junior High'), false);
    assert.equal(core.fandomWorkIdentityMatches('Batman Begins', 'Batman Begins Again'), false);
    assert.equal(core.fandomWorkIdentityMatches('Batman: Arkham City', 'Batman: Arkham City Stories'), false);
    assert.equal(core.fandomWorkIdentityMatches('Batman (1989)', 'Batman (2022)'), false);
    assert.equal(core.fandomWorkIdentityMatches('It (1990)', 'It (2017)'), false);
    assert.equal(core.fandomWorkIdentityMatches('Marvel Cinematic Universe', 'Marvel Cinematic Universe (MCU)'), true);
    assert.equal(core.fandomWorkIdentityMatches('漫威电影宇宙', '漫威电影宇宙（MCU）'), true);
});

test('custom search identity requires the exact request id, work, citations, and explicit correction link', () => {
    const core = loadCore();
    const candidate = {
        candidateName: '朝美', kind: 'character', workHint: 'Lycoris Recoil',
        candidateId: '0:identity-test', isOriginal: false,
    };
    const valid = {
        source: '自定义搜索 AI', verified: true,
        candidateId: candidate.candidateId, candidateName: '朝美', inputWorkHint: 'Lycoris Recoil',
        canonicalName: '结城朝美', originalName: '結城朝美', aliases: ['结城朝美'],
        title: '结城朝美', kind: 'character', workTitle: 'Lycoris Recoil',
        extract: '候选名“朝美”对应正式名“结城朝美”；结城朝美是该作人物。',
        identityEvidence: '原作页面明确显示朝美即结城朝美。',
        citations: ['https://example.test/lycoris/asami'],
    };
    assert.equal(core.customPageIdentityIsVerified(valid, candidate, { work: 'Lycoris Recoil' }), true);
    assert.equal(core.customPageIdentityIsVerified({ ...valid, candidateId: 'wrong-id' }, candidate, { work: 'Lycoris Recoil' }), false);
    assert.equal(core.customPageIdentityIsVerified({ ...valid, workTitle: 'Star Trek' }, candidate, { work: 'Lycoris Recoil' }), false);
    assert.equal(core.customPageIdentityIsVerified({ ...valid, citations: [], url: '' }, candidate, { work: 'Lycoris Recoil' }), false);
    for (const citations of [['无'], ['官方资料'], ['暂无链接'], ['ftp://example.test/asami']]) {
        assert.equal(core.customPageIdentityIsVerified({ ...valid, citations, url: '' }, candidate, { work: 'Lycoris Recoil' }), false,
            `非 HTTP(S) 引用 ${citations[0]} 不得被当作身份核验来源`);
    }
    assert.equal(core.customPageIdentityIsVerified({ ...valid, citations: [], url: '官方资料' }, candidate, { work: 'Lycoris Recoil' }), false);
    assert.equal(core.customPageIdentityIsVerified({
        ...valid, citations: ['官方资料'], url: '无',
    }, candidate, { work: 'Lycoris Recoil' }), false);
    const translatedCandidate = { ...candidate, workHint: '莉可丽丝' };
    const translatedWork = {
        ...valid,
        inputWorkHint: '莉可丽丝',
        identityEvidence: '朝美即结城朝美；莉可丽丝是 Lycoris Recoil 的中文译名，二者是同一作品。',
    };
    assert.equal(core.customPageIdentityIsVerified(
        translatedWork, translatedCandidate, { work: '莉可丽丝' },
    ), true);
    assert.equal(core.customPageIdentityIsVerified({
        ...translatedWork,
        identityEvidence: '莉可丽丝不是 Lycoris Recoil，二者属于不同作品。',
    }, translatedCandidate, { work: '莉可丽丝' }), false);
    assert.equal(core.customPageIdentityIsVerified({
        ...valid,
        identityEvidence: '朝美不是结城朝美，二者是不同角色。',
    }, candidate, { work: 'Lycoris Recoil' }), false);
    const negativeEnglishWork = { ...candidate, workHint: 'Lycoris Recoil Alternative' };
    assert.equal(core.customPageIdentityIsVerified({
        ...valid,
        inputWorkHint: negativeEnglishWork.workHint,
        identityEvidence: 'Lycoris Recoil Alternative and Lycoris Recoil are not the same work.',
    }, negativeEnglishWork, { work: negativeEnglishWork.workHint }), false);
    assert.equal(core.customPageIdentityIsVerified({
        ...translatedWork,
        identityEvidence: '朝美即结城朝美。',
    }, translatedCandidate, { work: '莉可丽丝' }), false);
    assert.equal(core.customPageIdentityIsVerified({
        ...valid,
        canonicalName: '井之上泷奈', originalName: '井之上泷奈', aliases: [], title: '井之上泷奈',
        extract: '井之上泷奈是该作人物。', identityEvidence: '资料只能证明井之上泷奈的身份。',
    }, candidate, { work: 'Lycoris Recoil' }), false);
});

test('a model self-label plus one unrelated arbitrary URL cannot upgrade a custom result to verified trust', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    const candidate = {
        candidateName: '星野澪', kind: 'character', workHint: '测试作品',
        isOriginal: false, researchMode: 'new_entities',
    };
    await core.saveCanonResearch({
        work: '测试作品', timeline: '', entities: ['星野澪'], entityCandidates: [candidate],
        researchMode: 'new_entities', canonChanges: [],
    }, [{
        source: '自定义搜索 AI', verified: true,
        candidateId: `0:${core.canonCandidateIdentityKey(candidate)}`,
        candidateName: '星野澪', inputWorkHint: '测试作品', canonicalName: '星野澪', originalName: '星野澪',
        aliases: [], title: '星野澪', kind: 'character', workTitle: '测试作品',
        extract: '星野澪是测试作品角色，黑色长发，性格沉静，经历与人际关系均由这个未经核实的页面自行声称。',
        identityEvidence: '星野澪是测试作品中的星野澪。',
        citations: ['https://example.com/unrelated'],
    }]);
    const recordKey = core.findCanonRecordName('星野澪', cardProfile.canonDatabase, { kind: 'character', work: '测试作品' });
    const record = cardProfile.canonDatabase[recordKey];
    assert.ok(!record || (record.sourceTrust !== 'verified'
        && record.baselineStatus !== 'verified'
        && record.kindVerified !== true),
    '任意不受信域名不能仅凭模型返回 verified=true 就升级身份、类型和原著档案信任');
});

test('identical same-name summaries from different works cannot be copied into both canon profiles', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    const candidates = [
        { candidateName: '亚瑟', kind: 'character', workHint: 'Fate/Grand Order', isOriginal: false, researchMode: 'new_entities' },
        { candidateName: '亚瑟', kind: 'character', workHint: 'DC', isOriginal: false, researchMode: 'new_entities' },
    ];
    const copiedFateSummary = '亚瑟的完整人物档案：他是Fate/Grand Order中的男性从者，持有圣剑，拥有骑士王相关经历、能力、性格与人际关系。';
    const page = (index, url) => ({
        source: '自定义搜索 AI', verified: true,
        candidateId: `${index}:${core.canonCandidateIdentityKey(candidates[index])}`,
        candidateName: '亚瑟', inputWorkHint: candidates[index].workHint,
        canonicalName: '亚瑟', originalName: 'Arthur', aliases: [], title: '亚瑟', kind: 'character',
        workTitle: candidates[index].workHint, extract: copiedFateSummary,
        identityEvidence: `亚瑟是${candidates[index].workHint}中的亚瑟。`, citations: [url],
    });
    await core.saveCanonResearch({
        work: '交叉同人', timeline: '', entities: ['亚瑟'], entityCandidates: candidates,
        researchMode: 'new_entities', canonChanges: [],
    }, [
        page(0, 'https://fategrandorder.fandom.com/wiki/Arthur_Pendragon'),
        page(1, 'https://dc.fandom.com/wiki/Arthur_Curry_(Prime_Earth)'),
    ]);
    const dcKey = core.findCanonRecordName('亚瑟', cardProfile.canonDatabase, { kind: 'character', work: 'DC' });
    const dcRecord = cardProfile.canonDatabase[dcKey];
    assert.ok(!dcRecord || (!String(dcRecord.profile || '').includes('Fate/Grand Order')
        && !(dcRecord.sources || []).some(source => String(source.extract || '').includes('Fate/Grand Order'))),
    '同名跨作品结果即使 candidateId 各自正确，也不能把完全重复的 FGO 档案写入 DC 记录');
});

test('an AU ownerRecordKey conflicting with its explicit work is rejected or rebound by work identity', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase = {
        '亚瑟〔DC〕': {
            entity: '亚瑟', kind: 'character', kindVerified: true, work: 'DC', aliases: ['亚瑟'],
            profile: 'DC中的亚瑟人物档案。', profileFormatVersion: 2, baselineStatus: 'verified', sourceTrust: 'verified', sources: [], canonChanges: [],
        },
        '亚瑟〔FGO〕': {
            entity: '亚瑟', kind: 'character', kindVerified: true, work: 'Fate/Grand Order', aliases: ['亚瑟'],
            profile: 'Fate/Grand Order中的亚瑟人物档案。', profileFormatVersion: 2, baselineStatus: 'verified', sourceTrust: 'verified', sources: [], canonChanges: [],
        },
    };
    const evidence = 'Fate世界的亚瑟已经获得了圣剑';
    globalThis.__fcrTestContext.chat = [
        { is_user: true, mes: evidence, send_date: 'owner-work-user' },
        { is_user: false, mes: '明白。', send_date: 'owner-work-assistant' },
    ];
    await core.persistCanonDeltas({
        work: '交叉同人', timeline: '', messageId: 1, entities: ['亚瑟'],
        entityCandidates: [
            { candidateName: '亚瑟', kind: 'character', workHint: 'DC', isOriginal: false },
            { candidateName: '亚瑟', kind: 'character', workHint: 'Fate/Grand Order', isOriginal: false },
        ],
        canonChanges: [{
            entity: '亚瑟', ownerRecordKey: '亚瑟〔DC〕', kind: 'character', work: 'Fate/Grand Order',
            facet: 'item.圣剑.ownership', current: '已经获得圣剑', source: 'user', evidence,
        }],
        auEvidenceSources: { user: evidence },
    }, { syncScene: false, syncCanon: false });
    const facts = core.activeAuFacts(cardProfile);
    assert.ok(!facts.some(fact => fact.ownerRecordKey === '亚瑟〔DC〕'));
    assert.ok(facts.length === 0 || facts.every(fact => fact.ownerRecordKey === '亚瑟〔FGO〕'));
});

test('research single-flight keys distinguish message revisions, works, and entity kinds', () => {
    const core = loadCore();
    freshProfile(core);
    const base = {
        messageId: 7, messageSignature: 'message-a', work: '作品甲', timeline: '节点甲', queries: ['查询'],
        entityCandidates: [{ candidateName: '圣杯', kind: 'item', workHint: '作品甲', isOriginal: false }],
    };
    const initial = core.researchJobKey(base);
    assert.notEqual(initial, core.researchJobKey({ ...base, messageSignature: 'message-b' }));
    assert.notEqual(initial, core.researchJobKey({ ...base, work: '作品乙' }));
    assert.notEqual(initial, core.researchJobKey({
        ...base,
        entityCandidates: [{ candidateName: '圣杯', kind: 'world_rule', workHint: '作品甲', isOriginal: false }],
    }));
});

test('worldbook checked-save fingerprint includes the disabled activation state', () => {
    const core = loadCore();
    const ownedEntry = {
        comment: '实体·同人原作资料库·DC.png', content: '档案', key: ['实体'], keysecondary: [],
        constant: true, selective: false, addMemo: true, order: 100, position: 0,
        disable: true, probability: 100, useProbability: true,
        excludeRecursion: true, preventRecursion: true,
        characterFilter: { isExclude: false, names: ['DC.png'], tags: [] },
    };
    const disabled = core.pluginWorldEntryFingerprint({
        entries: { 1: ownedEntry, 2: { comment: '用户自己的条目', content: '不应纳入指纹' } },
    }, 'DC.png');
    const enabled = core.pluginWorldEntryFingerprint({
        entries: { 1: { ...ownedEntry, disable: false } },
    }, 'DC.png');
    assert.equal(disabled.length, 1);
    assert.notDeepEqual(disabled, enabled);
});

test('manual-task ownership survives invalidation and cannot be released by an obsolete finally block', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const functionBlock = (startMarker, endMarker) => {
        const start = source.indexOf(startMarker);
        const end = source.indexOf(endMarker, start);
        assert.ok(start >= 0 && end > start, `${startMarker} source block must exist`);
        return source.slice(start, end);
    };
    const autoFill = functionBlock('async function autoFillCurrentProfile()', '\nfunction buildReference');
    const preflight = functionBlock('async function runPreflight(', '\nglobalThis.fandomCanonPreflight');
    for (const block of [autoFill, preflight]) {
        assert.match(block, /const taskBusyOwner\s*=\s*\+\+busyOwner;[\s\S]*?busy\s*=\s*true;/);
        assert.match(block, /const operationFresh\s*=\s*\(\)\s*=>\s*busyOwner\s*===\s*taskBusyOwner/);
        const firstScopeAwait = block.indexOf('await ensureConversationScope();');
        const freshnessAfterAwait = block.indexOf('if (!operationFresh()) return;', firstScopeAwait);
        assert.ok(firstScopeAwait >= 0 && freshnessAfterAwait > firstScopeAwait,
            'reset/generation invalidation during the pre-token await must make the operation exit');
        assert.match(block, /finally\s*\{[\s\S]*?if \(busyOwner === taskBusyOwner\) busy = false;/,
            'an obsolete task must not release the lock now owned by a newer task');
    }

    const clearRuntime = functionBlock('function clearRuntimeState(', '\nfunction invalidateManualOperations');
    assert.match(clearRuntime, /busyOwner\+\+;[\s\S]*?busy\s*=\s*false;/);
    const reset = functionBlock('async function resetCurrentConversationData(', '\nasync function retryPendingWorldBookCleanup');
    assert.ok(reset.indexOf('clearRuntimeState();') < reset.indexOf('await clearCanonWorldBookEntries'),
        'reset must invalidate a pre-token manual operation before slow worldbook I/O');
    const generationStart = source.slice(
        source.indexOf("context.eventSource?.on?.(context.eventTypes?.GENERATION_STARTED"),
        source.indexOf("context.eventSource?.on?.(context.eventTypes?.GENERATION_AFTER_COMMANDS"),
    );
    assert.match(generationStart, /foregroundGenerationEpoch\+\+;[\s\S]*?invalidateManualOperations\(\);/);
});

test('stopped generations only permit explicitly allowStopped swipe waiters to continue', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const scheduleStart = source.indexOf('function scheduleMessageReview(');
    const scheduleEnd = source.indexOf('\nfunction reconcileLatestAssistantMessage', scheduleStart);
    const schedule = source.slice(scheduleStart, scheduleEnd);
    assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart);
    assert.ok([...schedule.matchAll(/!options\.allowStopped\s*&&\s*stoppedGenerationEpoch\s*===\s*generationEpoch/g)].length >= 2,
        'ordinary reviews must be rejected both before scheduling and when their timer wakes');

    const reviewStart = source.indexOf('async function reviewGeneratedMessage(');
    const reviewEnd = source.indexOf('\nfunction applyRevisionsToStructuredValue', reviewStart);
    const review = source.slice(reviewStart, reviewEnd);
    assert.match(review, /options\.allowStopped\s*===\s*true\s*\|\|\s*stoppedGenerationEpoch\s*!==\s*taskGenerationEpoch/,
        'a waiter joining an in-flight review may survive stop only when explicitly opted in');

    const received = source.slice(
        source.indexOf("context.eventSource?.on?.(context.eventTypes?.MESSAGE_RECEIVED"),
        source.indexOf("context.eventSource?.on?.(context.eventTypes?.CHARACTER_MESSAGE_RENDERED"),
    );
    assert.doesNotMatch(received, /allowStopped\s*:\s*true/);
    const swipe = source.slice(
        source.indexOf("context.eventSource?.on?.(context.eventTypes?.MESSAGE_SWIPED"),
        source.indexOf("for (const \[eventName, fallback\]", source.indexOf("context.eventSource?.on?.(context.eventTypes?.MESSAGE_SWIPED")),
    );
    assert.match(swipe, /allowStopped\s*:\s*true/);
});

test('deleting compressed timeline transactions restores every profile cache and attempt field', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    const sourceRecord = {
        entity: '测试角色', kind: 'character', kindVerified: true, work: '测试作品', aliases: ['测试角色'],
        sources: [{ title: '测试角色', source: '专属 Wiki', url: 'https://example.test/role', extract: '测试角色在测试作品中的可靠原著资料。' }],
        canonChanges: [],
    };
    const stateA = {
        timeline: '节点A', profile: '测试角色在节点A的压缩档案。', profileHash: 'hash-a', profileFormatVersion: 1,
        profileAttemptHash: 'attempt-a', profileAttemptedAt: 101, baselineStatus: 'verified', sourceTrust: 'verified', updatedAt: 1001,
    };
    const stateB = {
        timeline: '节点B', profile: '测试角色在节点B的压缩档案。', profileHash: 'hash-b', profileFormatVersion: 2,
        profileAttemptHash: 'attempt-b', profileAttemptedAt: 202, baselineStatus: 'stale', sourceTrust: 'verified', updatedAt: 2002,
    };
    const stateC = {
        timeline: '节点C', profile: '测试角色在节点C的压缩档案。', profileHash: 'hash-c', profileFormatVersion: 3,
        profileAttemptHash: 'attempt-c', profileAttemptedAt: 303, baselineStatus: 'provisional', sourceTrust: 'provisional', updatedAt: 3003,
    };
    cardProfile.canonDatabase['测试角色'] = { ...sourceRecord, ...stateC };
    const userA = { is_user: true, mes: '推进到节点B。', send_date: 'timeline-user-b' };
    const assistantB = { is_user: false, mes: '节点B正文。', send_date: 'timeline-assistant-b' };
    const userB = { is_user: true, mes: '推进到节点C。', send_date: 'timeline-user-c' };
    const assistantC = { is_user: false, mes: '节点C正文。', send_date: 'timeline-assistant-c' };
    const chat = [userA, assistantB, userB, assistantC];
    globalThis.__fcrTestContext.chat = chat;
    cardProfile.sceneHistory = [{
        messageId: 1, messageSignature: core.messageProvenanceSignature(assistantB), updatedAt: 2002,
        previousProfileState: { workTitle: '测试作品', timeline: '节点A', entities: '测试角色', lastAutoWorkTitle: '测试作品', lastAutoTimeline: '节点A', lastAutoEntities: ['测试角色'] },
        previousRecordTimelines: { 测试角色: stateA }, characters: ['测试角色'], locations: [], subjects: [], pinned: [],
    }];
    cardProfile.currentScene = {
        messageId: 3, messageSignature: core.messageProvenanceSignature(assistantC), updatedAt: 3003,
        previousProfileState: { workTitle: '测试作品', timeline: '节点B', entities: '测试角色', lastAutoWorkTitle: '测试作品', lastAutoTimeline: '节点B', lastAutoEntities: ['测试角色'] },
        previousRecordTimelines: { 测试角色: stateB }, characters: ['测试角色'], locations: [], subjects: [], pinned: [],
    };

    core.reconcileLocalMessageState(chat, { invalidateFromMessageId: 3 });
    for (const [field, value] of Object.entries(stateB)) {
        assert.equal(cardProfile.canonDatabase['测试角色'][field], value, `B restore: ${field}`);
    }
    assert.equal(cardProfile.currentScene?.messageSignature, core.messageProvenanceSignature(assistantB));

    core.reconcileLocalMessageState(chat, { invalidateFromMessageId: 1 });
    for (const [field, value] of Object.entries(stateA)) {
        assert.equal(cardProfile.canonDatabase['测试角色'][field], value, `A restore: ${field}`);
    }
    assert.equal(cardProfile.currentScene, null);
});

test('cleanup is tri-state safe across unreadable books, repeated resets, and pending local sync', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const clearStart = source.indexOf('async function clearCanonWorldBookEntries(');
    const clearEnd = source.indexOf('\nasync function clearProfileWorldBookEntries', clearStart);
    const clear = source.slice(clearStart, clearEnd);
    assert.match(clear, /if \(!data\?\.entries\) return [^;]*\? false : null;/,
        'a confirmed-missing worldbook may complete cleanup, but an unreadable one must remain indeterminate');
    assert.match(clear, /return result !== null;/,
        'an unreadable worldbook must be reported as incomplete, not as an empty successful cleanup');

    const resetStart = source.indexOf('async function resetCurrentConversationData(');
    const resetEnd = source.indexOf('\nasync function retryPendingWorldBookCleanup', resetStart);
    const reset = source.slice(resetStart, resetEnd);
    assert.match(reset, /const previousCleanup\s*=\s*cardProfile\.cleanupPending/);
    assert.match(reset, /previousCleanup\?\.profileKey/);
    assert.match(reset, /previousCleanup\?\.profileKeys/);
    assert.match(reset, /previousCleanup\?\.worldBooks/,
        'a second reset must retain every unresolved profile key and worldbook from the first reset');

    const retryStart = resetEnd + 1;
    const retryEnd = source.indexOf('\nasync function ensureConversationScope', retryStart);
    const retry = source.slice(retryStart, retryEnd);
    const errorReturn = retry.indexOf('if (errors.length)');
    const clearPending = retry.indexOf('cardProfile.cleanupPending = null;');
    assert.ok(errorReturn >= 0 && clearPending > errorReturn);
    assert.match(retry.slice(errorReturn, clearPending), /return false;/,
        'failed/unreadable cleanup must return before cleanupPending is cleared');

    const reconcileStart = source.indexOf('async function reconcileDeletedWorldBookEntries(');
    const reconcileEnd = source.indexOf('\nfunction worldBookEntry', reconcileStart);
    const reconcile = source.slice(reconcileStart, reconcileEnd);
    assert.match(reconcile, /cardProfile\.cleanupPending\s*\|\|\s*cardProfile\.worldSyncPending/,
        'reconciliation must not interpret an unsynced local record as a user-deleted worldbook entry');
});

test('durable scene, record, and compact-profile mutations mark worldSyncPending before cancellable sync', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const block = (startMarker, endMarker) => {
        const start = source.indexOf(startMarker);
        const end = source.indexOf(endMarker, start);
        assert.ok(start >= 0 && end > start, `${startMarker} source block must exist`);
        return source.slice(start, end);
    };
    const sceneSync = block('async function syncDynamicSceneState(', '\nfunction applyTextRevisions');
    const sceneMutation = sceneSync.indexOf('cardProfile.currentScene = snapshot;');
    const scenePending = sceneSync.indexOf('markWorldSyncPending(cardProfile)', sceneMutation);
    const sceneAwait = sceneSync.indexOf('await repairWorldBookFromLocalState', scenePending);
    assert.ok(sceneMutation >= 0 && scenePending > sceneMutation && sceneAwait > scenePending);

    const saveResearch = block('async function saveCanonResearch(', '\nfunction loadCanonResearch');
    const saveMutation = saveResearch.indexOf('database[storageName] = nextRecord;');
    const savePending = saveResearch.indexOf('markWorldSyncPending(cardProfile)', saveMutation);
    const saveFreshnessAfterMutation = saveResearch.indexOf("typeof plan?.freshnessGuard === 'function' && !plan.freshnessGuard()", saveMutation);
    assert.ok(saveMutation >= 0 && savePending > saveMutation);
    assert.ok(saveFreshnessAfterMutation < 0 || savePending < saveFreshnessAfterMutation,
        'a cancelled research save must leave worldSyncPending after its durable database mutation');

    const profiles = block('async function ensureCanonProfiles(', '\nfunction relevantCanonRecords');
    const profileMutation = profiles.indexOf('record.profile = text;');
    const profilePending = profiles.indexOf('markWorldSyncPending(cardProfile)', profileMutation);
    const profileFreshnessAfterMutation = profiles.indexOf('if (!isFresh()) return [];', profileMutation);
    assert.ok(profileMutation >= 0 && profilePending > profileMutation);
    assert.ok(profileFreshnessAfterMutation < 0 || profilePending < profileFreshnessAfterMutation,
        'a cancelled profile compression must leave worldSyncPending after its durable profile mutation');

    const repair = block('async function repairWorldBookFromLocalState(', '\nasync function clearCanonWorldBookEntries');
    const finalClear = repair.indexOf('cardProfile.worldSyncPending = !completed;');
    assert.ok(finalClear > repair.lastIndexOf('if (!isFresh()) return false;', finalClear),
        'only a fresh completed repair may clear the pending marker');
});

test('custom same-name research binds by candidateId and AU work aliases resolve the existing owner', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    const candidates = [
        { candidateName: '亚瑟', kind: 'character', workHint: '作品甲', isOriginal: false },
        { candidateName: '亚瑟', kind: 'character', workHint: '作品乙', isOriginal: false },
    ];
    const pageFor = (index, marker) => ({
        source: '自定义搜索 AI', verified: true,
        candidateId: `${index}:${core.canonCandidateIdentityKey(candidates[index])}`,
        candidateName: '亚瑟', inputWorkHint: candidates[index].workHint,
        canonicalName: '亚瑟', originalName: `Arthur-${marker}`, aliases: [`亚瑟${marker}`], title: '亚瑟',
        kind: 'character', workTitle: candidates[index].workHint,
        extract: index === 0
            ? '亚瑟是作品甲中的角色；本页身份标记为A。他留着银色长发，处事克制，依靠古老契约施展防御术，并曾长期守卫北境。'
            : '亚瑟属于作品乙；本页身份标记为B。他是短发的现代调查员，言行外向，擅长机械装置，关键经历发生在海港都市。',
        identityEvidence: `候选亚瑟与${candidates[index].workHint}中的亚瑟是同一角色。`,
        citations: [
            `https://en.wikipedia.org/wiki/Arthur_${marker}`,
            `https://fictional-${marker.toLowerCase()}.fandom.com/wiki/Arthur`,
        ],
        trustedCitations: [
            `https://en.wikipedia.org/wiki/Arthur_${marker}`,
            `https://fictional-${marker.toLowerCase()}.fandom.com/wiki/Arthur`,
        ],
    });
    await core.saveCanonResearch({
        work: '交叉同人', timeline: '', entities: ['亚瑟'], entityCandidates: candidates,
        researchMode: 'new_entities', canonChanges: [],
    }, [pageFor(1, 'B'), pageFor(0, 'A')]);
    const aKey = core.findCanonRecordName('亚瑟', cardProfile.canonDatabase, { kind: 'character', work: '作品甲' });
    const bKey = core.findCanonRecordName('亚瑟', cardProfile.canonDatabase, { kind: 'character', work: '作品乙' });
    assert.ok(aKey && bKey && aKey !== bKey);
    assert.match(cardProfile.canonDatabase[aKey].sources.map(item => item.extract).join('\n'), /标记为A/);
    assert.doesNotMatch(cardProfile.canonDatabase[aKey].sources.map(item => item.extract).join('\n'), /标记为B/);
    assert.match(cardProfile.canonDatabase[bKey].sources.map(item => item.extract).join('\n'), /标记为B/);
    assert.doesNotMatch(cardProfile.canonDatabase[bKey].sources.map(item => item.extract).join('\n'), /标记为A/);
    assert.equal(cardProfile.canonDatabase[aKey].profileFormatVersion, 2);
    assert.equal(cardProfile.canonDatabase[aKey].baselineStatus, 'verified');
    assert.match(cardProfile.canonDatabase[aKey].profile, /标记为A/,
        'a verified per-object search summary should become the compact profile without a second LLM call');

    const aliasCore = loadCore();
    const aliasProfile = freshProfile(aliasCore);
    aliasProfile.canonDatabase['阿尔托莉雅'] = {
        entity: '阿尔托莉雅', kind: 'character', kindVerified: true, work: 'Fate/stay night',
        workAliases: ['命运之夜'], aliases: ['阿尔托莉雅'], sources: [], canonChanges: [],
    };
    await aliasCore.persistCanonDeltas({
        work: '交叉同人', timeline: '', entities: ['阿尔托莉雅'],
        entityCandidates: [{ candidateName: '阿尔托莉雅', kind: 'character', workHint: '命运之夜', isOriginal: false }],
        canonChanges: [{
            entity: '阿尔托莉雅', kind: 'character', work: '命运之夜', facet: 'relationship.士郎',
            current: '本世界尚未与士郎相识', source: 'manual', evidence: '',
        }],
    }, { syncScene: false, syncCanon: false });
    assert.deepEqual(Object.keys(aliasProfile.canonDatabase), ['阿尔托莉雅']);
    assert.equal(aliasCore.activeAuFacts(aliasProfile).length, 1);
    assert.equal(aliasCore.activeAuFacts(aliasProfile)[0].ownerRecordKey, '阿尔托莉雅');
});

test('cross-language work aliases merge one entity and select the matching baseline and AU fact', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    const sourceFor = (marker, work) => ({
        title: '锦木千束', source: '专属 Wiki', url: `https://example.test/${marker}`,
        extract: `锦木千束是${work}中的角色；这是${marker}版本的可靠人物资料。`,
    });
    cardProfile.canonDatabase = {
        '锦木千束·英文记录': {
            entity: '锦木千束', kind: 'character', kindVerified: true,
            work: 'Lycoris Recoil', workAliases: ['莉可丽丝'], aliases: ['锦木千束', '千束'],
            profile: '锦木千束在英文作品标题记录下的原著档案。', profileHash: 'english-hash', profileFormatVersion: 2,
            baselineStatus: 'verified', sourceTrust: 'verified', sources: [sourceFor('english', 'Lycoris Recoil')], canonChanges: [],
        },
        '锦木千束·中文记录': {
            entity: '锦木千束', kind: 'character', kindVerified: true,
            work: '莉可丽丝', workAliases: ['Lycoris Recoil'], aliases: ['锦木千束', '千束'],
            profile: '锦木千束在中文作品标题记录下的原著档案。', profileHash: 'chinese-hash', profileFormatVersion: 2,
            baselineStatus: 'verified', sourceTrust: 'verified', sources: [sourceFor('chinese', '莉可丽丝')], canonChanges: [],
        },
    };
    core.sanitizeCanonDatabase(cardProfile.canonDatabase, cardProfile);
    assert.equal(Object.keys(cardProfile.canonDatabase).length, 1,
        '同一实体的中英文作品标题通过显式 workAliases 应合并为一条记录');
    const [mergedKey] = Object.keys(cardProfile.canonDatabase);
    const merged = cardProfile.canonDatabase[mergedKey];
    assert.ok(core.recordWorkAliases(merged).includes('Lycoris Recoil'));
    assert.ok(core.recordWorkAliases(merged).includes('莉可丽丝'));

    const unrelated = {
        entity: '锦木千束', kind: 'character', kindVerified: true,
        work: '另一部作品', workAliases: [], aliases: ['锦木千束', '千束'],
        profile: '另一部作品中的同名角色档案。', profileFormatVersion: 2,
        baselineStatus: 'verified', sourceTrust: 'verified', sources: [sourceFor('other', '另一部作品')], canonChanges: [],
    };
    cardProfile.canonDatabase['锦木千束〔另一部作品〕'] = unrelated;
    const selected = core.disambiguateMentionedCanonRecords(
        '千束走进房间。', [merged, unrelated], [], '莉可丽丝',
    );
    assert.deepEqual(selected, [merged]);

    cardProfile.auFacts = [{
        owner: '锦木千束', ownerRecordKey: mergedKey, kind: 'character', work: 'Lycoris Recoil',
        facet: 'appearance.hair', current: '本卡中改为黑色短发', source: 'manual', evidence: '', active: true,
    }];
    const facts = core.relevantAuFactsForNames(['锦木千束'], '', { work: '莉可丽丝' });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].ownerRecordKey, mergedKey);
});

test('different canonical people sharing one title alias in the same work never consolidate', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase = {
        '巴里·艾伦': {
            entity: '巴里·艾伦', kind: 'character', kindVerified: true, work: 'DC', aliases: ['巴里·艾伦', '闪电侠'],
            profile: '巴里·艾伦是第一条独立人物档案，职业与经历均属于巴里本人。', profileHash: 'barry-hash', profileFormatVersion: 2,
            baselineStatus: 'verified', sourceTrust: 'verified', canonChanges: [],
            sources: [{ title: '巴里·艾伦', source: '专属 Wiki', url: 'https://example.test/barry', extract: '巴里·艾伦拥有自己的经历与人物关系。' }],
        },
        '沃利·韦斯特': {
            entity: '沃利·韦斯特', kind: 'character', kindVerified: true, work: 'DC', aliases: ['沃利·韦斯特', '闪电侠'],
            profile: '沃利·韦斯特是第二条独立人物档案，职业与经历均属于沃利本人。', profileHash: 'wally-hash', profileFormatVersion: 2,
            baselineStatus: 'verified', sourceTrust: 'verified', canonChanges: [],
            sources: [{ title: '沃利·韦斯特', source: '专属 Wiki', url: 'https://example.test/wally', extract: '沃利·韦斯特拥有自己的经历与人物关系。' }],
        },
    };
    core.sanitizeCanonDatabase(cardProfile.canonDatabase, cardProfile);
    assert.deepEqual(Object.keys(cardProfile.canonDatabase).sort(), ['巴里·艾伦', '沃利·韦斯特'].sort());
    assert.match(cardProfile.canonDatabase['巴里·艾伦'].profile, /巴里本人/);
    assert.doesNotMatch(cardProfile.canonDatabase['巴里·艾伦'].profile, /沃利本人/);
    assert.match(cardProfile.canonDatabase['沃利·韦斯特'].profile, /沃利本人/);
    assert.doesNotMatch(cardProfile.canonDatabase['沃利·韦斯特'].profile, /巴里本人/);
    assert.deepEqual(cardProfile.canonDatabase['巴里·艾伦'].sources.map(source => source.url), ['https://example.test/barry']);
    assert.deepEqual(cardProfile.canonDatabase['沃利·韦斯特'].sources.map(source => source.url), ['https://example.test/wally']);
});

test('verified new-entity custom summaries become compact profiles while official deltas preserve them', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    const candidate = {
        candidateName: '锦木千束', kind: 'character', workHint: 'Lycoris Recoil',
        isOriginal: false, researchMode: 'new_entities',
    };
    const candidateId = `0:${core.canonCandidateIdentityKey(candidate)}`;
    const initialSummary = '锦木千束是Lycoris Recoil的主要角色，金色短发、红色制服，性格乐观随性，同时拥有极强的近距离闪避与射击能力。';
    const customPage = (extract, suffix) => ({
        source: '自定义搜索 AI', verified: true, candidateId,
        candidateName: '锦木千束', inputWorkHint: 'Lycoris Recoil',
        canonicalName: '锦木千束', originalName: '錦木千束', aliases: ['千束'], title: '锦木千束',
        kind: 'character', workTitle: 'Lycoris Recoil', extract,
        identityEvidence: '锦木千束即錦木千束，是Lycoris Recoil中的同一角色。',
        citations: [
            `https://en.wikipedia.org/wiki/Chisato_Nishikigi#${suffix}`,
            `https://lycoris-recoil.fandom.com/wiki/Chisato_Nishikigi?source=${suffix}`,
        ],
        trustedCitations: [
            `https://en.wikipedia.org/wiki/Chisato_Nishikigi#${suffix}`,
            `https://lycoris-recoil.fandom.com/wiki/Chisato_Nishikigi?source=${suffix}`,
        ],
    });
    await core.saveCanonResearch({
        work: 'Lycoris Recoil', timeline: '原作前期', entities: ['锦木千束'],
        entityCandidates: [candidate], researchMode: 'new_entities', canonChanges: [],
    }, [customPage(initialSummary, 'baseline')]);
    const recordKey = core.findCanonRecordName('锦木千束', cardProfile.canonDatabase, {
        kind: 'character', work: 'Lycoris Recoil',
    });
    assert.ok(recordKey);
    const record = cardProfile.canonDatabase[recordKey];
    assert.equal(record.profile, initialSummary);
    assert.equal(record.profileFormatVersion, 2);
    assert.equal(record.profileHash, core.canonProfileHash(record));
    assert.equal(record.baselineStatus, 'verified');

    const deltaSummary = '锦木千束在原作后期又经历了新的事件；这份official delta只应补充来源并使旧压缩档案待刷新，不能直接覆盖已经核实的基础档案。';
    await core.saveCanonResearch({
        work: 'Lycoris Recoil', timeline: '原作后期', entities: ['锦木千束'],
        entityCandidates: [{ ...candidate, researchMode: 'official_delta' }],
        researchMode: 'official_delta', canonChanges: [],
    }, [customPage(deltaSummary, 'delta')]);
    assert.equal(cardProfile.canonDatabase[recordKey].profile, initialSummary,
        'official_delta 返回的检索摘要不能冒充新基础档案覆盖已有 profile');
    assert.ok(cardProfile.canonDatabase[recordKey].sources.some(source => /official delta/.test(source.extract)));
});

test('profile compression commits only after record-identity and source-hash CAS checks', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const start = source.indexOf('async function ensureCanonProfiles(');
    const end = source.indexOf('\nfunction relevantCanonRecords', start);
    const ensureProfiles = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    const analysisAwait = ensureProfiles.indexOf('await runJsonAnalysisPrompt');
    const firstCas = ensureProfiles.indexOf('database[recordName] === record && canonProfileHash(record) === hash', analysisAwait);
    const successMutation = ensureProfiles.indexOf('record.profile = text;', firstCas);
    assert.ok(analysisAwait >= 0 && firstCas > analysisAwait && successMutation > firstCas,
        '异步压缩返回后，必须先确认原记录对象和资料 hash 都未变化再提交 profile');
    assert.ok([...ensureProfiles.matchAll(/database\[recordName\]\s*===\s*record\s*&&\s*canonProfileHash\(record\)\s*===\s*hash/g)].length >= 2,
        '成功和异常回退写 attempt 状态都必须经过相同 identity+hash CAS');
    const catchAt = ensureProfiles.indexOf('} catch (error)');
    const catchCas = ensureProfiles.indexOf('database[recordName] === record && canonProfileHash(record) === hash', catchAt);
    const attemptMutation = ensureProfiles.indexOf('record.profileAttemptHash = hash;', catchCas);
    assert.ok(catchAt >= 0 && catchCas > catchAt && attemptMutation > catchCas);
});

test('normal preflight and runtime invalidation reschedule one finite pending worldbook repair', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const delayMatch = source.match(/const WORLD_BOOK_REPAIR_DELAYS_MS\s*=\s*\[([^\]]+)\]/);
    assert.ok(delayMatch);
    const delays = delayMatch[1].split(',').map(value => Number(value.trim())).filter(Number.isFinite);
    assert.ok(delays.length >= 1 && delays.length <= 8 && delays.every(value => value > 0));
    const repairStart = source.indexOf('function scheduleWorldBookRepair(');
    const repairEnd = source.indexOf('\nasync function clearCanonWorldBookEntries', repairStart);
    const repair = source.slice(repairStart, repairEnd);
    assert.match(repair, /if \(attempt >= WORLD_BOOK_REPAIR_DELAYS_MS\.length\) return false;/,
        '后台补写必须在有限重试表耗尽后停止');

    const clearStart = source.indexOf('function clearRuntimeState(');
    const clearEnd = source.indexOf('\nfunction invalidateManualOperations', clearStart);
    const clearRuntime = source.slice(clearStart, clearEnd);
    const deleteOld = clearRuntime.indexOf('worldBookRepairTimers.delete(targetScope);');
    const pendingCheck = clearRuntime.indexOf('if (cardProfile.worldSyncPending)', deleteOld);
    const reschedule = clearRuntime.indexOf('scheduleWorldBookRepair(', pendingCheck);
    assert.ok(deleteOld >= 0 && pendingCheck > deleteOld && reschedule > pendingCheck,
        'clearRuntimeState 必须先撤销旧 timer，再为当前 pending revision 重排 repair');

    const preflightStart = source.indexOf('async function runPreflight(');
    const manualStart = source.indexOf('    const taskBusyOwner = ++busyOwner;', preflightStart);
    const normalPreflight = source.slice(preflightStart, manualStart);
    assert.match(normalPreflight, /else if \(reconciledProfile\.worldSyncPending\)\s*\{[\s\S]*?scheduleWorldBookRepair\(/,
        '普通生成前即使本轮没有本地回滚，也必须重新排队未完成的世界书补写');
});

test('entity reclassification is carried by the plan into durable changed records and full sync', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.workTitle = '测试作品';
    cardProfile.lastAutoWorkTitle = '测试作品';
    cardProfile.canonDatabase['圣杯'] = {
        entity: '圣杯', kind: 'unknown', kindVerified: false, work: '测试作品', aliases: ['圣杯'],
        profile: '圣杯是测试作品中的关键器物；旧资料尚未完成实体类型迁移。', profileHash: 'old-hash', profileFormatVersion: 2,
        baselineStatus: 'verified', sourceTrust: 'verified',
        sources: [{ title: '圣杯', source: '专属 Wiki', url: 'https://example.test/grail', extract: '圣杯是测试作品中的关键器物。' }],
        canonChanges: [],
    };
    const plan = core.scenePlanFromAnalysis({
        sceneComplete: true, workTitle: '测试作品', timeline: '', currentEntities: [],
        canonSubjects: [{ candidateName: '圣杯', kind: 'item', workHint: '测试作品', isOriginal: false }],
        canonChanges: [],
    });
    assert.equal(cardProfile.canonDatabase['圣杯'].kind, 'unknown',
        'scenePlanFromAnalysis 必须保持纯函数，类型迁移只能在持久事务内提交');
    assert.deepEqual(plan.reclassifiedEntities ?? [], []);
    const beforeRevision = Number(cardProfile.worldSyncRevision) || 0;
    const changed = await core.persistCanonDeltas(plan);
    assert.equal(cardProfile.canonDatabase['圣杯'].kind, 'item');
    assert.deepEqual(plan.reclassifiedEntities, ['圣杯']);
    assert.ok(changed.includes('圣杯'));
    assert.equal(cardProfile.worldSyncPending, true);
    assert.ok(cardProfile.worldSyncRevision > beforeRevision);
});

test('preflight reconciles, signs, plans, and references the live context chat rather than an interceptor clone', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const start = source.indexOf('async function runPreflight(');
    const end = source.indexOf('\nglobalThis.fandomCanonPreflight', start);
    const preflight = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(preflight, /getContext\(\)\.chat/,
        'ensureConversationScope 后必须重新读取当前聊天数组');
    for (const staleCall of [
        /reconcileLocalMessageState\(chat\)/,
        /buildStoredGenerationReference\(chat\)/,
        /conversationSignature\(chat\)/,
        /planQueries\(chat\s*,/,
    ]) {
        assert.doesNotMatch(preflight, staleCall,
            'interceptor 传入的 clone 不得用于消息回滚、签名、引用或检索规划');
    }
});

test('two model-claimed reserved-domain citations still cannot upgrade custom research to verified trust', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    const candidate = {
        candidateName: '星野澪', kind: 'character', workHint: '测试作品',
        isOriginal: false, researchMode: 'new_entities',
    };
    await core.saveCanonResearch({
        work: '测试作品', timeline: '', entities: ['星野澪'], entityCandidates: [candidate],
        researchMode: 'new_entities', canonChanges: [],
    }, [{
        source: '自定义搜索 AI', verified: true,
        candidateId: `0:${core.canonCandidateIdentityKey(candidate)}`,
        candidateName: '星野澪', inputWorkHint: '测试作品', canonicalName: '星野澪', originalName: '星野澪',
        aliases: [], title: '星野澪', kind: 'character', workTitle: '测试作品',
        extract: '星野澪是测试作品角色，黑色长发，性格沉静，拥有完整经历、关系、能力和说话方式档案。',
        identityEvidence: '星野澪是测试作品中的星野澪。',
        citations: ['https://madeup-one.invalid/a', 'https://madeup-two.invalid/b'],
    }]);
    const recordKey = core.findCanonRecordName('星野澪', cardProfile.canonDatabase, {
        kind: 'character', work: '测试作品',
    });
    const record = recordKey ? cardProfile.canonDatabase[recordKey] : null;
    if (record) {
        assert.notEqual(record.sourceTrust, 'verified');
        assert.notEqual(record.baselineStatus, 'verified');
        assert.notEqual(record.kindVerified, true);
    }
});

test('entity-specific extraction keeps unnamed attribute sections following a named dossier heading', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    const candidate = {
        candidateName: '锦木千束', kind: 'character', workHint: 'Lycoris Recoil',
        isOriginal: false, researchMode: 'new_entities',
    };
    const dossier = '锦木千束\n\n外貌：金发红眼，常穿制服。\n\n性格：开朗乐观。\n\n经历：LycoReco 成员。';
    await core.saveCanonResearch({
        work: 'Lycoris Recoil', timeline: '', entities: ['锦木千束'],
        entityCandidates: [candidate], researchMode: 'new_entities', canonChanges: [],
    }, [{
        source: '自定义搜索 AI', verified: true,
        candidateId: `0:${core.canonCandidateIdentityKey(candidate)}`,
        candidateName: '锦木千束', inputWorkHint: 'Lycoris Recoil',
        canonicalName: '锦木千束', originalName: '錦木千束', aliases: ['錦木千束'],
        title: '锦木千束', kind: 'character', workTitle: 'Lycoris Recoil', extract: dossier,
        identityEvidence: '锦木千束与錦木千束是同一名 Lycoris Recoil 角色的中日文名。',
        citations: [
            'https://zh.wikipedia.org/wiki/Lycoris_Recoil',
            'https://lycoris-recoil.fandom.com/wiki/Chisato_Nishikigi',
        ],
        trustedCitations: [
            'https://zh.wikipedia.org/wiki/Lycoris_Recoil',
            'https://lycoris-recoil.fandom.com/wiki/Chisato_Nishikigi',
        ],
    }]);
    const recordKey = core.findCanonRecordName('锦木千束', cardProfile.canonDatabase, {
        kind: 'character', work: 'Lycoris Recoil',
    });
    assert.ok(recordKey);
    const record = cardProfile.canonDatabase[recordKey];
    const storedExtract = record.sources.map(source => source.extract).join('\n');
    for (const marker of ['外貌：', '性格：', '经历：']) {
        assert.match(storedExtract, new RegExp(marker), `source.extract 必须保留 ${marker} 段`);
        assert.match(record.profile, new RegExp(marker), `直接 profile 必须保留 ${marker} 段`);
    }
});

test('database sanitization keeps ordinary narrative negation but removes an explicit no-canon sentinel', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    const validExtract = '蝙蝠侠是布鲁斯·韦恩，外貌为黑色披风。他未能发现小丑隐藏的炸弹。';
    cardProfile.canonDatabase = {
        '蝙蝠侠': {
            entity: '蝙蝠侠', kind: 'character', work: 'DC', aliases: ['蝙蝠侠'],
            profile: validExtract, baselineStatus: 'verified', sourceTrust: 'verified',
            sources: [{ title: '蝙蝠侠', url: 'https://www.dc.com/characters/batman', extract: validExtract }],
            canonChanges: [],
        },
        '伪对象': {
            entity: '伪对象', kind: 'character', work: 'DC', aliases: ['伪对象'], profile: '',
            baselineStatus: 'provisional', sourceTrust: 'provisional',
            sources: [{
                title: '伪对象', url: 'https://example.test/rejected',
                extract: '伪对象：未在原作中发现这一人物，无原作对应。',
            }],
            canonChanges: [],
        },
    };
    core.sanitizeCanonDatabase(cardProfile.canonDatabase, cardProfile);
    assert.ok(cardProfile.canonDatabase['蝙蝠侠']);
    assert.match(cardProfile.canonDatabase['蝙蝠侠'].sources[0]?.extract || '', /未能发现小丑隐藏的炸弹/,
        '普通剧情中的“未能发现”不是检索拒绝标记');
    assert.equal(cardProfile.canonDatabase['伪对象'], undefined,
        '明确“无原作对应”的哨兵仍必须被清除');
});

test('busy manual work defers scheduled review and blocks both review launch checkpoints', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const scheduleStart = source.indexOf('function scheduleMessageReview(');
    const scheduleEnd = source.indexOf('\nfunction reconcileLatestAssistantMessage', scheduleStart);
    const schedule = source.slice(scheduleStart, scheduleEnd);
    const timerCreation = schedule.indexOf('setTimeout(');
    const callbackBusy = schedule.indexOf('if (busy) {', timerCreation);
    const busyReschedule = schedule.indexOf('scheduleMessageReview(', callbackBusy);
    const busyReturn = schedule.indexOf('return;', busyReschedule);
    const reviewLaunch = schedule.indexOf('await reviewGeneratedMessage(', busyReturn);
    assert.ok(timerCreation >= 0 && callbackBusy > timerCreation
        && busyReschedule > callbackBusy && busyReturn > busyReschedule && reviewLaunch > busyReturn,
    '去重 timer 醒来发现 busy 时只能延迟重排，绝不能在该分支启动审核');

    const reviewStart = source.indexOf('async function reviewGeneratedMessage(');
    const reviewEnd = source.indexOf('\nfunction applyRevisionsToStructuredValue', reviewStart);
    const review = source.slice(reviewStart, reviewEnd);
    const entryBusy = review.search(/if \(busy\) return false;/);
    const firstAwait = review.indexOf('await ensureConversationScope();');
    const postScopeBusy = review.indexOf('if (busy ||', firstAwait);
    const scopeCapture = review.indexOf('const scopeToken = captureScopeToken()', firstAwait);
    assert.ok(entryBusy >= 0 && firstAwait > entryBusy,
        'review 入口必须在任何 await/分析前服从 busy 锁');
    assert.ok(postScopeBusy > firstAwait && scopeCapture > postScopeBusy,
        'ensureConversationScope 的 await 期间可能出现手动任务，返回后必须再次服从 busy 锁');
});

test('profile material cannot discard a new official delta behind a forward slice of old sources', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const start = source.indexOf('async function ensureCanonProfiles(');
    const materialStart = source.indexOf('const materialSections', start);
    const materialEnd = source.indexOf('const prompt =', materialStart);
    const material = source.slice(materialStart, materialEnd);
    assert.ok(start >= 0 && materialStart > start && materialEnd > materialStart);
    assert.doesNotMatch(material, /\.join\([^)]*\)\s*\.(?:slice|substring)\(\s*0\s*,/s,
        '整组 sources 从开头截断会永久排除追加在末尾的 official_delta');
});

test('profile material samples every hashed source instead of permanently skipping the middle', () => {
    const core = loadCore();
    const record = {
        entity: '测试角色', kind: 'character', work: '测试作品', profile: '',
        sources: Array.from({ length: 6 }, (_, index) => ({
            title: `来源 S${index}`,
            extract: `S${index} 独有事实 ${String.fromCharCode(65 + index).repeat(260)}`,
        })),
    };
    const material = core.canonProfileMaterial(record, 800);
    for (let index = 0; index < record.sources.length; index++) {
        assert.match(material, new RegExp(`S${index}`),
            `profileHash 覆盖的来源 S${index} 必须在本轮压缩材料中至少出现一次`);
    }
});

test('an original current-scene entity suppresses a same-name canon row in generation and review selection', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.workTitle = '原作甲';
    cardProfile.lastAutoWorkTitle = '原作甲';
    cardProfile.entities = '爱丽丝';
    cardProfile.canonDatabase['爱丽丝'] = {
        entity: '爱丽丝', kind: 'character', kindVerified: true, work: '原作甲', aliases: ['爱丽丝'],
        profile: '这是原作甲中同名爱丽丝的原著档案，不属于用户当前原创角色。', profileHash: 'canon-hash', profileFormatVersion: 2,
        baselineStatus: 'verified', sourceTrust: 'verified', sources: [], canonChanges: [],
    };
    cardProfile.currentScene = {
        workTitle: '原作甲', timeline: '', characters: ['爱丽丝'], locations: [], subjects: [], pinned: [],
        entities: [{ candidateName: '爱丽丝', kind: 'character', isOriginal: true, workHint: '' }],
        subjectEntities: [], summary: '用户原创的爱丽丝正在说话。',
    };
    const chat = [{ is_user: true, mes: '让爱丽丝继续说。', send_date: 'original-alice-user' }];
    globalThis.__fcrTestContext.chat = chat;
    assert.deepEqual(core.localGenerationRecords(chat).selected, []);
    assert.deepEqual(core.recordsForReview('爱丽丝继续说。', cardProfile.canonDatabase), []);
});

test('one unique blank-work legacy record is adopted by the identified work instead of duplicated', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase['亚瑟'] = {
        entity: '亚瑟', kind: 'character', kindVerified: true, work: '', workAliases: [], aliases: ['亚瑟'],
        profile: '亚瑟的旧版无作品字段人物档案。', profileHash: 'legacy-hash', profileFormatVersion: 2,
        baselineStatus: 'provisional', sourceTrust: 'provisional',
        sources: [{ title: '亚瑟', source: '旧资料', url: 'https://example.test/legacy-arthur', extract: '亚瑟的旧版资料。' }], canonChanges: [],
    };
    const candidate = { candidateName: '亚瑟', kind: 'character', workHint: 'Fate/Grand Order', isOriginal: false };
    assert.equal(core.candidateRecordName(candidate, cardProfile.canonDatabase, 'Fate/Grand Order'), '亚瑟');
    await core.saveCanonResearch({
        work: 'Fate/Grand Order', timeline: '', entities: ['亚瑟'], entityCandidates: [candidate], canonChanges: [],
    }, [{
        source: 'EN Wikipedia', candidateId: `0:${core.canonCandidateIdentityKey(candidate)}`,
        candidateName: '亚瑟', inputWorkHint: 'Fate/Grand Order', kind: 'character',
        title: '亚瑟', url: 'https://example.test/fgo-arthur',
        extract: '亚瑟是Fate/Grand Order中的角色；这条新资料明确了旧记录缺失的作品归属。',
    }]);
    assert.deepEqual(Object.keys(cardProfile.canonDatabase), ['亚瑟']);
    assert.equal(cardProfile.canonDatabase['亚瑟'].work, 'Fate/Grand Order');
});

test('missing entity kind stays unknown and cannot permanently classify a legacy row as character', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    const [candidate] = core.cleanCanonSubjectCandidates([{
        candidateName: '未知圣物', workHint: '测试作品', isOriginal: false,
    }]);
    assert.equal(candidate.kind, 'unknown');
    cardProfile.canonDatabase['未知圣物'] = {
        entity: '未知圣物', kind: 'unknown', kindVerified: false, work: '测试作品', aliases: ['未知圣物'],
        profile: '未知圣物的旧资料尚未确认它是人物、物品还是能力。', profileFormatVersion: 2,
        baselineStatus: 'pending', sourceTrust: 'provisional', sources: [], canonChanges: [],
    };
    assert.deepEqual(core.applyVerifiedEntityKinds([{
        candidateName: '未知圣物', workHint: '测试作品', isOriginal: false,
    }], cardProfile.canonDatabase), []);
    assert.equal(cardProfile.canonDatabase['未知圣物'].kind, 'unknown');
    assert.equal(cardProfile.canonDatabase['未知圣物'].kindVerified, false);
});

test('a verified direct profile rejects a mixed summary containing another candidate full dossier', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    const candidates = [
        { candidateName: '星野澪', kind: 'character', workHint: '测试作品', isOriginal: false, researchMode: 'new_entities' },
        { candidateName: '月城凛', kind: 'character', workHint: '测试作品', isOriginal: false, researchMode: 'new_entities' },
    ];
    const mixed = '星野澪档案：黑色长发，沉着谨慎，幼年加入研究所，擅长冰系能力，与导师关系紧张。\n月城凛档案：银色短发，开朗冲动，曾独自旅行，擅长火系能力，与姐姐长期失和。';
    await core.saveCanonResearch({
        work: '测试作品', timeline: '', entities: ['星野澪', '月城凛'], entityCandidates: candidates,
        researchMode: 'new_entities', canonChanges: [],
    }, [{
        source: '自定义搜索 AI', verified: true,
        candidateId: `0:${core.canonCandidateIdentityKey(candidates[0])}`,
        candidateName: '星野澪', inputWorkHint: '测试作品', canonicalName: '星野澪', originalName: '星野澪',
        aliases: [], title: '星野澪', kind: 'character', workTitle: '测试作品', extract: mixed,
        identityEvidence: '星野澪是测试作品中的星野澪。', citations: ['https://example.test/mio'],
    }]);
    const recordKey = core.findCanonRecordName('星野澪', cardProfile.canonDatabase, { kind: 'character', work: '测试作品' });
    assert.equal(recordKey ? String(cardProfile.canonDatabase[recordKey]?.profile || '') : '', '',
        '含另一候选完整档案的混合摘要不得直接成为星野澪的 profile');
});

test('narrative-banner parsing is pure and cannot mutate canon records before the sync transaction', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.workTitle = '测试作品';
    cardProfile.canonDatabase['英雄'] = {
        entity: '英雄', kind: 'character', kindVerified: true, work: '测试作品',
        aliases: ['英雄', '晋阳'], profile: '英雄的原著档案。', profileFormatVersion: 2,
        baselineStatus: 'verified', sourceTrust: 'verified', sources: [], canonChanges: [], updatedAt: 123,
    };
    globalThis.__fcrTestContext.name1 = '晋阳';
    const before = structuredClone(cardProfile.canonDatabase);
    const merged = core.mergeSceneWithNarrativeBanner(
        { workTitle: '测试作品', currentEntities: [] },
        '<!--NE-BANNER-->基地|上午|||英雄<!--/NE-BANNER-->',
        '',
    );
    assert.ok(Array.isArray(merged.sanitizedCanonEntities));
    assert.deepEqual(cardProfile.canonDatabase, before,
        'mergeSceneWithNarrativeBanner 只能返回清理意图，数据库写入必须留在 sync 事务内');
});

test('review prompt excludes AU facts derived from the exact assistant message under review', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    const record = {
        entity: '爱丽丝', kind: 'character', kindVerified: true, work: '测试作品', aliases: ['爱丽丝'],
        profile: '爱丽丝的已核验原著档案。', profileHash: 'alice-profile', profileFormatVersion: 2,
        baselineStatus: 'verified', sourceTrust: 'verified', sources: [], canonChanges: [],
    };
    cardProfile.workTitle = '测试作品';
    cardProfile.canonDatabase['爱丽丝'] = record;
    cardProfile.auFacts = [
        {
            owner: '爱丽丝', ownerRecordKey: '爱丽丝', work: '测试作品', kind: 'character',
            facet: 'appearance.hair', current: 'CURRENT_SELF_PROOF', source: 'assistant_event',
            eventChanged: true, evidence: '把头发染成蓝色', messageSignature: 'sig-current', active: true,
        },
        {
            owner: '爱丽丝', ownerRecordKey: '爱丽丝', work: '测试作品', kind: 'character',
            facet: 'item.钥匙.ownership', current: 'PROVENANCE_SELF_PROOF', source: 'assistant_event',
            eventChanged: true, evidence: '拿到了钥匙', messageSignature: 'sig-coalesced', active: true,
            provenance: [{
                source: 'assistant_event', messageSignature: 'sig-current', evidence: '拿到了钥匙',
            }],
        },
        {
            owner: '爱丽丝', ownerRecordKey: '爱丽丝', work: '测试作品', kind: 'character',
            facet: 'ability.flight', current: 'OLDER_CONFIRMED_FACT', source: 'assistant_event',
            eventChanged: true, evidence: '学会了飞行', messageSignature: 'sig-older', active: true,
        },
    ];
    const prompt = core.buildReviewPrompt(
        '爱丽丝正在等待审核。', [record], '', { reviewMessageSignature: 'sig-current' }, true,
    );
    assert.doesNotMatch(prompt, /CURRENT_SELF_PROOF|PROVENANCE_SELF_PROOF/,
        '待审正文自己产出的 AU 不能反过来证明该正文正确');
    assert.match(prompt, /OLDER_CONFIRMED_FACT/,
        '其他已完成消息建立的 AU 仍应提供给本轮审核');
});

test('scene timeline cannot jump core nodes without verbatim timeline evidence even for an auto-owned value', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.workTitle = '漫威电影宇宙';
    cardProfile.lastAutoWorkTitle = '漫威电影宇宙';
    cardProfile.timeline = '2012年，纽约之战结束后';
    cardProfile.lastAutoTimeline = cardProfile.timeline;

    for (const timelineEvidence of ['', '多年后进入终局之战阶段']) {
        const plan = core.scenePlanFromAnalysis({
            sceneComplete: true,
            workTitle: '漫威电影宇宙',
            timeline: '2023年，终局之战结束后',
            timelineChanged: true,
            timelineEvidence,
            _fcrFinalBody: '众人仍在复盘刚刚结束的纽约之战。',
            currentEntities: [], canonSubjects: [], canonChanges: [],
        });
        assert.equal(plan.timeline, '2012年，纽约之战结束后');
        assert.equal(plan.timelineChanged, false);
    }
});

test('current entities reject new hallucinations and carry prior entities only with verbatim body evidence', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.workTitle = '测试作品';
    cardProfile.lastAutoWorkTitle = '测试作品';
    cardProfile.currentScene = {
        characters: ['托尼·斯塔克'], locations: [], subjects: [], pinned: [],
        entities: [{
            candidateName: '托尼·斯塔克', kind: 'character', isOriginal: false, workHint: '测试作品',
        }],
    };
    cardProfile.canonDatabase = {
        '托尼·斯塔克': {
            entity: '托尼·斯塔克', kind: 'character', work: '测试作品', aliases: ['托尼·斯塔克'],
            sources: [], canonChanges: [],
        },
        '布鲁斯·韦恩': {
            entity: '布鲁斯·韦恩', kind: 'character', work: '测试作品', aliases: ['布鲁斯·韦恩'],
            sources: [], canonChanges: [],
        },
    };
    const body = '她推开门，随后继续喝咖啡。';
    const plan = core.scenePlanFromAnalysis({
        sceneComplete: true, workTitle: '测试作品', timeline: '', _fcrFinalBody: body,
        currentEntities: [
            {
                candidateName: '布鲁斯·韦恩', kind: 'character', isOriginal: false,
                workHint: '测试作品', contextEvidence: '她推开门',
            },
            {
                candidateName: '托尼·斯塔克', kind: 'character', isOriginal: false,
                workHint: '测试作品', contextEvidence: '继续喝咖啡',
            },
        ],
        canonSubjects: [], canonChanges: [],
    });
    assert.deepEqual(plan.autoEntities, ['托尼·斯塔克'],
        '正文没有专名时，逐字动作 evidence 只能延续上一场景对象，不能创造新对象');

    const missingEvidence = core.scenePlanFromAnalysis({
        sceneComplete: true, workTitle: '测试作品', timeline: '', _fcrFinalBody: body,
        currentEntities: [{
            candidateName: '托尼·斯塔克', kind: 'character', isOriginal: false,
            workHint: '测试作品', contextEvidence: '他仍站在窗前',
        }],
        canonSubjects: [], canonChanges: [],
    });
    assert.deepEqual(missingEvidence.autoEntities, [],
        '上一场景对象也不能在 evidence 未逐字出现时凭模型声明延续');
});

test('a grounded scene name with missing isOriginal stays visible but cannot fail open into canon research', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.workTitle = 'DC';
    cardProfile.lastAutoWorkTitle = 'DC';
    const candidateWithoutIdentity = {
        candidateName: '星野澪', kind: 'character', workHint: 'DC', contextEvidence: '星野澪走进房间',
    };
    const plan = core.scenePlanFromAnalysis({
        sceneComplete: true, workTitle: 'DC', timeline: '',
        _fcrFinalBody: '星野澪走进房间。',
        currentEntities: [candidateWithoutIdentity],
        canonSubjects: [candidateWithoutIdentity], canonChanges: [],
    });
    assert.deepEqual(plan.autoEntities, ['星野澪'],
        '正文逐字出现的对象仍可留在当前场景');
    assert.deepEqual(plan.entityCandidates, []);
    assert.deepEqual(plan.queries, [],
        '模型漏填 isOriginal 不能被解释成已确认原作身份并触发外搜');
});

test('an original same-name scene candidate cannot bind AU changes to an old canon record', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase['爱丽丝'] = {
        entity: '爱丽丝', kind: 'character', work: '原作甲', aliases: ['爱丽丝'],
        sources: [], canonChanges: [],
    };
    await core.persistCanonDeltas({
        work: '原作甲', timeline: '', entities: [], entityCandidates: [],
        sceneCandidates: [{
            candidateName: '爱丽丝', kind: 'character', workHint: '原作甲', isOriginal: true,
        }],
        canonChanges: [{
            entity: '爱丽丝', work: '原作甲', kind: 'character', facet: 'appearance.hair',
            current: '用户原创爱丽丝留着银色短发', source: 'manual',
        }],
    }, { syncScene: false, syncCanon: false });
    assert.equal(core.activeAuFacts(cardProfile).length, 0);
    assert.deepEqual(cardProfile.canonDatabase['爱丽丝'].canonChanges, []);
});

test('an ungrounded AU owner cannot create a database row, while a named current candidate can', async () => {
    const rejectedCore = loadCore();
    const rejectedProfile = freshProfile(rejectedCore);
    globalThis.__fcrTestContext.chat = [
        { is_user: true, mes: '好的', send_date: 'ungrounded-owner-user' },
    ];
    await rejectedCore.persistCanonDeltas({
        work: 'MCU', timeline: '', entities: [], entityCandidates: [], sceneCandidates: [], messageId: 1,
        canonChanges: [{
            entity: '灭霸', work: 'MCU', kind: 'character', facet: 'relationship.幻视',
            current: '不存在', source: 'user', evidence: '好的',
        }],
        auEvidenceSources: { user: '好的' },
    }, { syncScene: false, syncCanon: false });
    assert.equal(rejectedCore.activeAuFacts(rejectedProfile).length, 0);
    assert.deepEqual(Object.keys(rejectedProfile.canonDatabase), [],
        '与 owner 无关的泛化 evidence 不能凭空创建原作对象及 AU');

    const acceptedCore = loadCore();
    const acceptedProfile = freshProfile(acceptedCore);
    const evidence = '灭霸在本宇宙从未获得无限宝石';
    globalThis.__fcrTestContext.chat = [
        { is_user: true, mes: evidence, send_date: 'grounded-owner-user' },
    ];
    await acceptedCore.persistCanonDeltas({
        work: 'MCU', timeline: '', entities: ['灭霸'], messageId: 1,
        entityCandidates: [{
            candidateName: '灭霸', kind: 'character', workHint: 'MCU', isOriginal: false,
        }],
        sceneCandidates: [],
        canonChanges: [{
            entity: '灭霸', work: 'MCU', kind: 'character', facet: 'item.无限宝石.ownership',
            current: '从未获得无限宝石', source: 'user', evidence,
        }],
        auEvidenceSources: { user: evidence },
    }, { syncScene: false, syncCanon: false });
    assert.equal(acceptedCore.activeAuFacts(acceptedProfile).length, 1);
    assert.ok(acceptedCore.findCanonRecordName('灭霸', acceptedProfile.canonDatabase, {
        kind: 'character', work: 'MCU',
    }));
});

test('unknown narrative-banner people and locations default to original-safe identities', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.workTitle = '测试作品';
    const merged = core.mergeSceneWithNarrativeBanner(
        { workTitle: '测试作品', currentEntities: [], canonSubjects: [] },
        '<!--NE-BANNER-->雾隐庭院|夜晚|||星野澪<!--/NE-BANNER-->她安静地站在庭院里。',
        '',
    );
    const person = merged.currentEntities.find(candidate => candidate.candidateName === '星野澪');
    const location = merged.currentEntities.find(candidate => candidate.candidateName === '雾隐庭院');
    assert.equal(person?.kind, 'character');
    assert.equal(person?.isOriginal, true);
    assert.equal(location?.kind, 'location');
    assert.equal(location?.isOriginal, true);
    assert.ok(merged.canonSubjects.every(candidate => candidate.isOriginal),
        '横幅只能证明在场，未知对象不得据此进入原作检索');
});

test('an identical worldbook entry still records a successful worldSyncedAt ownership marker', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const start = source.indexOf('async function syncCanonDatabaseToWorldBook(');
    const end = source.indexOf('\nfunction formatCurrentSceneWorldEntry', start);
    const sync = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(sync, /if \(needsUpdate\) \{[\s\S]*?\n\s*\}\s*\n\s*syncedEntities\.add\(entity\);/,
        'byte-identical entries must enter the successful syncedEntities set outside needsUpdate');
    const diskWrite = sync.indexOf('if (changed || databaseChanged)');
    const syncedAt = sync.indexOf('const syncedAt = Date.now()', diskWrite);
    const markerWrite = sync.indexOf('worldSyncedAt = syncedAt', syncedAt);
    const saveSettings = sync.indexOf('saveSettingsDebounced()', markerWrite);
    assert.ok(diskWrite >= 0 && syncedAt > diskWrite && markerWrite > syncedAt && saveSettings > markerWrite,
        'worldSyncedAt must be committed after the optional disk-write branch even when changed=false');
});

test('fully rejected search pages carry acceptedEntities=0 through both reporting paths', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const enrichStart = source.indexOf('async function enrichPlanInBatches(');
    const enrichEnd = source.indexOf('\nfunction startCanonEnrichment', enrichStart);
    const enrich = source.slice(enrichStart, enrichEnd);
    assert.match(enrich, /pages\.acceptedEntities\s*=\s*acceptedEntities;/,
        'single-batch results must retain an explicit accepted entity array, including []');
    assert.match(enrich, /allPages\.acceptedEntities\s*=\s*cleanDetectedEntities\(\[\.\.\.acceptedEntities\]\);/,
        'multi/new-entity results must retain acceptedEntities=[] when every page is rejected');

    const sceneStart = source.indexOf('async function syncDynamicSceneState(');
    const sceneEnd = source.indexOf('\nfunction applyTextRevisions', sceneStart);
    const sceneSync = source.slice(sceneStart, sceneEnd);
    assert.match(sceneSync, /const acceptedCount = Array\.isArray\(pages\.acceptedEntities\)[\s\S]*?: 0;/);
    assert.match(sceneSync, /acceptedCount[\s\S]*?没有资料通过对象、作品与来源校验/,
        'scene report must distinguish returned-but-rejected pages from accepted research');

    const fillStart = source.indexOf('async function autoFillCurrentProfile(');
    const fillEnd = source.indexOf('\nfunction buildReference', fillStart);
    const autoFill = source.slice(fillStart, fillEnd);
    assert.match(autoFill, /const acceptedCount = Array\.isArray\(pages\.acceptedEntities\)[\s\S]*?: 0;/);
    assert.match(autoFill, /acceptedCount[\s\S]*?没有资料通过对象、作品与来源校验/,
        'manual fill background report must also expose acceptedEntities=0');
});

test('legacy migration is deferred until pending cleanup and legacy-entry deletion both complete', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const start = source.indexOf('async function refreshOrMigrateCanonDatabase()');
    const end = source.indexOf('\nfunction initialize()', start);
    const migrate = source.slice(start, end);
    assert.ok(start >= 0 && end > start);
    const pendingRetry = migrate.indexOf('await retryPendingWorldBookCleanup(cardProfile, { force: true })');
    const formatBranch = migrate.indexOf('cardProfile.canonDatabaseFormatVersion || 0', pendingRetry);
    assert.ok(pendingRetry >= 0 && formatBranch > pendingRetry);
    assert.match(migrate.slice(pendingRetry, formatBranch), /return;/,
        'an unfinished earlier cleanup must stop migration before any format mutation');

    const legacyBranch = migrate.slice(formatBranch, migrate.indexOf('\n    if ((cardProfile.canonDatabaseFormatVersion || 0) < CANON_DATABASE_FORMAT_VERSION)', formatBranch));
    const cleanupAttempt = legacyBranch.indexOf('await clearProfileWorldBookEntries');
    const failureReturn = legacyBranch.indexOf('return;', cleanupAttempt);
    const databaseReset = legacyBranch.indexOf('cardProfile.canonDatabase = {};');
    const formatCommit = legacyBranch.indexOf('cardProfile.canonDatabaseFormatVersion = CANON_DATABASE_FORMAT_VERSION;');
    assert.ok(cleanupAttempt >= 0 && failureReturn > cleanupAttempt
        && databaseReset > failureReturn && formatCommit > failureReturn,
        'legacy rows and their format version must remain intact until old worldbook cleanup succeeds');
    assert.match(legacyBranch.slice(cleanupAttempt, failureReturn), /cleanupPending\s*=\s*\{/);
});

test('world-info AU provenance survives inactivity but rolls back on an explicitly disabled entry', async () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.canonDatabase['神殿'] = {
        entity: '神殿', kind: 'location', work: '测试作品', aliases: ['神殿'],
        sources: [], canonChanges: [],
    };
    const evidence = '神殿在本世界已经被摧毁';
    const entry = {
        world: '本卡设定', uid: '17', hash: 'entry-v1', content: evidence, disabled: false,
    };
    const base = {
        work: '测试作品', timeline: '', entities: ['神殿'],
        entityCandidates: [{ candidateName: '神殿', kind: 'location', workHint: '测试作品', isOriginal: false }],
        auEvidenceSources: { world_info: evidence },
        auEvidenceAvailability: { world_info: true },
    };
    await core.persistCanonDeltas({
        ...base,
        canonChanges: [{
            entity: '神殿', kind: 'location', facet: 'state.destroyed', current: '已被摧毁',
            source: 'world_info', evidence,
        }],
        auEvidenceWorldEntries: [entry],
        auEvidenceWorldEntryStates: [entry],
    }, { syncScene: false, syncCanon: false });
    assert.equal(core.activeAuFacts(cardProfile).length, 1);
    assert.equal(core.activeAuFacts(cardProfile)[0].provenance[0].worldEntryUid, '17');

    await core.persistCanonDeltas({
        ...base, canonChanges: [], auEvidenceWorldEntries: [], auEvidenceWorldEntryStates: [entry],
    }, { syncScene: false, syncCanon: false });
    assert.equal(core.activeAuFacts(cardProfile).length, 1,
        'an enabled entry that simply did not trigger this turn must remain active');

    await core.persistCanonDeltas({
        ...base,
        canonChanges: [],
        auEvidenceWorldEntries: [],
        auEvidenceWorldEntryStates: [{ ...entry, disabled: true }],
    }, { syncScene: false, syncCanon: false });
    assert.equal(core.activeAuFacts(cardProfile).length, 0,
        'explicitly disabling the owning lore entry must remove its active AU');
    const source = readFileSync(sourcePath, 'utf8');
    const preflight = source.slice(
        source.indexOf('async function runPreflight('),
        source.indexOf('\n    const taskBusyOwner = ++busyOwner;', source.indexOf('async function runPreflight(')),
    );
    const reconcileAt = preflight.indexOf('await reconcileWorldInfoAuLifecycle(invocationFresh)');
    const referenceAt = preflight.indexOf('buildStoredGenerationReference(activeChat)');
    assert.ok(reconcileAt >= 0 && referenceAt > reconcileAt,
        'disabled lore provenance must be removed before the next local generation reference is built');
});

test('explicit named-event timeline instructions override the old local scene before generation', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.timeline = '奇异博士1结局后';
    cardProfile.currentScene = {
        characters: ['古一'], locations: ['卡玛泰姬'], subjects: [], summary: '旧场景不应继续注入',
    };
    const instruction = '把时间线推进到纽约大战结束后。';
    assert.equal(core.explicitTimelineDirectiveFromText(instruction)?.target, '纽约大战结束后');
    assert.equal(core.explicitTimelineDirectiveFromText('他回忆起纽约大战结束后的往事。'), null);
    const reference = core.buildStoredGenerationReference([
        { is_user: true, mes: instruction },
    ]);
    assert.match(reference, /纽约大战结束后/);
    assert.match(reference, /最高优先/);
    assert.doesNotMatch(reference, /旧场景不应继续注入/);
});

test('post-review timeline ignores recollections but accepts an exact latest-user event directive', () => {
    const core = loadCore();
    const cardProfile = freshProfile(core);
    cardProfile.timeline = '2020年';
    cardProfile.lastAutoTimeline = '2020年';
    const recalled = core.scenePlanFromAnalysis({
        workTitle: '', timeline: '2017年大战结束后', timelineChanged: true,
        timelineEvidence: '2017年大战已经结束',
        _fcrFinalBody: '他回忆起2017年大战已经结束时的往事。',
        currentEntities: [], canonSubjects: [], canonChanges: [],
    });
    assert.equal(recalled.timelineChanged, false);
    assert.equal(recalled.timeline, '2020年');

    const directive = core.explicitTimelineDirectiveFromText('将时间线切换到奥创纪元期间。');
    const directedScene = core.sceneWithExplicitTimelineDirective({
        timeline: '2020年', currentEntities: [], canonSubjects: [], canonChanges: [],
    }, directive);
    const directed = core.scenePlanFromAnalysis(directedScene);
    assert.equal(directed.timelineChanged, true);
    assert.equal(directed.timeline, '奥创纪元期间');
});

test('automatic prose revisions must be bound to the reviewed entity in the same sentence', () => {
    const core = loadCore();
    const records = [{ entity: '斯特兰奇', aliases: ['史蒂芬·斯特兰奇'], kind: 'character' }];
    assert.equal(core.modelRevisionIsGrounded({
        entity: '斯特兰奇', aspect: '经历', original: '门突然关闭', revised: '门保持打开',
    }, '门突然关闭。斯特兰奇站在窗边。', records), false);
    assert.equal(core.modelRevisionIsGrounded({
        entity: '斯特兰奇', aspect: '外貌', original: '斯特兰奇的斗篷是蓝色', revised: '斯特兰奇的斗篷是红色',
    }, '斯特兰奇的斗篷是蓝色。', records), true);
});

test('long local sources preserve explicit AU constraints from the middle without extra API calls', () => {
    const core = loadCore();
    const source = `${'甲'.repeat(1900)}斯特兰奇在本世界从未拥有时间宝石${'乙'.repeat(1900)}`;
    const excerpt = core.contextAwareExcerpt(source, 3000);
    assert.match(excerpt, /斯特兰奇在本世界从未拥有时间宝石/);
    assert.ok(excerpt.length < source.length);
});

test('current-model manual analysis blocks overlapping main generation and stopped retries preserve permission', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const preflight = source.slice(
        source.indexOf('async function runPreflight('),
        source.indexOf('\nglobalThis.fandomCanonPreflight', source.indexOf('async function runPreflight(')),
    );
    assert.match(preflight, /isAutomaticGeneration && busy && settings\(\)\.analysisSource === 'current'/);
    assert.match(preflight, /typeof _abortGeneration === 'function'/);
    const review = source.slice(
        source.indexOf('async function reviewGeneratedMessage('),
        source.indexOf('\nfunction applyRevisionsToStructuredValue', source.indexOf('async function reviewGeneratedMessage(')),
    );
    assert.match(review, /!options\.allowStopped && stoppedGenerationEpoch === taskGenerationEpoch/);
    assert.match(review, /scheduleMessageReview\(index, type, \{\s*\.\.\.options,/);
});

test('manifest interceptor and minimum client version match the runtime API used by the plugin', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const source = readFileSync(sourcePath, 'utf8');
    assert.equal(manifest.generate_interceptor, 'fandomCanonPreflight');
    assert.match(source, /globalThis\.fandomCanonPreflight\s*=/);
    assert.equal(manifest.minimum_client_version, '1.13.2');
});
