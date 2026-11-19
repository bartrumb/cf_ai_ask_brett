import { afterEach, describe, expect, it, vi } from "vitest";
import { dictationSupported, MAX_RECORDING_MS, startDictation, startRecording, startSpeech, stopPlayback } from "../client/voice";

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

describe("live dictation", () => {
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    static last: FakeSocket;
    readyState = 0;
    binaryType = "blob";
    sent: unknown[] = [];
    closed = false;
    constructor(public url: string) {
      super();
      FakeSocket.last = this;
    }
    send(data: unknown) {
      this.sent.push(data);
    }
    close() {
      this.closed = true;
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }
    say(data: unknown) {
      this.dispatchEvent(Object.assign(new Event("message"), { data }));
    }
  }
  class FakeNode {
    static last: FakeNode;
    port = { onmessage: null as ((event: { data: ArrayBuffer }) => void) | null, postMessage: vi.fn() };
    connect = vi.fn();
    disconnect = vi.fn();
    constructor() {
      FakeNode.last = this;
    }
  }

  function installDictationFakes(options: { connect?: "open" | "error" | "close" } = {}) {
    const stopTrack = vi.fn();
    const contexts: { resume: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) } });
    vi.stubGlobal("AudioContext", class {
      state = "suspended";
      destination = {};
      audioWorklet = { addModule: vi.fn(async () => {}) };
      resume = vi.fn(async () => { this.state = "running"; });
      close = vi.fn(async () => {});
      createMediaStreamSource = () => ({ connect: vi.fn() });
      constructor() {
        contexts.push(this);
      }
    });
    vi.stubGlobal("AudioWorkletNode", FakeNode);
    vi.stubGlobal("WebSocket", class extends FakeSocket {
      constructor(url: string) {
        super(url);
        const outcome = options.connect ?? "open";
        queueMicrotask(() => {
          if (outcome === "open") this.open();
          else this.dispatchEvent(new Event(outcome));
        });
      }
    });
    return { stopTrack, contexts };
  }

  const settle = async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  };

  it("reports support only where every piece exists", () => {
    vi.stubGlobal("isSecureContext", true);
    installDictationFakes();
    expect(dictationSupported()).toBe(true);
    vi.stubGlobal("AudioWorkletNode", undefined);
    expect(dictationSupported()).toBe(false);
  });

  it("creates the audio context inside the gesture, streams chunks and keeps live text", async () => {
    const { stopTrack, contexts } = installDictationFakes();
    const texts: string[] = [];
    const live = startDictation("wss://site/agents/dictation", "/js/capture-processor.js", (text) => texts.push(text));
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.resume).toHaveBeenCalled();
    await live.ready;
    const socket = FakeSocket.last;
    expect(socket.binaryType).toBe("arraybuffer");
    const chunk = new Int16Array([1, 2]).buffer;
    FakeNode.last.port.onmessage?.({ data: chunk });
    expect(socket.sent).toEqual([chunk]);
    socket.say("not json");
    socket.say(new ArrayBuffer(2));
    socket.say(JSON.stringify({ event: "Update", transcript: "Tell me" }));
    socket.say(JSON.stringify({ event: "EndOfTurn", transcript: "Tell me about Shepherd " }));
    await expect(live.result).resolves.toBe("Tell me about Shepherd");
    expect(texts).toEqual(["Tell me", "Tell me about Shepherd "]);
    expect(stopTrack).toHaveBeenCalled();
    expect(socket.closed).toBe(true);
    live.stop();
  });

  it("on stop, flushes audio, asks for the final words and keeps what it has", async () => {
    installDictationFakes();
    vi.useFakeTimers();
    const live = startDictation("wss://site/agents/dictation", "/w.js", () => {});
    await vi.waitFor(() => expect(FakeSocket.last.readyState).toBe(1));
    await settle();
    FakeSocket.last.say(JSON.stringify({ event: "Update", transcript: "Half a thought" }));
    live.stop();
    expect(FakeNode.last.port.postMessage).toHaveBeenCalledWith("stop");
    expect(FakeSocket.last.sent).toContain("stop");
    vi.advanceTimersByTime(1_500);
    await expect(live.result).resolves.toBe("Half a thought");
  });

  it("rejects ready when the socket is refused, and ends early if stopped before connecting", async () => {
    installDictationFakes({ connect: "close" });
    const refused = startDictation("wss://site/agents/dictation", "/w.js", () => {});
    await expect(refused.ready).rejects.toThrow("refused");
    installDictationFakes({ connect: "error" });
    const failed = startDictation("wss://site/agents/dictation", "/w.js", () => {});
    await expect(failed.ready).rejects.toThrow("did not connect");

    const { stopTrack } = installDictationFakes();
    const early = startDictation("wss://site/agents/dictation", "/w.js", () => {});
    early.stop();
    await expect(early.result).resolves.toBe("");
    await early.ready;
    expect(stopTrack).toHaveBeenCalled();
  });

  it("keeps the transcript when the server closes the session", async () => {
    installDictationFakes();
    const live = startDictation("wss://site/agents/dictation", "/w.js", () => {});
    await live.ready;
    FakeSocket.last.say(JSON.stringify({ event: "Update", transcript: "Cut off" }));
    FakeSocket.last.dispatchEvent(new Event("close"));
    await expect(live.result).resolves.toBe("Cut off");
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
