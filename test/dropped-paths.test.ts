import { describe, expect, it } from "vitest";
import { detectDroppedPaths, resolveDroppedPaths } from "../src/ui/dropped-paths.js";

describe("detectDroppedPaths", () => {
  it("recognizes a single absolute path drop", () => {
    expect(detectDroppedPaths("/Users/alfa/Desktop/photo.png")).toEqual([
      { raw: "/Users/alfa/Desktop/photo.png", absolutePath: "/Users/alfa/Desktop/photo.png", looksLikeImage: true },
    ]);
  });

  it("recognizes a multi-file drop, one path per line", () => {
    const pasted = "/Users/alfa/a.txt\n/Users/alfa/b.txt";
    expect(detectDroppedPaths(pasted)).toEqual([
      { raw: "/Users/alfa/a.txt", absolutePath: "/Users/alfa/a.txt", looksLikeImage: false },
      { raw: "/Users/alfa/b.txt", absolutePath: "/Users/alfa/b.txt", looksLikeImage: false },
    ]);
  });

  it("flags known image extensions case-insensitively", () => {
    expect(detectDroppedPaths("/Users/alfa/shot.JPG")?.[0]?.looksLikeImage).toBe(true);
    expect(detectDroppedPaths("/Users/alfa/notes.md")?.[0]?.looksLikeImage).toBe(false);
  });

  it("decodes a file:// URI drop", () => {
    expect(detectDroppedPaths("file:///Users/alfa/My%20File.png")).toEqual([
      { raw: "file:///Users/alfa/My%20File.png", absolutePath: "/Users/alfa/My File.png", looksLikeImage: true },
    ]);
  });

  it("unwraps shell-quoted and shell-escaped paths", () => {
    expect(detectDroppedPaths('"/Users/alfa/My File.png"')?.[0]?.absolutePath).toBe("/Users/alfa/My File.png");
    expect(detectDroppedPaths("/Users/alfa/My\\ File.png")?.[0]?.absolutePath).toBe("/Users/alfa/My File.png");
  });

  it("recognizes a Windows-style absolute path", () => {
    expect(detectDroppedPaths("C:\\Users\\alfa\\photo.png")?.[0]?.absolutePath).toBe("C:\\Users\\alfa\\photo.png");
  });

  it("returns undefined for ordinary pasted text", () => {
    expect(detectDroppedPaths("just some pasted prose")).toBeUndefined();
    expect(detectDroppedPaths("relative/path.txt")).toBeUndefined();
  });

  it("returns undefined for a single typed character", () => {
    expect(detectDroppedPaths("/")).toBeUndefined();
  });

  it("returns undefined when one line in a multi-line paste isn't a bare path (avoids false positives on pasted commands)", () => {
    expect(detectDroppedPaths("/usr/bin/env python3 -c 'print(1)'")).toBeUndefined();
  });
});

describe("resolveDroppedPaths", () => {
  it("keeps only candidates that exist on disk", async () => {
    const candidates = detectDroppedPaths("/exists/a.png\n/missing/b.png")!;
    const stat = async (path: string) => {
      if (path === "/missing/b.png") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isDirectory: () => false };
    };
    const resolved = await resolveDroppedPaths(candidates, stat);
    expect(resolved.map((entry) => entry.absolutePath)).toEqual(["/exists/a.png"]);
    expect(resolved[0]?.isDirectory).toBe(false);
  });
});
