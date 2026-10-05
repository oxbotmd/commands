/**
 * commands/goodbye.js
 * .goodbye — configure a custom "member left" message
 * handleMemberLeave — actually sends it, called from botManager.js on
 * group-participants.update (mirrors the commands/welcome.js pattern)
 *
 * Placeholders supported in the goodbye text:
 *   {user}    → @mention of the member who left
 *   {group}   → group name
 *   {count}   → member count remaining after they left
 */

const DEFAULT_GOODBYE_TEXT =
    '😢 {user} just left *{group}*.\n\nWe will miss you! 💔 Hope to see you back soon.';

function fillTemplate(template, { userMention, groupName, count }) {
    return template
        .replace(/\{user\}/g,  userMention)
        .replace(/\{group\}/g, groupName || 'the group')
        .replace(/\{count\}/g, String(count ?? '?'));
}

// ═══════════════════════════════════════════════════
// .goodbye COMMAND (Owner Only)
// ═══════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const db        = botData?.db;
    const sessionId = botData?.sessionId;
    const sub       = (args[0] || '').trim().toLowerCase();

    try {
        // ── .goodbye on / off ────────────────────────────────────────────────
        if (sub === 'on' || sub === 'off') {
            const enabled = sub === 'on' ? 1 : 0;

            if (db && sessionId) {
                try {
                    await db.query(
                        `INSERT INTO bot_settings (session_id, goodbye_enabled) VALUES (?, ?)
                         ON DUPLICATE KEY UPDATE goodbye_enabled = ?`,
                        [sessionId, enabled, enabled]
                    );
                } catch (err) {
                    console.error('[GOODBYE] DB Error:', err.message);
                }
            }

            return await sock.sendMessage(chatId, {
                text: enabled
                    ? '✅ *Goodbye messages turned ON.*\n\nThe group gets notified when someone leaves.'
                    : '🔕 *Goodbye messages turned OFF.*'
            }, { quoted: msg });
        }

        // ── .goodbye reset ───────────────────────────────────────────────────
        if (sub === 'reset') {
            if (db && sessionId) {
                try {
                    await db.query(
                        `INSERT INTO bot_settings (session_id, goodbye_text) VALUES (?, NULL)
                         ON DUPLICATE KEY UPDATE goodbye_text = NULL`,
                        [sessionId]
                    );
                } catch (err) {
                    console.error('[GOODBYE] DB Error (reset):', err.message);
                }
            }

            return await sock.sendMessage(chatId, {
                text: `♻️ *Goodbye Message Reset!*\n\nBack to the default:\n\n${DEFAULT_GOODBYE_TEXT}`
            }, { quoted: msg });
        }

        // ── .goodbye set <text> ──────────────────────────────────────────────
        if (sub === 'set') {
            const newText = args.slice(1).join(' ').trim();

            if (!newText) {
                return await sock.sendMessage(chatId, {
                    text: `❌ *Missing text!*\n\nUsage: \`.goodbye set <text>\`\n\n` +
                          `Placeholders: {user} {group} {count}\n` +
                          `Example: \`.goodbye set Bye {user}, we'll miss you in {group}! 😢\``
                }, { quoted: msg });
            }

            if (newText.length > 700) {
                return await sock.sendMessage(chatId, {
                    text: '❌ *Too long!*\n\nKeep the goodbye text under 700 characters.'
                }, { quoted: msg });
            }

            if (db && sessionId) {
                try {
                    await db.query(
                        `INSERT INTO bot_settings (session_id, goodbye_text) VALUES (?, ?)
                         ON DUPLICATE KEY UPDATE goodbye_text = ?`,
                        [sessionId, newText, newText]
                    );
                } catch (err) {
                    console.error('[GOODBYE] DB Error (set):', err.message);
                }
            }

            return await sock.sendMessage(chatId, {
                text: `✅ *Goodbye Message Updated!*\n\n*Preview:*\n${fillTemplate(newText, {
                    userMention: '@2348031234567',
                    groupName:   'Sample Group',
                    count:       41,
                })}\n\n_Tip: run \`.goodbye on\` if it's not enabled yet._`,
                mentions: ['2348031234567@s.whatsapp.net'],
            }, { quoted: msg });
        }

        // ── No/unknown sub-command: show current status + usage ─────────────
        let enabledRow = null;
        let textRow    = null;
        if (db && sessionId) {
            try {
                const [rows] = await db.query(
                    'SELECT goodbye_enabled, goodbye_text FROM bot_settings WHERE session_id=? ORDER BY id DESC LIMIT 1',
                    [sessionId]
                );
                if (rows.length) {
                    enabledRow = rows[0].goodbye_enabled;
                    textRow    = rows[0].goodbye_text;
                }
            } catch {}
        }

        const isOn      = enabledRow === 1 || enabledRow === '1';
        const currentTx = textRow || DEFAULT_GOODBYE_TEXT;

        return await sock.sendMessage(chatId, {
            text: `👋 *Goodbye Message Configuration*\n\n` +
                  `Status: ${isOn ? '✅ ON' : '🔕 OFF'}\n\n` +
                  `Current text:\n${currentTx}\n\n` +
                  `*Usage:*\n` +
                  `• \`.goodbye on\` / \`.goodbye off\`\n` +
                  `• \`.goodbye set <text>\`\n` +
                  `• \`.goodbye reset\`\n\n` +
                  `Placeholders: {user} {group} {count}`
        }, { quoted: msg });

    } catch (err) {
        console.error('[GOODBYE] Error:', err.message);
        await sock.sendMessage(chatId, {
            text: `❌ Failed to update goodbye settings: ${err.message}`
        }, { quoted: msg });
    }

    return null;
}

// ═══════════════════════════════════════════════════
// ★ ACTUALLY SENDS THE GOODBYE — called from botManager.js
// on group-participants.update, same pattern as welcome.js
// ═══════════════════════════════════════════════════
async function handleMemberLeave(sock, update, botData) {
    if (!update || update.action !== 'remove') return;

    const groupJid = update.id;
    const leftUsers = update.participants || [];
    if (!groupJid || !leftUsers.length) return;

    const db        = botData?.db;
    const sessionId = botData?.sessionId;
    if (!db || !sessionId) return;

    let enabled  = false;
    let template = DEFAULT_GOODBYE_TEXT;

    try {
        const [rows] = await db.query(
            'SELECT goodbye_enabled, goodbye_text FROM bot_settings WHERE session_id=? ORDER BY id DESC LIMIT 1',
            [sessionId]
        );
        if (rows.length) {
            enabled  = rows[0].goodbye_enabled === 1 || rows[0].goodbye_enabled === '1';
            template = rows[0].goodbye_text || DEFAULT_GOODBYE_TEXT;
        }
    } catch (err) {
        console.error('[GOODBYE] DB read failed:', err.message);
        return;
    }

    if (!enabled) return;

    // Don't send a "we'll miss you" if the bot itself was removed/left
    const botNumber = sock.user?.id?.split(':')[0]?.split('@')[0];
    const realLeavers = leftUsers.filter(jid => {
        const num = jid.split('@')[0];
        return num !== botNumber;
    });
    if (!realLeavers.length) return;

    let groupName = 'the group';
    let count     = null;

    try {
        const meta = await sock.groupMetadata(groupJid);
        groupName = meta?.subject || groupName;
        count     = meta?.participants?.length ?? null;
    } catch (err) {
        console.error('[GOODBYE] groupMetadata failed:', err.message);
    }

    // Send one message per leaver (usually just one at a time in practice)
    for (const jid of realLeavers) {
        const userMention = `@${jid.split('@')[0]}`;
        const text = fillTemplate(template, { userMention, groupName, count });

        try {
            await sock.sendMessage(groupJid, {
                text,
                mentions: [jid],
            });
        } catch (err) {
            console.error('[GOODBYE] Send failed:', err.message);
        }
    }
}

module.exports = {
    name: 'goodbye',
    aliases: ['setgoodbye', 'leavemsg'],
    desc: 'Configure the message sent when a member leaves the group',
    category: 'owner',
    execute,
    handleMemberLeave,
};
