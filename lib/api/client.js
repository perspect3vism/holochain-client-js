import { decode, encode } from "@msgpack/msgpack";
import Emittery from "emittery";
//@ts-ignore
import { StandardWebSocketClient } from "isomorphic-ws";
import { SignalType } from "./app/types.js";
/**
 * A Websocket client which can make requests and receive responses,
 * as well as send and receive signals.
 *
 * Uses Holochain's websocket WireMessage for communication.
 *
 * @public
 */
export class WsClient extends Emittery {
    socket;
    pendingRequests;
    index;
    constructor(socket) {
        super();
        this.socket = socket;
        this.pendingRequests = {};
        this.index = 0;
        //@ts-ignore
        socket.on("message", async (serializedMessage) => {
            // If data is not a buffer (nodejs), it will be a blob (browser)
            let deserializedData;
            if (typeof window === "object" &&
                serializedMessage.data instanceof window.Blob) {
                deserializedData = await serializedMessage.data.arrayBuffer();
            }
            else {
                if (typeof Buffer !== "undefined" &&
                    Buffer.isBuffer(serializedMessage.data)) {
                    deserializedData = serializedMessage.data;
                }
                else {
                    throw new Error("websocket client: unknown message format");
                }
            }
            const message = decode(deserializedData);
            assertHolochainMessage(message);
            if (message.type === "signal") {
                if (message.data === null) {
                    throw new Error("received a signal without data");
                }
                const deserializedSignal = decode(message.data);
                assertHolochainSignal(deserializedSignal);
                if (SignalType.System in deserializedSignal) {
                    // We have received a system signal, do nothing
                    return;
                }
                const encodedAppSignal = deserializedSignal[SignalType.App];
                // In order to return readable content to the UI, the signal payload must also be deserialized.
                const payload = decode(encodedAppSignal.signal);
                const signal = {
                    cell_id: encodedAppSignal.cell_id,
                    zome_name: encodedAppSignal.zome_name,
                    payload,
                };
                this.emit("signal", signal);
            }
            else if (message.type === "response") {
                this.handleResponse(message);
            }
            else {
                console.error(`Got unrecognized Websocket message type: ${message.type}`);
            }
        });
        //@ts-ignore
        socket.on("close", (event) => {
            const pendingRequestIds = Object.keys(this.pendingRequests).map((id) => parseInt(id));
            if (pendingRequestIds.length) {
                pendingRequestIds.forEach((id) => {
                    const error = new Error(`Websocket closed with pending requests. Close event code: ${event.code}, request id: ${id}`);
                    this.pendingRequests[id].reject(error);
                    delete this.pendingRequests[id];
                });
            }
        });
    }
    /**
     * Instance factory for creating WsClients.
     *
     * @param url - The `ws://` URL to connect to.
     * @returns An new instance of the WsClient.
     */
    static connect(url) {
        return new Promise((resolve, reject) => {
            const socket = new StandardWebSocketClient(url);
            // make sure that there are no uncaught connection
            // errors because that causes nodejs thread to crash
            // with uncaught exception
            socket.on("error", () => {
                reject(new Error(`could not connect to holochain conductor, please check that a conductor service is running and available at ${url}`));
            });
            socket.on("open", () => {
                const client = new WsClient(socket);
                resolve(client);
            });
        });
    }
    /**
     * Sends data as a signal.
     *
     * @param data - Data to send.
     */
    emitSignal(data) {
        const encodedMsg = encode({
            type: "signal",
            data: encode(data),
        });
        this.socket.send(encodedMsg);
    }
    /**
     * Send requests to the connected websocket.
     *
     * @param request - The request to send over the websocket.
     * @returns
     */
    request(request) {
        if (this.socket.readyState === this.socket.OPEN) {
            const id = this.index;
            const encodedMsg = encode({
                id,
                type: "request",
                data: encode(request),
            });
            const promise = new Promise((resolve, reject) => {
                this.pendingRequests[id] = { resolve, reject };
            });
            this.socket.send(encodedMsg);
            this.index += 1;
            return promise;
        }
        else {
            return Promise.reject(new Error("Socket is not open"));
        }
    }
    handleResponse(msg) {
        const id = msg.id;
        if (this.pendingRequests[id]) {
            if (msg.data === null || msg.data === undefined) {
                this.pendingRequests[id].reject(new Error("Response canceled by responder"));
            }
            else {
                this.pendingRequests[id].resolve(decode(msg.data));
            }
            delete this.pendingRequests[id];
        }
        else {
            console.error(`Got response with no matching request. id=${id}`);
        }
    }
    /**
     * Close the websocket connection.
     */
    close(code) {
        const closedPromise = new Promise((resolve) => this.socket.on("close", resolve));
        this.socket.close(code);
        return closedPromise;
    }
}
function assertHolochainMessage(message) {
    if (typeof message === "object" &&
        message !== null &&
        "type" in message &&
        "data" in message) {
        return;
    }
    throw new Error(`unknown message format ${JSON.stringify(message, null, 4)}`);
}
function assertHolochainSignal(signal) {
    if (typeof signal === "object" &&
        signal !== null &&
        Object.values(SignalType).some((type) => type in signal)) {
        return;
    }
    throw new Error(`unknown signal format ${JSON.stringify(signal, null, 4)}`);
}
