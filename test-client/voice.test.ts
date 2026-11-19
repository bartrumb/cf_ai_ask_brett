import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RECORDING_MS, startRecording, startSpeech, stopPlayback } from "../client/voice";

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
  vi.restoreAllMocks();
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

describe("streamed playback", () => {
  const audios: FakeAudio[] = [];
  let failPlay = false;
  class FakeAudio extends EventTarget {
    src = "";
    sources: string[] = [];
    pause = vi.fn();
    play = vi.fn(async () => {
      this.sources.push(this.src);
      if (failPlay && this.src !== "blob:0") throw new Error("blocked");
    });
    constructor() {
      super();
      audios.push(this);
    }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const handlers = () => ({ onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() });

  const install = () => {
    audios.length = 0;
    failPlay = false;
    let count = 0;
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:${count++}`);
    return vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  };

  it("unlocks audio in the gesture, then plays parts in order through one element", async () => {
    const revoke = install();
    const events = handlers();
    const player = startSpeech(events);
    const audio = audios[0] as FakeAudio;
    expect(audio.sources).toEqual(["blob:0"]);
    player.add("AAAA", "audio/mpeg");
    player.add("AAAA", "audio/mpeg");
    await settle();
    expect(events.onStart).toHaveBeenCalledTimes(1);
    audio.dispatchEvent(new Event("ended"));
    player.finish();
    expect(events.onEnd).not.toHaveBeenCalled();
    audio.dispatchEvent(new Event("ended"));
    expect(audio.sources).toEqual(["blob:0", "blob:1", "blob:2"]);
    expect(events.onEnd).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(3);
    expect(audios).toHaveLength(1);
  });

  it("ends at once when the stream finishes with nothing left to play", async () => {
    install();
    const events = handlers();
    const player = startSpeech(events);
    player.add("AAAA", "audio/mpeg");
    await settle();
    (audios[0] as FakeAudio).dispatchEvent(new Event("ended"));
    player.finish();
    expect(events.onEnd).toHaveBeenCalledTimes(1);
  });

  it("reports a refused part and stops", async () => {
    install();
    failPlay = true;
    const events = handlers();
    const player = startSpeech(events);
    player.add("AAAA", "audio/mpeg");
    await settle();
    expect(events.onError).toHaveBeenCalledTimes(1);
    player.add("AAAA", "audio/mpeg");
    expect((audios[0] as FakeAudio).sources).toHaveLength(2);
  });

  it("replaces earlier playback without running its callbacks", () => {
    install();
    const first = handlers();
    startSpeech(first);
    startSpeech(handlers());
    expect(audios[0]?.pause).toHaveBeenCalled();
    stopPlayback();
    expect(audios[1]?.pause).toHaveBeenCalled();
    expect(first.onEnd).not.toHaveBeenCalled();
  });
});
