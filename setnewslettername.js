/**
 * commands/setnewslettername.js
 * Edit ONLY the newsletter display name shown in the menu (Owner Only)
 *
 * Standalone from .setnewsletter — this never touches the JID, it just
 * lets the owner fix/rename the channel label (e.g. when it defaulted
 * to "My Channel" because auto-fetch failed).
 */

const DEFAULT_NEWSLETTER_JID = '120363421280626994@newsletter';

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const db        = botData?.db;
    const sessionId = botData?.sessionId;

    try {
        const newName = args.join(' ').trim();

        // ── No name given: show current name + usage ────────────────────────
        if (!newName) {
            const currentName = sock._newsletterName || 'My Channel';
            const currentJid  = sock._newsletterJid  || DEFAULT_NEWSLETTER_JID;

            return await sock.sendMessage(chatId, {
                text: `🏷️ *Channel Name Editor*\n\n` +
                      `Current Name: ${currentName}\n` +
                      `Linked JID: \`${currentJid}\`\n\n` +
                      `*Usage:*\n` +
                      `• \`.setnewslettername My Cool Channel\``
            }, { quoted: msg });
        }

        // ── Validate length ───────────────────────────────────────────────
        if (newName.length > 60) {
            return await sock.sendMessage(chatId, {
                text: '❌ *Name too long!*\n\nKeep it under 60 characters.'
            }, { quoted: msg });
        }

        // Keep whatever JID is already set (or the default) — this command
        // never changes the JID, only the label.
        const currentJid = sock._newsletterJid || DEFAULT_NEWSLETTER_JID;

        // ── Save to Database ───────────────────────────────────────────────
        if (db && sessionId) {
            try {
                await db.query(
                    `INSERT INTO bot_settings (session_id, newsletter_jid, newsletter_name) VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE newsletter_name = ?`,
                    [sessionId, currentJid, newName, newName]
                );
            } catch (err) {
                console.error('[SETNEWSLETTERNAME] DB Error:', err.message);
            }
        }

        // ── Cache on socket for instant use ─────────────────────────────────
        sock._newsletterJid  = currentJid;
        sock._newsletterName = newName;

        await sock.sendMessage(chatId, {
            text: `✅ *Channel Name Updated!*\n\n` +
                  `🏷️ Name: ${newName}\n` +
                  `📰 JID: \`${currentJid}\`\n\n` +
                  `Run .menu to see it in action.`
        }, { quoted: msg });

    } catch (err) {
        console.error('[SETNEWSLETTERNAME] Error:', err.message);
        await sock.sendMessage(chatId, {
            text: `❌ Failed to update channel name: ${err.message}`
        }, { quoted: msg });
    }

    return null;
}

module.exports = {
    name: 'setnewslettername',
    aliases: ['editnewsletter', 'channelname', 'setnlname'],
    desc: 'Edit only the channel display name (keeps the JID unchanged)',
    category: 'owner',
    execute
};