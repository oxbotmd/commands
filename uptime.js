/**
 * uptime.js — Bot Status (Multi-Session Safe)
 * Aliases: .uptime, .runtime, .botuptime, .alive
 * 
 * ★ SESSION TIME: Saved in DB (Per-User, 100% Multi-Session Safe)
 * ★ SERVER TIME:  Saved in File (Global, Survives PM2 Restarts)
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const UPTIME_FILE = path.join(DATA_DIR, 'uptime.json');

let processStartTime = Date.now();
let serverAccumulatedMs = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// ★ SERVER TIME INITIALIZATOR (File-Based, Global) ★
// ═══════════════════════════════════════════════════════════════════════════════
function initServerTime() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

        if (fs.existsSync(UPTIME_FILE)) {
            const data = JSON.parse(fs.readFileSync(UPTIME_FILE, 'utf8'));
            serverAccumulatedMs = data.server_accumulated_ms || 0;
            processStartTime = Date.now(); 
            startServerAutoSave(); 
            setupGracefulExit(); 
            return; 
        }

        saveServerTimeData();

    } catch (err) {
        console.error('[uptime] Server Time Init Error:', err.message);
        processStartTime = Date.now();
    }
    
    startServerAutoSave();
    setupGracefulExit();
}

function saveServerTimeData() {
    try {
        const currentServerMs = serverAccumulatedMs + (Date.now() - processStartTime);
        fs.writeFileSync(UPTIME_FILE, JSON.stringify({ 
            server_accumulated_ms: currentServerMs 
        }, null, 2), 'utf8');
    } catch (err) {
        console.error('[uptime] Error saving server time:', err.message);
    }
}

function startServerAutoSave() {
    setInterval(() => {
        serverAccumulatedMs += (Date.now() - processStartTime);
        processStartTime = Date.now(); 
        saveServerTimeData();
    }, 5 * 60 * 1000); // 5 minutes
}

function setupGracefulExit() {
    const exitHandler = () => {
        serverAccumulatedMs += (Date.now() - processStartTime);
        saveServerTimeData();
        process.exit(0);
    };
    process.on('SIGINT', exitHandler);
    process.on('SIGTERM', exitHandler);
}

initServerTime();


// ═══════════════════════════════════════════════════════════════════════════════
// ★ SESSION TIME GETTER (DB-Based, Per-User) ★
// ═══════════════════════════════════════════════════════════════════════════════
async function getSessionTime(db, sessionId) {
    try {
        if (!db || !sessionId) return 0;

        let [rows] = await db.query(
            'SELECT session_start_time FROM bot_settings WHERE session_id = ? LIMIT 1',
            [sessionId]
        );

        if (!rows.length && !String(sessionId).startsWith('oxbot_')) {
            [rows] = await db.query(
                'SELECT session_start_time FROM bot_settings WHERE session_id = ? LIMIT 1',
                [`oxbot_${sessionId}`]
            );
        }

        if (rows.length && rows[0].session_start_time) {
            return Date.now() - new Date(rows[0].session_start_time + 'Z').getTime();
        }
    } catch (err) {
        console.error('[uptime] DB session time error:', err.message);
    }
    return 0; // Fallback to 0s if not found
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

    const parts = [];
    if (days > 0)    parts.push(`${days}d`);
    if (hours > 0)   parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0) parts.push(`${seconds}s`);
    return parts.join(' ') || '0s';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ MAIN COMMAND ★
// ═══════════════════════════════════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const db = botData?.db || sock?._botData?.db;
    const sessionId = botData?.sessionId || sock?._botData?.sessionId;

    // Get true multi-session safe session time from DB
    const sessionMs = await getSessionTime(db, sessionId);
    
    // Get true persistent server time from file
    const serverMs = serverAccumulatedMs + (Date.now() - processStartTime);

    let devName = 'oxdominion.eth';
    let siteUrl = 'https://oxbot.name.ng';

    try {
        const cfg = require('./../config');
        if (cfg.developerName) devName = cfg.developerName;
        if (cfg.siteUrl)     siteUrl = cfg.siteUrl;
    } catch {}

    const botName = botData?.botName || 'OxBot';

    return (
        `*Bot Status*\n\n` +
        `🤖 *Name:* ${botName}\n` +
        `⏱️ *Session:* ${formatTime(sessionMs)}\n` +
        `🖥️ *Server:* ${formatTime(serverMs)}\n` +
        `👤 *Developer:* ${devName}\n` +
        `🔗 *Site:* ${siteUrl}`
    );
}

module.exports = {
    name:     'uptime',
    aliases:  ['runtime', 'botuptime', 'alive'],
    desc:     'Check bot status, uptime, and info',
    category: 'general',
    execute,
};
