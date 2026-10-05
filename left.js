/**
 * commands/left.js
 * User self-exits the group by typing .left
 * (Bot must be a group admin to remove participants — same requirement as .promote)
 */

const name     = 'left';
const aliases  = ['leave', 'exit'];
const desc     = 'Remove yourself from the group';
const category = 'group';

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!chatId.endsWith('@g.us')) {
        return await sock.sendMessage(chatId, { text: '❌ Group only command!' }, { quoted: msg });
    }

    const senderId = msg.key.participant || msg.key.remoteJid;

    // Don't let the group owner accidentally strand themselves via a typo/troll — still allow it,
    // but let them know first since this can't be undone by the bot itself.
    try {
        await sock.sendMessage(chatId, {
            text: `👋 @${senderId.split('@')[0]} is leaving the group...`,
            mentions: [senderId]
        }, { quoted: msg });

        await sock.groupParticipantsUpdate(chatId, [senderId], 'remove');
        // No further message needed — sender is no longer in the group to read it.

    } catch (err) {
        if (err?.message?.includes('not-admin') || err?.output?.statusCode === 400) {
            await sock.sendMessage(chatId, {
                text: '❌ *Action failed:* I need to be an admin to remove members.\n\n_⚠️ If you just made me admin, please REMOVE me from the group and ADD me back in to fix this bug._'
            }, { quoted: msg });
        } else {
            await sock.sendMessage(chatId, { text: `❌ Failed to leave: ${err.message}` }, { quoted: msg });
        }
    }
}

module.exports = { name, aliases, desc, category, execute };