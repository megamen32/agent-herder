const PROTOCOL_HEADER_SIZE = 13;
let input = Buffer.alloc(0);
let handshake = false;

function vql(value) {
  const bytes = [];
  do {
    let next = value & 0x7f;
    value >>>= 7;
    if (value) next |= 0x80;
    bytes.push(next);
  } while (value);
  return Buffer.from(bytes);
}

function encode(value) {
  if (value === undefined) return Buffer.from([0]);
  if (typeof value === "string") {
    const data = Buffer.from(value);
    return Buffer.concat([Buffer.from([1]), vql(data.length), data]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const data = Buffer.from(value);
    return Buffer.concat([Buffer.from([2]), vql(data.length), data]);
  }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([4]), vql(value.length), ...value.map(encode)]);
  if (Number.isInteger(value)) return Buffer.concat([Buffer.from([6]), vql(value)]);
  const data = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from([5]), vql(data.length), data]);
}

function readVql(data, state) {
  let value = 0;
  let shift = 0;
  while (true) {
    const next = data[state.offset++];
    value |= (next & 0x7f) << shift;
    if (!(next & 0x80)) return value;
    shift += 7;
  }
}

function decode(data, state) {
  const type = data[state.offset++];
  if (type === 0) return undefined;
  if (type === 1 || type === 2) {
    const length = readVql(data, state);
    const value = data.subarray(state.offset, state.offset + length);
    state.offset += length;
    return type === 1 ? value.toString() : value;
  }
  if (type === 4) {
    const length = readVql(data, state);
    return Array.from({ length }, () => decode(data, state));
  }
  if (type === 5) {
    const length = readVql(data, state);
    const value = JSON.parse(data.subarray(state.offset, state.offset + length).toString());
    state.offset += length;
    return value;
  }
  if (type === 6) return readVql(data, state);
  throw new Error(`unknown type ${type}`);
}

function frame(data) {
  const result = Buffer.alloc(PROTOCOL_HEADER_SIZE + data.length);
  result.writeUInt8(1, 0);
  result.writeUInt32BE(0, 1);
  result.writeUInt32BE(0, 5);
  result.writeUInt32BE(data.length, 9);
  data.copy(result, PROTOCOL_HEADER_SIZE);
  return result;
}

function sendMessage(header, body) {
  const result = frame(Buffer.concat([encode(header), encode(body)]));
  process.stdout.write(result.subarray(0, 7));
  setTimeout(() => process.stdout.write(result.subarray(7)), 1);
}

function handleFrame(data) {
  const state = { offset: 0 };
  const header = decode(data, state);
  const args = decode(data, state);
  const id = header?.[1];
  const method = header?.[3];
  if (method === "initialize") {
    sendMessage([201, id], { available: true, protocolName: "ZCode Protocol", protocolVersion: 1, transportKind: "stdio" });
  } else {
    sendMessage([201, id], []);
  }
}

function consumeFrames() {
  while (input.length >= PROTOCOL_HEADER_SIZE) {
    const length = input.readUInt32BE(9);
    if (input.length < PROTOCOL_HEADER_SIZE + length) return;
    const data = input.subarray(PROTOCOL_HEADER_SIZE, PROTOCOL_HEADER_SIZE + length);
    input = input.subarray(PROTOCOL_HEADER_SIZE + length);
    handleFrame(data);
  }
}

process.stdout.write(`${JSON.stringify({ type: "zcode-hello", version: "fake", platform: "linux", arch: "x64", pid: process.pid })}\n`);
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  if (!handshake) {
    const newline = input.indexOf(0x0a);
    if (newline < 0) return;
    const ack = JSON.parse(input.subarray(0, newline).toString());
    if (ack.type !== "zcode-hello-ack") throw new Error("missing hello ack");
    input = input.subarray(newline + 1);
    handshake = true;
    sendMessage([200], undefined);
  }
  consumeFrames();
});
process.stdin.on("end", () => process.exit(0));
