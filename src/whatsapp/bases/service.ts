import makeWASocket, {
    AnyMessageContent,
    AuthenticationState,
    Browsers,
    ConnectionState,
    Contact,
    DisconnectReason,
    MessageUpsertType,
    MiscMessageGenerationOptions,
    delay,
    downloadMediaMessage,
    fetchLatestBaileysVersion,
    jidDecode,
    jidNormalizedUser,
    promiseTimeout,
} from '@whiskeysockets/baileys'
import { pino } from 'pino'
import QRCodeTerminal from 'qrcode-terminal'
import { QR_TERMINAL } from 'src/config/config'
import { extractViewOnce, formatToJid, sanitizePhoneNumber } from 'src/util/baileys'
import { SendContactDto, SendFileDto, SendLocationDto, SendTextDto } from '../dto/message.dto'
import {
    AuthState,
    GroupData,
    StatusWhatsappService,
    WhatsappError,
    WhatsappMessage,
    WhatsappMessageUpdate,
    WhatsappSocket,
} from '../interface'
import { MediaMessage } from './media'

export abstract class WhatsappBaseService {
    protected contactConnected: Contact
    protected socket: WhatsappSocket
    protected qrcode: string

    constructor(
        protected serviceName = 'Whatsapp Service',
        protected serviceVersion = '0.0.1',
    ) {}

    async initialize() {
        if (this.socket) {
            return
        }
        this.socket = await this.createNewSocket()
        console.log(`Whatsapp service "${this.serviceName}" v${this.serviceVersion} ready`)
    }

    async reInitialize() {
        this.socket.ev.removeAllListeners('connection.update')
        this.socket.ev.removeAllListeners('creds.update')
        this.socket.ev.removeAllListeners('messages.upsert')
        this.socket.ev.removeAllListeners('messages.update')

        this.socket = await this.createNewSocket()

        console.log(`Reinitialize Whatsapp service "${this.serviceName}" v${this.serviceVersion}`)
    }

    async groupData(id: string) {
        if (!id.endsWith('@g.us')) {
            id = `${id}@g.us` } try { const group: GroupData = await this.socket.groupMetadata(id)  if (!group) { return null }  group.participants = await Promise.all( group.participants?.map(async participant => { try { participant.imgUrl = await this.socket.profilePictureUrl(participant.id, 'image') return participant } catch { return participant } }), )  return group } catch (error) { return null } }  async sendText(dto: SendTextDto) { return this.sendMessage(dto.sendTo, { text: dto.message }) }  async sendContact(dto: SendContactDto) { const waid = sanitizePhoneNumber(dto.phoneNumber)  const vcard = [ 'BEGIN:VCARD', 'VERSION:3.0', `FN:${dto.name}`,
            `TEL;type=CELL;type=VOICE;waid=${waid}:${dto.phoneNumber}`,
            'END:VCARD',
        ].join('\n')

        return this.sendMessage(dto.sendTo, {
            contacts: {
                displayName: dto.name,
                contacts: [{ vcard }],
            },
        })
    }

    async sendLocation(dto: SendLocationDto) {
        return this.sendMessage(dto.sendTo, {
            location: { degreesLatitude: dto.lat, degreesLongitude: dto.long },
        })
    }

    async sendFile(dto: SendFileDto) {
        return this.sendMessage(dto.sendTo, {
            document: dto.file,
            caption: dto.caption,
            fileName: dto.fileName,
            mimetype: dto.mimetype,
        })
    }

    async sendImage(dto: SendFileDto) {
        return this.sendMessage(dto.sendTo, {
            image: dto.file,
            caption: dto.caption,
        })
    }

    async convertAndSendSticker(message: WhatsappMessage) {
        if (formatToJid(message?.key?.remoteJid) === formatToJid(this.contactConnected.id)) {
            return false
        }

        const media = new MediaMessage(message)

        const sticker = await media.extractStickerMedia(`${this.serviceName} X${message.pushName}`, this.serviceName)
        if (!sticker) {
            return false
        }

        console.log(`Sending sticker to ${sticker.targetJid}`)
        await this.sendMessage(sticker.targetJid, sticker.message, { quoted: message })
        return true
    }

    async downloadViewOnce(message: WhatsappMessage) {
        const media = new MediaMessage(message)

        const viewOnce = await media.extractViewOnceMedia()
        if (!viewOnce) {
            return false
        }

        console.log(`Sending view once media to ${viewOnce.targetJid}`)
        await this.sendMessage(viewOnce.targetJid, viewOnce.message, { quoted: message })
        return true
    }

    async forwardViewOnce(message: WhatsappMessage) {
        const unwrapped = extractViewOnce(message)
        if (!unwrapped || !this.contactConnected?.id || message.key?.fromMe) {
            return false
        }

        const targetJid = jidNormalizedUser(this.contactConnected.id)
        const buffer = await downloadMediaMessage(unwrapped, 'buffer', {})
        const sender = message.pushName || message.key?.remoteJid?.split('@')[0] || 'Mtu'

        if (unwrapped.message?.imageMessage) {
            const caption = unwrapped.message.imageMessage.caption || ''
            console.log(`Forwarding view once image from ${sender} to${targetJid}`)
            await this.sendMessage(targetJid, {
                image: buffer,
                caption: `*View Once kutoka kwa ${sender}*\n${caption}`.trim(),
            })
            return true
        }

        if (unwrapped.message?.videoMessage) {
            const caption = unwrapped.message.videoMessage.caption || ''
            console.log(`Forwarding view once video from ${sender} to${targetJid}`)
            await this.sendMessage(targetJid, {
                video: buffer,
                caption: `*View Once kutoka kwa ${sender}*\n${caption}`.trim(),
            })
            return true
        }

        if (unwrapped.message?.audioMessage) {
            console.log(`Forwarding view once audio from ${sender} to${targetJid}`)
            await this.sendMessage(targetJid, {
                audio: buffer,
                mimetype: unwrapped.message.audioMessage.mimetype || 'audio/ogg; codecs=opus',
                ptt: unwrapped.message.audioMessage.ptt ?? true,
            })
            return true
        }

        return false
    }

    async autoReply(message: WhatsappMessage): Promise<boolean> {
        if (!message?.message || message.key?.fromMe) {
            return false
        }

        const remoteJid = message.key?.remoteJid
        if (!remoteJid || remoteJid === 'status@broadcast') {
            return false
        }

        const text =
            message.message.conversation ||
            message.message.extendedTextMessage?.text ||
            message.message.imageMessage?.caption ||
            message.message.videoMessage?.caption ||
            ''

        const cmd = text.trim().toLowerCase()
        if (!cmd) {
            return false
        }

        if (cmd === '.menu' || cmd === '#menu' || cmd === 'menu') {
            const menuText =
                `*SUREBOY WHATSAPP BOT*\n\n` +
                `Karibu! Commands zinazopatikana:\n` +
                `1. *.menu* / *#menu* - Orodha ya huduma\n` +
                `2. *.ping* - Pima kasi ya bot\n` +
                `3. *.muda* - Saa
