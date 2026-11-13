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
//   {"type":"error","error":"..."}
//
// GUI -> Bridge (stdin):
//   {"type":"tx","to":"CQ","text":"hello","sign":true}   // to/sign optional
//   {"type":"join","room":"EMCOMM"}
//   {"type":"leave","room":"EMCOMM"}
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
                // Tag the echo with the channel so the GUI renders it in the
                // right tab. CQ or a joined room name => room; anything else
                // (a specific callsign we're messaging) => DM.
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
        else {
            emit({ type: 'error', error: `unknown command type: ${cmd.type}` })
        }
    })

    // Stay alive until the TNC closes or we're signalled.
    return await new Promise<number>(() => { /* never resolves */ })
}
