/**
 * commands/send.js
 * Reply to a status with "send", ".send", "please send", etc.
 *
 * RULE (fixed): whoever types "send" gets the media in their own DM.
 * It no longer matters whose status it is (bot's own status, or a
 * random contact's status forwarded into a group) — the requester
 * always receives it. Previously it tried to route based on whether
 * the status belonged to the bot, which meant on public bots (where
 * almost every "send" is on someone else's status) the media went to
 * the status owner instead of the person who asked, so it looked like
 * the bot "just reacted and never sent anything."
 *
 * Free Trial: 10 times per hour
 * Pro: Unlimited
 */

const name     = 'send';
const desc     = 'Reply to a status to drop it on your DM';
const category = 'utility';
const aliases  = ['drop'];

// ═══════════════════════════════════════════════════
// ★ PRO PLAN CHECKERS ★
// ═══════════════════════════════════════════════════
async function getOwnerUserId(db, sessionId) {
    if (!db || !sessionId) return null;
    try {
        let [rows] = await db.query(
            'SELECT user_id, session_id FROM bots WHERE session_id=? LIMIT 1',
            [sessionId]
        );
        if (rows.length) return { userId: rows[0].user_id, dbSessionId: rows[0].session_id };

        if (!String(sessionId).startsWith('oxbot_')) {
            [rows] = await db.query(
                'SELECT user_id, session_id FROM bots WHERE session_id=? LIMIT 1',
                [`oxbot_${sessionId}`]
            );
            if (rows.length) return { userId: rows[0].user_id, dbSessionId: rows[0].session_id };
        }
        return null;
    } catch (err) {
        console.error('[send] getOwnerUserId error:', err.message);
        return null;
    }
}

async function isProUser(db, userId) {
    if (!userId) return false;
    try {
        const [rows] = await db.query(
            `SELECT id FROM pro_subscriptions WHERE user_id=? AND status='active' AND expires_at > NOW() LIMIT 1`,
            [userId]
        );
        return rows.length > 0;
    } catch (err) {
        console.error('[send] isProUser error:', err.message);
        return false;
    }
}

// ═══════════════════════════════════════════════════
// ★ FREE TRIAL LIMITER (10 per hour) ★
// ═══════════════════════════════════════════════════
const freeUsageMap = new Map();
const FREE_LIMIT = 10;
const RESET_TIME_MS = 60 * 60 * 1000; // 1 hour

function canFreeUse(userId) {
    if (!userId) return false;
    const now = Date.now();

    if (!freeUsageMap.has(userId)) {
        freeUsageMap.set(userId, { count: 1, firstUseTime: now });
        return true;
    }

    const userData = freeUsageMap.get(userId);
    const timePassed = now - userData.firstUseTime;

    // Reset if 1 hour has passed
    if (timePassed >= RESET_TIME_MS) {
        userData.count = 1;
        userData.firstUseTime = now;
        return true;
    }

    // Allow if under limit
    if (userData.count < FREE_LIMIT) {
        userData.count++;
        return true;
    }

    return false;
}

function getTimeLeft(userId) {
    if (!freeUsageMap.has(userId)) return '1h';
    const userData = freeUsageMap.get(userId);
    const timePassed = Date.now() - userData.firstUseTime;
    const msLeft = RESET_TIME_MS - timePassed;
    if (msLeft <= 0) return '0m';
    const minsLeft = Math.ceil(msLeft / (60 * 1000));
    return `${minsLeft}m`;
}

// Auto-cleanup memory every 2 hours
setInterval(() => {
    const now = Date.now();
    for (const [userId, data] of freeUsageMap) {
        if (now - data.firstUseTime > RESET_TIME_MS + 60000) {
            freeUsageMap.delete(userId);
        }
    }
}, 2 * 60 * 60 * 1000);

// ═══════════════════════════════════════════════════
// ★ RATE LIMIT CHECKER ★
// ═══════════════════════════════════════════════════
async function checkLimit(sock, chatId, msg, db, sessionId) {
    if (!db || !sessionId) return true; // Dev mode

    const ownerData = await getOwnerUserId(db, sessionId);
    const userId    = ownerData?.userId;

    // Pro users bypass limit
    if (await isProUser(db, userId)) return true;

    // Free users: check limit
    if (canFreeUse(userId)) return true;

    // Blocked
    const timeLeft = getTimeLeft(userId);
    await sock.sendMessage(chatId, {
        text: `⏳ *Free Trial Limit Reached*\n\n_You've used ${FREE_LIMIT} sends this hour._\n\n_⏱️ Resets in ${timeLeft}._\n\n_✨ Upgrade to Pro for unlimited sends:_\nhttps://oxbot.name.ng/dashboard`
    }, { quoted: msg }).catch(() => {});

    return false;
}

// ═══════════════════════════════════════════════════
// CORE SEND LOGIC
// ═══════════════════════════════════════════════════
async function doSend(sock, chatId, msg) {
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo || {};
    const quotedMsg   = contextInfo.quotedMessage;
    const statusOwner = contextInfo.participant || '';

    if (!quotedMsg || !statusOwner) return { ok: false, reason: 'no_quote' };
    if (contextInfo.remoteJid !== 'status@broadcast') return { ok: false, reason: 'not_status' };

    const mediaMap = {
        imageMessage:   { mime: 'image/jpeg'  },
        videoMessage:   { mime: 'video/mp4'   },
        stickerMessage: { mime: 'image/webp'  },
        audioMessage:   { mime: 'audio/mpeg'  },
    };

    let mediaType = null;
    let mediaMime  = null;

    for (const [type, info] of Object.entries(mediaMap)) {
        if (quotedMsg[type]) {
            mediaType = type;
            mediaMime  = info.mime;
            break;
        }
    }

    if (!mediaType) return { ok: false, reason: 'no_media' };

    try {
        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
        const buffer = await downloadMediaMessage(
            {
                key: {
                    remoteJid: contextInfo.remoteJid || chatId,
                    id: contextInfo.stanzaId || '',
                    participant: statusOwner,
                },
                message: quotedMsg,
            },
            'buffer',
            {},
            { logger: console, reuploadRequest: sock.updateMediaMessage }
        );

        if (!buffer || buffer.length === 0) return { ok: false, reason: 'empty_buffer' };

        // ═══════════════════════════════════════════════════
        // ★ ALWAYS DELIVER TO WHOEVER TYPED "send" ★
        // Doesn't matter whose status it is — the requester
        // (the person/chat that sent the "send" message) gets it.
        // In a group, msg.key.participant is the requester's
        // real number. In a DM, msg.key.remoteJid already IS
        // the requester.
        // ═══════════════════════════════════════════════════
        const targetChatId = msg.key.participant || msg.key.remoteJid;

        const quotedStatus = {
            key: {
                remoteJid: contextInfo.remoteJid || 'status@broadcast',
                id: contextInfo.stanzaId || '',
                participant: statusOwner,
            },
            message: quotedMsg,
        };

        if (mediaType === 'stickerMessage') {
            await sock.sendMessage(targetChatId, { sticker: buffer });
        } else if (mediaType === 'imageMessage') {
            await sock.sendMessage(targetChatId, { image: buffer, mimetype: mediaMime }, { quoted: quotedStatus });
        } else if (mediaType === 'videoMessage') {
            await sock.sendMessage(targetChatId, { video: buffer, mimetype: mediaMime }, { quoted: quotedStatus });
        } else if (mediaType === 'audioMessage') {
            await sock.sendMessage(targetChatId, { audio: buffer, mimetype: mediaMime, ptt: quotedMsg.audioMessage?.ptt || false });
        }

        await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }).catch(() => {});
        return { ok: true };

    } catch (err) {
        console.error('[send] Error:', err.message);
        await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }).catch(() => {});
        return { ok: false, reason: 'error', error: err.message };
    }
}

// ═══════════════════════════════════════════════════
// .send COMMAND (with dot)
// ═══════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const contextInfo = msg.message?.extendedTextMessage?.contextInfo || {};
    const quotedMsg   = contextInfo.quotedMessage;

    if (!quotedMsg || !contextInfo.participant) {
        return '❌ Reply to a status with *send* to drop it on your DM.';
    }

    if (!(await checkLimit(sock, chatId, msg, botData?.db, botData?.sessionId))) return null;

    const result = await doSend(sock, chatId, msg);
    if (!result.ok) return '❌ Could not send. The status may have expired.';
    return null;
}

// ═══════════════════════════════════════════════════
// NO-DOT WATCHER (Handles: "send", "please send", "send it")
// ═══════════════════════════════════════════════════
async function handleStatusReply(sock, msg, botData) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return false;
    if (chatId.endsWith('@g.us')) return false;

    const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        ''
    ).trim().toLowerCase();

    // \b means "word boundary" - matches "send" inside any sentence
    if (!/\bsend\b/i.test(text) && !/^drop$/i.test(text)) return false;

    const contextInfo = msg.message?.extendedTextMessage?.contextInfo || {};
    if (!contextInfo.quotedMessage || !contextInfo.participant) return false;

    if (!(await checkLimit(sock, chatId, msg, botData?.db, botData?.sessionId))) return false;

    const result = await doSend(sock, chatId, msg);
    return result.ok;
}

module.exports = {
    name,
    desc,
    category,
    aliases,
    execute,
    handleStatusReply,
};
