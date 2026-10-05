/**
 * commands/savecontact.js
 * Generate a VCF file to save a number to YOUR phone
 */

const name     = 'savecontact';
const aliases  = ['save', 'savec', 'vcf'];
const desc     = 'Generate contact file to save number to your phone';
const category = 'utility';

async function execute(sock, msg, botData, args) {
    const chatId = msg.key.remoteJid;
    if (!chatId) return null;

    // 1. Check if a name was provided
    if (!args || args.length === 0) {
        return await sock.sendMessage(chatId, { 
            text: '❌ Provide a name.\n\n*Usage: .savecontact John*' 
        }, { quoted: msg });
    }

    const contactName = args.join(' ').trim();
    let phoneNumber = null;

    // 2. Figure out the phone number perfectly
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;

    // Check A: Did you reply to their message? (Grab their number from the reply)
    if (contextInfo && contextInfo.participant) {
        phoneNumber = contextInfo.participant.split('@')[0];
    } 
    // Check B: Are you just in a normal DM chat with them? (Grab from chat ID)
    else if (chatId.endsWith('@s.whatsapp.net')) {
        phoneNumber = chatId.split('@')[0];
    } 
    // Check C: Are you in a group? (Block this, because we don't know who you want to save)
    else if (chatId.endsWith('@g.us')) {
        return await sock.sendMessage(chatId, { 
            text: '❌ In groups, you must *reply to the person\'s message* and type:\n*.savecontact Name*' 
        }, { quoted: msg });
    }

    // If it STILL can't find the number, throw this error
    if (!phoneNumber) {
        return await sock.sendMessage(chatId, { 
            text: '❌ Could not detect the number. Make sure you are in a private chat with them.' 
        }, { quoted: msg });
    }

    // 3. Create the vCard file
    const vCardString = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `N:;${contactName};;;`,
        `FN:${contactName}`,
        `TEL;TYPE=CELL:+${phoneNumber}`,
        'END:VCARD'
    ].join('\n');

    try {
        // 4. Send the file
        const vCardBuffer = Buffer.from(vCardString, 'utf-8');

        await sock.sendMessage(chatId, {
            document: vCardBuffer,
            fileName: `${contactName}.vcf`,
            mimetype: 'text/vcard',
            caption: `📱 *Here is the contact file*\n\nName: *${contactName}*\nNumber: *+${phoneNumber}*\n\n_👆 Tap the file above and click "Save" to add them to YOUR phone book._`
        }, { quoted: msg });

    } catch (error) {
        console.error('[savecontact] Error:', error);
        await sock.sendMessage(chatId, { 
            text: `❌ Failed to generate file: ${error.message}` 
        }, { quoted: msg });
    }
}

module.exports = { name, aliases, desc, category, execute };
