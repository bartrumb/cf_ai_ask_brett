import { Buffer } from "node:buffer";

export const FAKE_SECRET = "sample-not-a-real-key-1234";

/** A random ID in the format the Worker routes. */
export const conversationId = () => crypto.randomUUID().replaceAll("-", "");

/** A valid 16 kHz, 16-bit mono WAV recording, encoded the way the browser client sends it. */
export function wavBase64(sampleBytes = 16): string {
  const bytes = Buffer.alloc(44 + sampleBytes);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + sampleBytes, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(sampleBytes, 40);
  return bytes.toString("base64");
}

/** Polls until a value is truthy. */
export async function until<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out.");
}
