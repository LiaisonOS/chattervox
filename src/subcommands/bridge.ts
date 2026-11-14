import { Config } from '../config'
import { Keystore } from '../Keystore'
import { Messenger, MessageEvent, Verification } from '../Messenger'
import { stationToCallsignSSID, isCallsign } from '../utils'
import * as readline from 'readline'

//
// bridge — a headless JSON-lines adapter around Messenger so a GUI front-end
// (QtChattervox) can drive chattervox over stdin/stdout. It reuses the exact
// same engine as `chat` (KISS, AX.25, deflate, signing/verification), so a
// GUI built on it interoperates with every other chattervox station on air.
//
// Protocol: one JSON object per line, UTF-8, '\n'-terminated.
//
// CHANNELS: chattervox addresses by a 1-6 char alphanumeric name in the AX.25
// destination field. "CQ" is the default room; any other name (EMCOMM, EOC,
// NET1 …) is a chat room. A message addressed directly to our callsign is a
// DM. Every rx/tx carries a `channel` tag so the GUI can route it to a pane:
//   - room message  -> channel = the room name ("CQ", "EMCOMM", …)
//   - direct to us   -> channel = the OTHER station's callsign-ssid (a DM)
// We only surface rooms the GUI has joined (CQ is always joined), plus DMs.
//
// Bridge -> GUI (stdout):
//   {"type":"ready","callsign":"VA2OPS","ssid":0,"signing":true,"rooms":["CQ"]}
//   {"type":"status","state":"open"|"close"|"tnc-error","error"?:"..."}
//   {"type":"rooms","rooms":["CQ","EMCOMM"]}              // after join/leave
//   {"type":"rx","from":"VA2XYZ-1","to":"CQ","channel":"CQ","kind":"room",
//                "message":"hi","verification":"Valid","ts":...}
//   {"type":"tx","to":"CQ","channel":"CQ","kind":"room","message":"hello","ts":...}
//   {"type":"beacon","from":"VA2GWM","text":"QRV Montreal","verification":"Valid","ts":...}
//   {"type":"beacon-sent","text":"QRV","ts":...}         // our own beacon went out
//   {"type":"error","error":"..."}
//
// GUI -> Bridge (stdin):
//   {"type":"tx","to":"CQ","text":"hello","sign":true}   // to/sign optional
//   {"type":"join","room":"EMCOMM"}
//   {"type":"leave","room":"EMCOMM"}
//   {"type":"beacon","action":"start","intervalMin":15,"text":"QRV Montreal"}
//   {"type":"beacon","action":"stop"}
//   {"type":"beacon","action":"once","text":"QRV"}       // send one beacon now
//   {"type":"mail","to":"VA2GWM","id":"k3f9a","subject":"Sked","body":"meet 1900Z 40m"}
//
// Beacons broadcast to the AX.25 address "BEACON"; the bridge always listens
// for it and emits a `beacon` event (never a chat message) for the roster.
// Mail carries a \x01MAIL\x01<id>\x01<subj>\x01<body> sentinel; the bridge files
// it (addressed-to-us only), emits a `mail` event + a `mail-sent` echo on send,
// and AUTO-ACKs on receipt with \x01MACK\x01<id> -> sender gets a `mail-ack`
// event ({from,id,ts}). Duplicate ids are de-duped (filed once) but re-acked.
//

function emit(obj: any): void {
    // One compact JSON object per line. stdout to a pipe is line-safe.
    process.stdout.write(JSON.stringify(obj) + '\n')
}

export async function main(args: any, conf: Config, ks: Keystore): Promise<number> {

    const messenger = new Messenger(conf, ks)

    // Sign by default ONLY when config.signingKey actually matches a keypair in
    // the keystore for the CURRENT callsign. After a station rename the old key
    // won't match — degrade to unsigned instead of crashing, and warn the GUI.
    let signDefault = false
    let signingWarning = ''
    if (typeof conf.signingKey === 'string' && conf.signingKey.length > 0) {
        let hasKey = false
        try {
            hasKey = ks.getKeyPairs(conf.callsign)
                       .some((k: any) => k.public === conf.signingKey)
        } catch (e) { hasKey = false }
        if (hasKey) signDefault = true
        else signingWarning = `No signing key for ${conf.callsign} in the keystore — sending UNSIGNED. ` +
                              `Run "chattervox genkey" (or restart the Chattervox mode) to create one.`
    }

    // Rooms we're listening to. CQ is always joined. Names are upper-cased and
    // validated against the AX.25 callsign rule (1-6 alphanumeric chars).
    const joined: Set<string> = new Set<string>(['CQ'])
    const roomList = (): string[] => Array.from(joined)

    // Presence beacons. Beacons are broadcast to the dedicated AX.25 address
    // "BEACON"; we always listen for them (regardless of joined rooms) and feed
    // them to the GUI's Stations-on-Air roster instead of a chat tab.
    const BEACON_ADDR = 'BEACON'
    let beaconTimer: ReturnType<typeof setInterval> | null = null
    let beaconText = 'QRV'
    const sendBeacon = async () => {
        try {
            await messenger.send(BEACON_ADDR, beaconText || 'QRV', signDefault)
            emit({ type: 'beacon-sent', text: beaconText || 'QRV', ts: Date.now() })
        } catch (err) {
            emit({ type: 'error',
                   error: `beacon failed: ${String(err && (err as any).message ? (err as any).message : err)}` })
        }
    }

    // Mail: a store-and-forward message (subject + body) to one callsign. It
    // rides the same transport as chat but carries a control-char sentinel the
    // chat UI can never produce, so the receiver files it into the Inbox rather
    // than a chat tab. Format: \x01MAIL\x01<subject>\x01<body>
    const MAIL_PREFIX = '\x01MAIL\x01'   // \x01MAIL\x01<id>\x01<subject>\x01<body>
    const MACK_PREFIX = '\x01MACK\x01'   // \x01MACK\x01<id>  (ack on receipt)
    const MAIL_SUBJ_MAX = 60
    const MAIL_BODY_MAX = 500
    const seenMailIds: Set<string> = new Set<string>()   // de-dup filed mail

    // Classify an incoming/outgoing station pair into a channel + kind.
    //  - addressed to us  -> DM, channel = the other station
    //  - otherwise        -> room, channel = the destination name
    const classify = (to: { callsign: string, ssid: number },
                      other: string): { channel: string, kind: string } => {
        if (to.callsign === conf.callsign && to.ssid === conf.ssid)
            return { channel: other, kind: 'dm' }
        return { channel: to.callsign, kind: 'room' }
    }

    messenger.on('close', () => {
        emit({ type: 'status', state: 'close' })
        process.exit(1)
    })

    messenger.on('tnc-error', (err: any) => {
        emit({ type: 'status', state: 'tnc-error',
               error: String(err && err.message ? err.message : err) })
    })

    messenger.on('message', (message: MessageEvent) => {
        const fromStr = stationToCallsignSSID(message.from)
        // Mail? Structured id+subject+body — file into the Inbox, never a chat
        // tab. Only mail addressed to US (not overheard mail for others).
        if (message.message.startsWith(MAIL_PREFIX)) {
            if (!(message.to.callsign === conf.callsign && message.to.ssid === conf.ssid))
                return
            const rest = message.message.slice(MAIL_PREFIX.length)
            const i1 = rest.indexOf('\x01')
            const i2 = i1 >= 0 ? rest.indexOf('\x01', i1 + 1) : -1
            const id = i1 >= 0 ? rest.slice(0, i1) : ''
            const subject = (i1 >= 0 && i2 >= 0) ? rest.slice(i1 + 1, i2) : ''
            const body = i2 >= 0 ? rest.slice(i2 + 1)
                        : (i1 >= 0 ? rest.slice(i1 + 1) : rest)
            // Auto-ack on receipt — ALWAYS (even a duplicate: the sender retried
            // because our earlier ack was lost). Fire-and-forget.
            if (id)
                messenger.send(fromStr, MACK_PREFIX + id, signDefault).catch(() => {})
            // De-dup filing: don't file the same mail twice.
            if (id && seenMailIds.has(id)) return
            if (id) seenMailIds.add(id)
            emit({
                type: 'mail',
                from: fromStr,
                to: stationToCallsignSSID(message.to),
                id, subject, body,
                verification: Verification[message.verification],
                ts: Date.now()
            })
            return
        }
        // Mail acknowledgement from a station we sent mail to.
        if (message.message.startsWith(MACK_PREFIX)) {
            const id = message.message.slice(MACK_PREFIX.length)
            emit({ type: 'mail-ack', from: fromStr, id, ts: Date.now() })
            return
        }
        // Presence beacon? Feed the roster, never a chat tab. Always surfaced.
        if (message.to.callsign === BEACON_ADDR) {
            emit({
                type: 'beacon',
                from: fromStr,
                text: message.message,
                verification: Verification[message.verification],
                ts: Date.now()
            })
            return
        }
        const { channel, kind } = classify(message.to, fromStr)
        // Show DMs to us, and rooms we've joined. Drop rooms we're not in.
        if (kind !== 'dm' && !joined.has(channel)) return
        emit({
            type: 'rx',
            from: fromStr,
            to: stationToCallsignSSID(message.to),
            channel,
            kind,
            message: message.message,
            verification: Verification[message.verification], // enum -> name
            ts: Date.now()
        })
    })

    try {
        await messenger.openTNC()
    } catch (err) {
        emit({ type: 'status', state: 'tnc-error',
               error: `Could not open the KISS TNC at ${conf.kissPort}. Is the TNC running?` })
        return 1
    }

    emit({ type: 'status', state: 'open' })
    emit({ type: 'ready', callsign: conf.callsign, ssid: conf.ssid,
           signing: signDefault, rooms: roomList() })
    if (signingWarning) emit({ type: 'error', error: signingWarning })

    // Read newline-delimited JSON commands from the GUI.
    const rl = readline.createInterface({ input: process.stdin })
    rl.on('line', async (line: string) => {
        line = line.trim()
        if (line === '') return
        let cmd: any
        try {
            cmd = JSON.parse(line)
        } catch (err) {
            emit({ type: 'error', error: `bad JSON command: ${line}` })
            return
        }

        if (cmd.type === 'tx') {
            const to: string = (typeof cmd.to === 'string' && cmd.to.length > 0) ? cmd.to : 'CQ'
            const text: string = typeof cmd.text === 'string' ? cmd.text : ''
            const sign: boolean = typeof cmd.sign === 'boolean' ? cmd.sign : signDefault
            if (text === '') return
            try {
                await messenger.send(to, text, sign)
                const kind = (to === 'CQ' || joined.has(to.toUpperCase())) ? 'room' : 'dm'
                emit({ type: 'tx', to, channel: to, kind, message: text, ts: Date.now() })
            } catch (err) {
                emit({ type: 'error',
                       error: `send failed: ${String(err && (err as any).message ? (err as any).message : err)}` })
            }
        }
        else if (cmd.type === 'join') {
            const room = String(cmd.room || '').toUpperCase()
            if (!isCallsign(room)) {
                emit({ type: 'error',
                       error: `invalid room "${cmd.room}" — 1-6 letters/digits (AX.25 limit)` })
                return
            }
            joined.add(room)
            emit({ type: 'rooms', rooms: roomList() })
        }
        else if (cmd.type === 'leave') {
            const room = String(cmd.room || '').toUpperCase()
            if (room !== 'CQ') joined.delete(room)   // CQ can't be left
            emit({ type: 'rooms', rooms: roomList() })
        }
        else if (cmd.type === 'mail') {
            const to = String(cmd.to || '').trim()
            // id + subject must not contain the \x01 delimiter; clamp fields.
            const id = String(cmd.id || '').replace(/[\x00-\x1f]/g, '').slice(0, 12)
            const subject = String(cmd.subject || '')
                .replace(/[\x00-\x08\x0e-\x1f]/g, ' ').slice(0, MAIL_SUBJ_MAX)
            const body = String(cmd.body || '').slice(0, MAIL_BODY_MAX)
            if (!to) { emit({ type: 'error', error: 'mail: missing recipient' }); return }
            const payload = MAIL_PREFIX + id + '\x01' + subject + '\x01' + body
            try {
                await messenger.send(to, payload, signDefault)
                emit({ type: 'mail-sent', to, id, subject, ts: Date.now() })
            } catch (err) {
                emit({ type: 'error',
                       error: `mail failed: ${String(err && (err as any).message ? (err as any).message : err)}` })
            }
        }
        else if (cmd.type === 'beacon') {
            if (cmd.action === 'start') {
                if (typeof cmd.text === 'string') beaconText = cmd.text
                const mins = Number(cmd.intervalMin) > 0 ? Number(cmd.intervalMin) : 15
                if (beaconTimer) clearInterval(beaconTimer)
                sendBeacon()                                   // beacon once now
                beaconTimer = setInterval(sendBeacon, mins * 60 * 1000)
            } else if (cmd.action === 'stop') {
                if (beaconTimer) { clearInterval(beaconTimer); beaconTimer = null }
            } else if (cmd.action === 'once') {
                if (typeof cmd.text === 'string') beaconText = cmd.text
                sendBeacon()
            }
        }
        else {
            emit({ type: 'error', error: `unknown command type: ${cmd.type}` })
        }
    })

    // Stay alive until the TNC closes or we're signalled.
    return await new Promise<number>(() => { /* never resolves */ })
}
