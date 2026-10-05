/**
 * commands/setnewsletter.js
 * Set or change the newsletter JID for menu forwarding (Owner Only)
 *
 * Now also stores the newsletter's real name (auto-fetched from WhatsApp
 * when possible, or given manually as a second argument) so help.js can
 * show the *actual* channel in the menu's forward header instead of
 * always hardcoding "OxBot".
 */

const DEFAULT_NEWSLETTER_JID  = '120363421280626994@newsletter';
const DEFAULT_NEWSLETTER_NAME = 'OxBot';

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    let newsletterJid = '';

    try {
        // ── Reset back to the original OxBot channel ────────────────────────
        if (args[0] && ['reset', 'default'].includes(args[0].trim().toLowerCase())) {
            const db        = botData?.db;
            const sessionId = botData?.sessionId;

            if (db && sessionId) {
                try {
                    await db.query(
                        `INSERT INTO bot_settings (session_id, newsletter_jid, newsletter_name) VALUES (?, ?, ?)
                         ON DUPLICATE KEY UPDATE newsletter_jid = ?, newsletter_name = ?`,
                        [sessionId, DEFAULT_NEWSLETTER_JID, DEFAULT_NEWSLETTER_NAME, DEFAULT_NEWSLETTER_JID, DEFAULT_NEWSLETTER_NAME]
                    );
                } catch (err) {
                    console.error('[SETNEWSLETTER] DB Error (reset):', err.message);
                }
            }

            sock._newsletterJid  = DEFAULT_NEWSLETTER_JID;
            sock._newsletterName = DEFAULT_NEWSLETTER_NAME;

            return await sock.sendMessage(chatId, {
                text: `♻️ *Newsletter Reset!*\n\n` +
                      `📰 JID: \`${DEFAULT_NEWSLETTER_JID}\`\n` +
                      `🏷️ Name: ${DEFAULT_NEWSLETTER_NAME}\n\n` +
                      `The menu is back to the original OxBot channel.`
            }, { quoted: msg });
        }

        // Priority 1: If command is typed directly inside a newsletter chat
        if (chatId.endsWith('@newsletter')) {
            newsletterJid = chatId;
        }
        // Priority 2: Replying to a forwarded newsletter message
        else if (msg.message?.extendedTextMessage?.contextInfo) {
            const contextInfo = msg.message.extendedTextMessage.contextInfo;

            // Deep search the message context for any @newsletter string
            const findNewsletterJid = (obj, depth = 0) => {
                if (depth > 5 || !obj || typeof obj !== 'object') return null;
                for (const key in obj) {
                    const value = obj[key];
                    if (typeof value === 'string' && value.endsWith('@newsletter')) return value;
                    if (typeof value === 'object' && value !== null) {
                        const found = findNewsletterJid(value, depth + 1);
                        if (found) return found;
                    }
                }
                return null;
            };

            newsletterJid = findNewsletterJid(contextInfo);
        }

        // Priority 3: Provided manually as an argument
        if (!newsletterJid && args[0]) {
            newsletterJid = args[0].trim();
        }

        // If no JID found, show current status and usage
        if (!newsletterJid) {
            const currentJid  = sock._newsletterJid  || DEFAULT_NEWSLETTER_JID;
            const currentName = sock._newsletterName || DEFAULT_NEWSLETTER_NAME;
            return await sock.sendMessage(chatId, {
                text: `📰 *Newsletter Configuration*\n\n` +
                      `Current JID: \`${currentJid}\`\n` +
                      `Current Name: ${currentName}\n\n` +
                      `*Usage:*\n` +
                      `• Reply to a newsletter msg: \`.setnewsletter\`\n` +
                      `• Type inside newsletter: \`.setnewsletter\`\n` +
                      `• Manual JID: \`.setnewsletter 123@newsletter\`\n` +
                      `• Manual JID + name: \`.setnewsletter 123@newsletter My Channel Name\`\n` +
                      `• Reset to original: \`.setnewsletter reset\``
            }, { quoted: msg });
        }

        // Validate format
        if (!newsletterJid.endsWith('@newsletter')) {
            return await sock.sendMessage(chatId, {
                text: '❌ *Invalid JID format!*\n\nNewsletter JID must end with `@newsletter`\nExample: `120363161513685998@newsletter`'
            }, { quoted: msg });
        }

        // ── Figure out the display name ─────────────────────────────────────
        // Priority: manual name typed after the JID > auto-fetched metadata
        // from WhatsApp > fallback to "My Channel"
        let newsletterName = '';

        const manualNameArgs = args.slice(1).join(' ').trim();
        if (manualNameArgs) {
            newsletterName = manualNameArgs;
        }

        if (!newsletterName) {
            try {
                if (typeof sock.newsletterMetadata === 'function') {
                    const meta = await sock.newsletterMetadata('jid', newsletterJid);
                    newsletterName = meta?.name || meta?.thread?.name || '';
                }
            } catch (metaErr) {
                console.error('[SETNEWSLETTER] Metadata fetch failed:', metaErr.message);
            }
        }

        if (!newsletterName) newsletterName = 'My Channel';

        // ── Save to Database ───────────────────────────────────────────────
        const db = botData?.db;
        const sessionId = botData?.sessionId;

        if (db && sessionId) {
            try {
                await db.query(
                    `INSERT INTO bot_settings (session_id, newsletter_jid, newsletter_name) VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE newsletter_jid = ?, newsletter_name = ?`,
                    [sessionId, newsletterJid, newsletterName, newsletterJid, newsletterName]
                );
            } catch (err) {
                console.error('[SETNEWSLETTER] DB Error:', err.message);
            }
        }

        // ── Cache on socket for instant use (no DB reads needed) ───────────
        sock._newsletterJid  = newsletterJid;
        sock._newsletterName = newsletterName;

        await sock.sendMessage(chatId, {
            text: `✅ *Newsletter Updated Successfully!*\n\n` +
                  `📰 JID: \`${newsletterJid}\`\n` +
                  `🏷️ Name: ${newsletterName}\n\n` +
                  `The menu will now forward from this newsletter.`
        }, { quoted: msg });

    } catch (err) {
        console.error('[SETNEWSLETTER] Error:', err.message);
        await sock.sendMessage(chatId, {
            text: `❌ Failed to set newsletter: ${err.message}`
        }, { quoted: msg });
    }

    return null;
}

module.exports = {
    name: 'setnewsletter',
    aliases: ['setnl', 'setchannel'],
    desc: 'Set the newsletter JID (and name) for menu forwarding',
    category: 'owner',
    execute
};
