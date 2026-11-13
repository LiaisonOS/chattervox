import { Config } from '../config'
import { Keystore } from '../Keystore'
import { Messenger, MessageEvent, Verification } from '../Messenger'
import { stationToCallsignSSID } from '../utils'
import * as readline from 'readline'

//
// bridge — a headless JSON-lines adapter around Messenger so a GUI front-end
// (QtChattervox) can drive chattervox over stdin/stdout. It reuses the exact
// same engine as `chat` (KISS, AX.25, deflate, signing/verification), so a
// GUI built on it interoperates with every other chattervox station on air.
//
// Protocol: one JSON object per line, UTF-8, '\n'-terminated.
//
// Bridge -> GUI (stdout):
//   {"type":"ready","callsign":"VA2OPS","ssid":0,"signing":true}
//   {"type":"status","state":"open"}
//   {"type":"status","state":"close"}
//   {"type":"status","state":"tnc-error","error":"..."}
//   {"type":"rx","from":"VA2XYZ-1","to":"CQ","message":"hi",
//                "verification":"Valid","ts":1699999999999}
//   {"type":"tx","to":"CQ","message":"hello","ts":...}   // echo of our own send
//   {"type":"error","error":"..."}
//
// GUI -> Bridge (stdin):
//   {"type":"tx","to":"CQ","text":"hello","sign":true}   // sign optional
//

function emit(obj: any): void {
    // One compact JSON object per line. stdout to a pipe is line-safe.
    process.stdout.write(JSON.stringify(obj) + '\n')
}

export async function main(args: any, conf: Config, ks: Keystore): Promise<number> {

    const messenger = new Messenger(conf, ks)
    // Sign by default when the config has a signing key (same rule as `chat`).
    const signDefault: boolean = typeof conf.signingKey === 'string'

    messenger.on('close', () => {
        emit({ type: 'status', state: 'close' })
        process.exit(1)
    })

    messenger.on('tnc-error', (err: any) => {
        emit({ type: 'status', state: 'tnc-error',
               error: String(err && err.message ? err.message : err) })
    })

    messenger.on('message', (message: MessageEvent) => {
        // Surface broadcasts (CQ) and messages addressed to us — same filter
        // the terminal `chat` uses. (The station sidebar in a later slice can
        // widen this; Slice 0 mirrors chat exactly.)
        if (message.to.callsign === 'CQ' ||
           (message.to.callsign === conf.callsign &&
            message.to.ssid === conf.ssid)) {
            emit({
                type: 'rx',
                from: stationToCallsignSSID(message.from),
                to: stationToCallsignSSID(message.to),
                message: message.message,
                verification: Verification[message.verification], // enum -> name
                ts: Date.now()
            })
        }
    })

    try {
        await messenger.openTNC()
    } catch (err) {
        emit({ type: 'status', state: 'tnc-error',
               error: `Could not open the KISS TNC at ${conf.kissPort}. Is the TNC running?` })
        return 1
    }

    emit({ type: 'status', state: 'open' })
    emit({ type: 'ready', callsign: conf.callsign, ssid: conf.ssid, signing: signDefault })

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
                // Echo our own message back so the GUI renders it from a single
                // source of truth (no optimistic local bubble to reconcile).
                emit({ type: 'tx', to, message: text, ts: Date.now() })
            } catch (err) {
                emit({ type: 'error',
                       error: `send failed: ${String(err && (err as any).message ? (err as any).message : err)}` })
            }
        } else {
            emit({ type: 'error', error: `unknown command type: ${cmd.type}` })
        }
    })

    // Stay alive until the TNC closes or we're signalled.
    return await new Promise<number>(() => { /* never resolves */ })
}
