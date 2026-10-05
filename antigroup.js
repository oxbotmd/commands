/**
 * OxBot — Anti-Group (Auto-leave new groups)
 * Aliases: .antigroup
 * ── PRO FEATURE ── Requires active subscription
 */

const name     = 'antigroup';
const desc     = 'Auto-leave when added to new groups (Pro)';
const category = 'owner';
const aliases  = ['antigroupadd', 'nobingroup'];

// ═══════════════════════════════════════════════════════════════════
// ★ DB HELPERS ★
// ═══════════════════════════════════════════════════════════════════

async function ensureColumn(db) {
    try {
        await db.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS antigroup TINYINT(1) DEFAULT 0`);
    } catch (err) {
        if (err.errno !== 1060) {
            try { await db.query(`ALTER TABLE bot_settings ADD COLUMN antigroup TINYINT(1) DEFAULT 0`); } catch {}
        }
    }
}

async function isEnabled(db, sessionId) {
    try {
        let [rows] = await db.query('SELECT antigroup FROM bot_settings WHERE session_id = ? LIMIT 1', [sessionId]);
        if (rows.length) return rows[0].antigroup === 1;

        if (!String(sessionId).startsWith('oxbot_')) {
            [rows] = await db.query('SELECT antigroup FROM bot_settings WHERE session_id = ? LIMIT 1', [`oxbot_${sessionId}`]);
            return rows.length > 0 && rows[0].antigroup === 1;
        }
        return false;
    } catch { return false; }
}

async function setState(db, sessionId, val) {
    try {
        if (!db || !sessionId) return;
        await ensureColumn(db);
        await db.query(
            'INSERT INTO bot_settings (session_id, antigroup) VALUES (?, ?) ON DUPLICATE KEY UPDATE antigroup = ?',
            [sessionId, val ? 1 : 0, val ? 1 : 0]
        );
    } catch (err) {
        console.error('[antigroup] setState error:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════════════
// ★ PRO PLAN CHECKERS ★
// ═══════════════════════════════════════════════════════════════════

async function getOwnerUserId(db, sessionId) {
    if (!db || !sessionId) return null;
    try {
        let [rows] = await db.query('SELECT user_id, session_id FROM bots WHERE session_id=? LIMIT 1', [sessionId]);
        if (rows.length) return { userId: rows[0].user_id };
        if (!String(sessionId).startsWith('oxbot_')) {
            [rows] = await db.query('SELECT user_id FROM bots WHERE session_id=? LIMIT 1', [`oxbot_${sessionId}`]);
            if (rows.length) return { userId: rows[0].user_id };
        }
        return null;
    } catch (err) { return null; }
}

async function isProUser(db, userId) {
    if (!userId) return false;
    try {
        const [rows] = await db.query(`SELECT id FROM pro_subscriptions WHERE user_id=? AND status='active' AND expires_at > NOW() LIMIT 1`, [userId]);
        return rows.length > 0;
    } catch { return false; }
}

async function blockIfFree(sock, chatId, msg, db, sessionId) {
    if (!db || !sessionId) return false;
    const ownerData = await getOwnerUserId(db, sessionId);
    if (!await isProUser(db, ownerData?.userId)) {
        await sock.sendMessage(chatId, {
            text: '👑 *Pro Plan Required*\n\n_Anti-Group is a premium feature. Free Trial users cannot use this._\n\n_Upgrade to Pro at: https://oxbot.name.ng/dashboard_'
        }, { quoted: msg });
        return true;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════════
// ★ MAIN COMMAND ★
// ═══════════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const db = botData?.db || sock?._botData?.db;
    const sessionId = botData?.sessionId || sock?._botData?.sessionId;

    if (!db || !sessionId) {
        return await sock.sendMessage(chatId, { text: '⚠️ Database error.' }, { quoted: msg });
    }

    // ── PRO CHECK ─────────────────────────────────────────────────────────
    if (await blockIfFree(sock, chatId, msg, db, sessionId)) return null;

    // ── OWNER CHECK (Basic check from index.js) ──────────────────────────
    if (!msg.key.fromMe) {
         return await sock.sendMessage(chatId, { text: '❌ Owner only!' }, { quoted: msg });
    }

    await ensureColumn(db);
    const action = (args[0] || '').toLowerCase();

    if (['on', 'enable', '1'].includes(action)) {
        await setState(db, sessionId, true);
        return await sock.sendMessage(chatId, {
            text: '🛡️ *Anti-Group ENABLED!*\n\n_I will automatically leave any new group I am added to._'
        }, { quoted: msg });
    }

    if (['off', 'disable', '0'].includes(action)) {
        await setState(db, sessionId, false);
        return await sock.sendMessage(chatId, {
            text: '⛔ *Anti-Group DISABLED!*\n\n_I can now be added to groups normally._'
        }, { quoted: msg });
    }

    // No args = toggle
    const current = await isEnabled(db, sessionId);
    const newState = !current;
    await setState(db, sessionId, newState);

    return await sock.sendMessage(chatId, {
        text: `✅ Anti-Group has been ${newState ? 'enabled' : 'disabled'}!`
    }, { quoted: msg });
}

// ═══════════════════════════════════════════════════════════════════
// ★ BACKGROUND EVENT HANDLER (FIXED FOR BAILEYS FORMAT) ★
// ═══════════════════════════════════════════════════════════════════

async function handleGroupAdd(sock, update, botData) {
    if (!update || !update.id || !update.participants) return;

    const db = botData?.db;
    const sessionId = botData?.sessionId;
    if (!db || !sessionId) return;

    // 1. Check if feature is enabled first (save DB queries if disabled)
    const enabled = await isEnabled(db, sessionId);
    if (!enabled) return;

    // 2. Find the bot's true JID (handles normal and :device formats)
    const rawBotId = sock.user?.id || '';
    const botBaseJid = rawBotId.split(':')[0]; // e.g., "1234@s.whatsapp.net"

    // 3. Baileys passes participants as: [{ id: "jid", action: "add" }]
    let wasBotAdded = false;
    for (const p of update.participants) {
        if (p.action === 'add' && (p.id === rawBotId || p.id === botBaseJid || p.id?.startsWith(botBaseJid))) {
            wasBotAdded = true;
            break;
        }
    }

    if (!wasBotAdded) return;

    // 4. Get the group name to tell the owner
    let groupName = 'Unknown Group';
    try {
        const meta = await sock.groupMetadata(update.id);
        groupName = meta.subject || 'Unknown Group';
    } catch {}

    // 5. Find owner JID to send DM
    try {
        const [rows] = await db.query('SELECT u.phone FROM users u JOIN bots b ON b.user_id = u.id WHERE b.session_id = ? LIMIT 1', [sessionId]);
        if (rows.length && rows[0].phone) {
            const ownerJid = rows[0].phone.replace(/\D/g, '') + '@s.whatsapp.net';
            await sock.sendMessage(ownerJid, {
                text: `🚨 *ANTI-GROUP TRIGGERED*\n\n_I was just added to "${groupName}".\n\n_Because Anti-Group is ON, I have automatically left the group._`
            }).catch(() => {});
        }
    } catch {}

    // 6. Leave the group
    try {
        await sock.groupLeave(update.id);
        console.log(`[AntiGroup] Left group: ${groupName} (${update.id})`);
    } catch (err) {
        console.error('[AntiGroup] Failed to leave group:', err.message);
    }
}

module.exports = { name, desc, category, aliases, execute, handleGroupAdd };
