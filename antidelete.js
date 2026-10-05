/**
 * commands/antidelete.js
 * Recover deleted messages in groups & DMs
 * Sends recovered messages privately to the bot owner's DM.
 *
 * ✅ FIXED: antidelete is now a GLOBAL per-session toggle, not per-chat.
 * Previously, enabling it in one DM only protected that exact chat_id —
 * every other group/DM needed its own separate `.antidelete on`. Now one
 * `.antidelete on` (run from anywhere) protects every chat this bot is in.
 */

const name     = 'antidelete';
const desc     = '🛡️ Recover deleted messages in groups & DMs (Pro only)';
const category = 'owner';

const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

// Fixed key used for the global on/off + recovered-counter row, regardless
// of which chat the command was actually run from.
const GLOBAL_KEY = '__global__';

// ✅ FIXED: Nested Map so multiple bots don't delete each other's saved messages!
// Format: messageStore.get(msgId).get(sessionId) = { message data }
const messageStore = new Map();
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

function getOwnerJid(sock) {
    if (!sock?._ownerPhone) return null;
    return sock._ownerPhone + '@s.whatsapp.net';
}

// ═══════════════════════════════════════════════════════════════
// PRO CHECK
// ═══════════════════════════════════════════════════════════════
async function getOwnerUserId(db, sessionId) {
    if (!db || !sessionId) return null;
    try {
        let [rows] = await db.query(
            'SELECT user_id, session_id FROM bots WHERE session_id=? LIMIT 1', [sessionId]
        );
        if (rows.length) return { userId: rows[0].user_id, dbSessionId: rows[0].session_id };
        if (!String(sessionId).startsWith('oxbot_')) {
            [rows] = await db.query(
                'SELECT user_id, session_id FROM bots WHERE session_id=? LIMIT 1', [`oxbot_${sessionId}`]
            );
            if (rows.length) return { userId: rows[0].user_id, dbSessionId: rows[0].session_id };
        }
        return null;
    } catch (err) {
        console.error('[antidelete] getOwnerUserId error:', err.message);
        return null;
    }
}

async function isProUser(db, userId) {
    if (!userId) return false;
    try {
        const [rows] = await db.query(
            `SELECT id FROM pro_subscriptions WHERE user_id=? AND status='active' AND expires_at > NOW() LIMIT 1`,
            [String(userId)]
        );
        return rows.length > 0;
    } catch (err) {
        console.error('[antidelete] isProUser error:', err.message);
        return false;
    }
}

async function isSessionPro(db, sessionId) {
    if (!db || !sessionId) return false;
    const ownerData = await getOwnerUserId(db, sessionId);
    return await isProUser(db, ownerData?.userId);
}

// ═══════════════════════════════════════════════════════════════
// SQL TABLE SETUP
// ═══════════════════════════════════════════════════════════════
const verifiedDbs = new Set();

async function ensureTable(db) {
    if (!db || !db.query) return false;
    if (verifiedDbs.has(db)) return true;

    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS antidelete_settings (
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
        verifiedDbs.add(db);
        return true;
    } catch (e1) {
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS antidelete_settings (
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
            verifiedDbs.add(db);
            return true;
        } catch (e2) {
            console.error('[antidelete] Table creation failed:', e2.message);
            return false;
        }
    }
}

// NOTE: chatId param below is now always passed as GLOBAL_KEY by every
// caller in this file — kept as a param name for minimal diff, but in
// practice this is a per-session setting, not per-chat anymore.
async function getSetting(db, sessionId, chatId) {
    if (!db || !sessionId || !chatId) return null;
    try {
        const [rows] = await db.query(
            'SELECT enabled, recovered FROM antidelete_settings WHERE session_id = ? AND chat_id = ? LIMIT 1',
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
                'UPDATE antidelete_settings SET enabled = 1, enabled_at = ?, disabled_at = NULL WHERE session_id = ? AND chat_id = ?',
                [now, sessionId, chatId]
            );
            if ((res?.affectedRows ?? res?.changes ?? 0) > 0) return true;
            await db.query(
                'INSERT INTO antidelete_settings (session_id, chat_id, enabled, recovered, enabled_at) VALUES (?, ?, 1, 0, ?)',
                [sessionId, chatId, now]
            );
            return true;
        } else {
            await db.query(
                'UPDATE antidelete_settings SET enabled = 0, disabled_at = ? WHERE session_id = ? AND chat_id = ?',
                [now, sessionId, chatId]
            );
            return true;
        }
    } catch (err) {
        console.error('[antidelete] setEnabled error:', err.message);
        return false;
    }
}

async function incrementRecovered(db, sessionId, chatId) {
    if (!db || !sessionId || !chatId) return;
    try {
        await db.query('UPDATE antidelete_settings SET recovered = recovered + 1 WHERE session_id = ? AND chat_id = ?', [sessionId, chatId]);
    } catch {}
}

async function resetRecovered(db, sessionId, chatId) {
    if (!db || !sessionId || !chatId) return false;
    try {
        await db.query('UPDATE antidelete_settings SET recovered = 0 WHERE session_id = ? AND chat_id = ?', [sessionId, chatId]);
        return true;
    } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════
// CACHE
// ═══════════════════════════════════════════════════════════════
const enabledCache = new Map();

// ✅ FIXED: always checks the GLOBAL setting for this session, ignoring
// the actual chatId — so it's true for every chat once turned on once.
async function isChatEnabled(db, sessionId, _chatIdIgnored) {
    const key = `${sessionId}::${GLOBAL_KEY}`;
    const hit = enabledCache.get(key);
    if (hit && Date.now() - hit.ts < 30_000) return hit.v;
    const setting = await getSetting(db, sessionId, GLOBAL_KEY);
    const v = setting?.enabled || false;
    enabledCache.set(key, { v, ts: Date.now() });
    return v;
}

function bustCache(sessionId, _chatIdIgnored) {
    enabledCache.delete(`${sessionId}::${GLOBAL_KEY}`);
}

// ═══════════════════════════════════════════════════════════════
// STORE MESSAGE (Isolated per bot session + Disappearing Msg fix)
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
        // ✅ FIXED: global check, not tied to this specific chatId
        if (!(await isChatEnabled(db, sessionId, chatId))) return;

        let content = '';
        let mediaType = '';
        let mediaPath = '';
        let mediaMimetype = '';
        let isViewOnce = false;
        let isForwarded = false;

        const msg = message.message;
        if (!msg) return;

        // ✅ FIX: Unwrap ephemeralMessage (Disappearing Messages ON)
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
                    mediaPath = path.join(TEMP_DIR, `${msgId}_${sessionId}.${getFileExtension(mediaMimetype)}`);
                    fs.writeFileSync(mediaPath, buf);
                }
            } else if (voMsg.videoMessage) {
                mediaType = 'video';
                content = voMsg.videoMessage.caption || '';
                mediaMimetype = voMsg.videoMessage.mimetype || 'video/mp4';
                const buf = await safeDownload(voMsg.videoMessage, 'video');
                if (buf) {
                    mediaPath = path.join(TEMP_DIR, `${msgId}_${sessionId}.${getFileExtension(mediaMimetype)}`);
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
                mediaPath = path.join(TEMP_DIR, `${msgId}_${sessionId}.${getFileExtension(mediaMimetype)}`);
                fs.writeFileSync(mediaPath, buf);
            }
        } else if (actualMsg.videoMessage) {
            mediaType = 'video';
            content = actualMsg.videoMessage.caption || '';
            mediaMimetype = actualMsg.videoMessage.mimetype || 'video/mp4';
            const buf = await safeDownload(actualMsg.videoMessage, 'video');
            if (buf) {
                mediaPath = path.join(TEMP_DIR, `${msgId}_${sessionId}.${getFileExtension(mediaMimetype)}`);
                fs.writeFileSync(mediaPath, buf);
            }
        } else if (actualMsg.stickerMessage) {
            mediaType = 'sticker';
            mediaMimetype = actualMsg.stickerMessage.mimetype || 'image/webp';
            const buf = await safeDownload(actualMsg.stickerMessage, 'sticker');
            if (buf) {
                mediaPath = path.join(TEMP_DIR, `${msgId}_${sessionId}.webp`);
                fs.writeFileSync(mediaPath, buf);
            }
        } else if (actualMsg.audioMessage) {
            mediaType = 'audio';
            mediaMimetype = actualMsg.audioMessage.mimetype || 'audio/mpeg';
            const buf = await safeDownload(actualMsg.audioMessage, 'audio');
            if (buf) {
                mediaPath = path.join(TEMP_DIR, `${msgId}_${sessionId}.${getFileExtension(mediaMimetype)}`);
                fs.writeFileSync(mediaPath, buf);
            }
        } else if (actualMsg.documentMessage) {
            mediaType = 'document';
            content = actualMsg.documentMessage.caption || '';
            mediaMimetype = actualMsg.documentMessage.mimetype || 'application/octet-stream';
            const buf = await safeDownload(actualMsg.documentMessage, 'document');
            if (buf) {
                mediaPath = path.join(TEMP_DIR, `${msgId}_${sessionId}.${getFileExtension(mediaMimetype) || 'bin'}`);
                fs.writeFileSync(mediaPath, buf);
            }
        }

        if (!content && !mediaType) return;

        const senderName = message.pushName || cleanNum(sender);

        // ✅ FIX: Multi-bot isolation! Store inside a Map per sessionId
        if (!messageStore.has(msgId)) messageStore.set(msgId, new Map());
        messageStore.get(msgId).set(sessionId, {
            content, mediaType, mediaPath, mediaMimetype,
            sender, senderName, chatId, sessionId,
            time: Date.now(), isViewOnce, isForwarded
        });

        // Remove only THIS bot's saved message after 15 minutes
        setTimeout(() => {
            const msgMap = messageStore.get(msgId);
            if (msgMap) {
                const old = msgMap.get(sessionId);
                if (old?.mediaPath) {
                    try { fs.unlinkSync(old.mediaPath); } catch {}
                }
                msgMap.delete(sessionId);
                if (msgMap.size === 0) messageStore.delete(msgId);
            }
        }, 15 * 60 * 1000);

        // View-once: forward immediately
        if (isViewOnce && mediaPath) {
            const ownerJid = getOwnerJid(sock);
            if (ownerJid) {
                try {
                    const cap = `👁️ *View-Once ${mediaType}*\nFrom: ${senderName}`;
                    await sock.sendMessage(ownerJid, mediaType === 'image'
                        ? { image: { url: mediaPath }, caption: cap, mentions: [sender] }
                        : { video: { url: mediaPath }, caption: cap, mentions: [sender] }
                    );
                    await incrementRecovered(db, sessionId, GLOBAL_KEY);
                } catch {}
            }
            try { fs.unlinkSync(mediaPath); } catch {}
        }

    } catch (err) {
        console.error('[antidelete] Store error:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// HANDLE MESSAGE DELETION (Isolated per bot session)
// ═══════════════════════════════════════════════════════════════
async function handleMessageRevocation(sock, message, botData) {
    try {
        // ✅ FIX: Unwrap ephemeralMessage (Disappearing Messages ON)
        const protoMsg = message.message?.protocolMessage || message.message?.ephemeralMessage?.message?.protocolMessage;
        if (!protoMsg || protoMsg.type !== 0) return;

        const deletedMsgId = protoMsg.key?.id;
        if (!deletedMsgId) return;

        const deletedBy = message.key.participant || message.key.remoteJid;
        const chatId    = message.key.remoteJid;

        const db        = botData?.db;
        const sessionId = botData?.sessionId;
        if (!db || !sessionId) return;

        const ownerJid = getOwnerJid(sock);
        if (!ownerJid) {
            console.error('[antidelete] ERROR: sock._ownerPhone is not set');
            return;
        }

        // ✅ FIX: Multi-bot isolation. Only look for THIS bot's saved message
        const msgMap = messageStore.get(deletedMsgId);
        if (!msgMap) return;
        
        const original = msgMap.get(sessionId);
        if (!original) return; // Silently ignore if THIS bot didn't save it

        // ✅ FIXED: global check, not tied to this specific chatId
        if (!(await isChatEnabled(db, sessionId, chatId))) {
            msgMap.delete(sessionId);
            if (msgMap.size === 0) messageStore.delete(deletedMsgId);
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

        let chatName = 'Private Chat';
        if (chatId?.endsWith('@g.us')) {
            try {
                const meta = await sock.groupMetadata(chatId);
                chatName = meta.subject || 'Unknown Group';
            } catch {
                chatName = 'Unknown Group';
            }
        }

        const time = formatTime(original.time);

        let header = `*🔰 DELETED MESSAGE RECOVERED*\n\n`;
        header += `📱 *Chat:* ${chatName}\n`;
        header += `🗑️ *Deleted by:* ${deletedByName}\n`;
        header += `👤 *Sent by:* ${senderName}\n`;
        header += `🕒 *Time:* ${time}\n`;
        if (original.isForwarded) header += `↗️ *Forwarded:* Yes\n`;

        const hasMedia = original.mediaType && original.mediaPath && fs.existsSync(original.mediaPath);

        if (!hasMedia && !original.content) {
            msgMap.delete(sessionId);
            if (msgMap.size === 0) messageStore.delete(deletedMsgId);
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
                        await sock.sendMessage(ownerJid, { text: header, mentions: [original.sender, deletedBy] });
                        sendOpts = { sticker: mediaUrl };
                        break;
                    case 'audio':
                        await sock.sendMessage(ownerJid, { text: header, mentions: [original.sender, deletedBy] });
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

                if (sendOpts) await sock.sendMessage(ownerJid, sendOpts);
            } catch (err) {
                await sock.sendMessage(ownerJid, { text: header + `\n⚠️ Media failed: ${err.message}` });
            }

            try { fs.unlinkSync(original.mediaPath); } catch {}
        } else if (original.content) {
            await sock.sendMessage(ownerJid, {
                text: header + `\n💬 *Message:*\n${original.content}`,
                mentions: [original.sender, deletedBy]
            });
        }

        await incrementRecovered(db, sessionId, GLOBAL_KEY);
        
        // ✅ FIX: Only delete THIS bot's saved message, leave others alone
        msgMap.delete(sessionId);
        if (msgMap.size === 0) messageStore.delete(deletedMsgId);

    } catch (err) {
        console.error('[antidelete] Revocation error:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId    = msg.key.remoteJid;
    const db        = botData?.db;
    const sessionId = botData?.sessionId;

    if (!db || !sessionId) {
        return await sock.sendMessage(chatId, { text: '❌ Database error.' }, { quoted: msg });
    }

    await ensureTable(db);

    const pro = await isSessionPro(db, sessionId);

    if (!pro) {
        return await sock.sendMessage(chatId, {
            text: `👑 *Pro Plan Required*\n\n🛡️ Anti-Delete is a premium feature.\n\n💰 *Price:* ₦3000/month\n📌 Upgrade to Premium: https://oxbot.name.ng`
        }, { quoted: msg });
    }

    const action = args[0]?.toLowerCase();

    // ✅ FIXED: all actions now operate on the GLOBAL setting for this
    // session — protects every chat the bot is in, not just the one
    // the command happened to be typed in.
    if (!action || action === 'status') {
        const s = await getSetting(db, sessionId, GLOBAL_KEY);
        return sock.sendMessage(chatId, {
            text: `🛡️ *Anti-Delete Status*\n\n🌐 *Scope:* All chats (global)\n🔰 *Status:* ${s?.enabled ? '✅ ENABLED' : '❌ DISABLED'}\n📊 *Recovered:* ${s?.recovered || 0} messages\n\n📌 *.antidelete on*\n📌 *.antidelete off*`
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
                ? `✅ *Anti-Delete ENABLED!*\n\n🛡️ *All* your chats (DMs and groups) are now protected.\n🔰 Any deleted message anywhere will be sent to your DM.`
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
            text: `❌ *Anti-Delete DISABLED* for all chats.\n\n📊 ${s.recovered || 0} messages recovered while active.`
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
        text: `📖 *Anti-Delete Commands*\n\n• *.antidelete on* — protect ALL chats\n• *.antidelete off*\n• *.antidelete reset*`
    }, { quoted: msg });
}

module.exports = {
    name, desc, category,
    execute,
    storeMessage,
    handleMessageRevocation
};
