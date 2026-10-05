const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { exec } = require('child_process');

const COMMANDS_DIR = __dirname;

const GITHUB_ZIP =
    'https://github.com/oxbotmd/commands/archive/refs/heads/main.zip';

function downloadFile(url, destination) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                'User-Agent': 'OxBot'
            }
        }, (response) => {

            if (
                response.statusCode >= 300 &&
                response.statusCode < 400 &&
                response.headers.location
            ) {
                response.resume();

                return downloadFile(
                    response.headers.location,
                    destination
                ).then(resolve).catch(reject);
            }

            if (response.statusCode !== 200) {
                response.resume();

                return reject(
                    new Error(
                        'GitHub returned HTTP ' + response.statusCode
                    )
                );
            }

            const file = fs.createWriteStream(destination);

            response.pipe(file);

            file.on('finish', () => {
                file.close(resolve);
            });

            file.on('error', reject);

        }).on('error', reject);
    });
}

function runCommand(command) {
    return new Promise((resolve, reject) => {
        exec(command, {
            maxBuffer: 10 * 1024 * 1024
        }, (error, stdout, stderr) => {

            if (error) {
                return reject(error);
            }

            resolve({
                stdout,
                stderr
            });
        });
    });
}

async function updateCommands() {

    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'oxbot-update-')
    );

    const zipFile = path.join(
        tempDir,
        'commands.zip'
    );

    const extractDir = path.join(
        tempDir,
        'extract'
    );

    try {

        await downloadFile(
            GITHUB_ZIP,
            zipFile
        );

        fs.mkdirSync(
            extractDir,
            { recursive: true }
        );

        await runCommand(
            'unzip -q "' +
            zipFile +
            '" -d "' +
            extractDir +
            '"'
        );

        const folders = fs.readdirSync(extractDir);

        const githubFolder = folders.find(
            name => name.startsWith('commands-')
        );

        if (!githubFolder) {
            throw new Error(
                'GitHub commands folder was not found'
            );
        }

        const sourceDir = path.join(
            extractDir,
            githubFolder
        );

        const files = fs.readdirSync(sourceDir);

        for (const file of files) {

            if (file === '.git') {
                continue;
            }

            const source = path.join(
                sourceDir,
                file
            );

            const destination = path.join(
                COMMANDS_DIR,
                file
            );

            fs.rmSync(
                destination,
                {
                    recursive: true,
                    force: true
                }
            );

            fs.cpSync(
                source,
                destination,
                {
                    recursive: true
                }
            );
        }

    } finally {

        fs.rmSync(
            tempDir,
            {
                recursive: true,
                force: true
            }
        );
    }
}

async function execute(sock, msg, botData, args) {

    const chatId = msg.key.remoteJid;

    if (!chatId) {
        return null;
    }

    try {

        await sock.sendMessage(
            chatId,
            {
                text: '📥 *Updating...*'
            },
            { quoted: msg }
        );

        await updateCommands();

        await sock.sendMessage(
            chatId,
            {
                text: '✅ *Update complete!*'
            },
            { quoted: msg }
        );

    } catch (error) {

        console.error(
            '[update] Update failed:',
            error
        );

        try {
            await sock.sendMessage(
                chatId,
                {
                    text: '❌ *Update failed!*'
                },
                { quoted: msg }
            );
        } catch {}

    }

    return null;
}

module.exports = {
    name: 'update',
    aliases: ['pull', 'sync'],
    desc: 'Update commands from GitHub',
    category: 'owner',
    execute
};
