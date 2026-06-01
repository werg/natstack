export {
  FRAME_HEAD,
  FRAME_DATA,
  FRAME_END,
  FRAME_ERROR,
  FrameDecoder,
  encodeFrame,
  encodeHeadFrame,
  encodeDataFrame,
  encodeEndFrame,
  encodeErrorFrame,
  parseHeadFrame,
  parseEndFrame,
  parseErrorFrame,
  decodeFramedResponseToStreaming,
} from "@natstack/rpc/protocol/streamCodec";

export type {
  FrameType,
  HeadFramePayload,
  EndFramePayload,
  ErrorFramePayload,
} from "@natstack/rpc/protocol/streamCodec";
