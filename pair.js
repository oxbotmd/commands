/**
 * commands/pair.js
 * 100% Standalone - Free - 1-Tap Copyable Code
 *
 * FIXED: now matches oxbot/pairing.js's socket config + reconnect resilience.
 * The pairing handshake routinely closes/reopens the socket several times
 * (codes 515/428/503 are NORMAL mid-pairing, not failures) — this version
 * reconnects through those instead of silently hanging until timeout.
 */

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const NodeCache = require('node-cache');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@whiskeysockets/baileys');
const { autoJoinNewsletters, autoJoinGroups } = require('../oxbot/pairing');

const activePairingSockets = new Map();

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const senderId = msg.key.participant || msg.key.remoteJid;
    const senderDm = senderId.includes('@g.us') ? `${senderId.split('@')[0]}@s.whatsapp.net` : senderId;

    // ── 1. Validate Number ───────────────────────────────────────────────
    const rawNumber = args[0];
    if (!rawNumber) {
        return await sock.sendMessage(chatId, {
            text: '❌ Please provide a phone number.\n\n*Usage:* *.pair 2348012345678*'
        }, { quoted: msg });
    }

    const number = rawNumber.replace(/[^0-9]/g, '');
    if (number.length < 10 || number.length > 15) {
        return await sock.sendMessage(chatId, {
            text: '❌ *Invalid number.* Must be 10-15 digits with country code.'
        }, { quoted: msg });
    }

    // ── 2. Prevent duplicates ─────────────────────────────────────────────
    if (activePairingSockets.has(number)) {
        return await sock.sendMessage(chatId, {
            text: '⏳ *Pairing already in progress for this number.*'
        }, { quoted: msg });
    }

    // Tell user to check DM
    if (senderDm !== chatId) {
        await sock.sendMessage(chatId, {
            text: '⏳ *Generating code...*\n_Check your **DM**._'
        }, { quoted: msg });
    }

    const tempDir = path.join(process.cwd(), 'temp_pairing', number);

    // Guard flags shared across reconnect attempts for this number
    const state_ = { deliveryStarted: false, attempts: 0, reconnect: true };

    try {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        fs.mkdirSync(tempDir, { recursive: true });
    } catch (error) {
        console.error('[Pair Init Error]', error);
        await sock.sendMessage(chatId, { text: `❌ *Error:* ${error.message}` }, { quoted: msg });
        return null;
    }

    async function connect() {
        state_.attempts++;

        try {
            // ── 3. Setup Session Auth ───────────────────────────────────────
            const { version } = await fetchLatestBaileysVersion();
            const { state, saveCreds } = await useMultiFileAuthState(tempDir);

            // ── 4. Create Socket ─────────────────────────────────────────────
            // ✅ FIXED: keys now wrapped with makeCacheableSignalKeyStore, and
            // msgRetryCounterCache added — same as botManager.js/pairing.js.
            // Missing these was previously identified as a cause of Signal
            // handshake failures with new contacts.
            const tempSock = makeWASocket({
                version,
                logger: pino({ level: 'silent' }),
                printQRInTerminal: false,
                browser: Browsers.windows('Chrome'),
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
                },
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                syncFullHistory: false,
                downloadHistory: false,
                shouldSyncHistoryMessage: () => false,
                getMessage: async () => undefined,
                msgRetryCounterCache: new NodeCache({ stdTTL: 300, checkperiod: 60 }),
                keepAliveIntervalMs: 15_000,
                defaultQueryTimeoutMs: 30_000,
                connectTimeoutMs: 30_000,
                retryRequestDelayMs: 1000,
                emitOwnEvents: false,
            });

            tempSock.ev.on('creds.update', saveCreds);
            activePairingSockets.set(number, tempSock);

            // ── 5. Request Code ───────────────────────────────────────────────
            if (!tempSock.authState.creds.registered) {
                setTimeout(async () => {
                    if (!activePairingSockets.has(number)) return;
                    try {
                        const rawCode = await tempSock.requestPairingCode(number);
                        const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;

                        // ★ MESSAGE 1: SEND ONLY THE CODE (1-Tap Copyable) ★
                        await sock.sendMessage(senderDm, { text: formattedCode });

                        // Small delay so WhatsApp doesn't merge them
                        await delay(1000);

                        // ★ MESSAGE 2: SEND INSTRUCTIONS ★
                        await sock.sendMessage(senderDm, {
                            text: `
📲 *LINKING STEPS:*

1. Open WhatsApp > Linked Devices
2. Tap *Link a device*
3. Select *Link with phone number instead*
4. Enter number: *+${number}*
5. Paste the code above.

⏳ _Waiting for you to link..._
                            `.trim()
                        });

                    } catch (err) {
                        // ✅ FIXED: retry once instead of failing immediately —
                        // code requests can transiently fail right after connect
                        console.log(`[PAIR] Code request failed for ${number}: ${err.message} — retrying in 3s...`);
                        await delay(3000);
                        if (!activePairingSockets.has(number)) return;
                        try {
                            const rawCode2 = await tempSock.requestPairingCode(number);
                            const formattedCode2 = rawCode2?.match(/.{1,4}/g)?.join('-') || rawCode2;
                            await sock.sendMessage(senderDm, { text: formattedCode2 });
                            await delay(1000);
                            await sock.sendMessage(senderDm, {
                                text: `
📲 *LINKING STEPS:*

1. Open WhatsApp > Linked Devices
2. Tap *Link a device*
3. Select *Link with phone number instead*
4. Enter number: *+${number}*
5. Paste the code above.

⏳ _Waiting for you to link..._
                                `.trim()
                            });
                        } catch (err2) {
                            await sock.sendMessage(senderDm, { text: `❌ *Failed to get code:* ${err2.message}` }).catch(() => {});
                            state_.reconnect = false;
                            cleanupPairing(number, tempSock, tempDir);
                        }
                    }
                }, 2000);
            }

            // ── 6. Wait for Link & Send Session ID ────────────────────────────
            tempSock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === 'open') {
                    if (state_.deliveryStarted) return;
                    state_.deliveryStarted = true;
                    state_.reconnect = false;

                    await sock.sendMessage(senderDm, { text: '✅ *Linked!*\n_Generating Session ID..._' });

                    if (senderDm !== chatId) {
                        await sock.sendMessage(chatId, { text: '✅ *Linked!* Sending Session ID to DM.' });
                    }

                    // ────────────────────────────────────────────────────────
                    // ★ AUTO-JOIN NEWSLETTER & GROUP (same as oxbot/pairing.js)
                    // ────────────────────────────────────────────────────────
                    try {
                        await autoJoinNewsletters(tempSock, number, senderId);
                        await autoJoinGroups(tempSock, number, senderId);
                    } catch (joinErr) {
                        console.log(`[PAIR] Auto-join error for ${number}: ${joinErr.message}`);
                    }

                    try {
                        await saveCreds();
                        const credsPath = path.join(tempDir, 'creds.json');

                        let credsContent = null;
                        for (let i = 0; i < 40; i++) {
                            if (fs.existsSync(credsPath)) {
                                const parsed = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                                if (parsed.registered) {
                                    credsContent = fs.readFileSync(credsPath, 'utf8');
                                    break;
                                }
                            }
                            await delay(500);
                        }

                        if (credsContent) {
                            const b64 = Buffer.from(credsContent).toString('base64');
                            const sessionId = `oxbot_${number}`;
                            const fullSession = `${sessionId}::::${b64}`;

                            await delay(5000);

                            // Send Session ID
                            await sock.sendMessage(senderDm, { text: fullSession });

                            await delay(3000);

                            // Send Instructions
                            await sock.sendMessage(senderDm, {
                                text: `
⚠️ *Copy the Session ID above, then follow these steps:*

1️⃣ Go to https://oxbot.name.ng
2️⃣ Log in to your Dashboard
3️⃣ Click *Add Bot*
4️⃣ Paste the Session ID you just copied
5️⃣ Tap *Activate* to bring your bot online!
                                `.trim()
                            });

                            if (senderDm !== chatId) {
                                await sock.sendMessage(chatId, { text: '✅ *Session ID delivered!*' });
                            }
                        } else {
                            await sock.sendMessage(senderDm, { text: '❌ *Registration did not complete in time.* Please try `.pair` again.' }).catch(() => {});
                        }
                    } catch (err) {
                        console.error('[Pair Delivery Error]', err);
                    }

                    cleanupPairing(number, tempSock, tempDir);
                }

                if (connection === 'close' && !state_.deliveryStarted) {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;

                    // Fatal — don't retry
                    if (statusCode === DisconnectReason.loggedOut || statusCode === 403 || statusCode === 401) {
                        await sock.sendMessage(senderDm, {
                            text: '❌ *Pairing Failed.*\n_Too many linked devices or wrong code._'
                        }).catch(() => {});
                        state_.reconnect = false;
                        cleanupPairing(number, tempSock, tempDir);
                        return;
                    }

                    // Max attempts reached — give up
                    if (state_.attempts >= 5) {
                        await sock.sendMessage(senderDm, {
                            text: '❌ *Pairing failed after multiple attempts.* Please try `.pair` again.'
                        }).catch(() => {});
                        state_.reconnect = false;
                        cleanupPairing(number, tempSock, tempDir);
                        return;
                    }

                    // ✅ FIXED: codes like 515/428/503 are NORMAL during pairing
                    // handshake — reconnect instead of silently hanging.
                    if (state_.reconnect) {
                        console.log(`[PAIR] Transient close (code: ${statusCode ?? 'none'}) for ${number} — reconnecting...`);
                        activePairingSockets.delete(number);
                        try { tempSock.ws?.close(); } catch {}
                        try { tempSock.end(); } catch {}
                        await delay(statusCode === 408 ? 8000 : 3000);
                        connect();
                    }
                }
            });

        } catch (err) {
            if (state_.reconnect && state_.attempts < 5) {
                console.log(`[PAIR] Connection error for ${number}: ${err.message} — retrying in 5s...`);
                await delay(5000);
                connect();
                return;
            }
            await sock.sendMessage(senderDm, { text: `❌ *Error:* ${err.message}` }).catch(() => {});
            cleanupPairing(number, null, tempDir);
        }
    }

    connect();

    // ── 7. Timeout ────────────────────────────────────────────────────────
    setTimeout(() => {
        if (activePairingSockets.has(number)) {
            state_.reconnect = false;
            sock.sendMessage(senderDm, { text: '⏱️ *Pairing timed out.*' }).catch(() => {});
            cleanupPairing(number, activePairingSockets.get(number), tempDir);
        }
    }, 8 * 60 * 1000);

    return null;
}

function cleanupPairing(number, tempSock, tempDir) {
    activePairingSockets.delete(number);
    try { tempSock?.ws?.close(); } catch {}
    try { tempSock?.end(); } catch {}
    setTimeout(() => {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    }, 2000);
}

module.exports = {
    name: 'pair',
    aliases: ['link', 'paircode'],
    desc: 'Generate pairing code to link a new bot',
    category: 'general',
    execute
};
