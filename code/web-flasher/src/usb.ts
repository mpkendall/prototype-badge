// usb.ts
type SerialPort = any;
// Minimal MicroPython wrapper using Web Serial to upload files and run raw repl commands.
class MicroPythonWrapper {
    port: any;
    reader: ReadableStreamDefaultReader | null = null;
    writer: WritableStreamDefaultWriter | null = null;
    readingBuffer = '';
        isConnected = false;
        onDisconnect: (() => void) | null = null;
    readingUntil: string | null = null;
    resolveReadingUntilPromise: any = null;
    rejectReadingUntilPromise: any = null;
    constructor(port: any) {
        this.port = port;
    }

    async init() {
        this.reader = (this.port.readable as ReadableStream).getReader();
        this.writer = (this.port.writable as WritableStream).getWriter();
        // Start background read loop
        this.isConnected = true;
        if (typeof (navigator as any).serial !== 'undefined') {
            try {
                (navigator as any).serial.addEventListener('disconnect', (ev: any) => {
                    if (ev && ev.port && ev.port === this.port) {
                        this.isConnected = false;
                        if (this.onDisconnect) this.onDisconnect();
                    }
                });
            } catch (e) { /* ignore if not supported */ }
        }
        this.readForeverAndReport();
    }

    async readForeverAndReport() {
        try {
            if (wipeBadgeButton) wipeBadgeButton.disabled = true;
            if (saveConfigButton) saveConfigButton.disabled = true;
            if (uploadFirmwareButton) uploadFirmwareButton.disabled = true;
            while (true) {
                const { value, done } = await this.reader!.read();
                if (done) {
                    // Reader ended, mark disconnected and call onDisconnect
                    this.reader!.releaseLock();
                    this.isConnected = false;
                    if (this.onDisconnect) this.onDisconnect();
                    break;
                }
                if (value) {
                    const decoded = new TextDecoder().decode(value);
                    if (this.readingUntil != null) {
                        this.readingBuffer += decoded;
                        if (this.readingBuffer.indexOf(this.readingUntil) !== -1) {
                            const result = this.readingBuffer;
                            this.readingUntil = null;
                            this.readingBuffer = '';
                            if (this.resolveReadingUntilPromise) this.resolveReadingUntilPromise(result);
                        }
                    }
                }
            }
        } catch (err) {
            console.warn('Read loop ended:', err);
        }
    }

    async write(str: string) {
        const enc = new TextEncoder();
        await this.writer!.write(enc.encode(str));
    }

    readUntil(token: string, timeout = 10000): Promise<string> {
        // If token is already in buffer, return right away
        if (this.readingBuffer.indexOf(token) !== -1) {
            return Promise.resolve(this.readingBuffer);
        }
        this.readingUntil = token;
        this.readingBuffer = '';
        return new Promise((resolve, reject) => {
            this.resolveReadingUntilPromise = resolve;
            this.rejectReadingUntilPromise = reject;
            setTimeout(() => {
                if (this.readingUntil == token) {
                    this.readingUntil = null;
                    reject(new Error('Read timeout'));
                }
            }, timeout);
        });
    }

    async getPrompt() {
        // send ctrl-C and ctrl-B to interrupt and stop
        await this.write('\x03\x02');
        await this.readUntil('>>>');
    }

    async enterRawRepl() {
        await this.write('\x01');
        await this.readUntil('raw REPL; CTRL-B to exit');
    }

    async exitRawRepl() {
        await this.write('\x02');
        await this.readUntil('>>>');
    }

    async executeRaw(code: string) {
        // send code in chunks
        const S = 128;
        for (let i = 0; i < code.length; i += S) {
            const chunk = code.slice(i, i + S);
            await this.write(chunk);
            await new Promise((r) => setTimeout(r, 10));
        }
        await this.write('\x04');
        const out = await this.readUntil('\x04>', 20000);
        return out;
    }

    async uploadFileFromString(path: string, content: string, reporter?: (uploaded: number, total: number) => void, perChunkTimeout?: number) {
        const bytes = new TextEncoder().encode(content);
        return await this.uploadFile(path, bytes, reporter, perChunkTimeout);
    }

    async uploadFile(path: string, content: Uint8Array, reporter?: (uploaded: number, total: number) => void, _perChunkTimeout?: number) {
        const safePath = path.replace(/'/g, "\\'");
        // Fast upload implementation (based on shipwrecked webflasher behavior)
        const CHUNK_SIZE = 512; // larger chunk size to speed up transfers
        reporter = reporter || (() => false);
        await this.getPrompt();
        await this.enterRawRepl();
        try {
            await this.executeRaw(`f=open('${safePath}','wb')\nw=f.write`);
            for (let i = 0; i < content.byteLength; i += CHUNK_SIZE) {
                const chunk = new Uint8Array(content.slice(i, i + CHUNK_SIZE));
                await this.executeRaw(`w(bytes([${Array.from(chunk).join(',')}]))`);
                if (reporter) reporter(Math.min(i + CHUNK_SIZE, content.byteLength), content.byteLength);
                // small pause to allow the device to process and not overflow buffers
                await new Promise((r) => setTimeout(r, 5));
            }
            await this.executeRaw('f.close()');
        } finally {
            try { await this.exitRawRepl(); } catch (e) { /* ignore */ }
        }
    }

    async createFolder(path: string) {
        const safePath = path.replace(/'/g, "\\'");
        await this.getPrompt();
        await this.enterRawRepl();
        // Create parent folders if necessary by iterating path segments
        const code = `def mkdirs(p):\n  import uos\n  parts = [x for x in p.split('/') if x]\n  cur = ''\n  for part in parts:\n    cur += '/' + part\n    try:\n      uos.mkdir(cur)\n    except OSError:\n      pass\n\nmkdirs('${safePath}')`;
        await this.executeRaw(code);
        await this.exitRawRepl();
    }

    // Download file to string by using helper b2a_base64 method then decoding
    async runHelper() {
        const HELPER_CODE = `import os\nimport json\nimport ubinascii\n\nos.chdir('/')\n\ndef is_directory(path):\n  return True if os.stat(path)[0] == 0x4000 else False\n\ndef get_all_files(path, array_of_files = []):\n  files = os.ilistdir(path)\n  for file in files:\n    is_folder = file[1] == 16384\n    p = path + '/' + file[0]\n    array_of_files.append({"path": p, "type": "folder" if is_folder else "file"})\n    if is_folder:\n        array_of_files = get_all_files(p, array_of_files)\n  return array_of_files\n\ndef ilist_all(path):\n  print(json.dumps(get_all_files(path)))\n\ndef delete_folder(path):\n  files = get_all_files(path)\n  for file in files:\n    if file['type'] == 'file':\n        os.remove(file['path'])\n  for file in reversed(files):\n    if file['type'] == 'folder':\n        os.rmdir(file['path'])\n  # Avoid attempting to remove root path\n  if path != '/':\n    try:\n      os.rmdir(path)\n    except OSError:\n      pass\n\ndef b2a_base64(data):\n  import ubinascii\n  return ubinascii.b2a_base64(data)\n`;
        await this.getPrompt();
        await this.enterRawRepl();
        await this.executeRaw(HELPER_CODE);
        await this.exitRawRepl();
    }

    async removeFolder(path: string) {
        const safePath = path.replace(/'/g, "\\'");
        await this.getPrompt();
        await this.runHelper();
        await this.enterRawRepl();
        await this.executeRaw(`delete_folder('${safePath}')`);
        await this.exitRawRepl();
    }

    async downloadFileToString(path: string) {
        await this.runHelper();
        await this.enterRawRepl();
        const safePath = path.replace(/'/g, "\\'");
        const out = await this.executeRaw(`with open('${safePath}','rb') as f:\n  b = b2a_base64(f.read())\n  for i in b:\n    print(chr(i), end='')`);
        await this.exitRawRepl();
        // extract base64 from mixer output
        const idxOk = out.indexOf('OK');
        const idxEnd = out.indexOf('\x04');
        if (idxOk === -1 || idxEnd === -1) return '';
        const base64 = out.slice(idxOk + 2, idxEnd);
        return atob(base64);
    }

    async downloadFileToBytes(path: string) {
        // Returns the file as raw bytes (Uint8Array) by reusing download helper
        await this.runHelper();
        await this.enterRawRepl();
        const safePath = path.replace(/'/g, "\\'");
        const out = await this.executeRaw(`with open('${safePath}','rb') as f:\n  b = b2a_base64(f.read())\n  for i in b:\n    print(chr(i), end='')`);
        await this.exitRawRepl();
        const idxOk = out.indexOf('OK');
        const idxEnd = out.indexOf('\x04');
        if (idxOk === -1 || idxEnd === -1) return new Uint8Array([]);
        const base64 = out.slice(idxOk + 2, idxEnd);
        const decoded = atob(base64);
        return Uint8Array.from(decoded, c => c.charCodeAt(0));
    }

    async close() {
        try {
            if (this.reader) { await this.reader.cancel(); }
        } catch (e) {}
        try { if (this.writer) { await this.writer.releaseLock(); } } catch (e) {}
        try { await this.port.close(); } catch (e) {}
        this.isConnected = false;
        if (this.onDisconnect) this.onDisconnect();
    }
}

// Initialize UI after elements are defined


let port: SerialPort | null = null;
let mp: MicroPythonWrapper | null = null;
// Whether we're currently performing an upload or other write operation
let isUploading = false;
// Track overall bytes for progress across upload flow
let totalBytes = 0;

const btn = document.getElementById("connect-button") as HTMLButtonElement;
const filters = [
    { usbVendorId: 0x2E8A, usbProductId: 0x0005 }
]

if (btn) {
    btn.addEventListener("click", async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (!("serial" in navigator)) {
            console.error("Web Serial API not supported.");
            return;
        }

        // If we already have an active MicroPython wrapper and it's connected, disconnect
        if (mp && mp.isConnected) {
            if (isUploading) {
                const ok = confirm('An upload/write is currently in progress. Disconnecting will abort it and may leave the badge in an inconsistent state. Do you want to continue?');
                if (!ok) return;
            }
            try {
                if (mp) {
                    try { await mp.close(); } catch (e) {}
                }
                // close the underlying port
                try { await port.close(); } catch (e) {}
                mp = null;
                port = null;
                setDisconnectedAppearance();
                console.log("Disconnected.");
            } catch (err) {
                console.error("Disconnect failed:", err);
            }
            return;
        }

        // Otherwise, attempt connection
        try {
            port = await (navigator as any).serial.requestPort({ filters });
            await port.open({ baudRate: 115200 });

            // Setup wrapper
            mp = new MicroPythonWrapper(port as any);
            mp.onDisconnect = () => {
                // ensure UI updates
                mp = null;
                port = null;
                updateConnectButtonAppearance();
            };
            await mp.init();
            // Try to pre-load existing configuration & version, if present
            try {
                const cfg = await mp.downloadFileToString('/config.json');
                if (cfg) {
                    const parsed = JSON.parse(cfg);
                    (document.getElementById('userName') as HTMLInputElement).value = parsed.userName || '';
                    (document.getElementById('userHandle') as HTMLInputElement).value = parsed.userHandle || '';
                    (document.getElementById('userPronouns') as HTMLInputElement).value = parsed.userPronouns || '';
                }
            } catch (e) { /* ignore if not present */ }
            try {
                const version = await mp.downloadFileToString('/VERSION');
                if (version) {
                    console.log('Device firmware version:', version);
                }
            } catch (e) { }

            updateConnectButtonAppearance();
            console.log("Connected:", port);
        } catch (err) {
            console.log("Connection failed or cancelled:", err);
        }
    });
}

// UI helpers

function setConnectedAppearance() {
    btn.textContent = "Disconnect";
    btn.classList.remove("bg-green-700", "hover:bg-green-600");
    btn.classList.add("bg-red-900", "hover:bg-red-700");
    if (saveConfigButton) saveConfigButton.disabled = false;
    if (loadConfigButton) loadConfigButton.disabled = false;
    if (uploadFirmwareButton) uploadFirmwareButton.disabled = false;
    if (wipeBadgeButton) wipeBadgeButton.disabled = false;
    // update textual status indicator
    const statusText = document.getElementById('connection-text');
    const dot = document.getElementById('connection-dot');
    if (statusText) statusText.textContent = 'Connected';
    if (dot) {
        dot.classList.remove('bg-red-500');
        dot.classList.add('bg-green-500');
    }
    setUIFieldsEnabled(true);
}

function setDisconnectedAppearance() {
    btn.textContent = "Connect";
    btn.classList.remove("bg-red-900", "hover:bg-red-700");
    btn.classList.add("bg-green-700", "hover:bg-green-600");
    if (saveConfigButton) saveConfigButton.disabled = true;
    if (loadConfigButton) loadConfigButton.disabled = true;
    if (uploadFirmwareButton) uploadFirmwareButton.disabled = true;
    if (wipeBadgeButton) wipeBadgeButton.disabled = true;
    const statusText = document.getElementById('connection-text');
    const dot = document.getElementById('connection-dot');
    if (statusText) statusText.textContent = 'Disconnected';
    if (dot) {
        dot.classList.remove('bg-green-500');
        dot.classList.add('bg-red-500');
    }
    setUIFieldsEnabled(false);
}

function setUIFieldsEnabled(enabled: boolean) {
    // Text inputs
    const userNameEl = document.getElementById('userName') as HTMLInputElement | null;
    const userHandleEl = document.getElementById('userHandle') as HTMLInputElement | null;
    const userPronounsEl = document.getElementById('userPronouns') as HTMLInputElement | null;
    if (userNameEl) { userNameEl.disabled = !enabled; userNameEl.classList.toggle('opacity-50', !enabled); userNameEl.classList.toggle('cursor-not-allowed', !enabled); }
    if (userHandleEl) { userHandleEl.disabled = !enabled; userHandleEl.classList.toggle('opacity-50', !enabled); userHandleEl.classList.toggle('cursor-not-allowed', !enabled); }
    if (userPronounsEl) { userPronounsEl.disabled = !enabled; userPronounsEl.classList.toggle('opacity-50', !enabled); userPronounsEl.classList.toggle('cursor-not-allowed', !enabled); }

    // File input + firmware actions
    if (firmwareInput) {
        firmwareInput.disabled = !enabled;
        firmwareInput.classList.toggle('opacity-50', !enabled);
        firmwareInput.classList.toggle('cursor-not-allowed', !enabled);
        firmwareInput.classList.toggle('pointer-events-none', !enabled);
    }
    // keep choose firmware available even when disconnected (allows offline staging)
    if (chooseFirmwareButton) {
        chooseFirmwareButton.classList.toggle('opacity-50', false);
        chooseFirmwareButton.classList.remove('cursor-not-allowed');
        chooseFirmwareButton.classList.remove('pointer-events-none');
        chooseFirmwareButton.classList.toggle('cursor-pointer', true);
    }
    // allow 'Load firmware' offline as well
    if (loadFirmwareButton) {
        loadFirmwareButton.classList.toggle('opacity-50', false);
        loadFirmwareButton.classList.remove('cursor-not-allowed');
        loadFirmwareButton.classList.remove('pointer-events-none');
        loadFirmwareButton.classList.toggle('cursor-pointer', true);
    }
    if (uploadFirmwareButton) {
        uploadFirmwareButton.disabled = !enabled;
        uploadFirmwareButton.classList.toggle('opacity-50', !enabled);
        uploadFirmwareButton.classList.toggle('cursor-not-allowed', !enabled);
        uploadFirmwareButton.classList.toggle('pointer-events-none', !enabled);
        uploadFirmwareButton.classList.toggle('cursor-pointer', enabled);
    }

    // Config controls
    if (saveConfigButton) {
        saveConfigButton.disabled = !enabled;
        saveConfigButton.classList.toggle('opacity-50', !enabled);
        saveConfigButton.classList.toggle('cursor-not-allowed', !enabled);
        saveConfigButton.classList.toggle('pointer-events-none', !enabled);
        saveConfigButton.classList.toggle('cursor-pointer', enabled);
    }
    if (loadConfigButton) {
        loadConfigButton.disabled = !enabled;
        loadConfigButton.classList.toggle('opacity-50', !enabled);
        loadConfigButton.classList.toggle('cursor-not-allowed', !enabled);
        loadConfigButton.classList.toggle('pointer-events-none', !enabled);
        loadConfigButton.classList.toggle('cursor-pointer', enabled);
    }

    // Wipe and update
    if (wipeBadgeButton) {
        wipeBadgeButton.disabled = !enabled;
        wipeBadgeButton.classList.toggle('opacity-50', !enabled);
        wipeBadgeButton.classList.toggle('cursor-not-allowed', !enabled);
        wipeBadgeButton.classList.toggle('pointer-events-none', !enabled);
        wipeBadgeButton.classList.toggle('cursor-pointer', enabled);
    }
    // Keep checking for updates available even if not connected; do not disable updateBtn
}

function updateConnectButtonAppearance() {
    if (mp && mp.isConnected) {
        setConnectedAppearance();
    } else {
        setDisconnectedAppearance();
    }
}

// Listen for serial events (connect/disconnect) if supported to update UI
if (typeof (navigator as any).serial !== 'undefined') {
    try {
        (navigator as any).serial.addEventListener('connect', () => {
            updateConnectButtonAppearance();
        });
        (navigator as any).serial.addEventListener('disconnect', (ev: any) => {
            if (ev && ev.port && ev.port === port) {
                if (mp) {
                    try { mp.isConnected = false; } catch (e) { }
                }
                mp = null;
                port = null;
                updateConnectButtonAppearance();
            }
        });
    } catch (e) { /* not supported in some browsers */ }
}

// Close the port if the page unloads
window.addEventListener('beforeunload', (e) => {
    if (isUploading) {
        // Prevent accidental navigation during an upload
        e.preventDefault();
        (e as any).returnValue = '';
        return;
    }
    if (mp) {
        try { mp.close(); } catch (e) {}
    }
});

// UI wiring and features
const saveConfigButton = document.getElementById('save-config') as HTMLButtonElement | null;
const updateBtn = document.getElementById('update-button') as HTMLButtonElement | null;
const loadConfigButton = document.getElementById('load-config') as HTMLButtonElement | null;
const firmwareInput = document.getElementById('firmware-input') as HTMLInputElement | null;
const chooseFirmwareButton = document.getElementById('choose-firmware') as HTMLButtonElement | null;
const firmwareFilenameEl = document.getElementById('firmware-filename') as HTMLSpanElement | null;
const loadFirmwareButton = document.getElementById('load-firmware') as HTMLButtonElement | null;
const uploadFirmwareButton = document.getElementById('upload-firmware') as HTMLButtonElement | null;
const wipeBadgeButton = document.getElementById('wipe-badge') as HTMLButtonElement | null;

let firmwareFiles: { path: string, content: Uint8Array }[] = [];

function arraysEqual(a: Uint8Array, b: Uint8Array) {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

if (saveConfigButton) {
    saveConfigButton.addEventListener('click', async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (!mp) { alert('Not connected'); return; }
        if (isUploading) { if (!confirm('An upload is currently in progress. Overwriting configuration now will interrupt it. Continue?')) return; }
        const userName = (document.getElementById('userName') as HTMLInputElement).value || '';
        const userHandle = (document.getElementById('userHandle') as HTMLInputElement).value || '';
        const userPronouns = (document.getElementById('userPronouns') as HTMLInputElement).value || '';
        const data = { userName, userHandle, userPronouns };
        try {
            isUploading = true;
            if (progressBar) progressBar.value = 0;
            await mp.uploadFileFromString('/config.json', JSON.stringify(data, null, 2), (uploaded, total) => {
                const perc = Math.round((uploaded / total) * 100);
                appendOrUpdateLog('config', `Saving config: ${perc}% (${uploaded}/${total})`);
                if (progressBar) progressBar.value = perc;
            });
            console.log('Configuration saved successfully');
            alert('Configuration saved');
        } catch (err) {
            console.error('Failed to save configuration', err);
            appendOrUpdateLog('config', `Save failed: ${err}`);
            alert('Failed to save configuration: ' + err);
        } finally {
            if (saveConfigButton) saveConfigButton.disabled = false;
            isUploading = false;
            if (progressBar) progressBar.value = 0;
            appendOrUpdateLog('config', `Config save completed`);
        }
    });
}

if (loadConfigButton) {
    loadConfigButton.addEventListener('click', async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (!mp) { alert('Not connected'); return; }
        try {
            if (progressBar) progressBar.value = 0;
            appendOrUpdateLog('config', 'Loading config...');
            const content = await mp.downloadFileToString('/config.json');
            if (progressBar) progressBar.value = 100;
            const parsed = JSON.parse(content);
            (document.getElementById('userName') as HTMLInputElement).value = parsed.userName || '';
            (document.getElementById('userHandle') as HTMLInputElement).value = parsed.userHandle || '';
            (document.getElementById('userPronouns') as HTMLInputElement).value = parsed.userPronouns || '';
            alert('Configuration loaded');
        } catch (err) {
            console.error('Failed to load configuration', err);
            alert('Failed to load configuration: ' + (err as any).message || err);
        }
    });
}

if (loadFirmwareButton && firmwareInput) {
    loadFirmwareButton.addEventListener('click', async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const files = firmwareInput.files;
        if (!files || !files[0]) { alert('Please choose a firmware file (.zip or single file)'); return; }
        const file = files[0];
        if (file.name.endsWith('.zip')) {
            // @ts-ignore - dynamically import jszip
            const JSZip = (await import('jszip')).default;
            const jszip = new JSZip();
            const zip = await jszip.loadAsync(file);
            firmwareFiles = [];
            const zipFiles = zip.files as any;
            for (const path in zipFiles) {
                const entry = zipFiles[path] as any;
                if (entry.dir) { continue; }
                // skip macOS system files and folder metadata
                if (path.startsWith('__MACOSX') || path.endsWith('.DS_Store')) continue;
                const content = await entry.async('uint8array');
                firmwareFiles.push({ path: '/' + path, content });
            }
            // Deduplicate by path in case any duplicates exist in the zip
            {
                const map = new Map<string, Uint8Array>();
                for (const f of firmwareFiles) {
                    map.set(f.path, f.content);
                }
                firmwareFiles = [...map.entries()].map(([path, content]) => ({ path, content }));
            }
            // Move VERSION file to end so we upload it last
            const versionIndex = firmwareFiles.findIndex(f => f.path === '/VERSION');
            if (versionIndex !== -1) {
                const [versionFile] = firmwareFiles.splice(versionIndex, 1);
                firmwareFiles.push(versionFile);
            }
            console.log('Loaded firmware files:', firmwareFiles.map(f => f.path));
            alert('Firmware loaded (' + firmwareFiles.length + ' files)');
        } else {
            const buf = new Uint8Array(await file.arrayBuffer());
            firmwareFiles = [{ path: '/' + file.name, content: buf }];
            console.log('Loaded single firmware', firmwareFiles[0].path);
            alert('Firmware loaded: ' + file.name);
        }
    });
}

// Wire up the choose button and show filename when user selects a file
if (chooseFirmwareButton && firmwareInput) {
    chooseFirmwareButton.addEventListener('click', (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        firmwareInput.click();
    });
    firmwareInput.addEventListener('change', () => {
        const files = firmwareInput.files;
        if (!files || !files[0]) {
            if (firmwareFilenameEl) firmwareFilenameEl.textContent = 'No file chosen';
            return;
        }
        const file = files[0];
        if (firmwareFilenameEl) firmwareFilenameEl.textContent = file.name;
    });
}

if (uploadFirmwareButton) {
    uploadFirmwareButton.addEventListener('click', async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (!mp) { alert('Not connected'); return; }
        if (!firmwareFiles || firmwareFiles.length === 0) { alert('No firmware loaded'); return; }
        try {
            isUploading = true;
            clearLog();
            appendOrUpdateLog('overall', 'Starting firmware upload...');
            // Deduplicate at upload time as well to be safe
            if (firmwareFiles && firmwareFiles.length > 0) {
                const uniq = new Map<string, Uint8Array>();
                for (const f of firmwareFiles) uniq.set(f.path, f.content);
                firmwareFiles = [...uniq.entries()].map(([path, content]) => ({ path, content }));
            }
            console.log('Firmware upload will include', firmwareFiles.length, 'unique files');
            const folders = new Set<string>();
            for (const f of firmwareFiles) {
                const dir = f.path.substring(0, f.path.lastIndexOf('/')) || '/';
                if (dir && dir !== '/') folders.add(dir);
            }
            // include current UI config if present
            const userNameVal = (document.getElementById('userName') as HTMLInputElement).value || '';
            const userHandleVal = (document.getElementById('userHandle') as HTMLInputElement).value || '';
            const userPronounsVal = (document.getElementById('userPronouns') as HTMLInputElement).value || '';
            if (userNameVal || userHandleVal || userPronounsVal) {
                const configStr = JSON.stringify({ userName: userNameVal, userHandle: userHandleVal, userPronouns: userPronounsVal }, null, 2);
                // add or replace any existing '/config.json'
                const existing = firmwareFiles.findIndex(f => f.path === '/config.json');
                if (existing !== -1) {
                    firmwareFiles[existing].content = new TextEncoder().encode(configStr);
                } else {
                    firmwareFiles.push({ path: '/config.json', content: new TextEncoder().encode(configStr) });
                }
            }
            // Create folders in order of increasing depth to ensure parents are created first
            const folderList = [...folders].sort((a, b) => a.split('/').filter(Boolean).length - b.split('/').filter(Boolean).length);
            for (const folder of folderList) {
                try { await mp.createFolder(folder); } catch (e) { /* ignore exists errors */ }
            }
            // ensure we end by uploading VERSION at the very end
            const vIdx = firmwareFiles.findIndex(f => f.path === '/VERSION');
            if (vIdx !== -1) {
                const [v] = firmwareFiles.splice(vIdx, 1);
                firmwareFiles.push(v);
            }

            // compute total bytes for overall progress
            totalBytes = firmwareFiles.reduce((s, ff) => s + ff.content.byteLength, 0);
            let uploadedBytesTotal = 0;
            for (let fileIndex = 0; fileIndex < firmwareFiles.length; fileIndex++) {
                const f = firmwareFiles[fileIndex];
                appendOrUpdateLog('overall', `Uploading file ${fileIndex+1}/${firmwareFiles.length}: ${f.path}`);
                console.log('Uploading', f.path);
                appendOrUpdateLog(f.path, `Uploading ${f.path} ...`);
                try {
                    // Try file upload with a small number of retries; use fast upload by default
                    const fileRetries = 1;
                    let fileLastErr: any = null;
                    const FILE_UPLOAD_TIMEOUT_MS = 120000;
                    for (let attempt = 0; attempt <= fileRetries; attempt++) {
                        try {
                            const fileUploadPromise = mp.uploadFile(f.path, f.content, (uploaded, total) => {
                                const percent = Math.round((uploaded / total) * 100);
                                appendOrUpdateLog(f.path, `Uploading ${f.path}: ${percent}%`);
                                const overallUploaded = uploadedBytesTotal + uploaded;
                                const overallPercent = Math.round((overallUploaded / totalBytes) * 100);
                                appendOrUpdateLog('overall', `Overall: ${overallPercent}% (${overallUploaded}/${totalBytes} bytes)`);
                                if (progressBar) progressBar.value = overallPercent;
                            });
                            await Promise.race([fileUploadPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('File upload timeout')), FILE_UPLOAD_TIMEOUT_MS))]);
                            fileLastErr = null;
                            break;
                        } catch (err) {
                            fileLastErr = err;
                            appendOrUpdateLog(f.path, `Attempt ${attempt+1} failed: ${err}`);
                            // small backoff
                            await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
                        }
                    }
                    if (fileLastErr) {
                        appendOrUpdateLog(f.path, `Failed after ${fileRetries+1} attempts: ${fileLastErr}`);
                        // continue to next file rather than aborting the whole upload
                        continue;
                    }
                    uploadedBytesTotal += f.content.byteLength;
                    appendOrUpdateLog(f.path, `Uploaded ${f.path}`);
                    // Verify by reading back the file and comparing bytes only for critical files like VERSION
                    try {
                        if (f.path === '/VERSION') {
                            let verified = false;
                            const verifyRetries = 1;
                            for (let v = 0; v <= verifyRetries; v++) {
                                try {
                                    const remote = await Promise.race([
                                        mp.downloadFileToBytes(f.path),
                                        new Promise((_, rej) => setTimeout(() => rej(new Error('Download verification timeout')), 60000))
                                    ]) as Uint8Array;
                                    if (arraysEqual(remote, f.content)) {
                                        verified = true;
                                        appendOrUpdateLog(f.path, `Verified ${f.path}`);
                                        break;
                                    } else {
                                        appendOrUpdateLog(f.path, `Verification failed for ${f.path}: mismatch`);
                                        if (v < verifyRetries) {
                                            appendOrUpdateLog(f.path, `Re-uploading ${f.path} for verification...`);
                                            const reUploadPromise = mp.uploadFile(f.path, f.content, (uploaded, total) => {
                                                const p = Math.round((uploaded / total) * 100);
                                                appendOrUpdateLog(f.path, `Re-upload: ${f.path}: ${p}%`);
                                            });
                                            await Promise.race([reUploadPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('File re-upload timeout')), 90000))]);
                                        }
                                    }
                                } catch (vErr) {
                                    appendOrUpdateLog(f.path, `Verification attempt failed: ${vErr}`);
                                    if (v < verifyRetries) await new Promise(r => setTimeout(r, 200));
                                }
                            }
                            if (!verified) throw new Error('Verification failed');
                        }
                    } catch (verErr) {
                        appendOrUpdateLog(f.path, `Verification error: ${verErr}`);
                    }
                } catch (err) {
                    console.error('Failed to upload', f.path, err);
                    appendOrUpdateLog(f.path, `Failed to upload ${f.path}: ${err}`);
                }
            }
            appendLog('Firmware uploaded (attempted).');
        } catch (err) {
            console.error('Upload failed', err);
            appendLog('Upload failed: ' + err);
            // Keep visible error also as alert
            alert('Upload failed: ' + err);
        } finally {
            if (wipeBadgeButton) wipeBadgeButton.disabled = false;
            isUploading = false;
            // Re-enable upload button and mark progress complete
            if (uploadFirmwareButton) uploadFirmwareButton.disabled = false;
            if (progressBar) progressBar.value = 100;
            appendOrUpdateLog('overall', `Overall: 100% (${totalBytes}/${totalBytes} bytes)`);
            appendLog('Upload process completed.');
            setTimeout(() => {
                if (progressBar) progressBar.value = 0;
            }, 2000);
        }
    });
}

if (wipeBadgeButton) {
    wipeBadgeButton.addEventListener('click', async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (!mp) { alert('Not connected'); return; }
        if (!confirm('Are you sure you want to wipe the badge?')) return;
        try {
            if (isUploading) { if (!confirm('An upload is in progress. Wipe may interfere. Continue?')) return; }
            isUploading = true;
            if (progressBar) progressBar.value = 10;
            await mp.removeFolder('/');
            alert('Badge wiped successfully');
        } catch (err) {
            console.error('Wipe failed', err);
            alert('Wipe failed: ' + err);
        } finally {
            isUploading = false;
            if (progressBar) progressBar.value = 0;
        }
    });
}
if (updateBtn) {
    updateBtn.addEventListener('click', async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        clearLog();
        appendLog('Checking for updates...');
        // Attempt to fetch latest firmware zip from the reference repo (if hosted)
        try {
            updateBtn.disabled = true;
            updateBtn.textContent = 'Checking...';

            firmwareFiles = [];

            // Preferred method: fetch files directly from the code/embedded folder (recursive)
            const dirUrl = 'https://api.github.com/repos/mpkendall/prototype-badge/contents/code/embedded?ref=main';
            let resp = await fetch(dirUrl);
            if (resp.ok) {
                // Recursively traverse directories to find files and keep folder structure
                async function fetchGitHubDir(path: string) {
                    const url = `https://api.github.com/repos/mpkendall/prototype-badge/contents/${encodeURIComponent(path)}?ref=main`;
                    const r = await fetch(url);
                    if (!r.ok) throw new Error('Failed to fetch ' + url + ': ' + r.statusText);
                    const listing = await r.json();
                    if (!Array.isArray(listing)) throw new Error('Unexpected directory listing for ' + path);
                    for (const item of listing) {
                        if (item.type === 'file') {
                            if (!item.download_url) continue;
                            // skip macOS system files and folder metadata
                            if ((item.path && item.path.indexOf('__MACOSX') !== -1) || (item.name && item.name.endsWith('.DS_Store'))) continue;
                            try {
                                const fileResp = await fetch(item.download_url);
                                if (!fileResp.ok) continue;
                                const arrayBuf = await fileResp.arrayBuffer();
                                const content = new Uint8Array(arrayBuf);
                                // compute path relative to code/embedded and keep structure
                                const rel = item.path.replace(/^code\/embedded\/?/, '');
                                firmwareFiles.push({ path: '/' + rel, content });
                            } catch (e) {
                                console.warn('Failed to download file', item.download_url, e);
                                continue;
                            }
                        } else if (item.type === 'dir') {
                            // recurse into subdirectory
                            await fetchGitHubDir(item.path);
                        }
                    }
                }
                try {
                    await fetchGitHubDir('code/embedded');
                } catch (err) {
                    // If recursive fetch fails, fall back to the original behavior by trying to read the top level listing entries
                    console.warn('Recursive fetch failed, falling back to listing:', err);
                    const listing = await resp.json();
                    if (!Array.isArray(listing)) throw new Error('Unexpected directory listing');
                    for (const item of listing) {
                        if (item.type !== 'file') continue;
                        if (!item.download_url) continue;
                        const fileResp = await fetch(item.download_url);
                        if (!fileResp.ok) continue;
                        const arrayBuf = await fileResp.arrayBuffer();
                        const content = new Uint8Array(arrayBuf);
                        firmwareFiles.push({ path: '/' + item.name, content });
                    }
                }
            } else {
                // Fallback: look for a single firmware zip in the code folder
                const zipUrl = 'https://api.github.com/repos/mpkendall/prototype-badge/contents/code/embedded/firmware.zip?ref=main';
                resp = await fetch(zipUrl);
                if (resp.ok) {
                    const json = await resp.json();
                    if (!json.content) throw new Error('No content available in firmware.zip');
                    const b64 = json.content;
                    const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                    const blob = new Blob([binary]);
                    // parse zip content
                    // @ts-ignore
                    const JSZip = (await import('jszip')).default;
                    const jszip = new JSZip();
                    const zip = await jszip.loadAsync(blob);
                    const zipFiles = zip.files as any;
                    for (const path in zipFiles) {
                        const entry = zipFiles[path] as any;
                        if (entry.dir) continue;
                        if (path.startsWith('__MACOSX') || path.endsWith('.DS_Store')) continue;
                        const content = await entry.async('uint8array');
                        firmwareFiles.push({ path: '/' + path, content });
                    }
                } else {
                    throw new Error('Firmware fetch failed: ' + resp.statusText);
                }
            }
            // ensure uniqueness by path
            {
                const uniq = new Map<string, Uint8Array>();
                for (const f of firmwareFiles) {
                    uniq.set(f.path, f.content);
                }
                firmwareFiles = [...uniq.entries()].map(([path, content]) => ({ path, content }));
            }
            // Move VERSION to end
            const versionIndex = firmwareFiles.findIndex(f => f.path === '/VERSION');
            if (versionIndex !== -1) {
                const [versionFile] = firmwareFiles.splice(versionIndex, 1);
                firmwareFiles.push(versionFile);
            }
            appendLog('Latest firmware fetched and loaded (' + firmwareFiles.length + ' files)');
        } catch (err) {
            console.error('Update failed', err);
            alert('Update failed: ' + err);
        } finally {
            updateBtn.disabled = false;
            updateBtn.textContent = 'Check for Updates';
        }
    });
}
// Help modal wiring
const helpButton = document.getElementById('help-button') as HTMLButtonElement | null;
const helpModal = document.getElementById('help-modal') as HTMLDivElement | null;
const helpClose = document.getElementById('help-close') as HTMLButtonElement | null;
const helpOverlay = document.getElementById('help-overlay') as HTMLDivElement | null;

function openHelp() {
    if (!helpModal || !helpButton) return;
    helpModal.classList.remove('opacity-0', 'pointer-events-none');
    helpModal.classList.add('flex');
    helpButton.setAttribute('aria-expanded', 'true');
}

function closeHelp() {
    if (!helpModal || !helpButton) return;
    helpModal.classList.add('opacity-0', 'pointer-events-none');
    helpModal.classList.remove('flex');
    helpButton.setAttribute('aria-expanded', 'false');
}

if (helpButton) {
    helpButton.addEventListener('click', (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        // Toggle by checking our visibility classes
        if (helpModal && helpModal.classList.contains('opacity-0')) {
            openHelp();
        } else {
            closeHelp();
        }
    });
}

if (helpClose) {
    helpClose.addEventListener('click', (e: Event) => { e.preventDefault(); closeHelp(); });
}
if (helpOverlay) {
    helpOverlay.addEventListener('click', (e: Event) => { e.preventDefault(); closeHelp(); });
}
window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeHelp();
});
// Update UI initial state now that elements exist
updateConnectButtonAppearance();

// Logging below the Update button
const logBox = document.createElement('div');
logBox.id = 'update-log';
logBox.className = 'mt-3 bg-black/10 p-2 rounded text-sm font-mono max-h-40 overflow-auto text-stone-300';
const updateButtonWrapper = document.getElementById('update-button')?.parentElement;
if (updateButtonWrapper) updateButtonWrapper.appendChild(logBox);

// Add a progress bar for overall progress
const progressBar = document.createElement('progress');
progressBar.id = 'update-progress';
progressBar.max = 100;
progressBar.value = 0;
progressBar.className = 'w-full mt-2 h-2';
if (updateButtonWrapper) updateButtonWrapper.appendChild(progressBar);

const logEntries = new Map<string, HTMLDivElement>();
function appendLog(msg: string) {
    const line = document.createElement('div');
    line.textContent = msg;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
}

function appendOrUpdateLog(key: string, msg: string) {
    if (logEntries.has(key)) {
        const el = logEntries.get(key)!;
        el.textContent = msg;
    } else {
        const el = document.createElement('div');
        el.id = `log-${Math.random().toString(36).slice(2)}`;
        el.textContent = msg;
        logEntries.set(key, el);
        logBox.appendChild(el);
    }
    logBox.scrollTop = logBox.scrollHeight;
}

function clearLog() {
    if (logBox) logBox.innerHTML = '';
    logEntries.clear();
    if (progressBar) progressBar.value = 0;
}

