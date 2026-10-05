/**
 * commands/bass.js — Deep/Bass Voice Effect
 * Aliases: .bass, .deepvoice, .bassboost, .deep
 *
 * Reply to a voice note (or any audio message) with .bass to get it
 * back pitched down with boosted low end. Pure local ffmpeg.
 *
 * Media download uses downloadContentFromMessage from Baileys —
 * imported directly, not called as a sock method. Confirm this import
 * path matches your installed Baileys version/fork; if your bot uses
 * a custom wrapper around Baileys, swap this one function accordingly.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Adjust this import if your package/fork differs
// (e.g. '@adiwajshing/baileys', a local lib/ wrapper, etc.)
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

const PRESETS = {
    bass: 'asetrate=44100*0.82,aresample=44100,atempo=1.05,bass=g=12:f=110:w=0.6',
    deep: 'asetrate=44100*0.87,aresample=44100,atempo=1.02,bass=g=6:f=90',
};

async function downloadAudioMessage(audioMsg) {
    const stream = await downloadContentFromMessage(audioMsg, 'audio');
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

async function runFfmpeg(inputPath, outputPath, filterChain) {
    const args = ['-y', '-i', inputPath, '-af', filterChain, '-vn', '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', outputPath];
    await execFileAsync(FFMPEG_BIN, args, { timeout: 60000 });
}

function getQuotedAudioMessage(msg) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo
        || msg.message?.conversation?.contextInfo;
    const quoted = ctx?.quotedMessage;
    if (!quoted) return null;
    return quoted.audioMessage || quoted.pttMessage || null;
}

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    const quotedAudio = msg.message?.audioMessage || getQuotedAudioMessage(msg);

    if (!quotedAudio) {
        return `*🔊 BASS / DEEP VOICE*\n\nReply to a voice note with *.bass* (heavy bass) or *.deep* (subtle pitch drop).\n\n*Aliases:* .deepvoice  .bassboost`;
    }

    const requestedName = (args?.[0] || '').toLowerCase();
    const preset = PRESETS[requestedName] ? requestedName : 'bass';
    const filterChain = PRESETS[preset];

    try { await sock.sendMessage(chatId, { react: { text: '🎚️', key: msg.key } }); } catch {}

    const tmpDir = os.tmpdir();
    const inPath = path.join(tmpDir, `voicein_${Date.now()}.ogg`);
    const outPath = path.join(tmpDir, `voiceout_${Date.now()}.mp3`);

    try {
        const buffer = await downloadAudioMessage(quotedAudio);
        fs.writeFileSync(inPath, buffer);

        await runFfmpeg(inPath, outPath, filterChain);

        const outBuf = fs.readFileSync(outPath);
        await sock.sendMessage(chatId, {
            audio: outBuf,
            mimetype: 'audio/mpeg',
            ptt: true,
        }, { quoted: msg });

        try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }); } catch {}
        return null;
    } catch (err) {
        console.log(`[bass] Error — ${err.message}`);
        try { await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } }); } catch {}
        return `❌ *Failed to process audio*\n\n_${err.message}_`;
    } finally {
        try { fs.unlinkSync(inPath); } catch {}
        try { fs.unlinkSync(outPath); } catch {}
    }
}

module.exports = {
    name: 'bass',
    aliases: ['deepvoice', 'bassboost', 'deep'],
    desc: 'Apply a bass-boosted or deep-voice effect to a quoted voice note',
    category: 'audio',
    execute,
};
