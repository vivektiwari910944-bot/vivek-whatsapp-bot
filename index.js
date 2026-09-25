// ╔══════════════════════════════════════════════════════════════╗
// ║   V I V E K  -  U L T I M A T E   W H A T S A P P   B O T   ║
// ╚══════════════════════════════════════════════════════════════╝

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = "VIVEKJOD";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const activeSockets = new Map();
const pairingCodes = new Map();
const targetAutoReplies = new Map();
const messageStore = new Map();

// Baileys retry counter cache. Keep it outside the socket so reconnects
// do not reset retry counts and cause decrypt/retry loops.
const retryCounts = new Map();
const msgRetryCounterCache = {
    get: (key) => retryCounts.get(key),
    set: (key, value) => { retryCounts.set(key, value); },
    del: (key) => { retryCounts.delete(key); }
};

const processedMessages = new Set();
const startingSessions = new Set();
const reconnectTimers = new Map();

const SESSIONS_BASE = process.env.SESSIONS_DIR || './sessions';
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

const getUptime = () => {
    const uptimeSeconds = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = Math.floor((uptimeSeconds % 60));
    return `${hours}h ${minutes}m ${seconds}s`;
};

const sessionPathFor = (phone) => path.join(SESSIONS_BASE, phone);

function clearReconnectTimer(phone) {
    const timer = reconnectTimers.get(phone);
    if (timer) {
        clearTimeout(timer);
        reconnectTimers.delete(phone);
    }
}

async function closeSocket(phone, sock) {
    try {
        sock.ev.removeAllListeners();
    } catch (e) {}

    try {
        if (sock.ws && sock.ws.readyState === 1) sock.ws.close();
    } catch (e) {}

    if (activeSockets.get(phone) === sock) {
        activeSockets.delete(phone);
    }
}

async function startSession(phoneNumber, options = {}) {
    const cleanedNumber = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (!cleanedNumber) return { success: false, error: 'Invalid Phone Number' };

    // Never create two Baileys sockets for the same WhatsApp account.
    const existing = activeSockets.get(cleanedNumber);
    if (existing) {
        return {
            success: true,
            code: pairingCodes.get(cleanedNumber) || null,
            alreadyRunning: true
        };
    }

    if (startingSessions.has(cleanedNumber)) {
        return {
            success: true,
            code: pairingCodes.get(cleanedNumber) || null,
            starting: true
        };
    }

    startingSessions.add(cleanedNumber);
    clearReconnectTimer(cleanedNumber);

    const sessionPath = sessionPathFor(cleanedNumber);

    try {
        fs.mkdirSync(sessionPath, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            auth: state,
            version,
            logger: pino({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            printQRInTerminal: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            emitOwnEvents: true,
            enableRecentMessageCache: true,
            msgRetryCounterCache,
            maxMsgRetryCount: 5,

            // WhatsApp/Baileys can ask for an older message again during
            // retry/decryption. Return the original message from our store.
            // IMPORTANT: return undefined on a cache miss; never return a fake
            // empty message because that can consume a retry permanently.
            getMessage: async (key) => {
                const stored = messageStore.get(key?.id);
                return stored?.message || undefined;
            }
        });

        // Store every outgoing message immediately. A just-sent message can be
        // requested for retry before messages.upsert is emitted.
        const originalSendMessage = sock.sendMessage.bind(sock);
        sock.sendMessage = async (jid, content, options) => {
            const sent = await originalSendMessage(jid, content, options);
            if (sent?.key?.id && sent?.message) {
                messageStore.set(sent.key.id, sent);
                if (messageStore.size > 5000) {
                    const oldestKey = messageStore.keys().next().value;
                    if (oldestKey) messageStore.delete(oldestKey);
                }
            }
            return sent;
        };

        activeSockets.set(cleanedNumber, sock);

        let generatedCode = null;

        if (!sock.authState.creds.registered) {
            try {
                await new Promise((resolve) => setTimeout(resolve, 4000));

                if (activeSockets.get(cleanedNumber) !== sock) {
                    throw new Error('Session socket was replaced before pairing.');
                }

                generatedCode = await sock.requestPairingCode(cleanedNumber);
                pairingCodes.set(cleanedNumber, generatedCode);
                console.log(`[PAIRING CODE - ${cleanedNumber}]: ${generatedCode}`);
            } catch (err) {
                console.error(`Pairing Error (${cleanedNumber}):`, err);
                await closeSocket(cleanedNumber, sock);

                if (options.resetOnPairingError) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }

                startingSessions.delete(cleanedNumber);
                return {
                    success: false,
                    error: 'Pairing code generation failed. Try again.'
                };
            }
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (upd) => {
            const { connection, lastDisconnect } = upd;

            if (connection === 'open') {
                pairingCodes.delete(cleanedNumber);
                startingSessions.delete(cleanedNumber);
                console.log(`✅ Session Active: ${cleanedNumber}`);
                return;
            }

            if (connection !== 'close') return;

            const statusCode =
                lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output.statusCode
                    : 500;

            pairingCodes.delete(cleanedNumber);

            // An old socket must never delete/restart a newer socket.
            if (activeSockets.get(cleanedNumber) !== sock) return;

            activeSockets.delete(cleanedNumber);
            startingSessions.delete(cleanedNumber);

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log(`🔴 Logged out: ${cleanedNumber}`);
                fs.rmSync(sessionPath, { recursive: true, force: true });
                return;
            }

            // Reconnect without deleting credentials. This preserves Signal keys.
            if (!reconnectTimers.has(cleanedNumber)) {
                const timer = setTimeout(() => {
                    reconnectTimers.delete(cleanedNumber);

                    startSession(cleanedNumber).catch((err) =>
                        console.error(`Reconnect Error (${cleanedNumber}):`, err)
                    );
                }, 5000);

                reconnectTimers.set(cleanedNumber, timer);
            }
        });

        sock.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                /*
                 * FIX:
                 * Store BOTH incoming and own/outgoing messages.
                 * This gives Baileys a local copy when WhatsApp asks
                 * for a message again instead of showing:
                 *
                 * "Waiting for this message. This may take a while."
                 */
                for (const msg of (chatUpdate.messages || [])) {
                    if (msg?.key?.id && msg?.message) {
                        messageStore.set(msg.key.id, msg);

                        // Keep memory under control.
                        if (messageStore.size > 5000) {
                            const oldestKey = messageStore.keys().next().value;
                            if (oldestKey) {
                                messageStore.delete(oldestKey);
                            }
                        }
                    }
                }

                if (chatUpdate.type !== 'notify') return;

                const mek = chatUpdate.messages[0];

                if (
                    !mek ||
                    !mek.message ||
                    mek.key.remoteJid === 'status@broadcast'
                ) return;

                if (processedMessages.has(mek.key.id)) return;

                processedMessages.add(mek.key.id);

                if (processedMessages.size > 2000) {
                    processedMessages.clear();
                }

                if (mek.key.id) {
                    messageStore.set(mek.key.id, mek);
                }

                const from = mek.key.remoteJid;
                const isGroup = from.endsWith('@g.us');
                const type = Object.keys(mek.message)[0];
                const sender = mek.key.participant || mek.key.remoteJid;

                const botOwner = sock.user.id
                    ? (sock.user.id.split(':')[0] + '@s.whatsapp.net')
                    : from;

                const body =
                    (type === 'conversation')
                        ? mek.message.conversation
                        : (type === 'extendedTextMessage')
                            ? mek.message.extendedTextMessage.text
                            : (type === 'imageMessage')
                                ? mek.message.imageMessage.caption
                                : (type === 'videoMessage')
                                    ? mek.message.videoMessage.caption
                                    : '';

                const command = body.trim().toLowerCase().split(' ')[0];
                const args = body.trim().split(' ').slice(1);
                const qtext = args.join(' ');

                const sendBorderStatus = async (statusTitle, statusText) => {
                    const borderMsg = `
╭━━━━━━━╮
    ╭━━━╯  ⚡  ╰━━━╮
   ╱   𝙑𝙄𝙑𝙀权 𝙑𝙄𝘽𝙀𝙎   ╲
  ╲     𝙐𝙇𝙏𝙄𝙈𝘼𝙏𝙀     ╱
   ╰━━╮           ╭━━╯
      ╰━━╮     ╭━━╯
         ╰━━━╯

   ╭─╮  ⚡ 𝙎𝙔𝙎𝙏𝙀𝙈 𝙎𝙏𝘼𝙏𝙐𝙎
   ╰╮╰━━━━━━━━━━━━━━━━
    ╰─ ⚙️ ${statusTitle}
       📝 ${statusText}

       ╭━━━━━━━━╮
    ╭━━╯  𝙑𝙄𝙑𝙀权  ╰━━╮
    ╰━━ 𝙎𝙔𝙎𝙏𝙀𝙈  ━━╯
       ╰━━━━━━━━╯`;

                    await sock.sendMessage(from, { text: borderMsg });
                };

                if (!mek.key.fromMe && targetAutoReplies.has(sender)) {
                    await sock.sendMessage(
                        from,
                        { text: targetAutoReplies.get(sender) },
                        { quoted: mek }
                    );
                }

                if (!mek.key.fromMe) return;

                if (command === '.menu' || command === 'menu') {
                    const menuText = `╭━━━━━━━╮
    ╭━━━╯  ⚡  ╰━━━╮
   ╱   𝙑𝙄𝙑𝙀权 𝙑𝙄𝘽𝙀𝙎   ╲
  ╲     𝙐𝙇𝙏𝙄𝙈𝘼𝙏𝙀     ╱
   ╰━━╮           ╭━━╯
      ╰━━╮     ╭━━╯
         ╰━━━╯

      ╭╮ 🎯 𝙍𝙀𝙋𝙇𝙔 𝙈𝙊𝘿𝙀
   ╭━━╯╰━━━━━━━━━━━━━━
   ╰━━ 𝙖𝙪𝙩𝙤𝙧𝙚𝙥𝙡𝙮 <𝙈𝙎𝙂>
        𝙖𝙪𝙩𝙤𝙧𝙚𝙥𝙡𝙮 𝙤𝙛𝙛

   ╭─╮ 🕶️ 𝙎𝙏𝙀𝘼𝙇𝙏𝙃
   ╰━━╮━━━━━━━━━━━━━━
       ╰─ 𝙝𝙖𝙝𝙖
         𝙨𝙨

      ╭━━╮ 🤖 𝘼𝙄 𝙕𝙊𝙉𝙀
   ╭━━╯  ╰━━━━━━━━━━━━
   ╰━━ 𝙖𝙞 <𝙦𝙪𝙚𝙨𝙩𝙞𝙤𝙣>
       𝙨𝙩𝙞𝙘𝙠𝙚𝙧

   ╭╮ 👥 𝙍𝙊𝙐𝙋 𝙒𝙀𝘼𝙋𝙊𝙉𝙎
   ╰╰━━╮━━━━━━━━━━━━━━
        ╰─ 𝙩𝙖𝙜𝙖𝙡𝙡
           𝙥𝙞𝙣𝙜 / 𝙧𝙪𝙣𝙩𝙞𝙢𝙚

       ╭━━━━━━━━╮
    ╭━━╯  𝙑𝙄𝙑𝙀权  ╰━━╮
    ╰━━ 𝙎𝙔𝙎𝙏𝙀𝙈  ━━╯
       ╰━━━━━━━━╯`;

                    await sock.sendMessage(
                        from,
                        { text: menuText },
                        { quoted: mek }
                    );
                }

                if (command === '.autoreply' || command === 'autoreply') {
                    let targetJid = from;

                    if (
                        isGroup &&
                        type === 'extendedTextMessage' &&
                        mek.message.extendedTextMessage.contextInfo?.quotedMessage
                    ) {
                        targetJid =
                            mek.message.extendedTextMessage.contextInfo.participant;
                    }

                    if (qtext.toLowerCase() === 'off') {
                        targetAutoReplies.delete(targetJid);

                        await sendBorderStatus(
                            '𝘼𝙐𝙏𝙊𝙍𝙀𝙋𝙇𝙔 𝘿𝙀𝘼𝘾𝙏𝙄𝙑𝘼𝙏𝙀𝘿',
                            `Removed for @${targetJid.split('@')[0]}`
                        );
                    } else if (qtext) {
                        targetAutoReplies.set(targetJid, qtext);

                        await sendBorderStatus(
                            '𝘼𝙐𝙏𝙊𝙍𝙀𝙋𝙇𝙔 𝘼𝘾𝙏𝙄𝙑𝘼𝙏𝙀𝘿',
                            `Set for @${targetJid.split('@')[0]}:\n"${qtext}"`
                        );
                    } else {
                        await sendBorderStatus(
                            '𝘼𝙐𝙏𝙊𝙍𝙀𝙋𝙇𝙔 𝙄𝙉𝙁𝙊',
                            'Usage: .autoreply <MSG> | .autoreply off'
                        );
                    }
                }

                if (
                    command === 'haha!' ||
                    command === 'haha' ||
                    command === '.haha'
                ) {
                    try {
                        const quoted =
                            type === 'extendedTextMessage'
                                ? mek.message.extendedTextMessage
                                    ?.contextInfo
                                    ?.quotedMessage
                                : null;

                        let targetMessage = quoted || mek.message;

                        // Unwrap WhatsApp wrapper messages recursively
                        for (let i = 0; i < 5; i++) {
                            if (targetMessage?.ephemeralMessage?.message) {
                                targetMessage =
                                    targetMessage.ephemeralMessage.message;
                            } else if (targetMessage?.viewOnceMessage?.message) {
                                targetMessage =
                                    targetMessage.viewOnceMessage.message;
                            } else if (
                                targetMessage?.viewOnceMessageV2?.message
                            ) {
                                targetMessage =
                                    targetMessage.viewOnceMessageV2.message;
                            } else if (
                                targetMessage
                                    ?.viewOnceMessageV2Extension
                                    ?.message
                            ) {
                                targetMessage =
                                    targetMessage
                                        .viewOnceMessageV2Extension.message;
                            } else if (
                                targetMessage
                                    ?.documentWithCaptionMessage
                                    ?.message
                            ) {
                                targetMessage =
                                    targetMessage
                                        .documentWithCaptionMessage.message;
                            } else {
                                break;
                            }
                        }

                        const mediaType = Object.keys(
                            targetMessage || {}
                        ).find((key) =>
                            [
                                'imageMessage',
                                'videoMessage',
                                'audioMessage',
                                'documentMessage'
                            ].includes(key)
                        );

                        if (!mediaType) {
                            await sendBorderStatus(
                                '𝙑𝙄𝙀𝙒-𝙊𝙉𝘾𝙀 𝙀𝙍𝙍𝙊𝙍',
                                'No supported media found.'
                            );
                            return;
                        }

                        const streamType =
                            mediaType.replace('Message', '');

                        const media = targetMessage[mediaType];

                        const stream = await downloadContentFromMessage(
                            media,
                            streamType
                        );

                        const chunks = [];

                        for await (const chunk of stream) {
                            chunks.push(chunk);
                        }

                        const buffer = Buffer.concat(chunks);

                        if (mediaType === 'imageMessage') {
                            await sock.sendMessage(botOwner, {
                                image: buffer,
                                caption: '🤫 *View-Once Saved*'
                            });
                        } else if (mediaType === 'videoMessage') {
                            await sock.sendMessage(botOwner, {
                                video: buffer,
                                caption: '🤫 *View-Once Saved*'
                            });
                        } else if (mediaType === 'audioMessage') {
                            await sock.sendMessage(botOwner, {
                                audio: buffer,
                                mimetype: media.mimetype || 'audio/mp4'
                            });
                        } else if (mediaType === 'documentMessage') {
                            await sock.sendMessage(botOwner, {
                                document: buffer,
                                mimetype:
                                    media.mimetype ||
                                    'application/octet-stream',
                                fileName:
                                    media.fileName ||
                                    'saved-file'
                            });
                        }

                        await sock.sendMessage(from, {
                            react: {
                                text: '✅',
                                key: mek.key
                            }
                        });

                    } catch (err) {
                        console.error('View Once Error:', err);

                        await sendBorderStatus(
                            '𝙑𝙄𝙀𝙒-𝙊𝙉𝘾𝙀 𝙀𝙍𝙍𝙊𝙍',
                            'Media download failed. Check Render logs.'
                        );
                    }
                }

                if (
                    command === '.ss' ||
                    command === 'ss' ||
                    command === '.savestatus'
                ) {
                    const isQuoted =
                        type === 'extendedTextMessage' &&
                        mek.message.extendedTextMessage
                            .contextInfo
                            ?.quotedMessage;

                    if (isQuoted) {
                        const quotedMsg =
                            mek.message.extendedTextMessage
                                .contextInfo.quotedMessage;

                        let mediaType = Object.keys(quotedMsg)[0];

                        if (
                            ['imageMessage', 'videoMessage']
                                .includes(mediaType)
                        ) {
                            const streamType =
                                mediaType.replace('Message', '');

                            const stream =
                                await downloadContentFromMessage(
                                    quotedMsg[mediaType],
                                    streamType
                                );

                            let buffer = Buffer.from([]);

                            for await (const chunk of stream) {
                                buffer = Buffer.concat([
                                    buffer,
                                    chunk
                                ]);
                            }

                            if (mediaType === 'imageMessage') {
                                await sock.sendMessage(botOwner, {
                                    image: buffer,
                                    caption: '📲 *Status Saved!*'
                                });
                            } else {
                                await sock.sendMessage(botOwner, {
                                    video: buffer,
                                    caption: '📲 *Status Saved!*'
                                });
                            }

                            await sock.sendMessage(from, {
                                react: {
                                    text: '✅',
                                    key: mek.key
                                }
                            });
                        }
                    }
                }

                if (command === '.ai' || command === 'ai') {
                    if (!qtext) {
                        return sendBorderStatus(
                            '𝘼𝙄 𝙀𝙍𝙍𝙊𝙍',
                            'Please ask a question.'
                        );
                    }

                    try {
                        const response = await fetch(
                            `https://api.vyture.workers.dev/?prompt=${encodeURIComponent(qtext)}`
                        );

                        const data = await response.json();

                        await sendBorderStatus(
                            '𝘼𝙄 𝙕𝙊𝙉𝙀',
                            data.result ||
                            data.response ||
                            "No response."
                        );
                    } catch (e) {
                        await sendBorderStatus(
                            '𝘼𝙄 𝙀𝙍𝙍𝙊𝙍',
                            'API connection failed.'
                        );
                    }
                }

                if (
                    command === '.s' ||
                    command === '.sticker' ||
                    command === 'sticker'
                ) {
                    const isQuotedImage =
                        type === 'extendedTextMessage' &&
                        mek.message.extendedTextMessage
                            .contextInfo
                            ?.quotedMessage
                            ?.imageMessage;

                    const isImage = type === 'imageMessage';

                    if (isImage || isQuotedImage) {
                        const imgMsg = isImage
                            ? mek.message.imageMessage
                            : mek.message.extendedTextMessage
                                .contextInfo
                                .quotedMessage
                                .imageMessage;

                        const stream =
                            await downloadContentFromMessage(
                                imgMsg,
                                'image'
                            );

                        let buffer = Buffer.from([]);

                        for await (const chunk of stream) {
                            buffer = Buffer.concat([
                                buffer,
                                chunk
                            ]);
                        }

                        await sock.sendMessage(
                            from,
                            { sticker: buffer },
                            { quoted: mek }
                        );
                    }
                }

                if (
                    (command === '.tagall' || command === 'tagall') &&
                    isGroup
                ) {
                    const groupMetadata =
                        await sock.groupMetadata(from);

                    let text =
                        `📢 *ATTENTION EVERYONE*\n\n`;

                    let mentions = [];

                    for (
                        let mem of groupMetadata.participants
                    ) {
                        text +=
                            `@${mem.id.split('@')[0]}\n`;

                        mentions.push(mem.id);
                    }

                    await sock.sendMessage(
                        from,
                        {
                            text,
                            mentions
                        },
                        {
                            quoted: mek
                        }
                    );
                }

                if (
                    command === '.ping' ||
                    command === 'ping' ||
                    command === '.runtime' ||
                    command === 'runtime'
                ) {
                    await sendBorderStatus(
                        '𝙋𝙄𝙉𝙂 & 𝙍𝙐𝙉𝙏𝙄𝙈𝙀',
                        `Status: Online 🟢\n       ⏳ Uptime: ${getUptime()}`
                    );
                }

            } catch (e) {
                console.error(
                    'Processing Error:',
                    e
                );
            }
        });

        return {
            success: true,
            code: generatedCode
        };

    } catch (err) {
        console.error(
            `startSession Error (${cleanedNumber}):`,
            err
        );

        startingSessions.delete(cleanedNumber);
        clearReconnectTimer(cleanedNumber);

        const currentSocket =
            activeSockets.get(cleanedNumber);

        if (currentSocket) {
            try {
                await closeSocket(
                    cleanedNumber,
                    currentSocket
                );
            } catch (e) {}
        }

        return {
            success: false,
            error:
                err?.message ||
                'Failed to start session.'
        };
    }
}


// Auto Start Active Sessions
fs.readdirSync(
    SESSIONS_BASE,
    { withFileTypes: true }
).forEach((entry) => {
    if (!entry.isDirectory()) return;

    const folder = entry.name;

    if (
        fs.existsSync(
            path.join(
                SESSIONS_BASE,
                folder,
                'creds.json'
            )
        )
    ) {
        startSession(folder).catch((err) =>
            console.error(
                `Auto-start Error (${folder}):`,
                err
            )
        );
    }
});


// APIs
app.post('/connect', async (req, res) => {
    const { phone } = req.body;

    const cleanedNumber =
        phone
            ? phone.replace(/[^0-9]/g, '')
            : '';

    if (!cleanedNumber) {
        return res.status(400).json({
            success: false,
            error: 'Invalid Phone Number'
        });
    }

    // Never delete a saved session here:
    // the Signal keys must survive reconnects/restarts.
    const result =
        await startSession(cleanedNumber);

    res.json(result);
});


app.post('/disconnect', async (req, res) => {
    const { phone } = req.body;

    const cleanedNumber =
        phone
            ? phone.replace(/[^0-9]/g, '')
            : '';

    if (activeSockets.has(cleanedNumber)) {
        try {
            const sock =
                activeSockets.get(cleanedNumber);

            sock.ev.removeAllListeners();

            await sock.logout();

            sock.end(undefined);
        } catch (e) {}

        activeSockets.delete(cleanedNumber);
    }

    const sessionPath =
        `${SESSIONS_BASE}/${cleanedNumber}`;

    if (fs.existsSync(sessionPath)) {
        fs.rmSync(
            sessionPath,
            {
                recursive: true,
                force: true
            }
        );
    }

    res.json({
        success: true,
        message:
            'Session Deleted Successfully'
    });
});


app.get('/status/:phone', (req, res) => {
    const cleanedNumber =
        req.params.phone.replace(
            /[^0-9]/g,
            ''
        );

    const isConnected =
        activeSockets.has(cleanedNumber);

    const code =
        pairingCodes.get(cleanedNumber) ||
        null;

    res.json({
        connected: isConnected,
        code
    });
});


app.get('/admin/accounts', (req, res) => {
    const password = req.query.pass;

    if (password === ADMIN_PASSWORD) {
        let allSessions = new Set();

        activeSockets.forEach(
            (_, key) =>
                allSessions.add(key)
        );

        if (fs.existsSync(SESSIONS_BASE)) {
            fs.readdirSync(SESSIONS_BASE)
                .forEach(folder => {
                    if (
                        fs.existsSync(
                            `${SESSIONS_BASE}/${folder}/creds.json`
                        )
                    ) {
                        allSessions.add(folder);
                    }
                });
        }

        const accounts =
            Array.from(allSessions)
                .map((num) => ({
                    phone: num,
                    status:
                        activeSockets.has(num)
                            ? 'Connected 🟢'
                            : (
                                pairingCodes.has(num)
                                    ? 'Pairing 🟡'
                                    : 'Saved 📁'
                            )
                }));

        res.json({
            accounts,
            uptime: getUptime()
        });

    } else {
        res.status(403).json({
            error: 'Unauthorized'
        });
    }
});


// Dashboard UI
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>VIVEK BOT ENGINE</title>

    <link
        href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@500;700&display=swap"
        rel="stylesheet"
    >

    <script
        src="https://cdn.jsdelivr.net/npm/sweetalert2@11"
    ></script>

    <style>
        :root {
            --neon-blue: #00f3ff;
            --neon-purple: #9d00ff;
            --bg-dark: #05050a;
            --card-bg: rgba(15, 15, 30, 0.85);
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: 'Rajdhani', sans-serif;
        }

        body {
            background: var(--bg-dark);
            color: #fff;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
        }

        .container {
            width: 90%;
            max-width: 480px;
            padding: 30px;
            background: var(--card-bg);
            border-radius: 20px;
            border: 1px solid rgba(0, 243, 255, 0.3);
            box-shadow: 0 0 30px rgba(0, 243, 255, 0.2);
            text-align: center;
        }

        h1 {
            font-family: 'Orbitron', sans-serif;
            font-size: 20px;
            background: linear-gradient(
                90deg,
                var(--neon-blue),
                var(--neon-purple)
            );
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 20px;
        }

        .input-box {
            width: 100%;
            padding: 14px;
            margin: 12px 0;
            border-radius: 10px;
            border: 1px solid rgba(0,243,255,0.3);
            background: rgba(0, 0, 0, 0.6);
            color: #fff;
            font-size: 16px;
            outline: none;
        }

        .btn-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-top: 15px;
        }

        .btn {
            padding: 14px;
            border: none;
            border-radius: 10px;
            font-size: 15px;
            font-weight: 700;
            cursor: pointer;
            text-transform: uppercase;
            transition: 0.3s;
        }

        .btn-primary {
            background:
                linear-gradient(
                    45deg,
                    #00f3ff,
                    #0066ff
                );
            color: #000;
        }

        .btn-danger {
            background:
                linear-gradient(
                    45deg,
                    #ff0055,
                    #9d00ff
                );
            color: #fff;
        }

        .btn-info {
            background:
                linear-gradient(
                    45deg,
                    #11998e,
                    #38ef7d
                );
            color: #000;
        }

        .btn-admin {
            background:
                linear-gradient(
                    45deg,
                    #f857a6,
                    #ff5858
                );
            color: #fff;
            grid-column: span 2;
        }

        .btn:hover {
            transform: scale(1.03);
        }

        .code-display {
            margin-top: 20px;
            padding: 15px;
            background: rgba(0,0,0,0.9);
            border-radius: 10px;
            border: 1px dashed var(--neon-blue);
            font-family: 'Orbitron', sans-serif;
            font-size: 24px;
            color: var(--neon-blue);
            display: none;
        }

        .account-card {
            background:
                rgba(255,255,255,0.05);
            padding: 10px;
            border-radius: 8px;
            margin-bottom: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border:
                1px solid
                rgba(255,255,255,0.1);
        }
    </style>
</head>

<body>

    <div class="container">

        <h1>
            ⚡ VIVEK BOT ENGINE ⚡
        </h1>

        <input
            type="text"
            id="phoneNumber"
            class="input-box"
            placeholder="919876543210 (Country Code)"
        >

        <div class="btn-grid">

            <button
                class="btn btn-primary"
                onclick="connectBot()"
            >
                🚀 Link Account
            </button>

            <button
                class="btn btn-danger"
                onclick="disconnectBot()"
            >
                🚫 Disconnect
            </button>

            <button
                class="btn btn-info"
                onclick="checkStatus()"
            >
                🔍 Status Check
            </button>

            <button
                class="btn btn-admin"
                onclick="openAdminPanel()"
            >
                👑 Admin Panel
            </button>

        </div>

        <div
            id="codeDisplay"
            class="code-display"
        ></div>

        <div
            id="adminPanel"
            style="display:none; margin-top:20px; text-align:left;"
        >

            <h3
                style="color:var(--neon-blue); margin-bottom:10px;"
            >
                🛡️ Active Sessions
            </h3>

            <div id="accountsList"></div>

        </div>

    </div>


    <script>

        let cachedAdminPass = '';


        async function connectBot() {

            const phone =
                document
                    .getElementById('phoneNumber')
                    .value;

            if(!phone) {
                return Swal.fire(
                    'Error',
                    'Enter phone number!',
                    'error'
                );
            }

            Swal.fire({
                title: 'Requesting Code...',
                allowOutsideClick: false,
                didOpen: () =>
                    Swal.showLoading()
            });

            try {

                const res =
                    await fetch(
                        '/connect',
                        {
                            method: 'POST',
                            headers: {
                                'Content-Type':
                                    'application/json'
                            },
                            body:
                                JSON.stringify({
                                    phone
                                })
                        }
                    )
                    .then(r => r.json());


                if(res.success && res.code) {

                    Swal.close();

                    const display =
                        document
                            .getElementById(
                                'codeDisplay'
                            );

                    display.innerText =
                        res.code;

                    display.style.display =
                        'block';

                } else if(res.success) {

                    checkStatus();

                } else {

                    Swal.fire(
                        'Error',
                        res.error ||
                            'Failed to generate code',
                        'error'
                    );
                }

            } catch (err) {

                Swal.fire(
                    'Error',
                    'Server error, try again!',
                    'error'
                );
            }
        }


        async function disconnectBot(targetPhone) {

            const phone =
                targetPhone ||
                document
                    .getElementById(
                        'phoneNumber'
                    )
                    .value;

            if(!phone) {
                return Swal.fire(
                    'Error',
                    'Enter phone number!',
                    'error'
                );
            }

            const res =
                await fetch(
                    '/disconnect',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type':
                                'application/json'
                        },
                        body:
                            JSON.stringify({
                                phone
                            })
                    }
                )
                .then(r => r.json());


            if(res.success) {

                Swal.fire(
                    'Success',
                    'Session Removed!',
                    'success'
                );

                document
                    .getElementById(
                        'codeDisplay'
                    )
                    .style.display = 'none';

                if(cachedAdminPass) {
                    fetchAdminSessions();
                }

            } else {

                Swal.fire(
                    'Error',
                    res.error,
                    'error'
                );
            }
        }


        async function checkStatus() {

            const phone =
                document
                    .getElementById(
                        'phoneNumber'
                    )
                    .value;

            if(!phone) {
                return Swal.fire(
                    'Error',
                    'Enter phone number!',
                    'error'
                );
            }

            const res =
                await fetch(
                    '/status/' + phone
                )
                .then(r => r.json());


            const display =
                document
                    .getElementById(
                        'codeDisplay'
                    );


            if(res.connected) {

                Swal.fire(
                    'Status',
                    '🟢 Account Online!',
                    'success'
                );

                display.style.display =
                    'none';

            } else if(res.code) {

                Swal.close();

                display.innerText =
                    res.code;

                display.style.display =
                    'block';

            } else {

                Swal.fire(
                    'Status',
                    '🟡 Generating code, check again in 3s...',
                    'info'
                );
            }
        }


        async function openAdminPanel() {

            if(!cachedAdminPass) {

                const {
                    value: password
                } = await Swal.fire({
                    title:
                        'Admin Verification',
                    input:
                        'password',
                    showCancelButton:
                        true
                });

                if (password) {
                    cachedAdminPass =
                        password;
                }
            }

            if(cachedAdminPass) {
                fetchAdminSessions();
            }
        }


        async function fetchAdminSessions() {

            try {

                const res =
                    await fetch(
                        '/admin/accounts?pass=' +
                        cachedAdminPass
                    )
                    .then(r => r.json());


                if (res.error) {

                    cachedAdminPass = '';

                    return Swal.fire(
                        'Denied',
                        'Wrong Password!',
                        'error'
                    );
                }


                const list =
                    document
                        .getElementById(
                            'accountsList'
                        );

                list.innerHTML = '';


                if(res.accounts.length === 0) {

                    list.innerHTML =
                        '<div style="color:#aaa;">No active or saved sessions found.</div>';
                }


                res.accounts.forEach(
                    acc => {

                        list.innerHTML +=
                            `<div class="account-card">
                                <span>+${acc.phone} (${acc.status})</span>
                                <button
                                    class="btn btn-danger"
                                    style="padding:6px 12px; font-size:12px;"
                                    onclick="adminRemove('${acc.phone}')"
                                >
                                    🗑️ Delete
                                </button>
                            </div>`;
                    }
                );

                document
                    .getElementById(
                        'adminPanel'
                    )
                    .style.display =
                    'block';

            } catch(e) {

                Swal.fire(
                    'Error',
                    'Could not load sessions',
                    'error'
                );
            }
        }


        async function adminRemove(phone) {

            Swal.fire({
                title:
                    'Delete Session?',
                text:
                    'Are you sure you want to delete session for +' +
                    phone +
                    '?',
                icon:
                    'warning',
                showCancelButton:
                    true,
                confirmButtonColor:
                    '#ff0055',
                confirmButtonText:
                    'Yes, Delete!'
            })
            .then(async (result) => {

                if (result.isConfirmed) {
                    await disconnectBot(phone);
                }

            });
        }

    </script>

</body>
</html>
    `);
});


app.listen(
    PORT,
    () =>
        console.log(
            `🚀 Server active on port ${PORT}`
        )
);