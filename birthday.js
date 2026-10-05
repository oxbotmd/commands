/**
 * commands/birthday.js
 * Save your birthday (day/month) — works in groups or DM.
 * If set inside a group, the bot announces it there on the day.
 * If set in DM, the bot sends you a private "Happy Birthday" instead.
 *
 * Usage:
 *   .birthday set 15-08      (or 15/08)
 *   .birthday                (view your saved birthday)
 *   .birthday remove
 *   .birthday list           (group only — shows everyone's birthday set in THIS group)
 */

const name     = 'birthday';
const aliases  = ['bday'];
const desc     = '🎂 Save your birthday — get wished automatically on the day';
const category = 'general';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check hourly
const LAGOS_TZ = 'Africa/Lagos';

// One watcher per bot session (keyed by session_id). Re-registered on every
// command call so it always points at the CURRENT live socket (handles reconnects).
const watchers = new Map();

function cleanNum(jid) {
    if (!jid) return '';
    return jid.replace(/[^0-9]/g, '');
}

function getLagosNow() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: LAGOS_TZ, day: '2-digit', month: '2-digit', year: 'numeric'
    }).formatToParts(new Date());
    const map = {};
    parts.forEach(p => map[p.type] = p.value);
    return { day: parseInt(map.day), month: parseInt(map.month), year: parseInt(map.year) };
}

async function ensureTable(db) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS birthdays (
            user_jid VARCHAR(50) NOT NULL PRIMARY KEY,
            group_jid VARCHAR(50) DEFAULT NULL,
            day TINYINT NOT NULL,
            month TINYINT NOT NULL,
            last_announced_year INT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `).catch(() => {});
}

async function checkAndAnnounce(sock, db) {
    try {
        const { day, month, year } = getLagosNow();
        const [rows] = await db.query(
            `SELECT * FROM birthdays WHERE day=? AND month=? AND (last_announced_year IS NULL OR last_announced_year <> ?)`,
            [day, month, year]
        );

        for (const row of rows) {
            const targetChat = row.group_jid || row.user_jid;
            const num = cleanNum(row.user_jid);
            try {
                await sock.sendMessage(targetChat, {
                    text: `🎉🎂 *Happy Birthday @${num}!* 🎂🎉\n\nWishing you an amazing day filled with joy! 🥳`,
                    mentions: row.group_jid ? [row.user_jid] : undefined,
                });
            } catch (err) {
                console.error('[birthday] Failed to send announcement:', err.message);
            }
            await db.query('UPDATE birthdays SET last_announced_year=? WHERE user_jid=?', [year, row.user_jid]).catch(() => {});
        }
    } catch (err) {
        console.error('[birthday] Check error:', err.message);
    }
}

function registerWatcher(sock, db, sessionKey) {
    const existing = watchers.get(sessionKey);
    if (existing) clearInterval(existing);

    const intervalId = setInterval(() => checkAndAnnounce(sock, db), CHECK_INTERVAL_MS);
    watchers.set(sessionKey, intervalId);

    // Also run once immediately so a birthday isn't missed while waiting for the first tick
    checkAndAnnounce(sock, db).catch(() => {});
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const db = botData?.db;
    if (!db || !db.query) {
        return await sock.sendMessage(chatId, { text: '❌ Database error.' }, { quoted: msg });
    }

    await ensureTable(db);

    // Self-register the daily check for this bot session (safe to call repeatedly)
    const sessionKey = botData?.sessionId || sock._ownerPhone || 'default';
    registerWatcher(sock, db, sessionKey);

    const senderId = msg.key.participant || msg.key.remoteJid;
    const isGroup = chatId.endsWith('@g.us');
    const opt = (args[0] || '').toLowerCase();

    // ── .birthday list (group only) ──────────────────────────────────────
    if (opt === 'list') {
        if (!isGroup) {
            return await sock.sendMessage(chatId, { text: '❌ `.birthday list` only works in groups.' }, { quoted: msg });
        }
        const [rows] = await db.query(
            'SELECT user_jid, day, month FROM birthdays WHERE group_jid=? ORDER BY month, day', [chatId]
        );
        if (!rows.length) {
            return await sock.sendMessage(chatId, { text: '📭 No birthdays saved in this group yet.\n\nUse `.birthday set DD-MM` to add yours!' }, { quoted: msg });
        }
        const monthNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        let text = `🎂 *Group Birthdays*\n\n`;
        const mentions = [];
        rows.forEach(r => {
            text += `• @${cleanNum(r.user_jid)} — ${r.day} ${monthNames[r.month]}\n`;
            mentions.push(r.user_jid);
        });
        return await sock.sendMessage(chatId, { text, mentions }, { quoted: msg });
    }

    // ── .birthday remove ──────────────────────────────────────────────────
    if (opt === 'remove' || opt === 'delete') {
        await db.query('DELETE FROM birthdays WHERE user_jid=?', [senderId]);
        return await sock.sendMessage(chatId, { text: '🗑️ Your saved birthday has been removed.' }, { quoted: msg });
    }

    // ── .birthday set DD-MM ────────────────────────────────────────────────
    if (opt === 'set') {
        const dateArg = args[1] || '';
        const match = dateArg.match(/^(\d{1,2})[-\/](\d{1,2})$/);
        if (!match) {
            return await sock.sendMessage(chatId, {
                text: '❌ Invalid format!\n\n*Usage:* `.birthday set DD-MM`\n*Example:* `.birthday set 15-08` (15th August)'
            }, { quoted: msg });
        }

        const day   = parseInt(match[1]);
        const month = parseInt(match[2]);

        if (day < 1 || day > 31 || month < 1 || month > 12) {
            return await sock.sendMessage(chatId, { text: '❌ That date doesn\'t look valid. Use DD-MM, e.g. `.birthday set 15-08`.' }, { quoted: msg });
        }

        const groupJid = isGroup ? chatId : null;

        await db.query(
            `INSERT INTO birthdays (user_jid, group_jid, day, month) VALUES (?,?,?,?)
             ON DUPLICATE KEY UPDATE group_jid=?, day=?, month=?, last_announced_year=NULL`,
            [senderId, groupJid, day, month, groupJid, day, month]
        );

        const where = isGroup ? 'You\'ll be wished in this group.' : 'You\'ll get a birthday DM from the bot.';
        return await sock.sendMessage(chatId, {
            text: `✅ *Birthday saved!* 🎂\n\n📅 ${day}/${month}\n${where}`
        }, { quoted: msg });
    }

    // ── .birthday (view) ────────────────────────────────────────────────
    const [rows] = await db.query('SELECT * FROM birthdays WHERE user_jid=?', [senderId]);
    if (!rows.length) {
        return await sock.sendMessage(chatId, {
            text: `🎂 *Birthday Reminder*\n\nYou haven't saved a birthday yet!\n\n*Usage:*\n\`.birthday set DD-MM\`\n\`.birthday remove\`\n\`.birthday list\` _(group only)_`
        }, { quoted: msg });
    }

    const b = rows[0];
    const monthNames = ['','January','February','March','April','May','June','July','August','September','October','November','December'];
    return await sock.sendMessage(chatId, {
        text: `🎂 *Your Saved Birthday*\n\n📅 ${b.day} ${monthNames[b.month]}\n📍 Announced in: ${b.group_jid ? 'this group' : 'DM only'}`
    }, { quoted: msg });
}

module.exports = { name, aliases, desc, category, execute };