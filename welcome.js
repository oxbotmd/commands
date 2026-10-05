/**
 * commands/welcome.js
 * .setwelcome — configure a custom welcome message for new group members
 * handleMemberJoin — actually sends it, called from botManager.js on
 * group-participants.update (mirrors the antigroup.js wiring pattern)
 *
 * Placeholders supported in the welcome text:
 *   {user}    → @mention of the new member(s)
 *   {group}   → group name
 *   {count}   → member count after they joined
 *   {desc}    → group description (blank if none set)
 */

const DEFAULT_WELCOME_TEXT =
    '👋 Welcome {user} to the *OxBot Community*!\n\nType *.menu* to see all commands.\n\nYou are member #{count} in the group!';

function fillTemplate(template, { userMentions, groupName, count, desc }) {
    return template
        .replace(/\{user\}/g,  userMentions)
        .replace(/\{group\}/g, groupName || 'the group')
        .replace(/\{count\}/g, String(count ?? '?'))
        .replace(/\{desc\}/g,  desc || '');
}

// ═══════════════════════════════════════════════════
// .setwelcome COMMAND (Owner Only)
// ═══════════════════════════════════════════════════
async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const db        = botData?.db;
    const sessionId = botData?.sessionId;
    const sub       = (args[0] || '').trim().toLowerCase();

    try {
        // ── .setwelcome on / off ─────────────────────────────────────────────
        if (sub === 'on' || sub === 'off') {
            const enabled = sub === 'on' ? 1 : 0;

            if (db && sessionId) {
                try {
                    await db.query(
                        `INSERT INTO bot_settings (session_id, welcome_enabled) VALUES (?, ?)
                         ON DUPLICATE KEY UPDATE welcome_enabled = ?`,
                        [sessionId, enabled, enabled]
                    );
                } catch (err) {
                    console.error('[SETWELCOME] DB Error:', err.message);
                }
            }

            return await sock.sendMessage(chatId, {
                text: enabled
                    ? '✅ *Welcome messages turned ON.*\n\nNew members will now get greeted automatically.'
                    : '🔕 *Welcome messages turned OFF.*'
            }, { quoted: msg });
        }

        // ── .setwelcome reset ────────────────────────────────────────────────
        if (sub === 'reset') {
            if (db && sessionId) {
                try {
                    await db.query(
                        `INSERT INTO bot_settings (session_id, welcome_text) VALUES (?, NULL)
                         ON DUPLICATE KEY UPDATE welcome_text = NULL`,
                        [sessionId]
                    );
                } catch (err) {
                    console.error('[SETWELCOME] DB Error (reset):', err.message);
                }
            }

            return await sock.sendMessage(chatId, {
                text: `♻️ *Welcome Message Reset!*\n\nBack to the default:\n\n${DEFAULT_WELCOME_TEXT}`
            }, { quoted: msg });
        }

        // ── .setwelcome set <text> ───────────────────────────────────────────
        if (sub === 'set') {
            const newText = args.slice(1).join(' ').trim();

            if (!newText) {
                return await sock.sendMessage(chatId, {
                    text: `❌ *Missing text!*\n\nUsage: \`.setwelcome set <text>\`\n\n` +
                          `Placeholders: {user} {group} {count} {desc}\n` +
                          `Example: \`.setwelcome set Hey {user}, welcome to {group}! You're #{count} 🎉\``
                }, { quoted: msg });
            }

            if (newText.length > 700) {
                return await sock.sendMessage(chatId, {
                    text: '❌ *Too long!*\n\nKeep the welcome text under 700 characters.'
                }, { quoted: msg });
            }

            if (db && sessionId) {
                try {
                    await db.query(
                        `INSERT INTO bot_settings (session_id, welcome_text) VALUES (?, ?)
                         ON DUPLICATE KEY UPDATE welcome_text = ?`,
                        [sessionId, newText, newText]
                    );
                } catch (err) {
                    console.error('[SETWELCOME] DB Error (set):', err.message);
                }
            }

            return await sock.sendMessage(chatId, {
                text: `✅ *Welcome Message Updated!*\n\n*Preview:*\n${fillTemplate(newText, {
                    userMentions: '@2348031234567',
                    groupName:    'Sample Group',
                    count:        42,
                    desc:         'A sample group description',
                })}\n\n_Tip: run \`.setwelcome on\` if it's not enabled yet._`,
                mentions: ['2348031234567@s.whatsapp.net'],
            }, { quoted: msg });
        }

        // ── No/unknown sub-command: show current status + usage ─────────────
        let enabledRow = null;
        let textRow    = null;
        if (db && sessionId) {
            try {
                const [rows] = await db.query(
                    'SELECT welcome_enabled, welcome_text FROM bot_settings WHERE session_id=? ORDER BY id DESC LIMIT 1',
                    [sessionId]
                );
                if (rows.length) {
                    enabledRow = rows[0].welcome_enabled;
                    textRow    = rows[0].welcome_text;
                }
            } catch {}
        }

        const isOn      = enabledRow === 1 || enabledRow === '1';
        const currentTx = textRow || DEFAULT_WELCOME_TEXT;

        return await sock.sendMessage(chatId, {
            text: `👋 *Welcome Message Configuration*\n\n` +
                  `Status: ${isOn ? '✅ ON' : '🔕 OFF'}\n\n` +
                  `Current text:\n${currentTx}\n\n` +
                  `*Usage:*\n` +
                  `• \`.setwelcome on\` / \`.setwelcome off\`\n` +
                  `• \`.setwelcome set <text>\`\n` +
                  `• \`.setwelcome reset\`\n\n` +
                  `Placeholders: {user} {group} {count} {desc}`
        }, { quoted: msg });

    } catch (err) {
        console.error('[SETWELCOME] Error:', err.message);
        await sock.sendMessage(chatId, {
            text: `❌ Failed to update welcome settings: ${err.message}`
        }, { quoted: msg });
    }

    return null;
}

// ═══════════════════════════════════════════════════
// ★ ACTUALLY SENDS THE WELCOME — called from botManager.js
// on group-participants.update, same pattern as antigroup.js
// ═══════════════════════════════════════════════════
async function handleMemberJoin(sock, update, botData) {
    if (!update || update.action !== 'add') return;

    const groupJid = update.id;
    const newUsers = update.participants || [];
    if (!groupJid || !newUsers.length) return;

    const db        = botData?.db;
    const sessionId = botData?.sessionId;
    if (!db || !sessionId) return;

    let enabled = false;
    let template = DEFAULT_WELCOME_TEXT;

    try {
        const [rows] = await db.query(
            'SELECT welcome_enabled, welcome_text FROM bot_settings WHERE session_id=? ORDER BY id DESC LIMIT 1',
            [sessionId]
        );
        if (rows.length) {
            enabled  = rows[0].welcome_enabled === 1 || rows[0].welcome_enabled === '1';
            template = rows[0].welcome_text || DEFAULT_WELCOME_TEXT;
        }
    } catch (err) {
        console.error('[WELCOME] DB read failed:', err.message);
        return;
    }

    if (!enabled) return;

    let groupName = 'the group';
    let desc      = '';
    let count     = newUsers.length;

    try {
        const meta = await sock.groupMetadata(groupJid);
        groupName = meta?.subject || groupName;
        desc      = meta?.desc || '';
        count     = meta?.participants?.length ?? count;
    } catch (err) {
        console.error('[WELCOME] groupMetadata failed:', err.message);
    }

    const userMentions = newUsers.map(jid => `@${jid.split('@')[0]}`).join(' ');
    const text = fillTemplate(template, { userMentions, groupName, count, desc });

    try {
        await sock.sendMessage(groupJid, {
            text,
            mentions: newUsers,
        });
    } catch (err) {
        console.error('[WELCOME] Send failed:', err.message);
    }
}

module.exports = {
    name: 'setwelcome',
    aliases: ['welcome'],
    desc: 'Configure the welcome message for new group members',
    category: 'owner',
    execute,
    handleMemberJoin,
};
