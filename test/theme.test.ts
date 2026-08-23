import { describe, expect, it } from "vitest";
import { inferThemeMode, resolveTheme, supportsMotion } from "../src/ui/theme.js";

describe("terminal theme", () => {
  it("infers dark and light backgrounds from COLORFGBG", () => {
    expect(inferThemeMode("15;0")).toBe("dark");
    expect(inferThemeMode("0;15")).toBe("light");
    expect(inferThemeMode(undefined)).toBe("dark");
  });

  it("allows an explicit theme override", () => {
    expect(resolveTheme({ ALFACODE_THEME: "light", COLORFGBG: "15;0" }).mode).toBe("light");
  });

  it("disables motion in automation and reduced-motion mode", () => {
    expect(supportsMotion({ CI: "true" })).toBe(false);
    expect(supportsMotion({ ALFACODE_REDUCED_MOTION: "1" })).toBe(false);
    expect(supportsMotion({ TERM: "xterm-256color" })).toBe(true);
  });
});
