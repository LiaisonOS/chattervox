'use strict';
const EventEmitter = require('events');
const { Socket } = require('net');

const defs = {
    framing : {
    	fend : (1<<6)|(1<<7),
    	fesc : (1<<0)|(1<<1)|(1<<3)|(1<<4)|(1<<6)|(1<<7),
    	tfend : (1<<2)|(1<<3)|(1<<4)|(1<<6)|(1<<7),
    	tfesc : (1<<0)|(1<<2)|(1<<3)|(1<<4)|(1<<6)|(1<<7),
    },
    commands : {
    	data : 0,
    	tx_delay : 1,
    	persistence : 2,
    	slot_time : 3,
    	tx_tail : 4,
    	duplex : 5,
    	set_hardware : 6,
    	exit_kiss : 255
    }
};

function valid_numeric_setting(setting, value) {
    if (typeof value != 'number' || value < 0 || value > 255) {
        throw `Invalid ${setting}: ${value}`;
    }
}

class KISS_TNC extends EventEmitter {

    constructor (device, baud_rate) {

        super();

        let socket = null
        let serial = null
        // rx_buffer MUST persist across 'data' events: a KISS frame can arrive
        // split across chunks (USB CDC hands up arbitrary ~64-byte boundaries).
        // It was a plain local passed into _on_data_rx, where reassignment only
        // updated the parameter — so every event started from empty and any
        // split frame was lost (broke USB KISS RX; BT slipped by delivering
        // whole frames per chunk). Make it an instance field.
        this._rx_buffer = Buffer.from([]);

        // if the device is a network location
        if (device.startsWith('kiss://')) {

            let openCallback = null
            const network_location = device.substring(7)
            const split = network_location.split(':')
            if (split.length != 2) {
                throw TypeError('kiss:// device location must be in the format "kiss://host:port".')
            }
            const host = split[0]
            const port = parseInt(split[1])
            if (isNaN(port)) throw TypeError('kiss:// device must include a valid port number.')
            else if (port < 0 || port > 65535) {
                throw TypeError('kiss:// device port must be an integer between 0 and 65535.')
            }

            socket = new Socket({ readable: true, writable: true })
            socket.on('error', (err) => {
                if (openCallback) openCallback(err)
                this.emit('error', err)
            })
            socket.on('data', (data) => this._on_data_rx(data))

            this.open = (callback) => {
                openCallback = callback
                socket.on('connect', () => {
                    openCallback = null
                    callback()
                })
                socket.connect({ host, port })
            }

            this.close = (callback) => {
                socket.on('close', callback)
                socket.end()
            }

        // if the device is a serial device
        } else {
            // Modern serialport API (v10+): destructured import, options object
            const { SerialPort } = require('serialport');
            serial = new SerialPort({ path: device, baudRate: baud_rate, autoOpen: false });
            serial.on('error', (err) => this.emit('error', err));
            serial.on('data', (data) => this._on_data_rx(data));
            this.open = (callback) => serial.open(callback);
            this.close = (callback) => serial.close(callback);
        }

        this._send_command = function (command, port = 0, data = Buffer.from([]), callback = () => {}) {
            if (typeof command != 'number' || command < 0 || (command > 6 && command != 255)) {
                throw `Invalid command ${command}`;
            } else if (!Buffer.isBuffer(data)) {
                throw `Invalid data ${data}`;
            } else {
                const tx_buffer = this._get_tx_buffer(command, port, data)
                if (serial != null) {
                    serial.write(tx_buffer);
                    serial.drain(callback);
                } else if (socket != null) {
                    socket.write(Buffer.from(tx_buffer), null, callback)
                } else {
                    throw Error('Cannot send command, both socket and serial are null.')
                }
            }
        }
    }

    _on_data_rx(data) {
        // Accumulate into the persistent buffer, then scan the WHOLE buffer in
        // one forward pass, emitting every complete frame and keeping only the
        // trailing partial frame for the next chunk. (The old code sliced +
        // reset offset=0 mid-loop, which — with the for-loop's offset++ — then
        // skipped the first byte of each following frame; `consumed` avoids
        // that, and making rx_buffer an instance field fixes split frames.)
        const buf = Buffer.concat([this._rx_buffer, data]);
        let arr = [];
        let in_frame = false;
        let escaped = false;
        let consumed = 0;   // bytes through the last COMPLETED frame's trailing FEND
        for (let offset = 0; offset < buf.length; offset++) {
            let byte = buf.readUInt8(offset);
            if (!in_frame) {
                in_frame = (byte == defs.framing.fend);
            } else if (byte == defs.framing.fend) {
                // Trailing FEND — frame complete. Ignore empty frames (back-to-
                // back FENDs are used as idle/keepalive delimiters).
                if (arr.length > 0) {
                    this.emit(
                        'data', {
                            port : ((arr[0]&(15<<4))>>4),
                            command : (arr[0]&15),
                            data : Buffer.from(arr.slice(1))
                        }
                    );
                }
                arr = [];
                escaped = false;
                // A trailing FEND doubles as the next frame's opening FEND, so
                // stay in_frame and keep it as the next frame's start.
                in_frame = true;
                consumed = offset;
            } else if (!escaped && byte == defs.framing.fesc) {
                escaped = true;
            } else if (escaped) {
                if (byte == defs.framing.tfesc) {
                    arr.push(defs.framing.fesc);
                } else if (byte == defs.framing.tfend) {
                    arr.push(defs.framing.fend);
                }
                escaped = false;
            } else {
                arr.push(byte);
            }
        }
        // Keep the unconsumed tail (the partial/last-open frame) for next time.
        this._rx_buffer = buf.slice(consumed);
    }

    _get_tx_buffer(command, port, data) {
        let tx_buffer = [ defs.framing.fend, command|(port<<4) ];
        for (let offset = 0; offset < data.length; offset++) {
            let byte = data.readUInt8(offset);
            if (byte == defs.framing.fend) {
                tx_buffer = tx_buffer.concat([ defs.framing.fesc, defs.framing.tfend ]);
            } else if (byte == defs.framing.fesc) {
                tx_buffer = tx_buffer.concat([ defs.framing.fesc, defs.framing.tfesc ]);
            } else {
                tx_buffer.push(byte);
            }
        }
        tx_buffer.push(defs.framing.fend);
        return tx_buffer;
    }

    set_tx_delay(value = 50, callback, port = 0) {
        valid_numeric_setting('tx_delay', value);
        this._send_command(defs.commands.tx_delay, port, Buffer.from([value]), callback);
    }

    set_persistence(value = 63, callback, port = 0) {
        valid_numeric_setting('persistence', value);
        this._send_command(defs.commands.persistence, port, Buffer.from([value]), callback);
    }

    set_slot_time(value = 10, callback, port = 0) {
        valid_numeric_setting('slot_time', value);
        this._send_command(defs.commands.slot_time, port, Buffer.from([value]), callback);
    }

    set_tx_tail(value = 1, callback, port = 0) {
        valid_numeric_setting('tx_tail', value);
        this._send_command(defs.commands.tx_tail, port, Buffer.from([value]), callback);
    }

    set_duplex(value = 0, callback, port = 0) {
        valid_numeric_setting('duplex', value);
        this._send_command(defs.commands.duplex, port, Buffer.from([value]), callback);
    }

    set_hardware(value, callback, port = 0) {
        this._send_command(defs.commands.set_hardware, port, value, callback);
    }

    send_data(data, callback, port = 0) {
        this._send_command(defs.commands.data, port, data, callback);
    }

    exit_kiss(callback) {
        this._send_command(defs.commands.exit_kiss, undefined, undefined, callback);
    }
}

module.exports = KISS_TNC;
