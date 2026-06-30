import type { RtcDataChannelLike } from "./webrtcPeer.js";

/**
 * Shared data-channel write primitives for BOTH pipe roles (offerer `webrtcClient`,
 * answerer `webrtcAnswerer`). These were byte-for-byte duplicated across the two
 * files — and had already diverged (the same `awaitDrain` wedge needed fixing in
 * both copies). One home so the next backpressure/chunking fix lands once.
 */

/**
 * Await the channel draining below its low-water threshold. Resolves early if the
 * channel CLOSES while backpressured — otherwise `onBufferedAmountLow` would never
 * fire and a serialized write loop would wedge forever on a dead channel.
 */
export async function awaitDrain(channel: RtcDataChannelLike): Promise<void> {
  if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return;
  await new Promise<void>((resolve) => {
    let offLow = () => {};
    let offClose = () => {};
    const done = () => {
      offLow();
      offClose();
      resolve();
    };
    offLow = channel.onBufferedAmountLow(done);
    offClose = channel.onClose(done);
    if (channel.readyState !== "open") done();
  });
}

/**
 * Send `bytes` over a data channel in ≤`chunkSize` (capped by the channel's
 * `maxMessageSize`) chunks, awaiting drain between chunks and bailing silently if
 * the channel closes mid-write (the pipe-down handler errors any dependent stream).
 * react-native-webrtc corrupts messages over ~16 KiB, so this chunking is a hard
 * interop requirement, not merely backpressure management. The caller ensures the
 * channel is open at the start.
 */
export async function writeChunked(
  channel: RtcDataChannelLike,
  bytes: Uint8Array,
  chunkSize: number
): Promise<void> {
  const max = Math.min(chunkSize, channel.maxMessageSize || chunkSize);
  for (let offset = 0; offset < bytes.byteLength; offset += max) {
    await awaitDrain(channel);
    if (channel.readyState !== "open") return;
    channel.send(bytes.subarray(offset, Math.min(offset + max, bytes.byteLength)));
  }
}
