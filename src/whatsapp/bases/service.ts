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
            id = `${id}@g.us`
        }
        try {
            const group: GroupData = await this.socket.groupMetadata(id)

            if (!group) {
                return null
            }

            group.participants = await Promise.all(
                group.participants?.map(async participant => {
                    try {
                        participant.imgUrl = await this.socket.profilePictureUrl(participant.id, 'image')
                        return participant
                    } catch {
                        return participant
                    }
                }),
            )

            return group
        } catch (error) {
            return null
        }
    }

    async sendText(dto: SendTextDto) {
        return this.sendMessage(dto.sendTo, { text: dto.message })
    }

    async sendContact(dto: SendContactDto) {
        const waid = sanitizePhoneNumber(dto.phoneNumber)

        const vcard = [
            'BEGIN:VCARD',
            'VERSION:3.0',
            `FN:${dto.name}`,
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

        const sticker = await media.extractStickerMedia(`${this.serviceName} X ${message.pushName}`, this.serviceName)
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
        const forwardMessage = extractViewOnce(message)
        if (!forwardMessage || !this.contactConnected.id) {
            return false
        }

        const targetJid = jidNormalizedUser(this.contactConnected.id)
        console.log(`Forward view once to ${targetJid}`)
        await this.sendMessage(targetJid, { forward: forwardMessage }, { quoted: message })
        return true
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
                `3. *.muda* - Saa na tarehe ya Tanzania\n` +
                `4. *.owner* - Taarifa za mmiliki\n` +
                `5. *#sticker* - Tuma picha yenye caption #sticker\n\n` +
                `_Powered by SUREBOY_`
            await this.sendMessage(remoteJid, { text: menuText }, { quoted: message })
            return true
        }

        if (cmd === '.ping' || cmd === '#ping') {
            await this.sendMessage(remoteJid, { text: 'Pong! SUREBOY Bot iko hewani na inafanya kazi kikamilifu.' }, { quoted: message })
            return true
        }

        if (cmd === '.muda' || cmd === '#muda') {
            const now = new Date().toLocaleString('sw-TZ', { timeZone: 'Africa/Dar_es_Salaam' })
            await this.sendMessage(remoteJid, { text: `Saa na tarehe (Dar es Salaam): *${now}*` }, { quoted: message })
            return true
        }

        if (cmd === '.owner' || cmd === '#owner') {
            await this.sendMessage(remoteJid, { text: 'Bot hii inamilikiwa na kusimamiwa na *SUREBOY*.' }, { quoted: message })
            return true
        }

        if (cmd === 'mambo' || cmd === 'habari' || cmd === 'hi' || cmd === 'hello' || cmd === 'niaje' || cmd === 'salamu') {
            const greetText =
                `Habari *${message.pushName || 'Rafiki'}*! Asante kwa kuwasiliana nasi.\n` +
                `Nimepokea ujumbe wako. Andika *.menu* kuona huduma zinazopatikana au subiri kidogo nitakujibu punde.`
            await this.sendMessage(remoteJid, { text: greetText }, { quoted: message })
            return true
        }

        return false
    }

    protected abstract removeSession(): Promise<void>

    async logout() {
        this.checkIsConnected()

        await this.socket.logout()

        await this.removeSession()

        delete this.contactConnected
        await this.reInitialize()

        return true
    }

    getStatus(): StatusWhatsappService {
        return {
            isConnected: !this.qrcode && !!this.contactConnected?.id,
            contactConnected: this.contactConnected,
            qrcode: this.qrcode,
        }
    }

    protected async sendMessage(
        phoneNumber: string,
        content: AnyMessageContent,
        options?: MiscMessageGenerationOptions,
        recursive?: number,
    ): Promise<WhatsappMessage> {
        try {
            this.checkIsConnected()

            return await promiseTimeout(1000 * 15, async (resolve, reject) => {
                try {
                    const jid = formatToJid(phoneNumber)
                    await this.socket.presenceSubscribe(jid)
                    await delay(1 * 1000)
                    await this.socket.sendPresenceUpdate('composing', jid)
                    await delay(2 * 1000)
                    await this.socket.sendPresenceUpdate('paused', jid)
                    await delay(1 * 1000)
                    const message = await this.socket.sendMessage(jid, content, options)
                    resolve(message)
                } catch (error) {
                    reject(error)
                }
            })
        } catch (error) {
            if (this.isShouldResend(error) && (recursive || 0) < 20) {
                await delay(500)
                return await this.sendMessage(phoneNumber, content, options, (recursive || 0) + 1)
            }

            throw error
        }
    }

    protected abstract makeAuthState(): Promise<AuthState>

    private async createNewSocket(): Promise<WhatsappSocket> {
        const { state, saveCreds } = await this.makeAuthState()
        const { version } = await
