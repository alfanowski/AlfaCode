import { describe, expect, it, vi } from "vitest";
import { createClipboardImageReader, mediaTypeForExtension, type ClipboardImageDeps } from "../src/ui/clipboard-image.js";

function deps(overrides: Partial<ClipboardImageDeps>): ClipboardImageDeps {
  return {
    platform: () => "darwin",
    execFile: vi.fn(async () => Buffer.from("")),
    readFile: vi.fn(async () => Buffer.from("")),
    cleanup: vi.fn(async () => undefined),
    tempFile: vi.fn((extension: string) => `/tmp/fixture.${extension}`),
    ...overrides,
  };
}

describe("clipboard image reader", () => {
  it("reads a PNG straight off the macOS clipboard via osascript", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const execFile = vi.fn(async (command: string) => {
      expect(command).toBe("osascript");
      return Buffer.from("OK\n");
    });
    const readFile = vi.fn(async (path: string) => { expect(path).toBe("/tmp/fixture.png"); return pngBytes; });
    const cleanup = vi.fn(async () => undefined);
    const reader = createClipboardImageReader(deps({ execFile, readFile, cleanup }));

    const image = await reader();

    expect(image).toEqual({ mediaType: "image/png", base64: pngBytes.toString("base64") });
    expect(execFile).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith("/tmp/fixture.png");
  });

  it("falls back to a TIFF-then-sips conversion when the clipboard has no PNG representation", async () => {
    const pngBytes = Buffer.from([1, 2, 3]);
    let call = 0;
    const execFile = vi.fn(async (command: string, args: readonly string[]) => {
      call += 1;
      if (call === 1) { expect(command).toBe("osascript"); return Buffer.from("NONE\n"); } // PNG attempt fails
      if (call === 2) { expect(command).toBe("osascript"); return Buffer.from("OK\n"); } // TIFF attempt succeeds
      expect(command).toBe("sips");
      expect(args).toContain("/tmp/fixture.tiff");
      return Buffer.from("");
    });
    const readFile = vi.fn(async (path: string) => { expect(path).toBe("/tmp/fixture.png"); return pngBytes; });
    const reader = createClipboardImageReader(deps({ execFile, readFile }));

    const image = await reader();

    expect(image).toEqual({ mediaType: "image/png", base64: pngBytes.toString("base64") });
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it("returns undefined when the macOS clipboard has neither PNG nor TIFF data", async () => {
    const execFile = vi.fn(async () => Buffer.from("NONE\n"));
    const reader = createClipboardImageReader(deps({ execFile }));

    await expect(reader()).resolves.toBeUndefined();
  });

  it("tries wl-paste then xclip on Linux, returning the first tool's raw PNG bytes", async () => {
    const pngBytes = Buffer.from([9, 9, 9]);
    const execFile = vi.fn(async (command: string) => {
      if (command === "wl-paste") throw new Error("not found");
      expect(command).toBe("xclip");
      return pngBytes;
    });
    const reader = createClipboardImageReader(deps({ platform: () => "linux", execFile }));

    await expect(reader()).resolves.toEqual({ mediaType: "image/png", base64: pngBytes.toString("base64") });
  });

  it("returns undefined on Linux when neither clipboard tool is available", async () => {
    const execFile = vi.fn(async () => { throw new Error("not found"); });
    const reader = createClipboardImageReader(deps({ platform: () => "linux", execFile }));

    await expect(reader()).resolves.toBeUndefined();
  });

  it("reads the clipboard via PowerShell on Windows", async () => {
    const pngBytes = Buffer.from([4, 5, 6]);
    const execFile = vi.fn(async (command: string) => { expect(command).toBe("powershell"); return Buffer.from("OK\n"); });
    const readFile = vi.fn(async () => pngBytes);
    const reader = createClipboardImageReader(deps({ platform: () => "win32", execFile, readFile }));

    await expect(reader()).resolves.toEqual({ mediaType: "image/png", base64: pngBytes.toString("base64") });
  });

  it("resolves to undefined instead of throwing on an unsupported platform", async () => {
    const execFile = vi.fn(async () => Buffer.from(""));
    const reader = createClipboardImageReader(deps({ platform: () => "sunos", execFile }));

    await expect(reader()).resolves.toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("swallows any unexpected error and resolves undefined rather than crashing the composer", async () => {
    const execFile = vi.fn(async () => { throw new Error("boom"); });
    const reader = createClipboardImageReader(deps({ execFile }));

    await expect(reader()).resolves.toBeUndefined();
  });
});

describe("mediaTypeForExtension", () => {
  it("maps common image extensions to Anthropic-supported media types", () => {
    expect(mediaTypeForExtension("photo.PNG")).toBe("image/png");
    expect(mediaTypeForExtension("photo.jpg")).toBe("image/jpeg");
    expect(mediaTypeForExtension("photo.jpeg")).toBe("image/jpeg");
    expect(mediaTypeForExtension("photo.gif")).toBe("image/gif");
    expect(mediaTypeForExtension("photo.webp")).toBe("image/webp");
  });

  it("returns undefined for anything else", () => {
    expect(mediaTypeForExtension("document.pdf")).toBeUndefined();
    expect(mediaTypeForExtension("noextension")).toBeUndefined();
  });
});
