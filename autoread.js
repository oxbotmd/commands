/**
 * OxBot — Auto Read Command
 * Automatically marks all messages as read (per-session, stored in SQL)
 * ── PRO FEATURE ── Requires active subscription
 */

// ── Strip device/LID suffix ──
function cleanNumber(jid) {
    if (!jid) return '';
    return jid.split(':')[0].split('@')[0];
}

// ── Fetch owner phone from users table for this session ──
async function getOwnerNumber(db, sessionId) {
    try {
        const [rows] = await db.query(
            'SELECT u.phone FROM users u JOIN bots b ON b.user_id = u.id WHERE b.session_id = ? LIMIT 1',
            [sessionId]
        );
        if (!rows.length || !rows[0].phone) return null;
        return String(rows[0].phone).replace(/\D/g, '');
    } catch (err) {
        console.error('[autoread] DB error fetching owner:', err.message);
        return null;
    }
}

// ── Check if sender is the owner ──
async function isOwner(db, sessionId, senderId, sock, chatId) {
    const ownerNumber = await getOwnerNumber(db, sessionId);
    if (!ownerNumber) return false;

    const ownerJid    = ownerNumber + '@s.whatsapp.net';
    const senderClean = cleanNumber(senderId);

    if (senderId === ownerJid) return true;
    if (senderClean === ownerNumber) return true;
    if (senderId.includes(ownerNumber)) return true;

    if (sock && chatId && chatId.endsWith('@g.us') && senderId.includes('@lid')) {
        try {
            const metadata     = await sock.groupMetadata(chatId);
            const participants = metadata.participants || [];
            const match = participants.find(p => {
                const pIdClean = cleanNumber(p.id || '');
                return pIdClean === ownerNumber || (p.id || '') === ownerJid;
            });
            if (match) return true;
        } catch {}
    }

    return false;
}

// ── Check if autoread is enabled for this session ──
async function isEnabled(db, sessionId) {
    try {
        const [rows] = await db.query(
            'SELECT autoread FROM bot_settings WHERE session_id = ? LIMIT 1',
            [sessionId]
        );
        return rows.length > 0 && rows[0].autoread === 1;
    } catch {
        return false;
    }
}

// ── Check if bot is mentioned in the message ──
function isBotMentioned(message, botJid) {
    if (!message.message) return false;

    const msgTypes = [
        'extendedTextMessage', 'imageMessage', 'videoMessage',
        'stickerMessage', 'documentMessage', 'audioMessage'
    ];

    for (const type of msgTypes) {
        const mentioned = message.message[type]?.contextInfo?.mentionedJid;
        if (mentioned && mentioned.some(jid => jid === botJid)) return true;
    }

    const textContent =
        message.message.conversation ||
        message.message.extendedTextMessage?.text ||
        message.message.imageMessage?.caption ||
        message.message.videoMessage?.caption || '';

    if (textContent) {
        const botNumber = botJid.split('@')[0];
        if (textContent.includes(`@${botNumber}`)) return true;
    }

    return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ PRO PLAN CHECKERS ★
// ═══════════════════════════════════════════════════════════════════════════════

async function getOwnerUserId(db, sessionId) {
    if (!db || !sessionId) return null;
    try {
        let [rows] = await db.query(
            'SELECT user_id, session_id FROM bots WHERE session_id=? LIMIT 1',
            [sessionId]
        );
        if (rows.length) return { userId: rows[0].user_id, dbSessionId: rows[0].session_id };

        // Fallback to oxbot_ prefix (fixes dashboard/bot data mismatch)
        if (!String(sessionId).startsWith('oxbot_')) {
            [rows] = await db.query(
                'SELECT user_id, session_id FROM bots WHERE session_id=? LIMIT 1',
                [`oxbot_${sessionId}`]
            );
            if (rows.length) return { userId: rows[0].user_id, dbSessionId: rows[0].session_id };
        }
        return null;
    } catch (err) {
        console.error('[autoread] getOwnerUserId error:', err.message);
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
        console.error('[autoread] isProUser error:', err.message);
        return false;
    }
}

/**
 * Blocks free users and sends upgrade message
 * @returns {boolean} true = blocked, false = allowed
 */
async function blockIfFree(sock, chatId, msg, db, sessionId) {
    if (!db || !sessionId) return false; // Dev mode — allow

    const ownerData = await getOwnerUserId(db, sessionId);
    const userId    = ownerData?.userId;
    const proOn     = await isProUser(db, userId);

    if (!proOn) {
        await sock.sendMessage(chatId, {
            text: '👑 *Pro Plan Required*\n\n_Auto-Read is a premium feature. Free Trial users cannot use this._\n\n_Upgrade to Pro at: https://oxbot.name.ng/dashboard_'
        }, { quoted: msg });
        return true; // BLOCKED
    }
    return false; // ALLOWED
}

// ═══════════════════════════════════════════════════════════════════════════════

// ── Called from index.js on every incoming message ──
// ★ Also checks Pro status to prevent lapsed users from keeping it on ★
async function handleAutoRead(sock, message, botData) {
    if (!botData?.sessionId || !botData?.db) return;

    // ★ Bulletproof: Force OFF if subscription expires while feature is active ★
    if (botData.db && botData.sessionId) {
        const ownerData = await getOwnerUserId(botData.db, botData.sessionId);
        const proOn = await isProUser(botData.db, ownerData?.userId);
        if (!proOn) return;
    }

    const enabled = await isEnabled(botData.db, botData.sessionId);
    if (!enabled) return;

    try {
        const botJid = sock.user?.id
            ? cleanNumber(sock.user.id) + '@s.whatsapp.net'
            : null;

        // If bot is mentioned — skip marking as read (keep unread for owner to see)
        if (botJid && isBotMentioned(message, botJid)) return;

        const key = {
            remoteJid:   message.key.remoteJid,
            id:          message.key.id,
            participant: message.key.participant
        };

        await sock.readMessages([key]);
    } catch {
        // Silent fail
    }
}

// ── The .autoread command ──
async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!botData?.sessionId || !botData?.db) {
        await sock.sendMessage(chatId, {
            text: '⚠️ Database error. Please restart the bot.'
        }, { quoted: msg });
        return null;
    }

    // ── ★ PRO CHECK — blocks free users immediately ★ ─────────
    if (await blockIfFree(sock, chatId, msg, botData?.db, botData?.sessionId)) {
        return null;
    }

    const senderId      = msg.key.participant || msg.key.remoteJid;
    const senderIsOwner = await isOwner(botData.db, botData.sessionId, senderId, sock, chatId);

    // Silent ignore for non-owners
    if (!msg.key.fromMe && !senderIsOwner) {
        return null;
    }

    // Make sure column exists
    try {
        await botData.db.query(
            `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS autoread TINYINT(1) DEFAULT 0`
        );
    } catch {}

    const action = (args[0] || '').toLowerCase();

    if (action === 'on' || action === 'enable' || action === '1') {
        try {
            await botData.db.query(
                `INSERT INTO bot_settings (session_id, autoread) VALUES (?, 1)
                 ON DUPLICATE KEY UPDATE autoread = 1`,
                [botData.sessionId]
            );
        } catch (err) {
            console.error('[autoread] DB error (enable):', err.message);
        }
        await sock.sendMessage(chatId, {
            text: '✅ *Auto-Read ENABLED!*\n\n📖 Bot will now automatically mark all messages as read.'
        }, { quoted: msg });
        return null;
    }

    if (action === 'off' || action === 'disable' || action === '0') {
        try {
            await botData.db.query(
                `INSERT INTO bot_settings (session_id, autoread) VALUES (?, 0)
                 ON DUPLICATE KEY UPDATE autoread = 0`,
                [botData.sessionId]
            );
        } catch (err) {
            console.error('[autoread] DB error (disable):', err.message);
        }
        await sock.sendMessage(chatId, {
            text: '⛔ *Auto-Read DISABLED!*\n\n📝 Messages will no longer be auto-read.'
        }, { quoted: msg });
        return null;
    }

    if (action && action !== 'on' && action !== 'off') {
        await sock.sendMessage(chatId, {
            text: '❌ Invalid option! Use:\n```.autoread on```\n```.autoread off```'
        }, { quoted: msg });
        return null;
    }

    // No args — toggle
    const current  = await isEnabled(botData.db, botData.sessionId);
    const newState = current ? 0 : 1;
    try {
        await botData.db.query(
            `INSERT INTO bot_settings (session_id, autoread) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE autoread = ?`,
            [botData.sessionId, newState, newState]
        );
    } catch (err) {
        console.error('[autoread] DB error (toggle):', err.message);
    }

    await sock.sendMessage(chatId, {
        text: `✅ Auto-Read has been ${newState ? 'enabled' : 'disabled'}!`
    }, { quoted: msg });
    
    return null;
}

module.exports = {
    name: 'autoread',
    aliases: ['read'],
    desc: 'Auto-read all messages (Owner Only, Pro)',
    category: 'owner',
    execute,
    handleAutoRead
};
