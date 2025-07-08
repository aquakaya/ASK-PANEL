require('./system/config');
const { default: makeWASocket, jidDecode, DisconnectReason, useMultiFileAuthState, Browsers, getContentType, proto, makeInMemoryStore, downloadContentFromMessage } = require('@whiskeysockets/baileys');

const pino = require("pino");
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const { Boom } = require("@hapi/boom");
const FileType = require('file-type');
const fetch = require('node-fetch');
const moment = require('moment-timezone');
const readline = require('readline');
const os = require('os');
const crypto = require('crypto');


const { imageToWebp, videoToWebp, writeExifImg, writeExifVid } = require('./system/myLib/ASK-BASE-TO-WEB');

const {smsg, fetchJson, await: awaitfunc, sleep } = require('./system/myLib/FuncIndex');

const store = makeInMemoryStore({ logger: pino().child({ level: "silent" }) });

let pairingCodeErrorShown = false;
const reconnectAttempts = {};
const pairingRequested = {}; 

function deleteFolderRecursive(folderPath) {
    if (fs.existsSync(folderPath)) {
        fs.readdirSync(folderPath).forEach(file => {
            const curPath = path.join(folderPath, file);
            fs.lstatSync(curPath).isDirectory() ? deleteFolderRecursive(curPath) : fs.unlinkSync(curPath);
        });
        fs.rmdirSync(folderPath);
    }
}
async function getBuffer(url) {
    try {
        const response = await fetch(url);
        return await response.buffer();
    } catch (e) {
        console.error("Erreur getBuffer:", e);
        return null;
    }
}

async function getProfilePicture(jid, type = 'image') {
    try {
        const url = await ask.profilePictureUrl(jid, type);
        return url || (type === 'user' 
            ? 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png'
            : 'https://i.ibb.co/RBx5SQC/avatar-group-large-v2.png');
    } catch (e) {
        console.error('Erreur getProfilePicture:', e);
        return type === 'user' 
            ? 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png'
            : 'https://i.ibb.co/RBx5SQC/avatar-group-large-v2.png';
    }
}

function loadGroupSettings() {
    try {
        return JSON.parse(fs.readFileSync('./system/database/groupSettings.json'));
    } catch (e) {
        console.error('Erreur groupSettings:', e);
        return {};
    }
}
async function startpairing(askNumber) {
    try {
        const sessionPath = `./sessions/${askNumber}`;

        if (!fs.existsSync(`${sessionPath}/creds.json`)) {
            console.warn(chalk.yellow(`[${askNumber}] Aucune session trouvée, démarrage d'une nouvelle session.`));
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        if (!state?.creds) {
            console.warn(chalk.red(`[${askNumber}] État de session invalide. Réinitialisation.`));
            deleteFolderRecursive(sessionPath);
            return setTimeout(() => startpairing(askNumber), 5000);
        }

        const ask = makeWASocket({
            logger: pino({ level: "silent" }),
            printQRInTerminal: false,
            auth: state,
            version: [2, 3000, 1017531287],
            browser: Browsers.ubuntu("Edge"),
            getMessage: async key => {
                const jid = jidNormalizedUser(key.remoteJid);
                const msg = await store.loadMessage(jid, key.id);
                return msg?.message || '';
            },
            shouldSyncHistoryMessage: msg => {
                console.log(`\x1b[32mChargement du chat [${msg.progress}%]\x1b[39m`);
                return !!msg.syncType;
            }
        });

        store.bind(ask.ev);

        const keepAliveInterval = setInterval(() => {
            if (ask?.user) {
                ask.sendPresenceUpdate('available').catch(err => {
                    console.error("Échec du keep-alive:", err.message);
                });
            }
        }, 1000 * 60 * 30);

        if (!state.creds.registered && askNumber && !pairingRequested[askNumber]) {
            pairingRequested[askNumber] = true;
            const phoneNumber = askNumber.replace(/[^0-9]/g, '');

            setTimeout(async () => {
                try {
                    let code = await ask.requestPairingCode(phoneNumber);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    fs.writeFileSync(`./system/database/pairing.json`, JSON.stringify({ code }, null, 2));
                } catch (err) {
                    if (!pairingCodeErrorShown) {
                        console.error("Erreur lors de la demande du code d'appairage:", err.stack || err.message);
                        pairingCodeErrorShown = true;
                    }
                }
            }, 1703);
        }

        ask.decodeJid = (jid) => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                const decode = jidDecode(jid) || {};
                return decode.user && decode.server && `${decode.user}@${decode.server}` || jid;
            }
            return jid;
        };
        
ask.ev.on("messages.upsert", async chatUpdate => {
            try {
                const msg = chatUpdate.messages[0];
                if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
                const m = smsg(ask, msg, store);
                require("./handler")(ask, m, chatUpdate, store);
            } catch (err) {
                console.error("Erreur de traitement du message:", err.stack || err.message);
            }
        });

        const badSessionRetries = {}; // Suivi des tentatives par numéro

        ask.ev.on("connection.update", async update => {
            const { connection, lastDisconnect } = update;
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;

            try {
                if (connection === "close") {
                    clearInterval(keepAliveInterval);

                    switch (statusCode) {
                        case DisconnectReason.badSession:
                            badSessionRetries[askNumber] = (badSessionRetries[askNumber] || 0) + 1;

                            if (badSessionRetries[askNumber] <= 6) {
                                console.log(chalk.yellow(`[${askNumber}] Mauvaise session détectée. Nouvelle tentative (${badSessionRetries[askNumber]}/6) sans suppression de session...`));
                                pairingRequested[askNumber] = false;
                                return setTimeout(() => startpairing(askNumber), 3000);
                            } else {
                                console.log(chalk.red(`[${askNumber}] Limite de tentatives atteinte. Suppression de la session et nouveau départ.`));
                                deleteFolderRecursive(sessionPath);
                                badSessionRetries[askNumber] = 0;
                                pairingRequested[askNumber] = false;
                                return setTimeout(() => startpairing(askNumber), 5000);
                            }

                        case DisconnectReason.connectionClosed:
                        case DisconnectReason.connectionLost:
                        case DisconnectReason.restartRequired:
                        case DisconnectReason.timedOut:
                        case 405:
                            reconnectAttempts[askNumber] = (reconnectAttempts[askNumber] || 0) + 1;
                            if (reconnectAttempts[askNumber] <= 5) {
                                console.log(`[${askNumber}] tentative de reconnexion (${reconnectAttempts[askNumber]}/5)...`);
                                return setTimeout(() => startpairing(askNumber), 2000);
                            } else {
                                console.log(`[${askNumber}] nombre maximum de tentatives atteint.`);
                            }
                            break;

                        case DisconnectReason.loggedOut:
                            deleteFolderRecursive(sessionPath);
                            pairingRequested[askNumber] = false;
                            console.log(chalk.bgRed(`${askNumber} déconnecté (déconnexion manuelle).`));
                            break;

                        default:
                            console.log("Raison de déconnexion inconnue:", statusCode);
                            console.error("Erreur de déconnexion:", lastDisconnect?.error?.stack || lastDisconnect?.error?.message);
                    }
                } else if (connection === "open") {
 ask.newsletterFollow("120363401251267400@newsletter");
            ask.sendMessage(ask.user.id, {
                image: { url: "https://files.catbox.moe/ecbwna.jpeg" },
                caption: `
╭──✧* 𝖠𝖲𝖪 - 𝖷𝖬𝖣 *✧───╮
├ ❏ 𝙽𝚄𝙼𝙱𝙴𝚁 𝙳𝙴𝚅: +24165183695
├ ❏ 𝙽𝙾𝙼 𝙳𝚄 𝙱𝙾𝚃 : *𝖠𝖲𝖪-𝖷𝖬𝖣 𝖵𝟷*
├ ❏ 𝙽𝙾𝙼𝙱𝚁𝙴𝚂 𝙲𝙾𝙼𝙼𝙰𝙽𝙳𝙴 : 47
├ ❏ 𝙿𝚁𝙴𝙵𝙸𝚇 : *${global.prefix}*
├ ❏ 𝙳𝙴𝚅 : 𝖠𝖲𝖪 𝖣𝙴𝖶 𝖳𝙴𝙲𝙷
├ ❏ 𝚅𝙴𝚁𝚂𝙸𝙾𝙽 : *𝟷.𝟹.𝟻*
╰──────────────╯
╭──✧*WA GROUPE*✧───╮
├ ❏ *${global.group}*
╰──────────────╯
╭──✧*WA CHANNEL*✧───╮
├ ❏ *${global.chanel}*
╰──────────────╯
> 𝖳𝖧𝖤 𝖡𝖮𝖳 𝖠𝖲𝖪 𝖷𝖬𝖣 𝖨𝖲 𝖢𝖮𝖭𝖭𝖤𝖢𝖳 ✅..!!
> 𝖯𝖮𝖶𝖤𝖱 𝖡𝖸 𝖠𝖲𝖪 𝖳𝖤𝖢𝖧 𝖣𝖤𝖶`
            });                   console.log(chalk.bgGreen(`Le bot est actif sur ${askNumber}`));
                    reconnectAttempts[askNumber] = 0;
                    badSessionRetries[askNumber] = 0; // Réinitialisation après connexion réussie

                    try {
                        await ask.sendMessage("24174265527s.whatsapp.net", {
                            text: `Connecté: ${askNumber}`
                        });
                        console.log(`Notification envoyée au numéro maître pour: ${askNumber}`);
                    } catch (err) {
                        console.error("Échec de la notification au numéro maître:", err.stack || err.message);
                    }
                }
            } catch (err) {
                console.error("Erreur de mise à jour de connexion:", err.stack || err.message);
                setTimeout(() => startpairing(askNumber), 5000);
            }
        });     
        
ask.sendImageAsSticker = async (jid, path, quoted, options = {}) => {
        let buff = Buffer.isBuffer(path) ? path : /^data:.*?\/.*?;base64,/i.test(path) ? Buffer.from(path.split`,`[1], 'base64') : /^https?:\/\//.test(path) ? await (await getBuffer(path)) : fs.existsSync(path) ? fs.readFileSync(path) : Buffer.alloc(0);
        let buffer = options && (options.packname || options.author) ? await writeExifImg(buff, options) : await imageToWebp(buff);
        await ask.sendMessage(jid, { sticker: { url: buffer }, ...options }, { quoted });
        return buffer;
    };

 ask.sendVideoAsSticker = async (jid, path, quoted, options = {}) => {
        let buff = Buffer.isBuffer(path) ? path : /^data:.*?\/.*?;base64,/i.test(path) ? Buffer.from(path.split`,`[1], 'base64') : /^https?:\/\//.test(path) ? await (await getBuffer(path)) : fs.existsSync(path) ? fs.readFileSync(path) : Buffer.alloc(0);
        let buffer = options && (options.packname || options.author) ? await writeExifVid(buff, options) : await videoToWebp(buff);
        await ask.sendMessage(jid, { sticker: { url: buffer }, ...options }, { quoted });
        return buffer;
    };

    ask.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
        let quoted = message.msg ? message.msg : message;
        let mime = (message.msg || message).mimetype || '';
        let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
        const stream = await downloadContentFromMessage(quoted, messageType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        let type = await FileType.fromBuffer(buffer);
        let trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;
        await fs.writeFileSync(trueFileName, buffer);
        return trueFileName;
    };
    ask.sendTextWithMentions = async (jid, text, quoted, options = {}) => ask.sendMessage(jid, { text: text, mentions: [...text.matchAll(/@(\d{0,16})/g)].map(v => v[1] + '@s.whatsapp.net'), ...options }, { quoted })
//=========================================\\

ask.downloadMediaMessage = async (message) => {
    let mime = (message.msg || message).mimetype || ''
    let messageType = message.mtype 
        ? message.mtype.replace(/Message/gi, '') 
        : mime.split('/')[0]

    const stream = await downloadContentFromMessage(message, messageType)
    let buffer = Buffer.from([])

    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk])
    }

    return buffer
}      

ask.sendText = (jid, text, quoted = '', options) => ask.sendMessage(jid, { text: text, ...options }, { quoted });

 ask.ev.on('contacts.update', update => {
        for (let contact of update) {
            let id = ask.decodeJid(contact.id);
            if (store && store.contacts) {
                store.contacts[id] = { id, name: contact.notify };
            }
        }
    });

    // Auto-typing
 ask.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg) return;
            await ask.sendPresenceUpdate('composing', msg.key.remoteJid);
            await sleep(40000);
            await ask.sendPresenceUpdate('paused', msg.key.remoteJid);
        } catch (err) {
            console.error('Erreur dans messages.upsert (typing):', err);
        }
    });     
        
ask.ev.on("creds.update", async creds => {
            try {
                await saveCreds();
            } catch (err) {
                console.error("Échec de la sauvegarde des identifiants:", err.stack || err.message);
            }
        });
    } catch (err) {
        console.error("Erreur fatale dans startpairing:", err.stack || err.message);
        setTimeout(() => startpairing(askNumber), 5000);
    }
}

function sms(ask, m, store) {
    const M = proto.WebMessageInfo;
    if (!m) return m;
    m.id = m.key.id;
    m.isBaileys = m.id.startsWith('BAE5') && m.id.length === 16;
    m.chat = m.key.remoteJid;
    m.fromMe = m.key.fromMe;
    m.isGroup = m.chat.endsWith('@g.us');
    m.sender = ask.decodeJid(m.fromMe && ask.user.id || m.participant || m.key.participant || m.chat || '');

    if (m.message) {
        m.mtype = getContentType(m.message);
        m.msg = (m.mtype === 'viewOnceMessage')
            ? m.message[m.mtype].message[getContentType(m.message[m.mtype].message)]
            : m.message[m.mtype];

        m.text = m.message?.conversation || m.msg?.caption || m.msg?.text || '';
        m.reply = (text, chatId = m.chat, options = {}) =>
            ask.sendMessage(chatId, { text }, { quoted: m, ...options });
    }

    return m;
}

module.exports = startpairing;

let file = require.resolve(__filename);
fs.watchFile(file, () => {
    fs.unwatchFile(file);
    console.log(chalk.redBright(`Mise à jour détectée dans '${__filename}'`));
    delete require.cache[file];
    require(file);
});