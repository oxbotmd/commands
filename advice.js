const fetch = require('node-fetch');

/**
 * .advice — Random life advice
 * Usage: .advice
 */
async function adviceCommand(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;

    try {
        const res = await fetch('https://api.adviceslip.com/advice');

        if (!res.ok) {
            throw await res.text();
        }

        const json = await res.json();
        const advice = json?.slip?.advice;

        if (!advice) {
            return '❌ No advice received. Try again.';
        }

        await sock.sendMessage(
            chatId,
            {
                text: `🧠 *ADVICE*\n\n"${advice}"\n\n💡 _Take it or leave it, but at least think about it._`,
            },
            { quoted: msg }
        );

    } catch (error) {
        console.error('[ADVICE ERROR]', error.message);
        await sock.sendMessage(
            chatId,
            { text: '❌ Failed to get advice. Try again later.' },
            { quoted: msg }
        );
    }
}

module.exports = {
    name: 'advice',
    desc: 'Get random life advice',
    category: 'fun',
    usage: '.advice',
    execute: adviceCommand,
};