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

class SimpleRetryCache {
    private store = new Map<string, number>()
    get<T>(key: string): T | undefined {
        return this.store.get(key) as unknown as T
    }
    set<T>(key: string, value: T): boolean {
        this.store.set(key, value as unknown as number)
        if (this.store.size > 500) {
            const first = this.store.keys().next().value
            if (first) this.store.delete(first)
        }
        return true
    }
    del(key: string): void {
        this.store.delete(key)
    }
    flushAll(): void {
        this.store.clear()
    }
}

export abstract class WhatsappBaseService {
    protected contactConnected: Contact
    protected socket: WhatsappSocket
    protected qrcode: string
    private viewOnceCache = new Map<string, any>()
    private lastViewOnceByChat = new Map<string, any>()
    private rawMessageStore = new Map<string, any>()
    private msgRetryCounterCache = new SimpleRetryCache()

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

    private unwrapAnyViewOnce(msgContent: any): any {
        if (!msgContent) return null

        const raw = msgContent.ephemeralMessage?.message || msgContent
        const wrapper =
            raw.viewOnceMessage ||
            raw.viewOnceMessageV2 ||
            raw.viewOnceMessageV2Extension

        const inner = wrapper?.message || raw
        if (!inner) return null

        const isViewOnce =
            !!wrapper ||
            inner.imageMessage?.viewOnce ||
            inner.videoMessage?.viewOnce ||
            inner.audioMessage?.viewOnce

        if (!isViewOnce) return null

        const copy: any = { ...inner }
        if (copy.imageMessage) {
            copy.imageMessage = { ...copy.imageMessage, viewOnce: false }
            return copy
        }
        if (copy.videoMessage) {
            copy.videoMessage = { ...copy.videoMessage, viewOnce: false }
            return copy
        }
        if (copy.audioMessage) {
            copy.audioMessage = { ...copy.audioMessage, viewOnce: false }
            return copy
        }
        return null
    }

    private cacheIncomingViewOnce(message: WhatsappMessage) {
        try {
            if (message?.key?.id && message?.message) {
                this.rawMessageStore.set(message.key.id, message.message)
                if (this.rawMessageStore.size > 300) {
                    const first = this.rawMessageStore.keys().next().value
                    if (first) this.rawMessageStore.delete(first)
                }
            }

            if (!message?.message) return
            const unwrappedInner = this.unwrapAnyViewOnce(message.message)
            if (unwrappedInner) {
                const storedMsg = {
                    key: message.key,
                    message: unwrappedInner,
                }
                if (message.key?.id) {
                    this.viewOnceCache.set(message.key.id, storedMsg)
                }
                if (message.key?.remoteJid) {
                    this.lastViewOnceByChat.set(message.key.remoteJid, storedMsg)
                }
                console.log(`[VV CACHE] Imehifadhi View Once kutoka ${message.key?.remoteJid} (ID: ${message.key?.id})`)
            }
        } catch (e) {
            console.error('[VV CACHE] Error:', e)
        }
    }

    async downloadViewOnce(message: WhatsappMessage): Promise<boolean> {
        try {
            if (!message?.message || !this.contactConnected?.id) {
                return false
            }

            const text =
                message.message.conversation ||
                message.message.extendedTextMessage?.text ||
                ''
            const cmd = text.trim().toLowerCase()

            if (!['.vv', '.vvo', '#dvo', '.dvo', '.vv dm', '.vvo dm', '#dvo dm'].includes(cmd)) {
                return false
            }

            const contextInfo = message.message.extendedTextMessage?.contextInfo
            const stanzaId = contextInfo?.stanzaId
            const quotedMsg = contextInfo?.quotedMessage
            const remoteJid = message.key?.remoteJid

            let targetMessage: any =
                (stanzaId ? this.viewOnceCache.get(stanzaId) : null) ||
                (remoteJid ? this.lastViewOnceByChat.get(remoteJid) : null)

            if (!targetMessage && quotedMsg) {
                const unwrappedInner = this.unwrapAnyViewOnce(quotedMsg)
                if (unwrappedInner) {
                    const mediaObj =
                        unwrappedInner.imageMessage ||
                        unwrappedInner.videoMessage ||
                        unwrappedInner.audioMessage
                    if (mediaObj && !mediaObj.url && mediaObj.directPath) {
                        mediaObj.url = `https://mmg.whatsapp.net${mediaObj.directPath}`
                    }
                    targetMessage = {
                        key: {
                            remoteJid,
                            id: stanzaId || message.key?.id,
                            participant: contextInfo?.participant,
                        },
                        message: unwrappedInner,
                    }
                }
            }

            if (!targetMessage) {
                await this.sendMessage(
                    remoteJid,
                    { text: '_View Once haikupatikana kwenye memory (huenda ilitumwa kabla bot haijawaka)._' },
                    { quoted: message },
                )
                return false
            }

            console.log('[VV] Inapakua media...')
            const buffer = await downloadMediaMessage(targetMessage, 'buffer', {})
            const myJid = jidNormalizedUser(this.contactConnected.id)
            const destinationJid = cmd.endsWith('dm') ? myJid : remoteJid
            const innerMsg = targetMessage.message

            if (innerMsg?.imageMessage) {
                const caption = innerMsg.imageMessage.caption || ''
                await this.sendMessage(
                    destinationJid,
                    { image: buffer, caption: caption || '_Opened by SUREBOY Bot_' },
                    { quoted: message },
                )
                return true
            }

            if (innerMsg?.videoMessage) {
                const caption = innerMsg.videoMessage.caption || ''
                await this.sendMessage(
                    destinationJid,
                    { video: buffer, caption: caption || '_Opened by SUREBOY Bot_' },
                    { quoted: message },
                )
                return true
            }

            if (innerMsg?.audioMessage) {
                await this.sendMessage(
                    destinationJid,
                    {
                        audio: buffer,
                        mimetype: innerMsg.audioMessage.mimetype || 'audio/ogg; codecs=opus',
                        ptt: innerMsg.audioMessage.ptt ?? true,
                    },
                    { quoted: message },
                )
                return true
            }

            return false
        } catch (err) {
            console.error('downloadViewOnce error:', err)
            if (message?.key?.remoteJid) {
                await this.sendMessage(
                    message.key.remoteJid,
                    { text: `_Imeshindwa kufungua View Once: ${err?.message || 'Media key haikupatikana'}_` },
                    { quoted: message },
                ).catch(() => {})
            }
            return false
        }
    }

    async forwardViewOnce(message: WhatsappMessage) {
        try {
            const unwrappedInner = this.unwrapAnyViewOnce(message?.message)
            if (!unwrappedInner || !this.contactConnected?.id || message.key?.fromMe) {
                return false
            }

            const targetJid = jidNormalizedUser(this.contactConnected.id)
            const msgToDownload: any = { key: message.key, message: unwrappedInner }
            const buffer = await downloadMediaMessage(msgToDownload, 'buffer', {})
            const sender = message.pushName || message.key?.remoteJid?.split('@')[0] || 'Mtu'

            if (unwrappedInner.imageMessage) {
                const caption = unwrappedInner.imageMessage.caption || ''
                console.log(`Forwarding view once image from ${sender} to ${targetJid}`)
                await this.sendMessage(targetJid, {
                    image: buffer,
                    caption: `*View Once kutoka kwa ${sender}*\n${caption}`.trim(),
                })
                return true
            }

            if (unwrappedInner.videoMessage) {
                const caption = unwrappedInner.videoMessage.caption || ''
                console.log(`Forwarding view once video from ${sender} to ${targetJid}`)
                await this.sendMessage(targetJid, {
                    video: buffer,
                    caption: `*View Once kutoka kwa ${sender}*\n${caption}`.trim(),
                })
                return true
            }

            if (unwrappedInner.audioMessage) {
                console.log(`Forwarding view once audio from ${sender} to ${targetJid}`)
                await this.sendMessage(targetJid, {
                    audio: buffer,
                    mimetype: unwrappedInner.audioMessage.mimetype || 'audio/ogg; codecs=opus',
                    ptt: unwrappedInner.audioMessage.ptt ?? true,
                })
                return true
            }

            return false
        } catch (err) {
            console.error('forwardViewOnce error:', err)
            return false
        }
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
            const menuText = [
                '*SUREBOY WHATSAPP BOT*',
                '',
                'Karibu! Commands zinazopatikana:',
                '1. *.menu* / *#menu* - Orodha ya huduma',
                '2. *.ping* - Pima kasi ya bot',
                '3. *.muda* - Saa na tarehe ya Tanzania',
                '4. *.owner* - Taarifa za mmiliki',
                '5. *#sticker* - Tuma picha yenye caption #sticker',
                '6. *.vv* / *.vvo* / *#dvo* - Reply View Once kuifungua',
                '',
                '_Powered by SUREBOY_',
            ].join('\n')
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
            const greetText = [
                `Habari *${message.pushName || 'Rafiki'}*! Asante kwa kuwasiliana nasi.`,
                'Nimepokea ujumbe wako. Andika *.menu* kuona huduma zinazopatikana au subiri kidogo nitakujibu punde.',
            ].join('\n')
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
        const { version } = await fetchLatestBaileysVersion()

        const socket = makeWASocket({
            version: version,
            auth: state,
            logger: pino({ level: 'silent' }) as any,
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            msgRetryCounterCache: this.msgRetryCounterCache as any,
            getMessage: async key => {
                if (key?.id && this.rawMessageStore.has(key.id)) {
                    return this.rawMessageStore.get(key.id)
                }
                return undefined
            },
        })

        socket.ev.on('connection.update', update => this.onConnectionUpdate(socket, state, update))
        socket.ev.on('creds.update', saveCreds)
        socket.ev.on('messages.upsert', chats => this.onNewMessage(chats))
        socket.ev.on('messages.update', chats => this.onUpdateMessage(chats))

        return socket
    }

    protected newMessageListeners = async (message: WhatsappMessage): Promise<boolean[]> => {
        this.cacheIncomingViewOnce(message)
        return await Promise.all([
            this.autoReply(message),
            this.convertAndSendSticker(message),
            this.downloadViewOnce(message),
            this.forwardViewOnce(message),
        ])
    }

    private async onNewMessage(messages: { messages: WhatsappMessage[]; type: MessageUpsertType }) {
        console.log(`[MSG IN] type=${messages.type}, count=${messages.messages?.length}`)
        return Promise.all(
            messages?.messages?.map(async message => {
                try {
                    console.log('RAW MSG:', JSON.stringify(message.message))
                    await this.newMessageListeners(message)
                } catch (error) {
                    console.error(`new message listener error: ${error}`)
                }
            }),
        )
    }

    protected updateMessageListeners = async (message: WhatsappMessageUpdate): Promise<boolean[]> => {
        return await Promise.all([!!message])
    }

    private async onUpdateMessage(messages: WhatsappMessageUpdate[]) {
        return Promise.all(
            messages?.map(async message => {
                try {
                    if (message?.update?.message) {
                        const reconstructed: any = {
                            key: message.key,
                            message: message.update.message,
                        }
                        this.cacheIncomingViewOnce(reconstructed)
                        await this.forwardViewOnce(reconstructed)
                    }
                    await this.updateMessageListeners(message)
                } catch (error) {
                    console.error(`update message listener error: ${error}`)
                }
            }),
        )
    }

    private async onConnectionUpdate(
        socket: WhatsappSocket,
        state: AuthenticationState,
        update: Partial<ConnectionState>,
    ): Promise<void> {
        const { connection, lastDisconnect } = update

        this.qrcode = update.qr
        if (update.qr && QR_TERMINAL) {
            console.log('\n')
            QRCodeTerminal.generate(update.qr, { small: true })
            console.log('Scan QRCode to connect your whatsapp\n')
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as any)?.output?.statusCode

            if (statusCode === DisconnectReason.loggedOut) {
                await this.removeSession()
                delete this.contactConnected

                console.log('Whatsapp logged out')
            }

            console.log(`Connection close (${statusCode}): ${lastDisconnect?.error}`)
            if (statusCode !== 403) {
                await this.reInitialize()
            }
            return
        }

        if (connection === 'open') {
            this.contactConnected = {
                ...state.creds.me,
                id: jidDecode(state.creds.me?.id)?.user,
            }
            delete this.qrcode

            await socket.sendPresenceUpdate('unavailable')

            console.log(`Whatsapp connected to ${this.contactConnected.id}`)
            return
        }
    }

    private checkIsConnected() {
        const status = this.getStatus()

        if (!status.isConnected) throw new WhatsappError('Whatsapp not connected yet')
    }

    private isShouldResend(error: any): boolean {
        if (error === 1006) return true

        const payload = error?.output?.payload

        if (!payload) return false

        return (
            payload.statusCode === 428 &&
            payload.error === 'Precondition Required' &&
            payload.message === 'Connection Closed'
        )
    }
}
