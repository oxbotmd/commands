/**
 * getnewsletter.js — Get WhatsApp Channel (Newsletter) JID from an invite link
 * Aliases: .getnewsletter, .getchannel, .channeljid
 *
 * Bots generally can't post/run commands inside a WhatsApp Channel itself,
 * so this no longer requires being run there. Instead: paste the channel's
 * invite link (or just the invite code) in any DM or group, and the bot
 * resolves it to the real JID via Baileys' newsletterMetadata() call.
 *
 * Usage:
 *   .getchannel https://whatsapp.com/channel/0029VaXXXXXXXXXXXXXXXX
 *   .getchannel 0029VaXXXXXXXXXXXXXXXX          (raw invite code also works)
 */

const name     = 'getnewsletter';
const aliases  = ['getchannel', 'channeljid'];
const desc     = 'Get the JID of a WhatsApp Channel from its invite link';
const category = 'tools';

function extractInviteCode(input) {
    if (!input) return null;

    // Full link: https://whatsapp.com/channel/<code>  (with or without trailing params)
    const linkMatch = input.match(/whatsapp\.com\/channel\/([A-Za-z0-9]+)/i);
    if (linkMatch) return linkMatch[1];

    // Raw code pasted directly (WA invite codes are alphanumeric, no spaces)
    const raw = input.trim();
    if (/^[A-Za-z0-9]{8,}$/.test(raw)) return raw;

    return null;
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const input = args.join(' ').trim();

    if (!input) {
        return await sock.sendMessage(chatId, {
            text: `📢 *Get Channel JID*\n\n` +
                  `Paste a WhatsApp Channel invite link (or its code) and I'll resolve it to the real JID — works from any DM or group, no need to be inside the channel.\n\n` +
                  `*Usage:*\n` +
                  `\`.getchannel https://whatsapp.com/channel/0029VaXXXXXXXXXXXXXXXX\`\n\n` +
                  `_Or just the code:_\n` +
                  `\`.getchannel 0029VaXXXXXXXXXXXXXXXX\``
        }, { quoted: msg });
    }

    const inviteCode = extractInviteCode(input);

    if (!inviteCode) {
        return await sock.sendMessage(chatId, {
            text: `❌ *Couldn't parse that as a channel link/code.*\n\n` +
                  `Make sure it looks like:\n\`https://whatsapp.com/channel/0029VaXXXXXXXXXXXXXXXX\`\n\n` +
                  `Or paste just the code after \`/channel/\`.`
        }, { quoted: msg });
    }

    if (typeof sock.newsletterMetadata !== 'function') {
        return await sock.sendMessage(chatId, {
            text: `❌ This Baileys version doesn't support \`newsletterMetadata()\`.\n\n_Update @whiskeysockets/baileys to a version with Channel support._`
        }, { quoted: msg });
    }

    try {
        const meta = await sock.newsletterMetadata('invite', inviteCode);

        if (!meta || !meta.id) {
            throw new Error('No metadata returned — link may be invalid or expired.');
        }

        const name        = meta.name || meta.subject || 'Unknown Channel';
        const subscribers = meta.subscribers ?? meta.subscriber_count ?? 'Unknown';
        const description  = meta.description || '';

        let text = `✅ *Channel Found!*\n\n`;
        text += `📛 *Name:* ${name}\n`;
        text += `👥 *Subscribers:* ${subscribers}\n`;
        text += `🆔 *JID:*\n> \`${meta.id}\`\n`;
        if (description) text += `\n📝 *Description:*\n${description.substring(0, 200)}\n`;
        text += `\n_Copy the JID above and use it in \`.setnewsletter\`._`;

        return await sock.sendMessage(chatId, { text }, { quoted: msg });

    } catch (err) {
        console.error('[getnewsletter] Lookup error:', err.message);
        return await sock.sendMessage(chatId, {
            text: `❌ *Failed to resolve channel:*\n${err.message}\n\n` +
                  `*Possible reasons:*\n` +
                  `• The link/code is invalid or expired\n` +
                  `• The channel was deleted\n` +
                  `• Try copying the link fresh from the channel's "Invite via link" option`
        }, { quoted: msg });
    }
}

module.exports = {
    name,
    aliases,
    desc,
    category,
    execute,
};
