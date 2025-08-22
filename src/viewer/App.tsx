import React, {CSSProperties, MouseEventHandler} from 'react';
// @ts-ignore no types for the package
import Panel from 'react-flex-panel';
import FontAwesome from 'react-fontawesome';
import {FixedSizeList, ListChildComponentProps} from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import classNames from 'classnames';
import './App.css';
import {ObjectInspector} from 'react-inspector';
import {deserializeFrame, deserializeFrameWithLength, ErrorCodes, Frame, FrameTypes,} from "@rsocket/core";
import Protocol from "devtools-protocol";
import {action, computed, makeObservable, observable} from "mobx";
import {observer} from "mobx-react-lite";
import {Index, IndexSearchResult} from "flexsearch";
import {Buffer} from "buffer";
import WebSocketFrameReceivedEvent = Protocol.Network.WebSocketFrameReceivedEvent;
import WebSocketFrameSentEvent = Protocol.Network.WebSocketFrameSentEvent;
import WebSocketFrame = Protocol.Network.WebSocketFrame;
import WebSocketCreatedEvent = Protocol.Network.WebSocketCreatedEvent;
import {extract} from "./GraphqlExtractor";

window.Buffer = Buffer

const flagsMap = new Map<string, number>([
    // ["NONE", 0],
    ["COMPLETE", 64],
    ["FOLLOWS", 128],
    ["IGNORE", 512],
    ["LEASE", 64],
    ["METADATA", 256],
    ["NEXT", 32],
    ["RESPOND", 128],
    ["RESUME_ENABLE", 128]
]);
const frameTypesMap = new Map<string, number>([
    ["RESERVED", 0],
    ["SETUP", 1],
    ["LEASE", 2],
    ["KEEPALIVE", 3],
    ["REQUEST_RESPONSE", 4],
    ["REQUEST_FNF", 5],
    ["REQUEST_STREAM", 6],
    ["REQUEST_CHANNEL", 7],
    ["REQUEST_N", 8],
    ["CANCEL", 9],
    ["PAYLOAD", 10],
    ["ERROR", 11],
    ["METADATA_PUSH", 12],
    ["RESUME", 13],
    ["RESUME_OK", 14],
    ["EXT", 63]
]);

function getRSocketType(type: number): string {
    for (const [name, code] of frameTypesMap) {
        if (code === type) {
            return name;
        }
    }
    return toHex(type);
}

function toHex(n: number): string {
    return '0x' + n.toString(16);
}

function shortFrame(frame: Frame) {
    const name = getRSocketType(frame.type);
    const flags: string[] = [];
    if (frame.flags === 0) {
        flags.push('NONE');
    } else {
        for (let [name, flag] of flagsMap) {
            if ((frame.flags & flag) === flag) {
                flags.push(name);
            }
        }
    }
    const data = extract(frame);
    if (data) {
        return `${frame.streamId} ${data}`;
    }
    return `${frame.streamId} ${name} [${flags.join(", ")}]`;
}

const padded = (num: number, d: number) => num.toFixed(0).padStart(d, '0');

function stringToBuffer(str: string) {
    const ui8 = new Uint8Array(str.length);
    for (let i = 0; i < str.length; ++i) {
        ui8[i] = str.charCodeAt(i);
    }
    return ui8;
}

const TimeStamp = ({time}: { time: Date }) => {
    const h = time.getHours();
    const m = time.getMinutes();
    const s = time.getSeconds();
    const ms = time.getMilliseconds();
    return <span className="timestamp">{padded(h, 2)}:{padded(m, 2)}:{padded(s, 2)}.{padded(ms, 3)}</span>;
};

function base64ToArrayBuffer(base64: string) {
    let binaryString: string;
    try {
        binaryString = window.atob(base64);
    } catch (e) {
        // TODO: the main reason for such an error is that currently there is no support for multiple websocket connections,
        //   e.g. webpack hot reloaders.
        binaryString = "";
    }
    const len = binaryString.length;
    const bytes = new Buffer(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

const FrameEntry = ({frame, selected, onClick, style}:
                    {
                        frame: WsFrameState,
                        selected: boolean,
                        onClick: MouseEventHandler,
                        style: CSSProperties
                    }) => {
    const rsocketFrame = tryDeserializeFrame(frame.payload)
    const frameName = rsocketFrame
        ? <span className="name">{shortFrame(rsocketFrame)}</span>
        : <span className="name">{frame.text != null ? "Text Frame" : "Binary Frame"}</span>
    return (
        <li
            className={classNames("frame", "frame-" + frame.type, {"frame-selected": selected})}
            style={style}
            onClick={onClick}>
            <FontAwesome name={frame.type === "incoming" ? "arrow-circle-down" : "arrow-circle-up"}/>
            <TimeStamp time={frame.time}/>
            {frameName}
            <span className="length">{frame.length}</span>
        </li>
    );
};

interface RSocketFrameProps {
    frame: Frame,
    data: Uint8Array,
    className: string
}

export function getErrorCodeExplanation(code: number): string {
    const explanation = ErrorCodes[code];
    if (explanation != null) {
        return explanation;
    } else if (code <= 0x00300) {
        return 'RESERVED (PROTOCOL)';
    } else {
        return 'RESERVED (APPLICATION)';
    }
}

function printFrame(frame: Frame) {
    const obj: Object = {...frame};
    Object.entries(obj).forEach(([key, value]) => {
        if (value) {
            //@ts-ignore
            obj[key] = value.toString()
        }
    })

    //@ts-ignore
    obj.type = FrameTypes[frame.type] + ` (${toHex(frame.type)})`;
    const flagNames = [];
    for (let [name, flag] of flagsMap) {
        if ((frame.flags & flag) === flag) {
            flagNames.push(name);
        }
    }

    //@ts-ignore
    obj.flags = flagNames.join(' | ') + ` (${toHex(frame.flags)})`;
    if (frame.type === FrameTypes.ERROR) {
        //@ts-ignore
        obj.code = getErrorCodeExplanation(frame.code) + ` (${toHex(frame.code)})`;
    }
    return JSON.stringify(obj, null, 2);
}

class RSocketFrame extends React.Component<RSocketFrameProps, any> {
    private hexView: HTMLDivElement | null = null;
    private asciiView: HTMLDivElement | null = null;

    render() {
        const {frame, data, className, ...props} = this.props;
        let numDigits = 4;
        while (1 << (numDigits * 4) <= data.length) {
            numDigits += 1;
        }
        const lineNumbers = [], hexView = [], asciiView = [];
        const dot = ".".charCodeAt(0);
        for (let pos = 0; pos < data.length; pos += 16) {
            const row = [...(data as any).subarray(pos, pos + 16)];
            // Use <wbr> to add line breaks but keep ASCII text copyable (<wbr> are not included in copied text)
            lineNumbers.push(<span key={pos}>{pos.toString(16).padStart(numDigits, '0')}:<wbr/></span>);
            hexView.push(<span key={pos}>
        {row.map((byte: number, i) => <span key={i}>{byte.toString(16).padStart(2, '0')}</span>)}
                {row.length < 16 && [...Array(16 - row.length)].map((nil, i) => <span key={i}
                                                                                      className="padding">{"  "}</span>)}
                <wbr/></span>);
            asciiView.push(<span
                key={pos}>{String.fromCharCode(...row.map(byte => byte >= 32 && byte <= 126 ? byte : dot))}
                <wbr/></span>);
        }
        let jsonData: any;
        try {
            let data = (frame as any).data;
            jsonData = data ? JSON.parse(data) : undefined;
        } catch (e) {
            jsonData = undefined;
        }
        let jsonMeta: any;
        try {
            let meta = (frame as any).metadata;
            jsonMeta = meta ? JSON.parse(meta) : undefined;
        } catch (e) {
            jsonMeta = undefined;
        }
        const dataField = jsonData
            ? <div>
                <hr/>
                Data<br/><ObjectInspector data={jsonData}/></div>
            : <div/>
        const jsonField = jsonMeta
            ? <div>
                <hr/>
                Metadata<br/><ObjectInspector data={jsonMeta}/></div>
            : <div/>
        return (
            <div>
                Frame<br/>
                {printFrame(frame)}
                {dataField}
                {jsonField}
                <hr/>
                <div className={classNames(className, "RSocketFrame")} {...props}>
                    <div className="line-numbers">
                        {lineNumbers}
                    </div>
                    <div className="hex-view" ref={node => this.hexView = node}>
                        {hexView}
                    </div>
                    <div className="ascii-view" ref={node => this.asciiView = node}>
                        {asciiView}
                    </div>
                </div>
            </div>
        )
    }
}

const TextViewer = ({data}: { data: string | Uint8Array }) => (
    <div className="TextViewer tab-pane">
        {data}
    </div>
);

// Could
// let cachedEncoders: Encoders<any> = Utf8Encoders
let cachedLengthPrefixedFrames: boolean = false;

function tryDeserializeFrameWith(data: string, buffer: Buffer, lengthPrefixedFrames: boolean) {
    try {
        return lengthPrefixedFrames
            ? deserializeFrameWithLength(buffer)
            : deserializeFrame(buffer);
    } catch (e) {
        // console.error("failed to decode frame", e)
        return undefined;
    }
}

function tryDeserializeFrame(data: string): Frame | undefined {
    const buffer = base64ToArrayBuffer(data)
    let frame: Frame | undefined;
    // fast path
    frame = tryDeserializeFrameWith(data, buffer, cachedLengthPrefixedFrames);

    if (frame) {
        return frame;
    }
    // slow path
    // let attempts: [Encoders<any>, boolean][] = [
    //     [Utf8Encoders, false],
    //     [Utf8Encoders, true],
    //     [BufferEncoders, false],
    //     [BufferEncoders, true],
    // ];
    // for (let [encoders, lengthPrefixedFrames] of attempts) {
    //     frame = tryDeserializeFrameWith(data, buffer, lengthPrefixedFrames, encoders);
    //     if (frame) {
    //         cachedEncoders = encoders;
    //         cachedLengthPrefixedFrames = lengthPrefixedFrames;
    //         return frame;
    //     }
    // }
    return undefined;
}

const RSocketViewer = ({frame, data}: { frame: Frame, data: string }) => {
    try {
        return (
            <div className="TextViewer tab-pane">
                <RSocketFrame className="tab-pane" frame={frame} data={base64ToArrayBuffer(data)}/>
            </div>
        )
    } catch (e) {
        console.error("Unable to decode frame", e);
        return (
            <div className="TextViewer tab-pane">
                Unable to decode frame
            </div>
        )
    }
};


class FrameView extends React.Component<{ wsFrame: WsFrameState }, { panel?: string }> {
    constructor(props: { wsFrame: WsFrameState }) {
        super(props);
        this.state = {panel: undefined};
    }

    render() {
        const {wsFrame} = this.props;
        const rsocketFrame = tryDeserializeFrame(wsFrame.payload)
        const panel = rsocketFrame
            ? <RSocketViewer frame={rsocketFrame} data={wsFrame.payload}/>
            : wsFrame.text
                ? <TextViewer data={wsFrame.text}/>
                : <TextViewer data={wsFrame.binary!}/>;
        return (
            <div className="FrameView">
                {panel}
            </div>
        );
    }
}

interface WsFrameState {
    id: number,
    type: 'incoming' | 'outgoing',
    time: Date,
    length: number,
    text?: string,
    binary?: Uint8Array,
    payload: string,
}

interface WsConnectionState {
    id: string,
    url?: string,
    frames: WsFrameState[];
    index: Index;
    activeFrame?: number
}

export type ChromeHandlers = { [name: string]: any };

export class AppStateStore {
    _uniqueId = 0;
    issueTime?: number = undefined;
    issueWallTime?: number = undefined;
    connections = new Map<string, WsConnectionState>();
    activeConnection?: string = undefined;
    searchValue: string = "";

    constructor(handlers: ChromeHandlers) {
        makeObservable(this, {
            connections: observable,
            activeConnection: observable,
            selectConnection: action.bound,
            search: action.bound,
            searchValue: observable,
            searchResult: computed,
            frameSent: action.bound,
            frameReceived: action.bound,
            webSocketCreated: action.bound,
            selectFrame: action.bound,
            clearFrames: action.bound,
        });

        handlers["Network.webSocketCreated"] = this.webSocketCreated.bind(this);
        handlers["Network.webSocketFrameReceived"] = this.frameReceived.bind(this);
        handlers["Network.webSocketFrameSent"] = this.frameSent.bind(this);
    }

    clearFrames() {
        if (!this.activeConnection) {
            return
        }
        const connection = this.connections.get(this.activeConnection);
        if (!connection) {
            return;
        }
        connection.frames = []
        connection.index = new Index({tokenize: "full"})
        this.searchValue = ""
    }

    selectFrame(id?: number) {
        if (!this.activeConnection) {
            return
        }
        const connection = this.connections.get(this.activeConnection);
        if (!connection) {
            return;
        }
        connection.activeFrame = id;
    }

    selectConnection(value: string) {
        this.activeConnection = value;
    }

    search(value: string) {
        this.searchValue = value;
    }

    get searchResult(): IndexSearchResult {
        if (!this.activeConnection) {
            return []
        }

        const connection = this.connections.get(this.activeConnection);
        if (!connection) {
            return []
        }

        const result = connection.index.search(this.searchValue);
        return result
    }

    webSocketCreated(event: WebSocketCreatedEvent) {
        const {requestId, url} = event;
        if (this.connections.get(requestId)) {
            // unexpected
            return;
        }
        this.connections.set(requestId, {
            id: requestId,
            url: url,
            frames: [],
            index: new Index({tokenize: "full"}),
            activeFrame: undefined,
        });
    }

    frameReceived(event: WebSocketFrameReceivedEvent) {
        const {requestId, timestamp, response} = event;
        this.addFrame('incoming', requestId, timestamp, response);
    }

    frameSent(event: WebSocketFrameSentEvent) {
        const {requestId, timestamp, response} = event;
        this.addFrame('outgoing', requestId, timestamp, response);
    }

    addFrame(type: 'incoming' | 'outgoing', requestId: string, timestamp: number, response: WebSocketFrame) {
        if (response.opcode === 1 || response.opcode === 2) {
            const frame: WsFrameState = {
                type,
                id: ++this._uniqueId,
                time: this.getTime(timestamp),
                length: response.payloadData.length,
                payload: response.payloadData,
            };
            if (response.opcode === 1) {
                frame.text = response.payloadData;
            } else {
                frame.binary = stringToBuffer(response.payloadData);
            }
            const connection = this.ensureConnection(requestId);
            const rSocketFrame = tryDeserializeFrame(frame.payload);
            connection.frames.push(frame)
            connection.index.add(frame.id, (rSocketFrame as any)?.data ?? frame.text ?? frame.payload)
            if (rSocketFrame) {
                this.activeConnection = requestId;
            }
        }
    }

    private ensureConnection(requestId: string): WsConnectionState {
        const connection = this.connections.get(requestId);
        if (connection) {
            return connection;
        }
        const newConnection = {
            id: requestId,
            frames: [],
            index: new Index({tokenize: "full"}),
            activeFrame: undefined,
        }
        this.connections.set(requestId, newConnection);
        return newConnection;
    }

    private getTime(timestamp: number): Date {
        if (this.issueTime === undefined || this.issueWallTime === undefined) {
            this.issueTime = timestamp;
            this.issueWallTime = new Date().getTime();
        }
        return new Date((timestamp - this.issueTime) * 1000 + this.issueWallTime);
    }
}

export const App = observer(({store}: { store: AppStateStore }) => {
    const {connections, activeConnection, searchValue, searchResult} = store;
    if (!activeConnection) {
        return <div>No active WebSocket connections</div>
    }
    const connection = connections.get(activeConnection);
    if (!connection) {
        throw Error(`the active connection: "${activeConnection}" is missing`);
    }
    const {frames, activeFrame} = connection;
    const active = frames.find(f => f.id === activeFrame);
    const filteredFrames = searchResult.length ? frames.filter((frame) => searchResult.includes(frame.id)) : frames;

    const Row = ({index, style}: ListChildComponentProps) => {
        const frame = filteredFrames[index];
        let selected = false
        if (active) {
            const rsocketFrame = tryDeserializeFrame(frame.payload)
            const activeRsocketFrame = tryDeserializeFrame(active.payload)
            selected = rsocketFrame?.streamId === activeRsocketFrame?.streamId
        }
        return (
            <FrameEntry
                key={frame.id}
                style={style}
                frame={frame}
                selected={selected}
                onClick={e => {
                    store.selectFrame(frame.id);
                    e.stopPropagation();
                }}
            />
        );
    };

    return (
        <Panel cols className="App">
            <Panel size={300} minSize={180} resizable className="LeftPanel">
                <div className="list-controls">
                    <FontAwesome className="list-button" name="ban" onClick={() => store.clearFrames()} title="Clear"/>
                    <select
                        style={{width: "100%"}}
                        value={activeConnection}
                        onChange={e => store.selectConnection(e.target.value)}
                    >
                        {[...connections.entries()]
                            .map(([id, connection]) =>
                                <option value={id} key={id}>
                                    {`${id}: ${connection.url ?? ''}`}
                                </option>)
                        }
                    </select>
                    <input
                        type="text"
                        placeholder="Search frame..."
                        style={{width: "100%", marginLeft: "8px", border: "1px solid black"}}
                        value={searchValue}
                        onChange={e => store.search(e.target.value)}
                    />
                </div>

                <div className="frame-list">
                    <AutoSizer disableWidth>
                        {({height}) => (
                            <FixedSizeList height={height} width="100%" itemCount={filteredFrames.length} itemSize={18}
                                           innerElementType="ul">
                                {Row}
                            </FixedSizeList>
                        )}
                    </AutoSizer>
                </div>
            </Panel>
            <Panel minSize={100} className="PanelView">
                {active != null ? <FrameView wsFrame={active}/> :
                    <span className="message">Select a frame to view its contents</span>}
            </Panel>
        </Panel>
    );
});
