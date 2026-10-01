/**
 * onnx-fixture.ts, genuinely loadable ONNX models for the hermetic harness.
 *
 * WHY NOT JUST SERVE RANDOM BYTES. The point of the wake e2e is that
 * onnxruntime-web really initialises in a real browser over bytes the daemon really
 * served, and that the tab really opens a microphone off the back of it. Random
 * bytes prove the opposite: the session creation fails and the test passes only the
 * error path, which the unit suite already covers.
 *
 * WHY NOT THE REAL PINNED MODELS. They are 3.7 MB of downloaded artifacts that live
 * on a provisioned host, and the harness is hermetic by construction, no daemon, no
 * network, nothing outside this repo. So this builds the smallest models that satisfy
 * the SDK engine's two shape contracts, from scratch, as ONNX protobuf:
 *
 *   embedding:  float32[1,76,32,1] -> Identity -> float32[1,76,32,1]   (>= 96 values)
 *   classifier: float32[1,16,96]   -> Identity -> float32[1,16,96]     (>= 1 value)
 *
 * An `Identity` graph is a real model with real declared inputs and outputs: the
 * runtime loads it, the engine feeds it, and it returns finite floats. The SCORES are
 * meaningless, which is correct division of labour, scripted scores and the
 * detection rules are unit-tested against a stub session, and this file exists to
 * prove the runtime, the bundle, the chunked read and the device path.
 *
 * The protobuf is written by hand because the alternative is adding an ONNX authoring
 * dependency to a test harness to emit ~200 bytes.
 */
import { createHash } from 'node:crypto';

// ─── Minimal protobuf writer ─────────────────────────────────────────────────

function varint(value: number): number[] {
  const out: number[] = [];
  let remaining = value;
  do {
    const byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    out.push(remaining > 0 ? byte | 0x80 : byte);
  } while (remaining > 0);
  return out;
}

/** A varint field: (fieldNumber << 3) | 0. */
function fieldVarint(fieldNumber: number, value: number): number[] {
  return [...varint((fieldNumber << 3) | 0), ...varint(value)];
}

/** A length-delimited field: (fieldNumber << 3) | 2, length, payload. */
function fieldBytes(fieldNumber: number, payload: readonly number[]): number[] {
  return [...varint((fieldNumber << 3) | 2), ...varint(payload.length), ...payload];
}

function fieldString(fieldNumber: number, value: string): number[] {
  return fieldBytes(fieldNumber, [...new TextEncoder().encode(value)]);
}

// ─── ONNX message shapes (onnx.proto field numbers) ──────────────────────────

/** TensorShapeProto.Dimension { 1: dim_value }. */
function dimension(size: number): number[] {
  return fieldVarint(1, size);
}

/** TensorShapeProto { 1: dim (repeated) }. */
function tensorShape(dims: readonly number[]): number[] {
  return dims.flatMap((size) => fieldBytes(1, dimension(size)));
}

/** TypeProto.Tensor { 1: elem_type, 2: shape }. 1 is FLOAT. */
function tensorType(dims: readonly number[]): number[] {
  return [...fieldVarint(1, 1), ...fieldBytes(2, tensorShape(dims))];
}

/** TypeProto { 1: tensor_type }. */
function typeProto(dims: readonly number[]): number[] {
  return fieldBytes(1, tensorType(dims));
}

/** ValueInfoProto { 1: name, 2: type }. */
function valueInfo(name: string, dims: readonly number[]): number[] {
  return [...fieldString(1, name), ...fieldBytes(2, typeProto(dims))];
}

/** NodeProto { 1: input, 2: output, 3: name, 4: op_type }. */
function identityNode(input: string, output: string): number[] {
  return [
    ...fieldString(1, input),
    ...fieldString(2, output),
    ...fieldString(3, 'passthrough'),
    ...fieldString(4, 'Identity'),
  ];
}

/** GraphProto { 1: node, 2: name, 11: input, 12: output }. */
function graph(name: string, inputName: string, outputName: string, dims: readonly number[]): number[] {
  return [
    ...fieldBytes(1, identityNode(inputName, outputName)),
    ...fieldString(2, name),
    ...fieldBytes(11, valueInfo(inputName, dims)),
    ...fieldBytes(12, valueInfo(outputName, dims)),
  ];
}

/** OperatorSetIdProto { 1: domain, 2: version }. */
function opset(version: number): number[] {
  return [...fieldString(1, ''), ...fieldVarint(2, version)];
}

/**
 * ModelProto { 1: ir_version, 2: producer_name, 7: graph, 8: opset_import }.
 *
 * ir_version 8 with opset 13 is the pairing onnxruntime-web 1.27 loads without a
 * version-conversion pass, and Identity-13 is defined for tensor(float).
 */
function onnxIdentityModel(name: string, dims: readonly number[]): Uint8Array {
  return new Uint8Array([
    ...fieldVarint(1, 8),
    ...fieldString(2, 'goodvibes-e2e'),
    ...fieldBytes(7, graph(name, 'input', 'output', dims)),
    ...fieldBytes(8, opset(13)),
  ]);
}

// ─── The two fixtures ────────────────────────────────────────────────────────

/** The speech-embedding backbone's shape: 76 mel frames x 32 bins, one channel. */
export const WAKE_EMBEDDING_DIMS = [1, 76, 32, 1] as const;

/** The classifier's shape: 16 embedding frames x 96 dimensions. */
export const WAKE_CLASSIFIER_DIMS = [1, 16, 96] as const;

export interface WakeModelFixture {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly base64: string;
}

function fixture(bytes: Uint8Array): WakeModelFixture {
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    base64: Buffer.from(bytes).toString('base64'),
  };
}

/** A loadable stand-in for the pinned speech-embedding model. */
export function wakeEmbeddingFixture(): WakeModelFixture {
  return fixture(onnxIdentityModel('embedding', WAKE_EMBEDDING_DIMS));
}

/** A loadable stand-in for the pinned hey_goodvibes classifier. */
export function wakeClassifierFixture(): WakeModelFixture {
  return fixture(onnxIdentityModel('classifier', WAKE_CLASSIFIER_DIMS));
}

/** The model card. Real text, no shape contract to satisfy. */
export function wakeNoticeFixture(): WakeModelFixture {
  return fixture(new TextEncoder().encode(
    '# hey_goodvibes\n\nSynthetic-recall-only evaluation. Test fixture, not the pinned model.\n',
  ));
}
