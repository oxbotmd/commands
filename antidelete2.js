/**
 * commands/antidelete2.js
 * Recover deleted messages IN THE SAME CHAT (group/DM) they were deleted from.
 *
 * This is a direct clone of antidelete.js's proven store/revocation logic —
 * same message capture, same view-once handling, same deletion catch flow.
 * The ONLY functional difference: every recovered message is sent back to
 * `chatId` (the group/DM it happened in) instead of the owner's private DM.
 *
 * Free for everyone — no Pro requirement.
 *
 * Does NOT check who deleted the message. If the owner deletes their own
 * message, it gets recovered and reposted in that chat too, same as if
 * anyone else in the chat deleted theirs.
 */

const name     = 'antidelete2';
const desc     = '🛡️ Recover deleted messages back into the same chat (Free)';
const category = 'owner';
const aliases  = ['adg', 'antideletegroup'];

const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

// Fixed key used for the global on/off + recovered-counter row, regardless
// of which chat the command was actually run from.
const GLOBAL_KEY = '__global__';

// ✅ Nested Map so multiple bots don't delete each other's saved messages!
// Format: messageStore2.get(msgId).get(sessionId) = { message data }
const messageStore2 = new Map();
const TEMP_DIR = path.join(__dirname, '../tmp');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════
// TEMP FILE CLEANER (Runs every 10 minutes)
// ═══════════════════════════════════════════════════════════════
setInterval(() => {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        files.forEach(f => {
            try {
                const filePath = path.join(TEMP_DIR, f);
                const stats = fs.statSync(filePath);
                if (now - stats.mtimeMs > 30 * 60 * 1000) fs.unlinkSync(filePath);
            } catch {}
        });
    } catch {}
}, 10 * 60 * 1000);

async function toBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

// ═══════════════════════════════════════════════════════════════
// SAFE DOWNLOAD
// ═══════════════════════════════════════════════════════════════
async function safeDownload(mediaMsg, type) {
    try {
        const stream = await downloadContentFromMessage(mediaMsg, type);
        return await toBuffer(stream);
    } catch (e) {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
function cleanNum(jid) {
    return jid ? jid.split(':')[0].split('@')[0] : '';
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleString('en-US', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    });
}

function getFileExtension(mimetype) {
    const map = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
        'video/mp4': 'mp4', 'video/3gpp': '3gp',
        'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/wav': 'wav',
        'application/pdf': 'pdf', 'text/plain': 'txt'
    };
    return map[mimetype] || 'bin';
}

// ═══════════════════════════════════════════════════════════════
// SQL TABLE SETUP (own table, separate from antidelete.js)
// ═══════════════════════════════════════════════════════════════
const verifiedDbs2 = new Set();

async function ensureTable(db) {
    if (!db || !db.query) return false;
    if (verifiedDbs2.has(db)) return true;

    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS antidelete2_settings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                session_id VARCHAR(100) NOT NULL,
                chat_id VARCHAR(100) NOT NULL,
                enabled TINYINT(1) DEFAULT 0,
                recovered INT DEFAULT 0,
                enabled_at BIGINT,
                disabled_at BIGINT,
                UNIQUE KEY uniq_session_chat (session_id, chat_id)
            )
        `);
        verifiedDbs2.add(db);
        return true;
    } catch (e1) {
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS antidelete2_settings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    chat_id TEXT NOT NULL,
                    enabled INTEGER DEFAULT 0,
                    recovered INTEGER DEFAULT 0,
                    enabled_at INTEGER,
                    disabled_at INTEGER,
                    UNIQUE(session_id, chat_id)
                )
            `);
            verifiedDbs2.add(db);
            return true;
        } catch (e2) {
            console.error('[antidelete2] Table creation failed:', e2.message);
            return false;
        }
    }
}

async function getSetting(db, sessionId, chatId) {
    if (!db || !sessionId || !chatId) return null;
    try {
        const [rows] = await db.query(
            'SELECT enabled, recovered FROM antidelete2_settings WHERE session_id = ? AND chat_id = ? LIMIT 1',
            [sessionId, chatId]
        );
        if (rows?.length) return { enabled: rows[0].enabled === 1, recovered: rows[0].recovered || 0 };
    } catch {}
    return null;
}

async function setEnabled(db, sessionId, chatId, enabled) {
    if (!db || !sessionId || !chatId) return false;
    const now = Date.now();
    try {
        if (enabled) {
            const [res] = await db.query(
                'UPDATE antidelete2_settings SET enabled = 1, enabled_at = ?, disabled_at = NULL WHERE session_id = ? AND chat_id = ?',
                [now, sessionId, chatId]
            );
            if ((res?.affectedRows ?? res?.changes ?? 0) > 0) return true;
            await db.query(
                'INSERT INTO antidelete2_settings (session_id, chat_id, enabled, recovered, enabled_at) VALUES (?, ?, 1, 0, ?)',
                [sessionId, chatId, now]
            );
            return true;
        } else {
            await db.query(
                'UPDATE antidelete2_settings SET enabled = 0, disabled_at = ? WHERE session_id = ? AND chat_id = ?',
                [now, sessionId, chatId]
            );
            return true;
        }
    } catch (err) {
        console.error('[antidelete2] setEnabled error:', err.message);
        return false;
    }
}

async function incrementRecovered(db, sessionId, chatId) {
    if (!db || !sessionId || !chatId) return;
    try {
        await db.query('UPDATE antidelete2_settings SET recovered = recovered + 1 WHERE session_id = ? AND chat_id = ?', [sessionId, chatId]);
    } catch {}
}

async function resetRecovered(db, sessionId, chatId) {
    if (!db || !sessionId || !chatId) return false;
    try {
        await db.query('UPDATE antidelete2_settings SET recovered = 0 WHERE session_id = ? AND chat_id = ?', [sessionId, chatId]);
        return true;
    } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════
// CACHE
// ═══════════════════════════════════════════════════════════════
const enabledCache2 = new Map();

// ✅ Always checks the GLOBAL setting for this session, ignoring the
// actual chatId — so it's true for every chat once turned on once.
async function isChatEnabled(db, sessionId, _chatIdIgnored) {
    const key = `${sessionId}::${GLOBAL_KEY}`;
    const hit = enabledCache2.get(key);
    if (hit && Date.now() - hit.ts < 30_000) return hit.v;
    const setting = await getSetting(db, sessionId, GLOBAL_KEY);
    const v = setting?.enabled || false;
    enabledCache2.set(key, { v, ts: Date.now() });
    return v;
}

function bustCache(sessionId, _chatIdIgnored) {
    enabledCache2.delete(`${sessionId}::${GLOBAL_KEY}`);
}

// ═══════════════════════════════════════════════════════════════
// STORE MESSAGE (Isolated per bot session + Disappearing Msg fix)
// Same logic as antidelete.js. No sender filtering — the owner's own
// sent messages are captured too, same as anyone else's.
// ═══════════════════════════════════════════════════════════════
async function storeMessage(sock, message, botData) {
    try {
        if (!message.key?.id) return;
        if (message.key.remoteJid === 'status@broadcast') return;

        const msgId  = message.key.id;
        const sender = message.key.participant || message.key.remoteJid;
        const chatId = message.key.remoteJid;

        const db        = botData?.db;
        const sessionId = botData?.sessionId;
        if (!db || !sessionId) return;

        await ensureTable(db);
        if (!(await isChatEnabled(db, sessionId, chatId))) return;

        let content = '';
        let mediaType = '';
        let mediaPath = '';
        let mediaMimetype = '';
        let isViewOnce = false;
        let isForwarded = false;

        const msg = message.message;
        if (!msg) return;

        // ✅ Unwrap ephemeralMessage (Disappearing Messages ON)
        const actualMsg = msg.ephemeralMessage?.message || msg;

        if (actualMsg.extendedTextMessage?.contextInfo?.isForwarded) isForwarded = true;

        const voMsg = actualMsg.viewOnceMessageV2?.message || actualMsg.viewOnceMessage?.message;
        if (voMsg) {
            isViewOnce = true;
            if (voMsg.imageMessage) {
                mediaType = 'image';
                content = voMsg.imageMessage.caption || '';
                mediaMimetype = voMsg.imageMessage.mimetype || 'image/jpeg';
                const buf = await safeDownload(voMsg.imageMessage, 'image');
                if (buf) {
                    mediaPath = path.join(TEMP_DIR, `ad2_${msgId}_${sessionId}.${getFileExtension(mediaMimetype)}`);
                    fs.writeFileSync(mediaPath, buf);
                }
            } else if (voMsg.videoMessage) {
                mediaType = 'video';
                content = voMsg.videoMessage.caption || '';
                mediaMimetype = voMsg.videoMessage.mimetype || 'video/mp4';
                const buf = await safeDownload(voMsg.videoMessage, 'video');
                if (buf) {
                    mediaPath = path.join(TEMP_DIR, `ad2_${msgId}_${sessionId}.${getFileExtension(mediaMimetype)}`);
                    fs.writeFileSync(mediaPath, buf);
                }
            }
        } else if (actualMsg.conversation) {
            content = actualMsg.conversation;
        } else if (actualMsg.extendedTextMessage?.text) {
            content = actualMsg.extendedTextMessage.text;
        } else if (actualMsg.imageMessage) {
            mediaType = 'image';
            content = actualMsg.imageMessage.caption || '';
            mediaMimetype = actualMsg.imageMessage.mimetype || 'image/jpeg';
            const buf = await safeDownload(actualMsg.imageMessage, 'image');
            if (buf) {
                mediaPath = path.join(TEMP_DIR, `ad2_${msgId}_${sessionId}.${getFileExtension(mediaMimetype)}`);
                fs.writeFileSync(mediaPath, buf);
            }
        } else if (actualMsg.videoMessage) {
            mediaType = 'video';
            content = actualMsg.videoMessage.caption || '';
            mediaMimetype = actualMsg.videoMessage.mimetype || 'video/mp4';
            const buf = await safeDownload(actualMsg.videoMessage, 'video');
            if (buf) {
                mediaPath = path.join(TEMP_DIR, `ad2_${msgId}_${sessionId}.${getFileExtension(mediaMimetype)}`);
                fs.writeFileSync(mediaPath, buf);
            }
        } else if (actualMsg.stickerMessage) {
            mediaType = 'sticker';
            mediaMimetype = actualMsg.stickerMessage.mimetype || 'image/webp';
            const buf = await safeDownload(actualMsg.stickerMessage, 'sticker');
            if (buf) {
                mediaPath = path.join(TEMP_DIR, `ad2_${msgId}_${sessionId}.webp`);
                fs.writeFileSync(mediaPath, buf);
            }
        } else if (actualMsg.audioMessage) {
            mediaType = 'audio';
            mediaMimetype = actualMsg.audioMessage.mimetype || 'audio/mpeg';
            const buf = await safeDownload(actualMsg.audioMessage, 'audio');
            if (buf) {
                mediaPath = path.join(TEMP_DIR, `ad2_${msgId}_${sessionId}.${getFileExtension(mediaMimetype)}`);
                fs.writeFileSync(mediaPath, buf);
            }
        } else if (actualMsg.documentMessage) {
            mediaType = 'document';
            content = actualMsg.documentMessage.caption || '';
            mediaMimetype = actualMsg.documentMessage.mimetype || 'application/octet-stream';
            const buf = await safeDownload(actualMsg.documentMessage, 'document');
            if (buf) {
                mediaPath = path.join(TEMP_DIR, `ad2_${msgId}_${sessionId}.${getFileExtension(mediaMimetype) || 'bin'}`);
                fs.writeFileSync(mediaPath, buf);
            }
        }

        if (!content && !mediaType) return;

        const senderName = message.pushName || cleanNum(sender);

        // ✅ Multi-bot isolation. Store inside a Map per sessionId.
        if (!messageStore2.has(msgId)) messageStore2.set(msgId, new Map());
        messageStore2.get(msgId).set(sessionId, {
            content, mediaType, mediaPath, mediaMimetype,
            sender, senderName, chatId, sessionId,
            time: Date.now(), isViewOnce, isForwarded
        });

        // Remove only THIS bot's saved message after 15 minutes
        setTimeout(() => {
            const msgMap = messageStore2.get(msgId);
            if (msgMap) {
                const old = msgMap.get(sessionId);
                if (old?.mediaPath) {
                    try { fs.unlinkSync(old.mediaPath); } catch {}
                }
                msgMap.delete(sessionId);
                if (msgMap.size === 0) messageStore2.delete(msgId);
            }
        }, 15 * 60 * 1000);

        // View-once: forward immediately — SAME chat instead of owner DM.
        // (Mirrors antidelete.js's behavior exactly, just retargeted.)
        if (isViewOnce && mediaPath) {
            try {
                const cap = `👁️ *View-Once ${mediaType}*\nFrom: ${senderName}`;
                await sock.sendMessage(chatId, mediaType === 'image'
                    ? { image: { url: mediaPath }, caption: cap, mentions: [sender] }
                    : { video: { url: mediaPath }, caption: cap, mentions: [sender] }
                );
                await incrementRecovered(db, sessionId, GLOBAL_KEY);
            } catch {}
            try { fs.unlinkSync(mediaPath); } catch {}
        }

    } catch (err) {
        console.error('[antidelete2] Store error:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// HANDLE MESSAGE DELETION (Isolated per bot session)
// Same logic as antidelete.js. No filtering on who deleted it — if
// the owner deletes their own message, it's recovered too.
// ═══════════════════════════════════════════════════════════════
async function handleMessageRevocation(sock, message, botData) {
    try {
        // ✅ Unwrap ephemeralMessage (Disappearing Messages ON)
        const protoMsg = message.message?.protocolMessage || message.message?.ephemeralMessage?.message?.protocolMessage;
        if (!protoMsg || protoMsg.type !== 0) return;

        const deletedMsgId = protoMsg.key?.id;
        if (!deletedMsgId) return;

        const deletedBy = message.key.participant || message.key.remoteJid;
        const chatId    = message.key.remoteJid; // ← where we send the recovery back to
        if (!chatId) return;

        const db        = botData?.db;
        const sessionId = botData?.sessionId;
        if (!db || !sessionId) return;

        // ✅ Multi-bot isolation. Only look for THIS bot's saved message
        const msgMap = messageStore2.get(deletedMsgId);
        if (!msgMap) return;

        const original = msgMap.get(sessionId);
        if (!original) return; // Silently ignore if THIS bot didn't save it

        if (!(await isChatEnabled(db, sessionId, chatId))) {
            msgMap.delete(sessionId);
            if (msgMap.size === 0) messageStore2.delete(deletedMsgId);
            return;
        }

        const senderName = original.senderName;

        let deletedByName = message.pushName || 'Unknown';
        try {
            const profile = await sock.fetchProfile(deletedBy);
            if (profile?.name) deletedByName = profile.name;
            else if (chatId?.endsWith('@g.us')) {
                const meta = await sock.groupMetadata(chatId);
                const p = meta.participants?.find(x => x.id === deletedBy);
                if (p?.name) deletedByName = p.name;
            }
        } catch {}

        const time = formatTime(original.time);

        let header = `*🔰 DELETED MESSAGE RECOVERED*\n\n`;
        header += `🗑️ *Deleted by:* ${deletedByName}\n`;
        header += `👤 *Sent by:* ${senderName}\n`;
        header += `🕒 *Time:* ${time}\n`;
        if (original.isForwarded) header += `↗️ *Forwarded:* Yes\n`;

        const hasMedia = original.mediaType && original.mediaPath && fs.existsSync(original.mediaPath);

        if (!hasMedia && !original.content) {
            msgMap.delete(sessionId);
            if (msgMap.size === 0) messageStore2.delete(deletedMsgId);
            return;
        }

        if (hasMedia) {
            const captionText = original.content ? header + `\n💬 *Caption:*\n${original.content}` : header;
            try {
                const mediaUrl = { url: original.mediaPath };
                let sendOpts;

                switch (original.mediaType) {
                    case 'image':
                        sendOpts = { image: mediaUrl, caption: captionText, mentions: [original.sender, deletedBy] };
                        break;
                    case 'video':
                        sendOpts = { video: mediaUrl, caption: captionText, mentions: [original.sender, deletedBy] };
                        break;
                    case 'sticker':
                        await sock.sendMessage(chatId, { text: header, mentions: [original.sender, deletedBy] });
                        sendOpts = { sticker: mediaUrl };
                        break;
                    case 'audio':
                        await sock.sendMessage(chatId, { text: header, mentions: [original.sender, deletedBy] });
                        sendOpts = { audio: mediaUrl, mimetype: original.mediaMimetype || 'audio/mpeg' };
                        break;
                    case 'document':
                        sendOpts = {
                            document: mediaUrl,
                            mimetype: original.mediaMimetype || 'application/octet-stream',
                            caption: captionText,
                            fileName: `deleted_${Date.now()}.${getFileExtension(original.mediaMimetype)}`,
                            mentions: [original.sender, deletedBy]
                        };
                        break;
                }

                if (sendOpts) await sock.sendMessage(chatId, sendOpts);
            } catch (err) {
                await sock.sendMessage(chatId, { text: header + `\n⚠️ Media failed: ${err.message}` });
            }

            try { fs.unlinkSync(original.mediaPath); } catch {}
        } else if (original.content) {
            await sock.sendMessage(chatId, {
                text: header + `\n💬 *Message:*\n${original.content}`,
                mentions: [original.sender, deletedBy]
            });
        }

        await incrementRecovered(db, sessionId, GLOBAL_KEY);

        // ✅ Only delete THIS bot's saved message, leave others alone
        msgMap.delete(sessionId);
        if (msgMap.size === 0) messageStore2.delete(deletedMsgId);

    } catch (err) {
        console.error('[antidelete2] Revocation error:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// COMMAND EXECUTION — free for everyone, no Pro gate.
// ═══════════════════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId    = msg.key.remoteJid;
    const db        = botData?.db;
    const sessionId = botData?.sessionId;

    if (!db || !sessionId) {
        return await sock.sendMessage(chatId, { text: '❌ Database error.' }, { quoted: msg });
    }

    await ensureTable(db);

    const action = args[0]?.toLowerCase();

    // ✅ Global per-session toggle — protects every chat the bot is in.
    if (!action || action === 'status') {
        const s = await getSetting(db, sessionId, GLOBAL_KEY);
        return sock.sendMessage(chatId, {
            text: `🛡️ *Anti-Delete (In-Chat) Status* (Free)\n\n🌐 *Scope:* All chats (global)\n📍 *Delivery:* Same chat the delete happened in\n🔰 *Status:* ${s?.enabled ? '✅ ENABLED' : '❌ DISABLED'}\n📊 *Recovered:* ${s?.recovered || 0} messages\n\n📌 *.antidelete2 on*\n📌 *.antidelete2 off*`
        }, { quoted: msg });
    }

    if (action === 'on' || action === 'enable') {
        if ((await getSetting(db, sessionId, GLOBAL_KEY))?.enabled) {
            return sock.sendMessage(chatId, { text: `⚠️ Already ENABLED globally!` }, { quoted: msg });
        }
        const ok = await setEnabled(db, sessionId, GLOBAL_KEY, true);
        bustCache(sessionId);
        return sock.sendMessage(chatId, {
            text: ok
                ? `✅ *Anti-Delete (In-Chat) ENABLED!*\n\n🛡️ *All* your chats (DMs and groups) are now protected.\n📍 Deleted messages will be posted right back into the *same chat* they were deleted from — visible to everyone there, including if you delete your own message.`
                : '❌ Failed to enable.'
        }, { quoted: msg });
    }

    if (action === 'off' || action === 'disable') {
        const s = await getSetting(db, sessionId, GLOBAL_KEY);
        if (!s?.enabled) {
            return sock.sendMessage(chatId, { text: `⚠️ Already DISABLED globally!` }, { quoted: msg });
        }
        await setEnabled(db, sessionId, GLOBAL_KEY, false);
        bustCache(sessionId);
        return sock.sendMessage(chatId, {
            text: `❌ *Anti-Delete (In-Chat) DISABLED* for all chats.\n\n📊 ${s.recovered || 0} messages recovered while active.`
        }, { quoted: msg });
    }

    if (action === 'reset') {
        const ok = await resetRecovered(db, sessionId, GLOBAL_KEY);
        if (ok) bustCache(sessionId);
        return sock.sendMessage(chatId, {
            text: ok ? '🔄 *Counter reset!*' : '❌ No data to reset.'
        }, { quoted: msg });
    }

    return sock.sendMessage(chatId, {
        text: `📖 *Anti-Delete (In-Chat) Commands*\n\n• *.antidelete2 on* — protect ALL chats, post recoveries back in-chat\n• *.antidelete2 off*\n• *.antidelete2 reset*`
    }, { quoted: msg });
}

module.exports = {
    name, desc, category, aliases,
    execute,
    storeMessage,
    handleMessageRevocation
};
