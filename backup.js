/**
 * commands/backup.js
 * Session Backup System
 *
 * Problem it solves: if a bot disconnects and gets re-paired, Baileys/your
 * bots table gives it a NEW session_id, so bot_settings (ai_mode, persona,
 * etc.) starts empty again even though it's the same phone number.
 *
 * This snapshots bot_settings keyed by PHONE NUMBER (which survives a
 * re-pair). First time a phone connects with no existing backup, one is
 * auto-created. `.backup` lists snapshots for that phone; `.backup <n>`
 * restores snapshot #n into the CURRENT session.
 */

function cleanNumber(jid) {
    if (!jid) return '';
    return jid.split(':')[0].split('@')[0];
}

async function getActualDbSessionId(db, sessionId) {
    try {
        const [rows] = await db.query('SELECT session_id FROM bots WHERE session_id=? LIMIT 1', [sessionId]);
        if (rows.length) return rows[0].session_id;
        if (!String(sessionId).startsWith('oxbot_')) {
            const [rows2] = await db.query('SELECT session_id FROM bots WHERE session_id=? LIMIT 1', [`oxbot_${sessionId}`]);
            if (rows2.length) return rows2[0].session_id;
        }
    } catch {}
    return sessionId;
}

async function getPhoneForSession(db, sessionId) {
    try {
        const [rows] = await db.query(
            `SELECT u.phone FROM users u JOIN bots b ON b.user_id = u.id WHERE b.session_id = ? LIMIT 1`,
            [sessionId]
        );
        return rows.length && rows[0].phone ? String(rows[0].phone).replace(/\D/g, '') : null;
    } catch {
        return null;
    }
}

async function getOwnerNumber(db, sessionId) {
    return getPhoneForSession(db, sessionId);
}

async function isOwner(db, sessionId, senderId, sock, chatId) {
    const ownerNumber = await getOwnerNumber(db, sessionId);
    if (!ownerNumber) return false;

    const ownerJid = ownerNumber + '@s.whatsapp.net';
    const senderClean = cleanNumber(senderId);

    if (senderId === ownerJid) return true;
    if (senderClean === ownerNumber) return true;
    if (senderId.includes(ownerNumber)) return true;

    if (sock && chatId && chatId.endsWith('@g.us') && senderId.includes('@lid')) {
        try {
            const metadata = await sock.groupMetadata(chatId);
            const participants = metadata.participants || [];
            const match = participants.find(p => {
                const pIdClean = cleanNumber(p.id || '');
                return pIdClean === ownerNumber || (p.id || '') === ownerJid;
            });
            if (match) return true;
        } catch (e) {}
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════════
// ★ CORE SNAPSHOT LOGIC ★
// ═══════════════════════════════════════════════════════════════════

/**
 * Take a fresh snapshot of bot_settings right now, tagged to `phone`.
 * Returns true/false for success.
 */
async function snapshotSettings(db, sessionId, phoneOverride) {
    try {
        const actualId = await getActualDbSessionId(db, sessionId);
        const phone = phoneOverride || await getPhoneForSession(db, actualId);
        if (!phone) return false;

        const [settingsRows] = await db.query(
            'SELECT * FROM bot_settings WHERE session_id = ? ORDER BY id DESC LIMIT 1',
            [actualId]
        );
        const settings = settingsRows[0] || {};

        await db.query(
            'INSERT INTO bot_backups (phone, session_id, settings_json) VALUES (?, ?, ?)',
            [phone, actualId, JSON.stringify(settings)]
        );

        // Opportunistic cleanup — cheap, and guarantees old rows get purged
        // even if the MySQL EVENT in the migration is ever disabled.
        cleanupOldBackups(db).catch(() => {});

        return true;
    } catch (err) {
        console.error('[backup] snapshotSettings failed:', err.message);
        return false;
    }
}

/**
 * Delete backup snapshots older than 30 days. Safe to call often — it's
 * just a DELETE with an index on created_at. Called automatically after
 * every new snapshot, AND on a self-scheduled daily timer (see
 * startAutoCleanup below) so it also catches phones that never trigger
 * a new snapshot.
 */
async function cleanupOldBackups(db, days = 30) {
    try {
        const [result] = await db.query(
            'DELETE FROM bot_backups WHERE created_at < (NOW() - INTERVAL ? DAY)',
            [days]
        );
        if (result.affectedRows) {
            console.log(`[backup] cleanupOldBackups removed ${result.affectedRows} row(s) older than ${days} days`);
        }
        return result.affectedRows || 0;
    } catch (err) {
        console.error('[backup] cleanupOldBackups failed:', err.message);
        return 0;
    }
}

let _cleanupTimer = null;

/**
 * Pure Node/JS scheduler — no cron, no MySQL EVENT, no server config.
 * Call this ONCE when your bot process starts (e.g. in index.js / app.js,
 * right where you connect to `db`):
 *
 *     const { startAutoCleanup } = require('./commands/backup.js');
 *     startAutoCleanup(db);
 *
 * It runs cleanupOldBackups once immediately, then every 24h for as long
 * as the process stays alive. PM2 keeps the process alive, so this is
 * effectively "daily" without touching anything outside your app.
 */
function startAutoCleanup(db, days = 30) {
    if (_cleanupTimer) return; // already running, don't double-schedule
    cleanupOldBackups(db, days).catch(() => {});
    _cleanupTimer = setInterval(() => {
        cleanupOldBackups(db, days).catch(() => {});
    }, 24 * 60 * 60 * 1000);
    if (_cleanupTimer.unref) _cleanupTimer.unref(); // don't block process exit
}

/**
 * Call this right after a session finishes pairing/connecting
 * (e.g. from botManager.js's connection.update handler on 'open').
 * Only writes a backup if this phone has NEVER been backed up before,
 * so it doesn't spam a row on every reconnect.
 */
async function autoBackupIfMissing(db, sessionId) {
    try {
        const actualId = await getActualDbSessionId(db, sessionId);
        const phone = await getPhoneForSession(db, actualId);
        if (!phone) return;

        const [existing] = await db.query('SELECT id FROM bot_backups WHERE phone = ? LIMIT 1', [phone]);
        if (existing.length) return;

        await snapshotSettings(db, actualId, phone);
    } catch (err) {
        console.error('[backup] autoBackupIfMissing failed:', err.message);
    }
}

// Columns that must NEVER be copied from an old snapshot onto the current
// session — identity/timestamp columns that belong to the row itself, not
// to the owner's preferences.
const NON_RESTORABLE_COLUMNS = new Set([
    'id',
    'session_id',
    'created_at',
    'updated_at',
    'session_start_time', // current session gets its own fresh start time
]);

/**
 * Apply a stored settings_json blob onto the CURRENT session_id.
 * Works for every column in bot_settings automatically (autotyping,
 * antidelete, bot_mode, pmblocker, autoreply, welcome_text, ai_mode, ...)
 * since it just restores whatever keys were present at snapshot time,
 * minus the ones in NON_RESTORABLE_COLUMNS.
 */
async function restoreSnapshot(db, currentSessionId, backupRow) {
    const actualId = await getActualDbSessionId(db, currentSessionId);
    const saved = JSON.parse(backupRow.settings_json);

    const restorable = {};
    for (const [key, value] of Object.entries(saved)) {
        if (!NON_RESTORABLE_COLUMNS.has(key)) restorable[key] = value;
    }

    const keys = Object.keys(restorable);
    if (!keys.length) return false;

    const setClause = keys.map(k => `${k} = ?`).join(', ');
    const values = keys.map(k => restorable[k]);

    // Ensure a row exists for the current session first. Checked explicitly
    // rather than relying on ON DUPLICATE KEY, since bot_settings has a
    // known history of missing a UNIQUE constraint on session_id — that
    // trick silently does nothing (or duplicates rows) without one.
    const [existingRow] = await db.query(
        'SELECT id FROM bot_settings WHERE session_id = ? LIMIT 1',
        [actualId]
    );
    if (!existingRow.length) {
        await db.query('INSERT INTO bot_settings (session_id) VALUES (?)', [actualId]);
    }

    await db.query(
        `UPDATE bot_settings SET ${setClause} WHERE session_id = ?`,
        [...values, actualId]
    );
    return true;
}

// ═══════════════════════════════════════════════════════════════════
// ★ COMMAND ★
// ═══════════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!botData?.sessionId || !botData?.db) {
        return await sock.sendMessage(chatId, { text: '⚠️ Database error.' }, { quoted: msg });
    }

    const db = botData.db;
    const senderId = msg.key.participant || msg.key.remoteJid;
    const senderIsOwner = await isOwner(db, botData.sessionId, senderId, sock, chatId);

    if (!msg.key.fromMe && !senderIsOwner) {
        return await sock.sendMessage(chatId, { text: '❌ Owner only command.' }, { quoted: msg });
    }

    const actualId = await getActualDbSessionId(db, botData.sessionId);
    const phone = await getPhoneForSession(db, actualId);
    if (!phone) {
        return await sock.sendMessage(chatId, { text: '⚠️ Could not resolve your phone number for this session.' }, { quoted: msg });
    }

    const sub = (args[0] || '').toLowerCase();

    // ── .backup save → force a fresh snapshot right now ──
    if (sub === 'save') {
        const ok = await snapshotSettings(db, actualId, phone);
        return await sock.sendMessage(chatId, {
            text: ok ? '✅ Snapshot saved.' : '❌ Could not save snapshot.'
        }, { quoted: msg });
    }

    // ── .backup <n> → restore snapshot #n ──
    if (sub && /^\d+$/.test(sub)) {
        const [rows] = await db.query(
            'SELECT * FROM bot_backups WHERE phone = ? ORDER BY created_at DESC LIMIT 20',
            [phone]
        );
        const idx = parseInt(sub, 10) - 1;
        if (!rows.length || idx < 0 || idx >= rows.length) {
            return await sock.sendMessage(chatId, { text: '❌ Invalid backup number. Run `.backup` to see the list.' }, { quoted: msg });
        }

        const restored = await restoreSnapshot(db, botData.sessionId, rows[idx]);
        return await sock.sendMessage(chatId, {
            text: restored
                ? `✅ Restored settings from backup #${sub} (saved ${new Date(rows[idx].created_at).toLocaleString()}).`
                : '❌ Nothing to restore in that snapshot.'
        }, { quoted: msg });
    }

    // ── .backup (no args) → list snapshots for this phone ──
    const [rows] = await db.query(
        'SELECT * FROM bot_backups WHERE phone = ? ORDER BY created_at DESC LIMIT 20',
        [phone]
    );

    if (!rows.length) {
        // Shouldn't normally happen since we auto-backup on pair, but cover it.
        await snapshotSettings(db, actualId, phone);
        return await sock.sendMessage(chatId, {
            text: `📦 No backups found — created your first snapshot just now.\nRun *.backup* again to see it.`
        }, { quoted: msg });
    }

    const list = rows.map((r, i) =>
        `*${i + 1}.* oxbot_${r.phone} — ${new Date(r.created_at).toLocaleString()}`
    ).join('\n');

    return await sock.sendMessage(chatId, {
        text: `📦 *Backups for ${phone}:*\n\n${list}\n\nReply *.backup <number>* to restore, or *.backup save* to snapshot now.`
    }, { quoted: msg });
}

module.exports = {
    name: 'backup',
    execute: execute,
    desc: 'List/restore settings backups tied to your phone number (Owner)',
    category: 'owner',
    aliases: ['restore'],
    // Export for botManager.js to call on successful pairing
    autoBackupIfMissing,
    snapshotSettings,
    cleanupOldBackups,
    startAutoCleanup,
};