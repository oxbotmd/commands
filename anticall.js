/**
 * OxBot — Anti-Call
 * Automatically rejects incoming calls when enabled
 * Owner-only — saves state per user in DB
 * ── PRO FEATURE ── Requires active subscription
 */

// ═══════════════════════════════════════════════════════════════
// IN-MEMORY CACHE (Prevents DB spam for thousands of users)
// ═══════════════════════════════════════════════════════════════
const callCache = new Map();
const CACHE_TTL = 30 * 1000; // Remember setting for 30 seconds

// ═══════════════════════════════════════════════════════════════
// DB Helpers (Per-user isolation)
// ═══════════════════════════════════════════════════════════════
function cleanNumber(jid) {
    if (!jid) return '';
    return jid.split(':')[0].split('@')[0];
}

async function ensureColumn(db) {
    try {
        await db.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS anticall TINYINT(1) DEFAULT 0`);
    } catch (err) {
        if (err.errno !== 1060) {
            try { await db.query(`ALTER TABLE bot_settings ADD COLUMN anticall TINYINT(1) DEFAULT 0`); } catch {}
        }
    }
}

async function getState(db, sessionId) {
    try {
        if (!db || !sessionId) return false;
        
        // Check cache first (Lightning fast)
        const cached = callCache.get(sessionId);
        if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.on;

        await ensureColumn(db);
        const [rows] = await db.query('SELECT anticall FROM bot_settings WHERE session_id = ?', [sessionId]);
        const isEnabled = rows.length ? rows[0].anticall === 1 : false;
        
        // Save to cache
        callCache.set(sessionId, { on: isEnabled, ts: Date.now() });
        return isEnabled;
    } catch (err) {
        console.error('[anticall] getState error:', err.message);
        return false;
    }
}

async function setState(db, sessionId, val) {
    try {
        if (!db || !sessionId) return;
        await ensureColumn(db);
        await db.query(
            'INSERT INTO bot_settings (session_id, anticall) VALUES (?, ?) ON DUPLICATE KEY UPDATE anticall = ?',
            [sessionId, val ? 1 : 0, val ? 1 : 0]
        );
        // Update cache immediately
        callCache.set(sessionId, { on: val, ts: Date.now() });
    } catch (err) {
        console.error('[anticall] setState error:', err.message);
    }
}

async function isOwner(db, sessionId, senderId) {
    try {
        const [rows] = await db.query('SELECT u.phone FROM users u JOIN bots b ON b.user_id = u.id WHERE b.session_id = ?', [sessionId]);
        if (!rows.length || !rows[0].phone) return false;
        const ownerNum = String(rows[0].phone).replace(/\D/g, '');
        return cleanNumber(senderId) === ownerNum;
    } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════
// ★ PRO PLAN CHECKERS ★
// ═══════════════════════════════════════════════════════════════

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
        console.error('[anticall] getOwnerUserId error:', err.message);
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
        console.error('[anticall] isProUser error:', err.message);
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
            text: '👑 *Pro Plan Required*\n\n_Anti-Call is a premium feature. Free Trial users cannot use this._\n\n_Upgrade to Pro at: https://oxbot.name.ng/dashboard_'
        }, { quoted: msg });
        return true; // BLOCKED
    }
    return false; // ALLOWED
}

// ═══════════════════════════════════════════════════════════════
// .anticall Command
// ═══════════════════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!botData?.sessionId || !botData?.db) {
        return await sock.sendMessage(chatId, { text: '⚠️ Database error.' }, { quoted: msg });
    }

    // ── ★ PRO CHECK — blocks free users immediately ★ ─────────
    if (await blockIfFree(sock, chatId, msg, botData?.db, botData?.sessionId)) {
        return null;
    }

    const senderId = msg.key.participant || msg.key.remoteJid;
    if (!msg.key.fromMe && !await isOwner(botData.db, botData.sessionId, senderId)) {
        return await sock.sendMessage(chatId, { text: '❌ Owner only!' }, { quoted: msg });
    }

    const action = (args[0] || '').toLowerCase().trim();

    // Show status
    if (action === 'status' || !action) {
        const cur = await getState(botData.db, botData.sessionId);
        return await sock.sendMessage(chatId, {
            text: `*📞 ANTICALL*\n\nStatus: ${cur ? '✅ ON' : '❌ OFF'}\n\n*.anticall on*\n*.anticall off*`
        }, { quoted: msg });
    }

    if (['on', 'enable', '1', 'yes'].includes(action)) {
        await setState(botData.db, botData.sessionId, true);
        return await sock.sendMessage(chatId, {
            text: '📞 *Anti-Call ENABLED!*\n\nBot will automatically reject all incoming voice/video calls.'
        }, { quoted: msg });
    }

    if (['off', 'disable', '0', 'no'].includes(action)) {
        await setState(botData.db, botData.sessionId, false);
        return await sock.sendMessage(chatId, {
            text: '📵 *Anti-Call DISABLED!*\n\nBot will allow calls normally.'
        }, { quoted: msg });
    }

    return await sock.sendMessage(chatId, {
        text: '❌ Invalid option! Use:\n\n```.anticall on```\n```.anticall off```\n```.anticall status```'
    }, { quoted: msg });
}

// ═══════════════════════════════════════════════════════════════
// CALLS.EVENTS LISTENER FUNCTION
// ⚠️ NOTE: readState is now ASYNC because it checks the DB/Cache!
// ★ Also checks Pro status to prevent lapsed users from keeping it on ★
// ═══════════════════════════════════════════════════════════════
async function readState(db, sessionId) {
    if (!db || !sessionId) return false; // Dev mode fallback

    // ★ Bulletproof: Force OFF if subscription expires while feature is active ★
    const ownerData = await getOwnerUserId(db, sessionId);
    const proOn = await isProUser(db, ownerData?.userId);
    if (!proOn) return false;

    return await getState(db, sessionId);
}

async function init(db) {
    await ensureColumn(db);
    console.log('  ✅ Anticall initialized');
}

module.exports = {
    name: 'anticall',
    execute: execute,
    readState: readState, // Exported for app.js call listener
    init: init,
    desc: 'Auto-reject incoming calls (Owner Only, Pro)',
    category: 'owner',
    aliases: ['blockcall', 'nocall']
};
