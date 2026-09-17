importScripts('defaults.js');

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-1.13.0';
const MAX_PARALLEL = 4;
const MAX_WAITING = 80; // A page cannot build a longer queue than this.
const MAX_ATTEMPTS = 4;
const FEED_HOSTS = /(^|\.)(x\.com|twitter\.com|reddit\.com|linkedin\.com|news\.ycombinator\.com)$/;
const SETTING_KEYS = Object.keys(PF_DEFAULTS);

// Everything lives in chrome.storage.local, and this call closes that area to content scripts.
// A feed page that breaks into the content script cannot read the key and cannot change a rule or a limit.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

chrome.runtime.onInstalled.addListener(({ reason }) => {
    chrome.storage.local.remove(['proxyUrl', 'poke']); // Left from version 0.2.
    if (reason === 'install') chrome.tabs.create({ url: 'welcome.html' });
});

const getSettings = async () => pfNormalize(await chrome.storage.local.get(PF_DEFAULTS));
const rulesKey = rules => JSON.stringify(rules.map(r => [r.kind, r.scope, r.text]));
// The part of the settings that a feed tab needs. It holds no key, no limit and no counter.
const forFeed = s => ({ enabled: s.enabled, mode: s.mode, showScores: s.showScores, threshold: s.threshold, rules: s.rules, rulesKey: rulesKey(s.rules) });

let running = 0;
const waiting = [];
const limit = fn =>
    new Promise((resolve, reject) => {
        const start = () => {
            running++;
            fn().then(resolve, reject).finally(() => {
                running--;
                waiting.shift()?.();
            });
        };
        if (running < MAX_PARALLEL) start();
        else if (waiting.length < MAX_WAITING) waiting.push(start);
        else resolve({ error: 'queue_full' });
    });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Counters for the popup and for the daily limit. One object for each day. All writes go through one chain,
// so two requests cannot take the same last place under the limit.
let statsChain = Promise.resolve();
const withStats = fn =>
    (statsChain = statsChain.catch(() => {}).then(async () => {
        const { stats } = await chrome.storage.local.get('stats');
        const today = stats?.day === pfToday() ? stats : { day: pfToday(), checked: 0, hidden: 0, tokens: 0 };
        const result = fn(today);
        await chrome.storage.local.set({ stats: today });
        return result;
    }));

// Takes one place under the daily limit before the request goes out. A failed request keeps its place.
const reservePost = dailyLimit => withStats(today => today.checked < dailyLimit && Boolean(++today.checked));

const setProblem = problem => chrome.storage.local.set({ problem: problem ? { message: problem, at: Date.now() } : null });

async function askJev(apiKey, state, questions, attempts = MAX_ATTEMPTS, stillWanted = async () => true) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt && !(await stillWanted())) throw new Error('off'); // The user turned the filter off between two attempts.
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model: MODEL, state, questions }),
        });
        if (res.status === 429 || res.status >= 500) {
            await sleep(500 * 2 ** attempt);
            continue;
        }
        if (res.status === 401 || res.status === 403) throw new Error('bad_key');
        if (!res.ok) throw new Error(`Jev answered ${res.status}`);
        return res.json();
    }
    throw new Error('Jev is busy. Try again in a minute.');
}

async function judge({ site, text, replyingTo, isReply }) {
    // Read the settings now, not when the request entered the queue: the user can turn the filter off in between.
    const settings = await getSettings();
    const { apiKey } = await chrome.storage.local.get('apiKey');
    if (!apiKey) return { error: 'no_key' };
    if (!settings.enabled || !settings.rules.length) return { error: 'off' };
    isReply = Boolean(isReply || replyingTo);
    // A rule that does not apply to this item gets no question, and its answer is null.
    const applies = settings.rules.map(r => pfApplies(r, isReply));
    if (!applies.some(Boolean)) return { probs: applies.map(() => null), rulesKey: rulesKey(settings.rules) };
    if (!(await reservePost(settings.dailyLimit))) return { error: 'daily_limit' };

    // The rules come from the protected store, never from the page. The page gives the post text only.
    const state = {
        site: String(site).slice(0, 40),
        post: { is_reply: isReply, text: String(text).slice(0, PF_LIMITS.maxPostLength) },
        ...(replyingTo && { original_post: String(replyingTo).slice(0, PF_LIMITS.maxPostLength) }),
    };
    const questions = Object.fromEntries(
        settings.rules
            .map((r, i) => [`r${i}`, { type: 'noul', instructions: `Does the post in \`post.text\` match this description: ${JSON.stringify(r.text)}?` }])
            .filter((_, i) => applies[i])
    );

    try {
        const json = await askJev(apiKey, state, questions, MAX_ATTEMPTS, async () => (await getSettings()).enabled);
        withStats(today => (today.tokens += json.usage?.input_tokens ?? 0));
        setProblem(null);
        return { probs: settings.rules.map((_, i) => (applies[i] ? json.answers[`r${i}`].noul : null)), rulesKey: rulesKey(settings.rules) };
    } catch (e) {
        if (e.message === 'off') return { error: 'off' };
        const message = e.message === 'bad_key' ? 'TypeSafe refused the API key. Check it in the settings.' : e.message;
        setProblem(message);
        return { error: message };
    }
}

// The welcome page and the popup check a key with one request, with no second try.
async function testKey(apiKey) {
    try {
        await askJev(apiKey, 'Hello', { ok: { type: 'noul', instructions: 'Is this a greeting?' } }, 1);
        return { ok: true };
    } catch (e) {
        return { ok: false, message: e.message === 'bad_key' ? 'TypeSafe refused this key.' : e.message };
    }
}

// Jev reads a new rule one time and chooses its scope. A weak or failed answer gives 'all', the safe choice.
async function classifyRule(text) {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    if (!apiKey) return { scope: 'all' };
    try {
        const json = await askJev(apiKey, { filter_rule: String(text).slice(0, PF_LIMITS.maxRuleLength) }, {
            scope: {
                type: 'choice',
                instructions: 'A user of a social feed filter wrote `filter_rule` to describe content to filter. Which kind of content does the rule target?',
                criteria: {
                    replies: 'The rule is only about replies or comments under a post',
                    posts: 'The rule is only about top-level posts or threads, not about replies',
                    all: 'The rule is about a topic or a quality that can show in both posts and replies, or the rule names both',
                },
            },
        }, 1);
        const { choice, confidence } = json.answers.scope;
        return { scope: confidence >= 0.6 && PF_SCOPES.includes(choice) ? choice : 'all' };
    } catch {
        return { scope: 'all' };
    }
}

// Feed tabs cannot read the store. Send them the new settings after each change.
chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    const keyChanged = 'apiKey' in changes;
    if (!keyChanged && !SETTING_KEYS.some(k => k in changes)) return;
    const message = { type: 'settings', settings: forFeed(await getSettings()), retry: keyChanged };
    for (const tab of await chrome.tabs.query({})) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return; // Only this extension can talk to the worker.
    const fromFeed = sender.tab && FEED_HOSTS.test(new URL(sender.url ?? sender.tab.url ?? 'https://invalid').hostname);
    const fromOwnPage = sender.url?.startsWith(chrome.runtime.getURL(''));

    if (msg.type === 'getSettings' && fromFeed) {
        getSettings().then(s => reply(forFeed(s)));
        return true;
    }
    if (msg.type === 'judge' && fromFeed) {
        limit(() => judge(msg)).then(reply);
        return true;
    }
    if (msg.type === 'count' && fromFeed) {
        chrome.action.setBadgeBackgroundColor({ color: '#FF6B2C', tabId: sender.tab.id });
        chrome.action.setBadgeTextColor?.({ color: '#FFFFFF', tabId: sender.tab.id });
        chrome.action.setBadgeText({ text: msg.hidden ? String(msg.hidden) : '', tabId: sender.tab.id });
        const fresh = Math.min(50, Math.max(0, Number(msg.newlyHidden) || 0));
        if (fresh) withStats(today => (today.hidden += fresh));
    }
    if (msg.type === 'classifyRule' && fromOwnPage) {
        classifyRule(msg.text).then(reply);
        return true;
    }
    if (msg.type === 'testKey' && fromOwnPage) {
        testKey(String(msg.apiKey)).then(reply);
        return true;
    }
});
