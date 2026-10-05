/**
 * commands/developer.js
 * Sends bot developer's contact card (vCard)
 */

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    try {
        const devNum  = '2349133167169';
        const devName = 'Oxdominion.eth';

        // Format the vCard
        const vcard = `BEGIN:VCARD
VERSION:3.0
FN:${devName}
TEL;waid=${devNum}:${devNum}
END:VCARD`.trim();

        // Send the contact card
        await sock.sendMessage(chatId, {
            contacts: {
                displayName: devName,
                contacts: [{ vcard }]
            }
        }, { quoted: msg });

        // Send follow-up text
        await sock.sendMessage(chatId, {
            text: '🧑‍💻 Here is the contact of my *Developer*.'
        }, { quoted: msg });

    } catch (err) {
        console.error('[DEVELOPER] Error:', err.message);
        await sock.sendMessage(chatId, {
            text: '❌ *Failed to fetch developer contact.*'
        }, { quoted: msg });
    }

    return null;
}

module.exports = {
    name: 'developer',
    aliases: ['dev', 'botdev'],
    desc: 'Show bot developer contact information',
    category: 'general',
    execute
};