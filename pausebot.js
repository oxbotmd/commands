/**
 * commands/pausebot.js
 * .pausebot — pause this bot session from WhatsApp itself, no dashboard
 * login needed. This is the exact same logic as POST /api/deactivate-bot
 * in routes/bots.js, just triggered from chat instead of the dashboard
 * button:
 *   - marks the session stopped/inactive in memory (stoppedBots etc.)
 *   - closes the live socket
 *   - flips bots.status to "inactive" in the DB
 *   - clears console logs the same way the dashboard endpoint does
 *
 * Uses the SAME shared state Maps as routes/bots.js (imported from
 * ../oxbot/state) so the dashboard and this command never disagree
 * about whether a bot is active.
 */

const {
    activeBots,
    stoppedBots,
    connectingBots,
    reconnectLocks,
    reconnectAttempts,
} = require('../oxbot/state');
const { addLog } = require('../oxbot/utils');

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

async function getOwnerRow(db, sessionId) {
    try {
        const [rows] = await db.query(
            'SELECT u.id AS user_id, u.phone FROM users u JOIN bots b ON b.user_id = u.id WHERE b.session_id = ? LIMIT 1',
            [sessionId]
        );
        return rows.length ? rows[0] : null;
    } catch {
        return null;
    }
}

async function isOwner(db, sessionId, senderId, sock, chatId, ownerRow) {
    const ownerNumber = ownerRow?.phone ? String(ownerRow.phone).replace(/\D/g, '') : null;
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

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!botData?.sessionId || !botData?.db) {
        return await sock.sendMessage(chatId, { text: '⚠️ Database error.' }, { quoted: msg });
    }

    const db = botData.db;
    const senderId = msg.key.participant || msg.key.remoteJid;

    const sessionId = await getActualDbSessionId(db, botData.sessionId);
    const ownerRow = await getOwnerRow(db, sessionId);

    const senderIsOwner = await isOwner(db, sessionId, senderId, sock, chatId, ownerRow);
    if (!msg.key.fromMe && !senderIsOwner) {
        return await sock.sendMessage(chatId, { text: '❌ Owner only command.' }, { quoted: msg });
    }

    // Send the confirmation BEFORE tearing down the socket — once we
    // call sock.end() below, this same connection can't deliver anything.
    await sock.sendMessage(chatId, {
        text: '⏸️ Pausing this bot now — it will disconnect. Resume anytime from the dashboard or by re-pairing.'
    }, { quoted: msg });

    // ── Same steps as POST /api/deactivate-bot ──
    stoppedBots.add(sessionId);
    connectingBots.delete(sessionId);
    reconnectLocks.delete(sessionId);
    reconnectAttempts.delete(sessionId);

    const bot = activeBots.get(sessionId);
    if (bot?.sock) {
        try { bot.sock.ws?.close(1000, 'paused'); } catch {}
        try { bot.sock.end(); } catch {}
    }
    activeBots.delete(sessionId);
    global.botConnected = activeBots.size > 0;

    await db.query('UPDATE bots SET status="inactive" WHERE session_id=?', [sessionId]).catch(() => {});

    if (ownerRow?.user_id) {
        const userId = ownerRow.user_id;
        const [otherActive] = await db.query(
            `SELECT COUNT(*) as c FROM bots WHERE user_id=? AND status='active' AND session_id != ?`,
            [userId, sessionId]
        ).catch(() => [[{ c: 1 }]]);

        if (otherActive[0].c === 0) {
            await db.query('DELETE FROM console_logs WHERE user_id = ?', [userId]).catch(() => {});
            addLog(userId, `⏸️ Bot paused via .pausebot. No active bots — logs cleared.`);
        } else {
            addLog(userId, `⏸️ Bot paused via .pausebot: ${sessionId.slice(-8)}`);
        }
    }

    console.log(`[pausebot] Paused via chat command: ${sessionId}`);
}

module.exports = {
    name: 'pausebot',
    execute,
    desc: 'Pause this bot from chat, no dashboard login needed (Owner)',
    category: 'owner',
    aliases: ['pause', 'stopbot'],
};