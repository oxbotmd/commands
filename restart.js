const { exec } = require('child_process');

async function execute(sock, msg, botData, args) {

    const chatId = msg.key.remoteJid;

    if (!chatId) {
        return null;
    }

    try {

        await sock.sendMessage(
            chatId,
            {
                text: '🔄 *Restarting...*'
            },
            { quoted: msg }
        );

        setTimeout(() => {

            exec('pm2 restart oxbot', (error) => {

                if (error) {
                    console.error(
                        '[restart] PM2 restart failed:',
                        error.message
                    );
                    return;
                }

                console.log(
                    '[restart] OxBot restarted successfully.'
                );

            });

        }, 1000);

    } catch (error) {

        console.error(
            '[restart] Error:',
            error
        );

    }

    return null;
}

module.exports = {
    name: 'restart',
    aliases: ['reboot', 'reload'],
    desc: 'Restart OxBot',
    category: 'owner',
    execute
};
