const $ = id => document.getElementById(id);
const pct = n => `${Math.round(n * 100)}%`;
const KIND_TEXT = { hide: 'Hide', only: 'Show only' };
const SCOPE_TEXT = { all: 'All', replies: 'Replies', posts: 'Posts' };

// Jev reads the rule and chooses where it applies. The chip shows "…" during the request.
async function chooseScope(rule) {
    rule.thinking = true;
    drawRules();
    const answer = await chrome.runtime.sendMessage({ type: 'classifyRule', text: rule.text }).catch(() => null);
    rule.thinking = false;
    rule.scope = answer?.scope ?? 'all';
    drawRules();
    save(0);
}

let rules = [];

function drawRules() {
    const box = $('rules');
    box.textContent = '';
    $('ruleCount').textContent = rules.length ? `${rules.length} of ${PF_LIMITS.maxRules}` : '';
    if (!rules.length) {
        const empty = box.appendChild(document.createElement('div'));
        empty.className = 'empty';
        empty.textContent = 'No rules yet. Write one below, or pick a ready one.';
    }
    rules.forEach((rule, i) => {
        const row = box.appendChild(document.createElement('div'));
        row.className = 'rule card';

        const kind = row.appendChild(document.createElement('button'));
        kind.className = 'kind';
        kind.dataset.kind = rule.kind;
        kind.textContent = KIND_TEXT[rule.kind];
        kind.title = 'Click to change between "Hide" and "Show only"';
        kind.onclick = () => {
            rule.kind = rule.kind === 'hide' ? 'only' : 'hide';
            drawRules();
            save(0);
        };

        const input = row.appendChild(document.createElement('input'));
        // A ready rule shows its short label. Its full description goes to Jev.
        input.value = rule.label;
        input.title = rule.text;
        input.maxLength = PF_LIMITS.maxRuleLength;
        input.oninput = () => {
            rule.label = rule.text = input.value; // An edit makes the rule a custom rule.
            input.title = input.value;
            drawPresets();
            save(900);
        };
        input.onchange = () => rule.text.trim() && chooseScope(rule); // The text changed, so Jev chooses the scope again.

        const scope = row.appendChild(document.createElement('button'));
        scope.className = `scope${rule.thinking ? ' thinking' : ''}`;
        scope.dataset.scope = rule.scope ?? 'all';
        scope.textContent = rule.thinking ? '…' : SCOPE_TEXT[rule.scope ?? 'all'];
        scope.title = 'Where the rule applies: all, replies only, or posts only. Jev chose this. Click to change it.';
        scope.onclick = () => {
            rule.scope = PF_SCOPES[(PF_SCOPES.indexOf(rule.scope ?? 'all') + 1) % PF_SCOPES.length];
            drawRules();
            save(0);
        };

        const del = row.appendChild(document.createElement('button'));
        del.className = 'del';
        del.textContent = '×';
        del.title = 'Delete this rule';
        del.onclick = () => {
            rules.splice(i, 1);
            drawRules();
            save(0);
        };
    });
    $('adder').hidden = rules.length >= PF_LIMITS.maxRules;
    drawPresets();
}

function drawPresets() {
    const box = $('presets');
    box.textContent = '';
    for (const preset of PF_PRESETS) {
        const chip = box.appendChild(document.createElement('button'));
        chip.dataset.kind = preset.kind;
        chip.textContent = `+ ${preset.kind === 'only' ? 'Only ' : ''}${preset.label.toLowerCase()}`;
        chip.title = preset.text;
        chip.disabled = rules.length >= PF_LIMITS.maxRules || rules.some(r => r.text === preset.text);
        chip.onclick = () => {
            rules.push({ ...preset });
            drawRules();
            save(0);
        };
    }
}

const read = () => ({
    enabled: $('enabled').checked,
    mode: document.querySelector('input[name=mode]:checked').value,
    showScores: $('showScores').checked,
    threshold: Math.round((1 - Number($('strict').value)) * 100) / 100,
    dailyLimit: Math.min(100000, Math.max(100, Number($('dailyLimit').value) || PF_DEFAULTS.dailyLimit)),
    rules: rules.filter(r => r.text.trim()).map(({ thinking, ...r }) => r),
});

function drawStrict() {
    const threshold = 1 - Number($('strict').value);
    $('strictText').textContent = `hides at ${pct(threshold)} sure`;
}

let timer;
function save(delay) {
    drawStrict();
    clearTimeout(timer);
    timer = setTimeout(async () => {
        await chrome.storage.local.set(read()).catch(e => alert(`Sweep could not save the settings: ${e.message}`));
        $('saved').classList.add('on');
        setTimeout(() => $('saved').classList.remove('on'), 900);
    }, delay);
}

async function drawStatus() {
    const { apiKey, stats, problem } = await chrome.storage.local.get(['apiKey', 'stats', 'problem']);
    const today = stats?.day === pfToday() ? stats : { checked: 0, hidden: 0, tokens: 0 };
    $('setup').hidden = Boolean(apiKey);
    $('main').style.opacity = apiKey ? '' : '0.45';
    $('keyHint').textContent = apiKey ? `Saved in this browser: ••••${apiKey.slice(-4)}` : 'No key yet';
    $('statHidden').textContent = today.hidden;
    $('statChecked').textContent = today.checked;
    const cost = (today.tokens / 1e6) * PF_USD_PER_MILLION_TOKENS;
    $('statCost').textContent = today.tokens ? `about $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : '';
    // A problem older than ten minutes is history.
    const fresh = problem && Date.now() - problem.at < 600_000;
    $('problem').hidden = !fresh || !apiKey;
    if (fresh) $('problem').textContent = problem.message;
}

async function saveKey() {
    const apiKey = $('apiKey').value.trim();
    if (!apiKey) return;
    $('saveKey').disabled = true;
    $('saveKey').textContent = 'Checking…';
    const result = await chrome.runtime.sendMessage({ type: 'testKey', apiKey });
    $('saveKey').disabled = false;
    $('saveKey').textContent = 'Save';
    $('keyError').hidden = result.ok;
    if (!result.ok) return void ($('keyError').textContent = result.message);
    await chrome.storage.local.set({ apiKey, problem: null });
    $('apiKey').value = '';
    drawStatus();
}

chrome.storage.local.get(PF_DEFAULTS).then(stored => {
    const s = pfNormalize(stored);
    rules = s.rules.map(r => ({ ...r }));
    $('enabled').checked = s.enabled;
    $('showScores').checked = s.showScores;
    $('strict').value = 1 - s.threshold;
    $('dailyLimit').value = s.dailyLimit;
    document.querySelector(`input[name=mode][value=${s.mode}]`).checked = true;
    drawRules();
    drawStrict();
    drawStatus();

    const addRule = () => {
        const text = $('add').value.trim();
        if (!text) return;
        const rule = { kind: $('addKind').dataset.kind, scope: 'all', label: text, text };
        rules.push(rule);
        $('add').value = '';
        $('addGo').disabled = true;
        chooseScope(rule);
        $('add').focus();
    };
    $('addKind').onclick = () => {
        const kind = $('addKind').dataset.kind === 'hide' ? 'only' : 'hide';
        $('addKind').dataset.kind = kind;
        $('addKind').textContent = KIND_TEXT[kind];
        $('add').focus();
    };
    $('add').addEventListener('input', () => ($('addGo').disabled = !$('add').value.trim()));
    $('add').addEventListener('keydown', e => e.key === 'Enter' && (e.preventDefault(), addRule()));
    $('addGo').onclick = addRule;
    for (const id of ['enabled', 'showScores', 'strict']) $(id).addEventListener('input', () => save(0));
    $('dailyLimit').addEventListener('change', () => save(0));
    document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', () => save(0)));
    $('saveKey').onclick = saveKey;
    $('apiKey').addEventListener('keydown', e => e.key === 'Enter' && saveKey());
    $('changeKey').onclick = async () => {
        await chrome.storage.local.remove('apiKey');
        await drawStatus();
        $('apiKey').focus();
    };
    chrome.storage.onChanged.addListener((_, area) => area === 'local' && drawStatus());
});
