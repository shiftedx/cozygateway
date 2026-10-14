import { describe, expect, it } from "vitest";

import { acceptAssistantMediaBytes, acceptChatAttachmentBytes } from "../src/hermes-bridge/assistant-media.ts";

const ftyp = (brand: string): Uint8Array =>
  Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, ...[...brand].map((ch) => ch.charCodeAt(0))]);
const noImage = () => undefined;

/** The head of an AAC `.m4a` from iOS AVAudioRecorder: a 28-byte `ftyp` with major brand `M4A `
 *  (trailing space), minor version 0, compatible brands `M4A `, `mp42`, `isom`, then a `free` box. */
const avAudioRecorderM4a = Uint8Array.from([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x00, 0x00,
  0x4d, 0x34, 0x41, 0x20, 0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x08, 0x66, 0x72, 0x65, 0x65,
]);

// Matches CozyAgents' embedded gateway: `audio/mp4` needs an audio-appropriate major brand, while
// `video/mp4` keeps its broad ISO BMFF check. The sniffer is shared, so both acceptors see it.
describe("audio/mp4 major-brand allow-list", () => {
  it("accepts an iOS AVAudioRecorder AAC .m4a header", () => {
    expect(acceptChatAttachmentBytes("audio/mp4", "voice.m4a", avAudioRecorderM4a)).toMatchObject({ mime: "audio/mp4", ext: "m4a" });
    expect(acceptAssistantMediaBytes("audio/mp4", avAudioRecorderM4a, noImage)).toMatchObject({ kind: "audio" });
  });

  it.each(["M4A ", "M4B ", "mp42", "isom", "iso2"])("accepts major brand '%s' as audio/mp4", (brand) => {
    expect(acceptChatAttachmentBytes("audio/mp4", "voice.m4a", ftyp(brand))).toMatchObject({ mime: "audio/mp4" });
    expect(acceptAssistantMediaBytes("audio/mp4", ftyp(brand), noImage)).toMatchObject({ mime: "audio/mp4" });
  });

  // The trailing space in `M4A ` is part of the brand: `M4A\0` is not it.
  it.each(["qt  ", "heic", "avif", "M4A\0", "mp41"])("refuses major brand %j as audio/mp4", (brand) => {
    expect(() => acceptChatAttachmentBytes("audio/mp4", "voice.m4a", ftyp(brand))).toThrow(/did not match/);
    expect(() => acceptAssistantMediaBytes("audio/mp4", ftyp(brand), noImage)).toThrow(/did not match/);
  });

  it("leaves video/mp4's own sniff as it was", () => {
    expect(acceptAssistantMediaBytes("video/mp4", ftyp("isom"), noImage)).toMatchObject({ mime: "video/mp4" });
    expect(acceptAssistantMediaBytes("video/mp4", ftyp("heic"), noImage)).toMatchObject({ mime: "video/mp4" });
    expect(() => acceptAssistantMediaBytes("video/mp4", ftyp("qt  "), noImage)).toThrow(/did not match/);
  });
});
