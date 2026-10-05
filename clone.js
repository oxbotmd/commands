/**
 * OxBot — Clone Command (Owner Only)
 * Downloads a GitHub repo as a zip and sends it as a document
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50MB cap — see note below

// ── Strip device/LID suffix so JIDs always compare cleanly ──
function cleanNumber(jid) {
    if (!jid) return '';
    return jid.split(':')[0].split('@')[0];
}

// ── Fetch owner phone from users table for this session ──
async function getOwnerNumber(db, sessionId) {
    try {
        const [rows] = await db.query(
            'SELECT u.phone FROM users u JOIN bots b ON b.user_id = u.id WHERE b.session_id = ? LIMIT 1',
            [sessionId]
        );
        if (!rows.length || !rows[0].phone) return null;
        return String(rows[0].phone).replace(/\D/g, '');
    } catch (err) {
        console.error('[clone] DB error fetching owner:', err.message);
        return null;
    }
}

// ── Check if sender is the owner for this session ──
async function isOwner(db, sessionId, senderId, sock, chatId) {
    const ownerNumber = await getOwnerNumber(db, sessionId);
    if (!ownerNumber) return false;

    const ownerJid    = ownerNumber + '@s.whatsapp.net';
    const senderClean = cleanNumber(senderId);

    if (senderId === ownerJid)          return true;
    if (senderClean === ownerNumber)    return true;
    if (senderId.includes(ownerNumber)) return true;

    if (sock && chatId && chatId.endsWith('@g.us') && senderId.includes('@lid')) {
        try {
            const metadata     = await sock.groupMetadata(chatId);
            const participants = metadata.participants || [];

            const match = participants.find(p => {
                const pIdClean = cleanNumber(p.id || '');
                return pIdClean === ownerNumber || (p.id || '') === ownerJid;
            });

            if (match) return true;
        } catch (e) {
            console.error('[clone] Group LID check error:', e.message);
        }
    }

    return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ GITHUB HELPERS ★
// ═══════════════════════════════════════════════════════════════════════════════

function parseGithubUrl(input) {
    const cleaned = input.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/, '');
    const parts = cleaned.split('/').filter(Boolean);
    if (parts.length < 2) return null;

    const owner = parts[0];
    const repo  = parts[1];
    let branch  = null;

    const treeIdx = parts.indexOf('tree');
    if (treeIdx !== -1 && parts[treeIdx + 1]) branch = parts[treeIdx + 1];

    return { owner, repo, branch };
}

function resolveDefaultBranch(owner, repo) {
    return new Promise((resolve) => {
        https.get({
            hostname: 'api.github.com',
            path: `/repos/${owner}/${repo}`,
            headers: { 'User-Agent': 'OxBot' },
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data).default_branch || 'main');
                } catch {
                    resolve('main');
                }
            });
        }).on('error', () => resolve('main'));
    });
}

function downloadZipball(owner, repo, branch, destPath) {
    return new Promise((resolve, reject) => {
        const url = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`;
        const file = fs.createWriteStream(destPath);
        let received = 0;
        let rejected = false;

        https.get(url, { headers: { 'User-Agent': 'OxBot' } }, (res) => {
            if (res.statusCode === 404) {
                rejected = true;
                file.close();
                fs.unlink(destPath, () => {});
                return reject(new Error('Repo or branch not found (check spelling/visibility).'));
            }
            if (res.statusCode !== 200) {
                rejected = true;
                file.close();
                fs.unlink(destPath, () => {});
                return reject(new Error(`GitHub returned status ${res.statusCode}`));
            }

            res.on('data', (chunk) => {
                received += chunk.length;
                if (received > MAX_SIZE_BYTES) {
                    rejected = true;
                    res.destroy();
                    file.close();
                    fs.unlink(destPath, () => {});
                    reject(new Error(`Repo exceeds ${(MAX_SIZE_BYTES / 1024 / 1024).toFixed(0)}MB limit.`));
                }
            });

            res.pipe(file);
            file.on('finish', () => {
                if (!rejected) {
                    file.close();
                    resolve();
                }
            });
        }).on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ MAIN COMMAND ★
// ═══════════════════════════════════════════════════════════════════════════════

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    if (!botData?.sessionId || !botData?.db) {
        await sock.sendMessage(chatId, {
            text: '⚠️ Database error. Please restart the bot.'
        }, { quoted: msg });
        return null;
    }

    // ── Owner check ──
    const senderId = msg.key.participant || msg.key.remoteJid;
    const senderIsOwner = await isOwner(
        botData.db, botData.sessionId, senderId, sock, chatId
    );

    if (!msg.key.fromMe && !senderIsOwner) {
        await sock.sendMessage(chatId, {
            text: '❌ This command is only available for the owner!'
        }, { quoted: msg });
        return null;
    }

    const input = args.join(' ').trim();
    if (!input) {
        return await sock.sendMessage(chatId, {
            text: '📦 Usage: `.clone owner/repo` or a full GitHub URL'
        }, { quoted: msg });
    }

    const parsed = parseGithubUrl(input);
    if (!parsed) {
        return await sock.sendMessage(chatId, {
            text: '❌ Could not parse that as a GitHub repo. Use `owner/repo` or a full URL.'
        }, { quoted: msg });
    }

    const { owner, repo } = parsed;
    let branch = parsed.branch;

    await sock.sendMessage(chatId, { text: `🔍 Looking up *${owner}/${repo}*...` }, { quoted: msg });

    let tmpFile;
    try {
        if (!branch) branch = await resolveDefaultBranch(owner, repo);

        tmpFile = path.join(os.tmpdir(), `${repo}-${Date.now()}.zip`);
        await sock.sendMessage(chatId, { text: `⬇️ Downloading *${owner}/${repo}* (${branch})...` });

        await downloadZipball(owner, repo, branch, tmpFile);

        const stats = fs.statSync(tmpFile);
        await sock.sendMessage(chatId, {
            document: fs.readFileSync(tmpFile),
            fileName: `${repo}-${branch}.zip`,
            mimetype: 'application/zip',
            caption: `📦 *${owner}/${repo}* (${branch})\nSize: ${(stats.size / 1024 / 1024).toFixed(2)}MB`,
        });
    } catch (err) {
        await sock.sendMessage(chatId, { text: `❌ Clone failed: ${err.message}` }, { quoted: msg });
    } finally {
        if (tmpFile) fs.unlink(tmpFile, () => {});
    }

    return null;
}

module.exports = {
    name: 'clone',
    execute: execute,
    desc: 'Download a GitHub repo and send as a zip (Owner)',
    category: 'owner',
    aliases: ['ghclone', 'getrepo']
};