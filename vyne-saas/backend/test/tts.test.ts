import { describe, it, expect } from "vitest";
import { pcmToWav } from "../src/llm/tts.js";

describe("pcmToWav", () => {
  it("produces a valid RIFF/WAV header around the PCM payload", () => {
    const pcm = Buffer.alloc(4800, 7); // 100ms of 24kHz mono s16le
    const wav = pcmToWav(pcm, 24000);
    expect(wav.length).toBe(44 + 4800);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(24000);      // sample rate
    expect(wav.readUInt16LE(22)).toBe(1);          // mono
    expect(wav.readUInt32LE(40)).toBe(4800);       // data size
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });
});
