/**
 * OxBot — Auto-React to Text Command (Pro Only)
 * Bot reacts to incoming text messages with random emojis
 */

// ── Massive Emoji Reaction Pool (Sticker-like & Expressive) ──
const REACTION_EMOJIS = [
    '😂', '❤️', '🔥', '👍', '😍', '😜', '😭', '💀', '🥺', '😎',
    '🤣', '✨', '🙏', '🤩', '💯', '🥰', '😏', '🤔', '💪', '🫡',
    '🤯', '👻', '🤖', '👽', '🙈', '💋', '🦾', '👀', '🫠', '💅',
    '🤡', '💩', '🤮', '😴', '🥱', '🤤', '🥵', '🥶', '😈', '👿',
    '🌸', '🌺', '🌻', '🌹', '🪷', '🍀', '🌟', '⭐', '💫', '☁️',
    '⚡', '💥', '🎶', '🎵', '🎸', '🎹', '🥁', '🪘', '🏆', '🥇',
    '⚽', '🏀', '🎮', '🎯', '🧩', '🎲', '🃏', '🧸', '🎀', '🪄',
    '👑', '💎', '🧿', '🔮', '🪬', '🧬', '🧪', '🔭', '💡', '🪫',
    '🛸', '🛰️', '🚀', '🌍', '🌎', '🌏', '❄️', '☃️', '🌊', '🦋',
    '🦊', '🐱', '🐶', '🦁', '🐻', '🐼', '🐨', '🐸', '🦄', '🐉'
];

// ── Strip device/LID suffix so JIDs always compare cleanly ──
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
        console.error('[reactext] DB error fetching owner:', err.message);
        return null;
    }
}

// ── Check if sender is the owner for this session ──
async function isOwner(db, sessionId, senderId, sock, chatId) {
    const ownerNumber = await getOwnerNumber(db, sessionId);
    if (!ownerNumber) return false;

    const ownerJid    = ownerNumber + '@s.whatsapp.net';
    const senderClean = cleanNumber(senderId);

    if (senderId === ownerJid)          return true;
    if (senderClean === ownerNumber)    return true;
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
        } catch (e) {
            console.error('[reactext] Group LID check error:', e.message);
        }
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

        if (!String(sessionId).startsWith('oxbot_')) {
            [rows] = await db.query(
                'SELECT user_id, session_id FROM bots WHERE session_id=? LIMIT 1',
                [`oxbot_${sessionId}`]
            );
            if (rows.length) return { userId: rows[0].user_id, dbSessionId: rows[0].session_id };
        }
        return null;
    } catch (err) {
        console.error('[reactext] getOwnerUserId error:', err.message);
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
        console.error('[reactext] isProUser error:', err.message);
        return false;
    }
}

async function blockIfFree(sock, chatId, msg, db, sessionId) {
    if (!db || !sessionId) return false;

    const ownerData = await getOwnerUserId(db, sessionId);
    const userId = ownerData?.userId;
    const proOn = await isProUser(db, userId);

    if (!proOn) {
        await sock.sendMessage(chatId, {
            text: '👑 *Pro Plan Required*\n\n_Auto-React is a premium feature. Free Trial users cannot use this._\n\n_Upgrade to Pro at: https://oxbot.name.ng/dashboard_'
        }, { quoted: msg });
        return true;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ BACKGROUND HANDLER ★
// ═══════════════════════════════════════════════════════════════════════════════

async function isEnabled(db, sessionId) {
    try {
        let [rows] = await db.query(
            'SELECT reactext FROM bot_settings WHERE session_id = ? LIMIT 1',
            [sessionId]
        );
        if (rows.length) return rows[0].reactext === 1;

        if (!String(sessionId).startsWith('oxbot_')) {
            [rows] = await db.query(
                'SELECT reactext FROM bot_settings WHERE session_id = ? LIMIT 1',
                [`oxbot_${sessionId}`]
            );
            return rows.length > 0 && rows[0].reactext === 1;
        }
        
        return false;
    } catch {
        return false;
    }
}

async function handleReactextForMessage(sock, chatId, message, botData) {
    if (!botData?.sessionId || !botData?.db) return;

    // Only react to actual text messages
    const userMessage = (
        message.message?.conversation ||
        message.message?.extendedTextMessage?.text ||
        ''
    ).trim();

    if (!userMessage) return;

    const enabled = await isEnabled(botData.db, botData.sessionId);
    if (!enabled) return;

    try {
        // Pick a completely random emoji from the massive pool
        const randomEmoji = REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
        
        await sock.sendMessage(chatId, {
            react: {
                text: randomEmoji,
                key: message.key
            }
        });
    } catch {
        // Silent fail (e.g., if chat restrictions prevent reactions)
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ MAIN COMMAND ★
// ═══════════════════════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!botData?.sessionId || !botData?.db) {
        await sock.sendMessage(chatId, {
            text: '⚠️ Database error. Please restart the bot.'
        }, { quoted: msg });
        return null;
    }

    // ── PRO CHECK ──
    if (await blockIfFree(sock, chatId, msg, botData.db, botData.sessionId)) {
        return null;
    }

    // ── Owner check ──
    const senderId = msg.key.participant || msg.key.remoteJid;
    const senderIsOwner = await isOwner(
        botData.db, botData.sessionId, senderId, sock, chatId
    );

    if (!msg.key.fromMe && !senderIsOwner) {
        await sock.sendMessage(chatId, {
            text: '❌ This command is only available for the owner!'
        }, { quoted: msg });
        return null;
    }

    const action = (args[0] || '').toLowerCase();

    // ★ Get actual DB session ID to prevent dashboard data split ★
    let actualDbSessionId = botData.sessionId;
    const ownerData = await getOwnerUserId(botData.db, botData.sessionId);
    if (ownerData?.dbSessionId) {
        actualDbSessionId = ownerData.dbSessionId;
    }

    if (['on', 'enable', '1'].includes(action)) {
        try {
            await botData.db.query(
                `INSERT INTO bot_settings (session_id, reactext) VALUES (?, 1)
                 ON DUPLICATE KEY UPDATE reactext = 1`,
                [actualDbSessionId]
            );
        } catch (err) {
            console.error('[reactext] DB error (enable):', err.message);
        }
        return await sock.sendMessage(chatId, {
            text: '✅ *Auto-React ENABLED!*\n\n🙃 Bot will now react to all text messages with random emojis.'
        }, { quoted: msg });
    }

    if (['off', 'disable', '0'].includes(action)) {
        try {
            await botData.db.query(
                `INSERT INTO bot_settings (session_id, reactext) VALUES (?, 0)
                 ON DUPLICATE KEY UPDATE reactext = 0`,
                [actualDbSessionId]
            );
        } catch (err) {
            console.error('[reactext] DB error (disable):', err.message);
        }
        return await sock.sendMessage(chatId, {
            text: '⛔ *Auto-React DISABLED!*\n\n🚫 Bot will stop reacting to messages.'
        }, { quoted: msg });
    }

    if (action) {
        return await sock.sendMessage(chatId, {
            text: '❌ Invalid option! Use:\n```.reactext on```\n```.reactext off```'
        }, { quoted: msg });
    }

    // No args — toggle current state
    const current = await isEnabled(botData.db, botData.sessionId);
    const newState = current ? 0 : 1;
    
    try {
        await botData.db.query(
            `INSERT INTO bot_settings (session_id, reactext) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE reactext = ?`,
            [actualDbSessionId, newState, newState]
        );
    } catch (err) {
        console.error('[reactext] DB error (toggle):', err.message);
    }

    return await sock.sendMessage(chatId, {
        text: `✅ Auto-React has been ${newState ? 'enabled 🙃' : 'disabled 🚫'}!`
    }, { quoted: msg });
}

module.exports = {
    name: 'reactext',
    execute: execute,
    handleReactextForMessage: handleReactextForMessage,
    desc: 'Auto-react to text messages with emojis (Pro)',
    category: 'owner',
    aliases: ['autoreacttext', 'textreact']
};