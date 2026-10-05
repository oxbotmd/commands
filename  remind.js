

const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

const SCHEDULE_DIR = path.join(__dirname, '..', 'temp', 'scheduled_media');
if (!fs.existsSync(SCHEDULE_DIR)) fs.mkdirSync(SCHEDULE_DIR, { recursive: true });

// ★ GLOBAL TIMEZONE FIX: Automatically uses the server's timezone ★
const USER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function ensureTable(db) {
    if (!db) return;
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS scheduled_posts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                session_id VARCHAR(100),
                user_jid VARCHAR(100),
                chat_id VARCHAR(100),
                message TEXT,
                media_path VARCHAR(255),
                media_type VARCHAR(50),
                fire_at DATETIME,
                recurrence ENUM('once', 'daily', 'weekly', 'monthly') DEFAULT 'once',
                status ENUM('active', 'done', 'cancelled') DEFAULT 'active',
                pre_notified TINYINT(1) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    } catch (err) {
        console.error('[Remind] Table creation error:', err.message);
    }
}

async function downloadMedia(sock, msg) {
    let mediaMsg = msg.message?.imageMessage || msg.message?.videoMessage;
    let quotedMedia = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!mediaMsg && quotedMedia) mediaMsg = quotedMedia.imageMessage || quotedMedia.videoMessage;
    if (!mediaMsg) return null;

    try {
        const type = mediaMsg.mimetype.includes('image') ? 'image' : 'video';
        const ext = type === 'image' ? 'jpg' : 'mp4';
        const stream = await downloadContentFromMessage(mediaMsg, type);
        let buffer = Buffer.alloc(0);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        const filePath = path.join(SCHEDULE_DIR, `schedule_${Date.now()}.${ext}`);
        fs.writeFileSync(filePath, buffer);
        return { path: filePath, type: type, caption: mediaMsg.caption || '' };
    } catch (err) {
        console.error('[Remind] Media download error:', err.message);
        return null;
    }
}

function getNextTimeOccurrence(timeStr, isWeekly) {
    const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!match) return null;
    let hours = parseInt(match[1]);
    const mins = parseInt(match[2]) || 0;
    const ampm = (match[3] || '').toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    if (hours >= 24 || mins >= 60) return null;

    const now = new Date();
    let target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, mins, 0, 0);
    if (target <= now) {
        target.setDate(target.getDate() + (isWeekly ? 7 : 1)); 
    }
    return target;
}

function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    return parts.join(' ') || '0m';
}

function parseCommand(raw) {
    const lower = raw.toLowerCase().trim();
    const recTimeMatch = lower.match(/^(daily|weekly|monthly)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(.*)/);
    if (recTimeMatch) {
        const recurrence = recTimeMatch[1];
        const timeStr = recTimeMatch[2].trim();
        const targetDate = getNextTimeOccurrence(timeStr, recurrence === 'weekly');
        if (!targetDate) return null;
        const matchIndex = raw.indexOf(timeStr) + timeStr.length;
        const message = raw.substring(matchIndex).trim();
        return { targetDate, recurrence, label: `${recurrence} at ${timeStr}`, message };
    }

    const recMatch = lower.match(/^(daily|weekly|monthly)\s+(.*)/);
    if (recMatch) {
        const recurrence = recMatch[1];
        const message = recMatch[2].trim();
        let ms = 86400000; 
        if (recurrence === 'weekly') ms = 604800000;
        if (recurrence === 'monthly') ms = 2592000000;
        return { targetDate: new Date(Date.now() + ms), recurrence, label: `${recurrence} (in ${formatDuration(ms)})`, message };
    }

    const relMatch = lower.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|day|days?|w|wk|wks|weeks?)\s*(.*)/);
    if (relMatch) {
        const num = parseFloat(relMatch[1]);
        const unit = relMatch[2].toLowerCase();
        let ms = 0;
        if (/^m/.test(unit)) ms = num * 60 * 1000;
        else if (/^h/.test(unit)) ms = num * 60 * 60 * 1000;
        else if (/^d/.test(unit)) ms = num * 24 * 60 * 60 * 1000;
        else if (/^w/.test(unit)) ms = num * 7 * 24 * 60 * 60 * 1000;
        if (ms > 0) return { targetDate: new Date(Date.now() + ms), recurrence: 'once', label: `In ${formatDuration(ms)}`, message: relMatch[3].trim() };
    }
    return null;
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    const db = botData?.db;
    if (!chatId || !db) return null;
    await ensureTable(db);

    const sender = msg.key.participant || msg.key.remoteJid;
    const sessionId = botData?.sessionId;
    const cmdWord = (args[0] || '').toLowerCase();

    if (cmdWord === 'list' || cmdWord === 'all') {
        const [rows] = await db.query('SELECT * FROM scheduled_posts WHERE session_id = ? AND status = "active" ORDER BY fire_at ASC', [sessionId]);
        if (!rows.length) return '📭 You have no active scheduled posts.';
        const lines = rows.map(r => {
            const type = r.recurrence !== 'once' ? `🔄 ${r.recurrence}` : '⏱️ Once';
            const media = r.media_path ? '🖼️+📝' : '📝';
            const localTime = new Date(r.fire_at + 'Z').toLocaleString('en-GB', { timeZone: USER_TIMEZONE });
            return `*#${r.id}* ${type} ${media}\n📌 ${r.message || '(Media only)'}\n🗓 Fires: ${localTime}`;
        }).join('\n\n');
        return `📋 *YOUR SCHEDULED POSTS* (${rows.length})\n\n${lines}\n\n_Cancel with: .remind cancel <ID>_`;
    }

    if (cmdWord === 'cancel' || cmdWord === 'delete') {
        const id = parseInt(args[1]);
        if (isNaN(id)) return '❌ Provide an ID. Example: `.remind cancel 3`';
        const [rows] = await db.query('SELECT * FROM scheduled_posts WHERE id = ? AND session_id = ?', [id, sessionId]);
        if (!rows.length) return `❌ Post *#${id}* not found.`;
        if (rows[0].media_path && fs.existsSync(rows[0].media_path)) fs.unlinkSync(rows[0].media_path);
        await db.query('UPDATE scheduled_posts SET status = "cancelled" WHERE id = ?', [id]);
        return `✅ Scheduled post *#${id}* cancelled.`;
    }

    const rawString = args.join(' ');
    const parsed = parseCommand(rawString);
    if (!parsed) return `❌ *Invalid format.*\n\n*Examples:*\n• \`.remind 1m Test message\`\n• \`.remind daily 7am Morning devotional\`\n• \`.remind daily 3:39pm Evening prayer\``;

    const { targetDate, recurrence, label, message: textMessage } = parsed;
    const media = await downloadMedia(sock, msg);
    const finalMessage = media?.caption || textMessage || '';
    if (!finalMessage && !media) return '❌ Please provide a message or attach an image!';

    const fireAtUTC = targetDate.toISOString().replace('T', ' ').slice(0, 19);
    const [result] = await db.query(
        `INSERT INTO scheduled_posts (session_id, user_jid, chat_id, message, media_path, media_type, fire_at, recurrence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, sender, chatId, finalMessage, media?.path || null, media?.type || null, fireAtUTC, recurrence]
    );

    const displayTime = targetDate.toLocaleString('en-GB', { timeZone: USER_TIMEZONE });
    const responseText = `✅ *Scheduled Post Created!*\n\n🆔 *ID:* #${result.insertId}\n🔄 *Repeat:* ${label}\n📌 *Message:* ${finalMessage || '(Media only)'}\n🖼️ *Media:* ${media ? 'Yes' : 'No'}\n🗓 *Fires at:* ${displayTime} (_${USER_TIMEZONE}_)\n\n_Cancel anytime: .remind cancel ${result.insertId}_`;
    await sock.sendMessage(chatId, { text: responseText }, { quoted: msg });
    return null;
}

let cronInterval = null;

function initCron(sock, db) {
    if (cronInterval) clearInterval(cronInterval);
    ensureTable(db);
    console.log(`  ✅ Scheduled Posts Cron Active (Timezone: ${USER_TIMEZONE})`);

    cronInterval = setInterval(async () => {
        if (!db || !sock?.user?.id) return;
        try {
            const [ready] = await db.query(`SELECT * FROM scheduled_posts WHERE status = 'active' AND fire_at <= UTC_TIMESTAMP() ORDER BY fire_at ASC LIMIT 5`);

            if (ready.length === 0) return;

            for (const post of ready) {
                const sendOpts = {};
                let hasContent = false;
                
                if (post.media_path && fs.existsSync(post.media_path)) {
                    if (post.media_type === 'image') {
                        sendOpts.image = { url: post.media_path };
                        if (post.message && post.message.trim() !== '') sendOpts.caption = post.message;
                        hasContent = true;
                    } else if (post.media_type === 'video') {
                        sendOpts.video = { url: post.media_path };
                        if (post.message && post.message.trim() !== '') sendOpts.caption = post.message;
                        hasContent = true;
                    }
                } else if (post.message && post.message.trim() !== '') {
                    sendOpts.text = post.message;
                    hasContent = true;
                }

                if (!hasContent) {
                    await db.query('UPDATE scheduled_posts SET status = "cancelled" WHERE id = ?', [post.id]);
                    continue;
                }

                try {
                    await sock.sendMessage(post.chat_id, sendOpts);
                    console.log(`[Remind] ✅ SUCCESS! Sent post #${post.id}`);
                } catch (sendErr) {
                    console.error(`[Remind] ❌ FAILED! Post #${post.id} error:`, sendErr.message);
                    await sock.sendMessage(post.user_jid, { text: `❌ *Scheduled Post Failed!*\n\n_Error: ${sendErr.message}_` }).catch(() => {});
                    await db.query('UPDATE scheduled_posts SET status = "cancelled" WHERE id = ?', [post.id]);
                    continue;
                }

                if (post.recurrence === 'once') {
                    await db.query('UPDATE scheduled_posts SET status = "done" WHERE id = ?', [post.id]);
                    if (post.media_path && fs.existsSync(post.media_path)) fs.unlinkSync(post.media_path);
                } else {
                    let addMs = 86400000; 
                    if (post.recurrence === 'weekly') addMs = 604800000;
                    if (post.recurrence === 'monthly') addMs = 2592000000; 
                    const nextFireUTC = new Date(new Date(post.fire_at + 'Z').getTime() + addMs).toISOString().replace('T', ' ').slice(0, 19);
                    await db.query(`UPDATE scheduled_posts SET fire_at = ?, pre_notified = 0 WHERE id = ?`, [nextFireUTC, post.id]);
                }
            }
        } catch (err) {
            console.error('[Remind Cron Error]:', err.message);
        }
    }, 60 * 1000); 
}

module.exports = {
    name:     'remind',
    aliases:  ['schedule', 'reminders', 'cancelremind'],
    desc:     'Schedule posts with media (daily/weekly/monthly at exact times)',
    category: 'general',
    execute,
    initCron
};

