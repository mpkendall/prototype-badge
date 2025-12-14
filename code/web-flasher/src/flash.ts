const helpButton = document.getElementById('help-button');
const helpModal = document.getElementById('help-modal');
const helpClose = document.getElementById('help-close');
const helpOverlay = document.getElementById('help-overlay');
function openHelp() { if (!helpModal || !helpButton) return; helpModal.classList.remove('opacity-0','pointer-events-none'); helpModal.classList.add('flex'); helpButton.setAttribute('aria-expanded','true'); }
function closeHelp() { if (!helpModal || !helpButton) return; helpModal.classList.add('opacity-0','pointer-events-none'); helpModal.classList.remove('flex'); helpButton.setAttribute('aria-expanded','false'); }
if (helpButton) helpButton.addEventListener('click', (e)=>{ e.preventDefault(); if (helpModal && helpModal.classList.contains('opacity-0')) openHelp(); else closeHelp(); });
if (helpClose) helpClose.addEventListener('click', (e)=>{ e.preventDefault(); closeHelp(); });
if (helpOverlay) helpOverlay.addEventListener('click', (e)=>{ e.preventDefault(); closeHelp(); });
window.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') closeHelp(); });

const startBtn = document.getElementById('start-read') as HTMLButtonElement | null;
const flasher = document.getElementById('flasher') as HTMLDivElement | null;
const userNameEl = document.getElementById('userName') as HTMLInputElement | null;
const userHandleEl = document.getElementById('userHandle') as HTMLInputElement | null;
const userPronounsEl = document.getElementById('userPronouns') as HTMLInputElement | null;
const bitHoldInput = document.getElementById('bitHold') as HTMLInputElement | null;
const bitGapInput = document.getElementById('bitGap') as HTMLInputElement | null;

let flashing = false;

function appendFlasherLog(msg: string) {
	console.log(msg);
}

function bytesToHex(buf: Uint8Array) {
	return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function crc8(buf: Uint8Array, poly = 0x07, init = 0x00) {
	let crc = init & 0xff;
	for (const b of buf) {
		crc ^= b & 0xff;
		for (let i = 0; i < 8; i++) {
			if (crc & 0x80) crc = ((crc << 1) ^ poly) & 0xff; else crc = (crc << 1) & 0xff;
		}
	}
	return crc & 0xff;
}

function encodeConfig() {
	const name = userNameEl?.value || '';
	const handle = userHandleEl?.value || '';
	const pronouns = userPronounsEl?.value || '';
	const encoder = new TextEncoder();
	const joined = `${name}\0${handle}\0${pronouns}`;
	const bytes = encoder.encode(joined);
	const checksum = crc8(bytes);
	const withChecksum = new Uint8Array(bytes.length + 1);
	withChecksum.set(bytes, 0);
	withChecksum[bytes.length] = checksum;
	return { bytes, checksum, withChecksum };
}

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

let BIT_HOLD_MS = bitHoldInput ? Math.max(10, parseInt(bitHoldInput.value || '120', 10)) : 120; // duration the bit color is shown
let BIT_GAP_MS = bitGapInput ? Math.max(0, parseInt(bitGapInput.value || '50', 10)) : 50;   // gap between bits (neutral)

async function flashBit(bit: number) {
	if (!flasher) return;
	if (bit) {
		flasher.classList.remove('bg-stone-800','bg-black');
		flasher.classList.add('bg-white');
	} else {
		flasher.classList.remove('bg-stone-800','bg-white');
		flasher.classList.add('bg-black');
	}
	await sleep(BIT_HOLD_MS);
	// neutral
	flasher.classList.remove('bg-white','bg-black');
	flasher.classList.add('bg-stone-800');
	await sleep(BIT_GAP_MS);
}

async function performFlash(data: Uint8Array): Promise<boolean> {
	flashing = true;
	// Prepare console context strings so we can re-print them while updating bits on one line
	const preEncodedHex = 'Pre-encoded (hex): ' + bytesToHex(data.subarray(0, data.length - 1));
	const crcLine = 'CRC-8: 0x' + data[data.length - 1].toString(16).padStart(2, '0');
	const encodedLine = 'Encoded with checksum: ' + bytesToHex(data);
	let bitLine = '';

	for (let i = 0; i < data.length; i++) {
		const b = data[i];
		// MSB first
		for (let bit = 7; bit >= 0; bit--) {
			if (!flashing) return false;
			const v = (b >> bit) & 1;
			// append bit to the on-line bit log
			bitLine += v ? '1' : '0';
			// Clear and re-print the summary + the single-line bit log so the bits appear appended on one line
			console.clear();
			console.log(preEncodedHex);
			console.log(crcLine);
			console.log(encodedLine);
			console.log('Bits: ' + bitLine);
			await flashBit(v);
		}
		// small gap between bytes
		await sleep(100);
	}
	// Final complete print (ensure final state)
	console.clear();
	console.log(preEncodedHex);
	console.log(crcLine);
	console.log(encodedLine);
	console.log('Bits: ' + bitLine);
	return true;
}

function setButtonToStop() {
	if (!startBtn) return;
	startBtn.textContent = 'Stop';
	startBtn.classList.remove('bg-green-700','hover:bg-green-600');
	startBtn.classList.add('bg-red-700','hover:bg-red-600');
}

function setButtonToStart() {
	if (!startBtn) return;
	startBtn.textContent = 'Start';
	startBtn.classList.remove('bg-red-700','hover:bg-red-600');
	startBtn.classList.add('bg-green-700','hover:bg-green-600');
}

if (startBtn) {
	startBtn.addEventListener('click', async (e) => {
		e.preventDefault();
		if (flashing) {
			flashing = false;
			setButtonToStart();
			appendFlasherLog('Flashing stopped by user');
			return;
		}

		const { bytes, checksum, withChecksum } = encodeConfig();
		appendFlasherLog('Pre-encoded (hex): ' + bytesToHex(bytes));
        appendFlasherLog('CRC-8: 0x' + checksum.toString(16).padStart(2, '0'));
		appendFlasherLog('Encoded with checksum: ' + bytesToHex(withChecksum));

		if (!flasher) {
			appendFlasherLog('No flasher element found');
			return;
		}

		const proceed = confirm('Warning: flashing light patterns may trigger seizures in people with photosensitive epilepsy. Continue?');
		if (!proceed) {
			appendFlasherLog('User cancelled flashing (epilepsy warning)');
			return;
		}

		// Read advanced option values (if present) and validate
		if (bitHoldInput) {
			const v = parseInt(bitHoldInput.value || '120', 10);
			BIT_HOLD_MS = Number.isFinite(v) ? Math.max(10, v) : 120;
		}
		if (bitGapInput) {
			const v = parseInt(bitGapInput.value || '50', 10);
			BIT_GAP_MS = Number.isFinite(v) ? Math.max(0, v) : 50;
		}
		appendFlasherLog(`Using hold=${BIT_HOLD_MS}ms gap=${BIT_GAP_MS}ms`);
		setButtonToStop();
		appendFlasherLog('Starting flash...');
		try {
			const completed = await performFlash(withChecksum);
			if (completed) appendFlasherLog('Flash complete');
			else appendFlasherLog('Flash aborted');
		} catch (err) {
			appendFlasherLog('Flash aborted: ' + String(err));
		} finally {
			flashing = false;
			setButtonToStart();
		}
	});
}

