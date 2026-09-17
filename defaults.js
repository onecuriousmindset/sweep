// Shared by the content script, the popup, the welcome page and the service worker.
// A rule has a short label (shown on the post) and a full description (sent to Jev).
const PF_PRESETS = [
    { kind: 'hide', scope: 'replies', label: 'AI reply', text: 'reads as written by an AI or a reply bot: it praises or rephrases the original post in polished, generic language, often ends with a question to get engagement, and adds no personal experience, no specific fact and no real opinion' },
    { kind: 'hide', label: 'Slop', text: 'is mass-produced engagement content: a generic motivational line, a recycled listicle or "thread" hook, or vague advice with no specifics, written to get likes and follows. A short, casual, rude or sarcastic remark from a real person is not a match' },
    { kind: 'hide', label: 'Engagement bait', text: 'asks for likes, reposts, follows or comments to get reach, or opens with a hook such as "nobody tells you this"' },
    { kind: 'hide', label: 'Crypto', text: 'promotes crypto, tokens, NFTs or a get-rich-quick scheme' },
    { kind: 'hide', label: 'Brag', text: "brags or humble-brags about the author's own success, income or status" },
    { kind: 'hide', label: 'Rage bait', text: 'is written mainly to provoke anger or outrage' },
    { kind: 'only', label: 'High quality', text: 'is high quality: gives specific information, an original insight or first-hand experience' },
];

// Settings live in chrome.storage.local, which the worker closes to content scripts. They do not sync.
const PF_DEFAULTS = {
    enabled: true,
    mode: 'overlay', // 'overlay' keeps the post under a blur; 'remove' takes it out of the feed
    showScores: false,
    threshold: 0.5,
    dailyLimit: 5000, // posts sent to Jev for each day; a guard for the user's own API key
    rules: PF_PRESETS.slice(0, 4), // AI reply, slop, engagement bait, crypto
};

// A rule looks at each item ('all'), at replies only, or at posts that are not replies only.
// Jev chooses the scope when the user adds a rule. The user can change it.
const PF_SCOPES = ['all', 'replies', 'posts'];
const pfApplies = (rule, isReply) => rule.scope === 'all' || (rule.scope === 'replies') === Boolean(isReply);

const PF_LIMITS = { maxRules: 12, maxRuleLength: 300, maxPostLength: 1500 };
const PF_USD_PER_MILLION_TOKENS = 0.042;

// Settings can come from an older version or from a damaged store. Bring each value back into its range.
const pfClamp = (n, min, max, fallback) => (Number.isFinite(Number(n)) ? Math.min(max, Math.max(min, Number(n))) : fallback);
const pfNormalize = settings => ({
    enabled: settings.enabled !== false,
    showScores: settings.showScores === true,
    mode: settings.mode === 'remove' ? 'remove' : 'overlay',
    threshold: pfClamp(settings.threshold, 0.05, 0.95, PF_DEFAULTS.threshold),
    dailyLimit: Math.round(pfClamp(settings.dailyLimit, 100, 100000, PF_DEFAULTS.dailyLimit)),
    rules: (Array.isArray(settings.rules) ? settings.rules : PF_DEFAULTS.rules)
        .map(r => (typeof r === 'string' ? { kind: 'hide', label: r, text: r } : r))
        .filter(r => r && typeof r.text === 'string' && r.text.trim())
        .slice(0, PF_LIMITS.maxRules)
        .map(r => ({
            kind: r.kind === 'only' ? 'only' : 'hide',
            scope: PF_SCOPES.includes(r.scope) ? r.scope : 'all',
            label: String(r.label || r.text).slice(0, PF_LIMITS.maxRuleLength),
            text: r.text.slice(0, PF_LIMITS.maxRuleLength),
        })),
});

const pfToday = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
