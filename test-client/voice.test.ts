import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RECORDING_MS, playAudio, startRecording, stopPlayback } from "../client/voice";

class FakeRecorder extends EventTarget {
  state = "inactive";
  mimeType = "audio/webm";
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob(["sound"]) }));
    this.dispatchEvent(new Event("stop"));
  }
}

function installAudioFakes() {
  const stopTrack = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) } });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("AudioContext", class {
    decodeAudioData = async () => ({ duration: 0.001 });
    close = async () => {};
  });
  vi.stubGlobal("OfflineAudioContext", class {
    destination = {};
    createBufferSource = () => ({ connect() {}, start() {}, buffer: null });
    startRendering = async () => ({ getChannelData: () => new Float32Array([-2, -0.5, 0, 0.5, 2]) });
  });
  return stopTrack;
}

afterEach(() => {
  stopPlayback();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("recording", () => {
  it("returns clipped 16 kHz mono WAV audio and releases the microphone", async () => {
    const stopTrack = installAudioFakes();
    const recording = await startRecording();
    recording.stop();
    recording.stop();
    const bytes = Uint8Array.from(atob(await recording.result), (character) => character.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getInt16(44, true)).toBe(-32_768);
    expect(view.getInt16(52, true)).toBe(32_767);
    expect(stopTrack).toHaveBeenCalled();
  });

  it("stops automatically at the time limit", async () => {
    installAudioFakes();
    vi.useFakeTimers();
    const recording = await startRecording();
    vi.advanceTimersByTime(MAX_RECORDING_MS);
    vi.useRealTimers();
    await expect(recording.result).resolves.toBeTruthy();
  });
});

describe("playback", () => {
  it("plays decoded audio, replaces earlier playback and cleans up", async () => {
    const audios: FakeAudio[] = [];
    class FakeAudio extends EventTarget {
      pause = vi.fn();
      play = vi.fn(async () => {});
      constructor(public src: string) {
        super();
        audios.push(this);
      }
    }
    vi.stubGlobal("Audio", FakeAudio);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const onEnd = vi.fn();
    await playAudio("AAAA", "audio/mpeg", onEnd);
    await playAudio("AAAA", "audio/mpeg", onEnd);
    expect(audios[0]?.pause).toHaveBeenCalled();
    audios[0]?.dispatchEvent(new Event("ended"));
    audios[1]?.dispatchEvent(new Event("ended"));
    expect(onEnd).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
