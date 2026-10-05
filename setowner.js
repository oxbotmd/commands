/**
 * commands/setowner.js
 * Set a custom "Owner" name shown in the menu (Owner Only)
 *
 * help.js currently hardcodes:
 *   const owner = 'oxdominion.eth';
 * which means every single customer's bot shows YOUR name as the owner
 * on their menu. This lets each bot owner set their own name/handle
 * instead — stored in bot_settings, survives restarts, resettable back
 * to the default (oxdominion.eth) at any time.
 */

const DEFAULT_OWNER_NAME = 'oxdominion.eth';

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const db        = botData?.db;
    const sessionId = botData?.sessionId;

    try {
        const input = args.join(' ').trim();

        // ── Reset back to the default owner name ────────────────────────────
        if (input && ['reset', 'default'].includes(input.toLowerCase())) {
            if (db && sessionId) {
                try {
                    await db.query(
                        `INSERT INTO bot_settings (session_id, owner_name) VALUES (?, NULL)
                         ON DUPLICATE KEY UPDATE owner_name = NULL`,
                        [sessionId]
                    );
                } catch (err) {
                    console.error('[SETOWNER] DB Error (reset):', err.message);
                }
            }

            sock._ownerName = null;

            return await sock.sendMessage(chatId, {
                text: `♻️ *Owner Name Reset!*\n\n` +
                      `📛 Now showing: ${DEFAULT_OWNER_NAME}\n\n` +
                      `The menu is back to the default owner name.`
            }, { quoted: msg });
        }

        // ── No name given: show current status and usage ────────────────────
        if (!input) {
            const current = sock._ownerName || DEFAULT_OWNER_NAME;

            return await sock.sendMessage(chatId, {
                text: `📛 *Menu Owner Configuration*\n\n` +
                      `Current: ${current}\n\n` +
                      `*Usage:*\n` +
                      `• Set a name: \`.setowner John Doe\`\n` +
                      `• Reset to default: \`.setowner reset\``
            }, { quoted: msg });
        }

        // ── Validate length ───────────────────────────────────────────────
        if (input.length > 40) {
            return await sock.sendMessage(chatId, {
                text: '❌ *Name too long!*\n\nKeep it under 40 characters.'
            }, { quoted: msg });
        }

        // ── Save to Database ───────────────────────────────────────────────
        if (db && sessionId) {
            try {
                await db.query(
                    `INSERT INTO bot_settings (session_id, owner_name) VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE owner_name = ?`,
                    [sessionId, input, input]
                );
            } catch (err) {
                console.error('[SETOWNER] DB Error:', err.message);
            }
        }

        // ── Cache on socket for instant use (no DB reads needed) ───────────
        sock._ownerName = input;

        await sock.sendMessage(chatId, {
            text: `✅ *Menu Owner Updated!*\n\n` +
                  `📛 Now showing: ${input}\n\n` +
                  `Run .menu to see it in action.`
        }, { quoted: msg });

    } catch (err) {
        console.error('[SETOWNER] Error:', err.message);
        await sock.sendMessage(chatId, {
            text: `❌ Failed to set owner name: ${err.message}`
        }, { quoted: msg });
    }

    return null;
}

module.exports = {
    name: 'setowner',
    aliases: ['ownername'],
    desc: 'Set a custom owner name shown in the menu',
    category: 'owner',
    execute
};