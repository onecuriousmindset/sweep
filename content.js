// One adapter per site.
//   selector  the post elements
//   root      the element that holds the full post (default: the post element)
//   nodes     the elements to blur or to remove (default: the root)
//   host      the element that gets the overlay (default: the root)
const xText = article => article.querySelector('[data-testid="tweetText"], div[lang], div.whitespace-pre-wrap')?.textContent ?? '';

const ADAPTERS = [
    {
        site: 'Hacker News',
        host_re: /news\.ycombinator\.com$/,
        selector: 'tr.athing:not(.comtr)',
        text: el => el.querySelector('.titleline')?.textContent ?? '',
        // A story is three table rows: title, subtext, spacer.
        nodes: el => [el, el.nextElementSibling, el.nextElementSibling?.nextElementSibling].filter(Boolean),
        host: el => el.querySelector('.titleline')?.parentElement ?? el,
        veilState: 'veil-cells',
    },
    {
        site: 'Reddit',
        host_re: /reddit\.com$/,
        selector: 'shreddit-post',
        text: el => [el.getAttribute('post-title'), el.querySelector('[slot="text-body"]')?.textContent].filter(Boolean).join('\n'),
    },
    {
        site: 'X',
        host_re: /(^|\.)(x|twitter)\.com$/,
        // X serves two layouts: one with data-testid attributes, one with utility classes only.
        selector: 'article',
        text: el => xText(el),
        // In the utility-class layout, the clickable row around the article holds the padding and the border.
        root: el => el.closest('[role="link"][data-href]') ?? el,
        // On a post page, the address holds the ID of the main post. Posts above the main post are its parents.
        // Posts below it are replies. X takes the main post off the page on a long scroll, so keep its text.
        replyingTo: (el, text) => {
            const pageId = location.pathname.match(/\/status\/(\d+)/)?.[1];
            if (!pageId) return null;
            const idOf = article => (article.closest('[data-href]')?.dataset.href ?? article.querySelector('a[href*="/status/"]')?.getAttribute('href') ?? '').match(/\/status\/(\d+)/)?.[1];
            if (idOf(el) === pageId) return void (originals[pageId] = text);
            const main = [...document.querySelectorAll('article')].find(article => idOf(article) === pageId);
            if (main) originals[pageId] ??= xText(main).trim();
            const isParent = main && el.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING;
            return isParent ? null : originals[pageId] ?? '(the main post is not on the screen)';
        },
    },
    {
        site: 'LinkedIn',
        host_re: /linkedin\.com$/,
        selector: 'div.feed-shared-update-v2, div[data-urn^="urn:li:activity"]',
        text: el => el.querySelector('.update-components-text, .feed-shared-inline-show-more-text')?.textContent ?? '',
    },
];

const adapter = ADAPTERS.find(a => a.host_re.test(location.hostname));
const MIN_TEXT = 12;
const MAX_TRIES = 2;
const originals = {}; // post ID -> text of the main post of that page
const pct = n => `${Math.round(n * 100)}%`;

let settings = { ...pfNormalize(PF_DEFAULTS), enabled: false, rulesKey: '' }; // Off until the worker sends the real settings.
let pausedUntil = 0;
let retryTimer;
const posts = new Map(); // element -> { text, probs, revealed, hidden, counted, place, closed, overlay, badge }
const cache = new Map(); // post text -> probs, for the current rules

const make = (tag, className, text) => {
    const el = document.createElement(tag);
    el.className = className;
    if (text) el.textContent = text;
    return el;
};

// The labels show the user's rule text. They sit in a closed shadow root: the scripts of the feed page
// can see that a box is there, but they cannot read what is in it.
const SEALED_CSS = `
    :host { all: initial; }
    .row { max-width: 100%; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: inherit; font: 600 12px/1 system-ui, sans-serif; }
    .chip, button { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px; border: 0; border-radius: 999px;
        background: #fff4e6; color: #1f1a17; box-shadow: 0 1px 2px #0003, 0 4px 14px #0002; white-space: nowrap; font: inherit; }
    .chip { min-width: 0; max-width: min(280px, 100%); box-sizing: border-box; }
    .chip .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .chip::before { content: ''; flex: none; width: 7px; height: 7px; border-radius: 50%; background: #ff6b2c; }
    .chip.only::before { background: #2f9e6b; }
    .chip i { flex: none; font-style: normal; opacity: 0.55; font-variant-numeric: tabular-nums; }
    .chip.small { height: 20px; font-size: 10.5px; opacity: 0.9; box-shadow: none; }
    .chip.small::before { display: none; }
    .chip.small { display: block; max-width: 300px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; }
    button { background: #ff6b2c; color: #fff; font-weight: 700; cursor: pointer; transition: transform 0.12s; }
    button:hover { transform: scale(1.05); }
    .row.compact .chip, .row.compact button { height: 18px; font-size: 10.5px; padding: 0 8px; box-shadow: none; }
`;
function sealed(className) {
    const box = make('div', className);
    const shadow = box.attachShadow({ mode: 'closed' });
    shadow.appendChild(make('style', '', SEALED_CSS));
    const inside = shadow.appendChild(make('div', `row${adapter.veilState === 'veil-cells' ? ' compact' : ''}`));
    return { box, inside };
}

// A "hide" rule fails a post when Jev says yes. A "show only" rule fails a post when Jev says no.
const failures = post =>
    (post.probs ?? [])
        .map((p, i) => ({ rule: settings.rules[i], p: p === null ? null : settings.rules[i].kind === 'only' ? 1 - p : p }))
        .filter(f => f.p !== null && f.p >= settings.threshold) // null: the rule does not apply to this item
        .sort((a, b) => b.p - a.p);

function render(el) {
    const post = posts.get(el);
    const root = adapter.root?.(el) ?? el;
    const nodes = adapter.nodes?.(el) ?? [root];
    const host = adapter.host?.(el) ?? root;
    const veilState = adapter.veilState ?? 'veil';

    const failed = settings.enabled ? failures(post) : [];
    const active = failed.length > 0 && !post.revealed;
    if (active) post.place ??= root.getBoundingClientRect().top > innerHeight ? 'below' : 'seen';
    const remove = active && settings.mode === 'remove';
    const veil = active && !remove;
    // A post below the screen goes at once. A post that the user sees closes softly, so the feed does not jump.
    // Table rows (Hacker News) cannot animate their height.
    const closeSoftly = remove && post.place === 'seen' && !adapter.veilState && !post.closed;
    post.hidden = active;

    // The marks are data attributes. X and other React feeds write the class attribute again on each render.
    const state = remove ? 'gone' : veil ? veilState : null;
    if (closeSoftly) {
        post.closed = true;
        nodes.forEach(n => {
            n.style.height = `${n.offsetHeight}px`;
            n.dataset.pfState = 'closing';
            requestAnimationFrame(() => requestAnimationFrame(() => (n.style.height = '0px')));
            setTimeout(() => {
                n.style.height = '';
                if (n.dataset.pfState === 'closing') n.dataset.pfState = 'gone';
            }, 300);
        });
    } else nodes.forEach(n => (state ? (n.dataset.pfState = state) : delete n.dataset.pfState));

    post.overlay?.remove();
    post.badge?.remove();
    post.overlay = post.badge = null;

    if (veil) {
        const { box, inside } = sealed('pf-overlay');
        for (const f of failed) {
            const chip = inside.appendChild(make('span', `chip${f.rule.kind === 'only' ? ' only' : ''}`));
            const label = f.rule.kind === 'only' ? `Not ${f.rule.label.toLowerCase()}` : f.rule.label;
            chip.title = label; // The chip cuts a long label. The full text shows on hover.
            chip.append(make('span', 't', label), make('i', '', pct(f.p)));
        }
        inside.appendChild(make('button', '', 'Show'));
        // The feed opens the post on a click. Stop the click here.
        box.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            post.revealed = true;
            render(el);
            // The "reveal" state holds the transition, so the blur goes away softly.
            nodes.forEach(n => (n.dataset.pfState = 'reveal'));
            setTimeout(() => nodes.forEach(n => n.dataset.pfState === 'reveal' && delete n.dataset.pfState), 320);
            report();
        });
        post.overlay = host.appendChild(box);
    } else if (settings.enabled && !remove && settings.showScores && post.probs) {
        const { box, inside } = sealed('pf-badge');
        inside.appendChild(make('span', 'chip small', post.probs.map((p, i) => (p === null ? null : `${settings.rules[i].label} ${pct(p)}`)).filter(Boolean).join(' · ') || 'No rule applies'));
        post.badge = host.appendChild(box);
    }
    post.overlay || post.badge ? (host.dataset.pfHost = '') : delete host.dataset.pfHost;
}

function report() {
    const all = [...posts.values()];
    const fresh = all.filter(p => p.hidden && !p.counted);
    fresh.forEach(p => (p.counted = true));
    chrome.runtime.sendMessage({ type: 'count', hidden: all.filter(p => p.hidden).length, newlyHidden: fresh.length }).catch(() => {});
}

async function judge(el) {
    const post = posts.get(el);
    if (!post || !settings.enabled || !settings.rules.length || post.probs || post.pending || Date.now() < pausedUntil) return;
    if (post.tries >= MAX_TRIES) return; // One post never uses more than two requests for one set of rules.
    const replyingTo = adapter.replyingTo?.(el, post.text) ?? null;
    const cacheKey = `${Boolean(replyingTo)}|${post.text}`;
    if (cache.has(cacheKey)) post.probs = cache.get(cacheKey);
    else {
        post.pending = true;
        post.tries = (post.tries ?? 0) + 1;
        const res = await chrome.runtime
            .sendMessage({ type: 'judge', site: adapter.site, text: post.text, replyingTo })
            .catch(e => ({ error: String(e.message || e) }));
        post.pending = false;
        if (posts.get(el) !== post) return; // The feed gave this element to a different post.
        if (res?.probs && res.rulesKey !== settings.rulesKey) {
            // The rules changed during the request, so this answer is for other rules. Ask again in a moment,
            // when the worker and this tab have the same rules. This extra request does not count as a failed try.
            post.tries--;
            post.stale = (post.stale ?? 0) + 1;
            if (post.stale <= 3) setTimeout(() => judge(el), 600);
            return;
        }
        // These answers mean that no request went out, so they do not use one of the two tries.
        if (['off', 'no_key', 'daily_limit', 'queue_full'].includes(res?.error)) post.tries--;
        if (res?.error === 'off') return;
        if (!res || res.error) {
            // The popup shows the problem. Wait before the next try, so a bad key does not send a request for each post.
            pausedUntil = Date.now() + 30_000;
            clearTimeout(retryTimer);
            retryTimer = setTimeout(retryWaiting, 30_500);
            return;
        } else {
            post.probs = res.probs;
            cache.set(cacheKey, res.probs);
        }
    }
    render(el);
    report();
}

// Judge a post only when it comes near the screen.
const nearScreen = new IntersectionObserver(
    entries => entries.forEach(e => e.isIntersecting && judge(e.target)),
    { rootMargin: '2500px 0px' } // Far ahead, so the answer is there before the post is on the screen.
);

function forget(el) {
    const post = posts.get(el);
    post.probs = null;
    const wasEnabled = settings.enabled;
    settings.enabled = false; // Render with the filter off to take every mark off the element.
    render(el);
    settings.enabled = wasEnabled;
    posts.delete(el);
    nearScreen.unobserve(el);
}

function scan() {
    for (const el of document.querySelectorAll(adapter.selector)) {
        const text = adapter.text(el).trim();
        const known = posts.get(el);
        if (known?.text === text || text.length < MIN_TEXT) continue;
        if (known) forget(el); // Feeds with a virtual list use one element again for a different post.
        posts.set(el, { text });
        nearScreen.observe(el);
    }
    for (const el of posts.keys()) if (!el.isConnected) forget(el);
}

// Look again at each post that has no answer yet.
function retryWaiting() {
    pausedUntil = 0;
    for (const [el, post] of posts) {
        if (post.probs) continue;
        nearScreen.unobserve(el);
        nearScreen.observe(el);
    }
}

function rejudgeAll() {
    cache.clear();
    for (const [el, post] of posts) {
        Object.assign(post, { probs: null, revealed: false, tries: 0, stale: 0 });
        render(el);
        nearScreen.unobserve(el);
        nearScreen.observe(el);
    }
    report();
}

function applySettings(next, retry) {
    const before = settings;
    settings = next;
    if (before.mode !== settings.mode) posts.forEach(post => (post.closed = false));
    if (before.rulesKey !== settings.rulesKey || (!before.enabled && settings.enabled)) return rejudgeAll();
    posts.forEach((_, el) => render(el));
    report();
    if (retry) retryWaiting(); // The user saved a new API key.
}

if (adapter) {
    // This script cannot read the store of the extension. The worker sends the settings.
    chrome.runtime.sendMessage({ type: 'getSettings' }).then(first => {
        if (first) settings = first;
        scan();
        // The feed changes the page all the time. Scan at most one time for each 200 ms, and only when the browser is idle.
        let queued = false;
        new MutationObserver(() => {
            if (queued) return;
            queued = true;
            setTimeout(() => requestIdleCallback(() => ((queued = false), scan()), { timeout: 400 }), 200);
        }).observe(document.body, { childList: true, subtree: true });
    });

    chrome.runtime.onMessage.addListener((msg, sender) => {
        if (sender.id === chrome.runtime.id && msg.type === 'settings') applySettings(msg.settings, msg.retry);
    });
}
