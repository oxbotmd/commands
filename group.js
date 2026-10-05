/**
 * commands/group.js
 * Preview a WhatsApp group from its invite link WITHOUT joining.
 * Shows: name, member count, description, creation date.
 * Does NOT show message history/content — that requires being a
 * member, and even then only from the moment the bot joined onward.
 */

const name     = 'group';
const desc     = 'Preview a group from its invite link (name, members, description)';
const category = 'general';
const aliases  = ['groupcheck', 'gcinfo'];

function extractInviteCode(link) {
    if (!link) return null;
    const match = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
    return match ? match[1] : null;
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const link = args[0];
    if (!link || !link.includes('chat.whatsapp.com')) {
        return await sock.sendMessage(chatId, {
            text: '📖 Usage: .group <invite link>\nExample: .group https://chat.whatsapp.com/XXXXXXXXXX'
        }, { quoted: msg });
    }

    const inviteCode = extractInviteCode(link);
    if (!inviteCode) {
        return await sock.sendMessage(chatId, { text: '❌ Invalid invite link.' }, { quoted: msg });
    }

    try { await sock.sendPresenceUpdate('composing', chatId); } catch {}

    try {
        const info = await sock.groupGetInviteInfo(inviteCode);

        const createdDate = info.creation
            ? new Date(info.creation * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
            : 'Unknown';

        let text = `👥 *Group Preview*\n\n`;
        text += `📛 Name: ${info.subject || 'Unknown'}\n`;
        text += `👤 Members: ${info.size ?? 'Unknown'}\n`;
        text += `📅 Created: ${createdDate}\n`;
        if (info.desc) {
            text += `📝 Description:\n${info.desc}\n`;
        }
        text += `\n_Note: this is a preview only — the bot has NOT joined and cannot show chat history or messages from this group._`;

        return await sock.sendMessage(chatId, { text }, { quoted: msg });

    } catch (err) {
        console.error('[GROUP] Error:', err.message);
        let friendly = 'Failed to fetch group info.';
        if (err.message?.includes('not-authorized') || err.message?.includes('410')) {
            friendly = 'This invite link is invalid, expired, or the group is closed to previews.';
        }
        return await sock.sendMessage(chatId, { text: `❌ ${friendly}` }, { quoted: msg });
    }
}

module.exports = { name, desc, category, aliases, execute };