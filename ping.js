/**
 * ping.js — Bot Speed & True Session Uptime
 * Aliases: .ping, .p
 * 
 * ★ MULTI-SESSION SAFE ★
 * Session uptime is now stored in the Database (bot_settings) 
 * so each user gets their own fresh timer!
 */

// ═══════════════════════════════════════════════════════════════════════════════
// ★ PER-SESSION DB START TIME CACHE ★
// ═══════════════════════════════════════════════════════════════════════════════
const sessionStartCache = new Map();

async function getSessionStartTime(db, sessionId) {
    // 1. Check in-memory cache first (Instant, 0ms)
    if (sessionStartCache.has(sessionId)) {
        return sessionStartCache.get(sessionId);
    }

    // 2. Not in cache, ask Database
    try {
        if (!db || !sessionId) return Date.now();

        let [rows] = await db.query(
            'SELECT session_start_time FROM bot_settings WHERE session_id = ? LIMIT 1',
            [sessionId]
        );

        // Fallback to oxbot_ prefix if not found
        if (!rows.length && !String(sessionId).startsWith('oxbot_')) {
            [rows] = await db.query(
                'SELECT session_start_time FROM bot_settings WHERE session_id = ? LIMIT 1',
                [`oxbot_${sessionId}`]
            );
        }

        // If DB has a saved time, use it
        if (rows.length && rows[0].session_start_time) {
            const startTime = new Date(rows[0].session_start_time + 'Z').getTime();
            sessionStartCache.set(sessionId, startTime);
            return startTime;
        }

        // 3. FIRST TIME EVER: Save current time to DB
        const now = Date.now();
        const utcStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
        
        // Ensure the column exists
        try { await db.query(`ALTER TABLE bot_settings ADD COLUMN session_start_time DATETIME`); } catch {}

        // Insert it, but DON'T overwrite if it already exists (IFNULL)
        await db.query(
            `INSERT INTO bot_settings (session_id, session_start_time) VALUES (?, ?) 
             ON DUPLICATE KEY UPDATE session_start_time = IFNULL(session_start_time, VALUES(session_start_time))`,
            [sessionId, utcStr, utcStr]
        ).catch(async () => {
            // If oxbot_ prefix mismatch caused it to fail, try inserting with prefix
            await db.query(
                `INSERT INTO bot_settings (session_id, session_start_time) VALUES (?, ?) 
                 ON DUPLICATE KEY UPDATE session_start_time = IFNULL(session_start_time, VALUES(session_start_time))`,
                [`oxbot_${sessionId}`, utcStr, utcStr]
            ).catch(() => {});
        });

        // Cache and return
        sessionStartCache.set(sessionId, now);
        return now;

    } catch (err) {
        console.error('[ping] DB start time error:', err.message);
        return Date.now(); // Ultimate fallback
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ FORMAT TIME ★
// ═══════════════════════════════════════════════════════════════════════════════
function formatTime(ms) {
    if (ms <= 0) return '0s';
    let seconds = Math.floor(ms / 1000);
    const days    = Math.floor(seconds / 86400);
    seconds %= 86400;
    const hours   = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    seconds %= 60;

    let parts = [];
    if (days > 0)    parts.push(days + 'd');
    if (hours > 0)   parts.push(hours + 'h');
    if (minutes > 0) parts.push(minutes + 'm');
    if (seconds > 0) parts.push(seconds + 's');
    return parts.join(' ') || '0s';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ MAIN COMMAND ★
// ═══════════════════════════════════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    try {
        // ── Step 1: Send "Pinging..." message ─────────────────────────────────
        const start = Date.now();
        const sent = await sock.sendMessage(chatId, {
            text: '🏓 *Pinging...*'
        }, { quoted: msg });

        // ── Step 2: Calculate ping ──────────────────────────────────────────
        const end = Date.now();
        const ping = end - start;

        // ── Step 3: Get TRUE Per-Session Uptime from DB ─────────────────────
        const db = botData?.db || sock?._botData?.db;
        const sessionId = botData?.sessionId || sock?._botData?.sessionId;
        const sessionStart = await getSessionStartTime(db, sessionId);
        const sessionUptime = Date.now() - sessionStart;

        // ── Step 4: Ping rating ───────────────────────────────────────────────
        let icon, status;
        if (ping < 400) {
            icon = '🟢'; status = 'Excellent';
        } else if (ping < 1000) {
            icon = '🟡'; status = 'Normal';
        } else if (ping < 2500) {
            icon = '🟠'; status = 'Slow';
        } else {
            icon = '🔴'; status = 'Lagging';
        }

        // ── Step 5: Edit message with results ────────────────────────────────
        const result = (
            `${icon} *Pong!*\n\n` +
            `⚡ *Speed:* ${ping}ms _(${status})_\n` +
            `⏱️ *Session:* ${formatTime(sessionUptime)}\n` +
            `🤖 *Bot:* ${botData?.botName || 'OxBot'}`
        );

        await sock.sendMessage(chatId, {
            text: result,
            edit: sent.key,
        });

        return null;

    } catch (err) {
        console.error('[ping] Error:', err.message);

        try {
            const db = botData?.db || sock?._botData?.db;
            const sessionId = botData?.sessionId || sock?._botData?.sessionId;
            const sessionStart = await getSessionStartTime(db, sessionId);
            const sessionUptime = Date.now() - sessionStart;
            return `🏓 *Pong!*\n\n⚡ Speed: _error_\n⏱️ Session: ${formatTime(sessionUptime)}`;
        } catch {
            return '❌ Failed to ping.';
        }
    }
}

module.exports = {
    name:     'ping',
    aliases:  ['p'],
    desc:     'Check bot speed and session uptime',
    category: 'general',
    execute,
    getSessionStartTime // Exported so uptime.js can use the exact same timer!
};
