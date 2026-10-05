/**
 * OxBot — Daily Claim Command (PRO ONLY & OWNER ONLY)
 * Bot owners claim 1 coin every 3 days.
 * Opponents/strangers cannot claim coins for the owner's account.
 */

const name     = 'daily';
const desc     = 'Claim daily coins (Owner & Pro Only)';
const category = 'owner';
const aliases  = ['claim', 'reward'];

const PRO_REWARD = 1; // 1 coin per claim
const COOLDOWN   = 3 * 24 * 60 * 60 * 1000; // 3 days in milliseconds

// ═══════════════════════════════════════════════════════════════════════════════
// ★ OWNER VERIFICATION ★
// ═══════════════════════════════════════════════════════════════════════════════

function cleanNumber(jid) {
    if (!jid) return '';
    return jid.split(':')[0].split('@')[0];
}

async function getOwnerNumber(db, sessionId) {
    try {
        const [rows] = await db.query(
            'SELECT u.phone FROM users u JOIN bots b ON b.user_id = u.id WHERE b.session_id = ? LIMIT 1',
            [sessionId]
        );
        if (!rows.length || !rows[0].phone) return null;
        return String(rows[0].phone).replace(/\D/g, '');
    } catch (err) {
        console.error('[daily] DB error fetching owner:', err.message);
        return null;
    }
}

async function isOwner(db, sessionId, senderId, sock, chatId) {
    const ownerNumber = await getOwnerNumber(db, sessionId);
    if (!ownerNumber) return false;

    const ownerJid    = ownerNumber + '@s.whatsapp.net';
    const senderClean = cleanNumber(senderId);

    if (senderId === ownerJid) return true;
    if (senderClean === ownerNumber) return true;
    if (senderId.includes(ownerNumber)) return true;

    // Handle LID in groups
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

// ═══════════════════════════════════════════════════════════════════════════════
// ★ DB HELPERS ★
// ═══════════════════════════════════════════════════════════════════════════════

async function ensureColumn(db) {
    try {
        await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily_claim DATETIME DEFAULT NULL`);
    } catch (err) {
        if (err.errno !== 1060) {
            try { await db.query(`ALTER TABLE users ADD COLUMN last_daily_claim DATETIME DEFAULT NULL`); } catch {}
        }
    }
}

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
        console.error('[daily] getOwnerUserId error:', err.message);
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
        console.error('[daily] isProUser error:', err.message);
        return false;
    }
}

/**
 * Blocks free users with a specific FOMO message
 * @returns {boolean} true = blocked, false = allowed
 */
async function blockIfFree(sock, chatId, msg, db, sessionId) {
    if (!db || !sessionId) return false;

    const ownerData = await getOwnerUserId(db, sessionId);
    const userId    = ownerData?.userId;
    const proOn     = await isProUser(db, userId);

    if (!proOn) {
        await sock.sendMessage(chatId, {
            text: '⚠️ *You are missing out on a lot!*\n\n_Daily coin claims, premium commands, and exclusive features are strictly for Pro users._\n\n_👑 Upgrade to Pro now to enjoy this and many other benefits._\n\n_🔗 https://oxbot.name.ng/dashboard_'
        }, { quoted: msg });
        return true;
    }
    return false;
}

/**
 * Formats remaining cooldown into human-readable string
 */
function formatCooldown(ms) {
    const days    = Math.floor(ms / 86400000);
    const hours   = Math.floor((ms % 86400000) / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return `${days}d ${hours}h ${minutes}m`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ MAIN COMMAND ★
// ═══════════════════════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const db        = botData?.db || sock?._botData?.db;
    const sessionId = botData?.sessionId || sock?._botData?.sessionId;

    if (!db || !sessionId) {
        return await sock.sendMessage(chatId, { text: '⚠️ Database error.' }, { quoted: msg });
    }

    const senderId = msg.key.participant || msg.key.remoteJid;

    // ── STEP 1: STRICT OWNER CHECK ──────────────────────────────────────
    if (!msg.key.fromMe && !await isOwner(db, sessionId, senderId, sock, chatId)) {
        return await sock.sendMessage(chatId, {
            text: '❌ *Access Denied!*\n\n_Only the bot owner can claim daily coins. You cannot claim coins for someone else\'s account._'
        }, { quoted: msg });
    }

    // ── STEP 2: Identify User ───────────────────────────────────────────
    const ownerData = await getOwnerUserId(db, sessionId);
    if (!ownerData?.userId) {
        return await sock.sendMessage(chatId, { text: '❌ Could not verify your account.' }, { quoted: msg });
    }

    const userId = ownerData.userId;
    await ensureColumn(db);

    // ── STEP 3: PRO CHECK ───────────────────────────────────────────────
    if (await blockIfFree(sock, chatId, msg, db, sessionId)) {
        return null;
    }

    // ── STEP 4: Fetch current claim status ──────────────────────────────
    const [userRows] = await db.query(
        'SELECT last_daily_claim, balance FROM users WHERE id = ?', [userId]
    );

    if (!userRows.length) {
        return await sock.sendMessage(chatId, { text: '❌ User not found.' }, { quoted: msg });
    }

    const user      = userRows[0];
    const now       = Date.now();
    const lastClaim = user.last_daily_claim ? new Date(user.last_daily_claim).getTime() : 0;
    const timeDiff  = now - lastClaim;

    // ── STEP 5: Check if 3 days have passed ─────────────────────────────
    if (timeDiff < COOLDOWN) {
        const remaining = COOLDOWN - timeDiff;
        return await sock.sendMessage(chatId, {
            text: `⏳ *Daily Claim Cooldown*\n\nYou already claimed your ${PRO_REWARD} coin!\n\n⏰ Come back in: *${formatCooldown(remaining)}*`
        }, { quoted: msg });
    }

    // ── STEP 6: Update Database ─────────────────────────────────────────
    try {
        await db.query(
            'UPDATE users SET balance = balance + ?, last_daily_claim = NOW() WHERE id = ?',
            [PRO_REWARD, userId]
        );
    } catch (err) {
        console.error('[daily] DB update error:', err.message);
        return await sock.sendMessage(chatId, { text: '❌ Failed to process reward.' }, { quoted: msg });
    }

    // ── STEP 7: Fetch new balance for display ───────────────────────────
    const [updatedUser] = await db.query('SELECT balance FROM users WHERE id = ?', [userId]);
    const newBalance = updatedUser[0]?.balance || 0;

    // ── STEP 8: Send Success Message ────────────────────────────────────
    const text = `
🎁 *Pro Daily Reward Claimed!*

👑 *Reward:* +${PRO_REWARD} Coin
🏦 *New Balance:* ${newBalance} Coins

⏰ _Come back in 3 days for your next claim!_
    `.trim();

    await sock.sendMessage(chatId, { text }, { quoted: msg });
    return null;
}

module.exports = { name, desc, category, aliases, execute };
