const $ = id => document.getElementById(id);

async function drawKey() {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    $('stepKey').classList.toggle('done', Boolean(apiKey));
    $('keyOk').hidden = !apiKey;
    if (apiKey) $('keyOk').textContent = `The key works. It is saved in this browser: ••••${apiKey.slice(-4)}`;
    $('apiKey').placeholder = apiKey ? 'Paste a new key to replace it' : 'Paste your API key';
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
    drawKey();
}

$('saveKey').onclick = saveKey;
$('apiKey').addEventListener('keydown', e => e.key === 'Enter' && saveKey());
drawKey();
