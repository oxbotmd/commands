/**
 * commands/setprofilename.js
 * Change the bot's own WhatsApp profile name
 */

const name     = 'setprofilename';
const desc     = 'Change the bot\'s WhatsApp profile name';
const category = 'owner';
const aliases  = ['setpname', 'profilename'];

function cleanNum(jid) {
    if (!jid) return '';
    return jid.replace(/[^0-9]/g, '');
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const senderId = msg.key.participant || chatId;
    const newName  = args.join(' ').trim();

    if (!newName) {
        return await sock.sendMessage(chatId, { text: '❌ Usage: .setprofilename <name>' }, { quoted: msg });
    }

    if (newName.length > 25) {
        return await sock.sendMessage(chatId, { text: '❌ Profile name must be 25 characters or fewer.' }, { quoted: msg });
    }

    // Owner-only — this changes the bot's account identity, not a per-group setting
    let senderIsOwner = msg.key.fromMe;
    if (!senderIsOwner) {
        const ownerPhone = sock._ownerPhone;
        const senderNum  = cleanNum(senderId);
        const ownerNum   = ownerPhone ? cleanNum(ownerPhone) : '';

        if (senderNum && ownerNum) {
            const sN = senderNum.startsWith('0') ? senderNum.slice(1) : senderNum;
            const oN = ownerNum.startsWith('0') ? ownerNum.slice(1) : ownerNum;
            senderIsOwner = sN === oN || sN.endsWith(oN) || oN.endsWith(sN);
        }
    }

    if (!senderIsOwner) {
        return await sock.sendMessage(chatId, { text: '❌ Only the bot owner can change the profile name.' }, { quoted: msg });
    }

    try {
        await sock.updateProfileName(newName);
        await sock.sendMessage(chatId, { text: `✅ Profile name changed to *${newName}*` }, { quoted: msg });
    } catch (err) {
        await sock.sendMessage(chatId, { text: `❌ Failed to change profile name: ${err.message}` }, { quoted: msg });
    }

    return null;
}

module.exports = { name, desc, category, aliases, execute };