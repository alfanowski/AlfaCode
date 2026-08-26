import { describe, expect, it } from "vitest";
import { getTheme, inferThemeMode, isThemeName, resolveTheme, resolveThemeName, supportsMotion, themeCatalog, themeNames } from "../src/ui/theme.js";

describe("terminal theme", () => {
  it("infers dark and light backgrounds from COLORFGBG", () => {
    expect(inferThemeMode("15;0")).toBe("dark");
    expect(inferThemeMode("0;15")).toBe("light");
    expect(inferThemeMode(undefined)).toBe("dark");
  });

  it("allows an explicit theme override", () => {
    expect(resolveTheme({ ALFACODE_THEME: "light", COLORFGBG: "15;0" }).mode).toBe("light");
  });

  it("falls back to the inferred mode for an unknown theme name", () => {
    expect(resolveThemeName({ ALFACODE_THEME: "not-a-real-theme", COLORFGBG: "0;15" })).toBe("light");
  });

  it("resolves every built-in theme name, including the colorblind-friendly variants", () => {
    expect(resolveThemeName({ ALFACODE_THEME: "dark" })).toBe("dark");
    expect(resolveThemeName({ ALFACODE_THEME: "light" })).toBe("light");
    expect(resolveThemeName({ ALFACODE_THEME: "dark-daltonized" })).toBe("dark-daltonized");
    expect(resolveThemeName({ ALFACODE_THEME: "light-daltonized" })).toBe("light-daltonized");
  });

  it("accepts an uppercase or mixed-case override", () => {
    expect(resolveThemeName({ ALFACODE_THEME: "Dark-Daltonized" })).toBe("dark-daltonized");
  });

  it("exposes exactly four built-in themes, half of them colorblind-safe", () => {
    expect(themeNames).toEqual(["dark", "light", "dark-daltonized", "light-daltonized"]);
    expect(themeCatalog).toHaveLength(4);
    expect(themeCatalog.filter((entry) => entry.theme.colorblindSafe).map((entry) => entry.name)).toEqual([
      "dark-daltonized",
      "light-daltonized",
    ]);
  });

  it("gives every theme a distinct, non-empty color for every token", () => {
    for (const entry of themeCatalog) {
      const theme = getTheme(entry.name);
      const values = Object.entries(theme).filter(([key]) => key !== "name" && key !== "mode" && key !== "colorblindSafe");
      for (const [token, value] of values) {
        expect(value, `${entry.name}.${token}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it("rejects an invalid theme name", () => {
    expect(isThemeName("dark")).toBe(true);
    expect(isThemeName("nope")).toBe(false);
  });

  it("disables motion in automation and reduced-motion mode", () => {
    expect(supportsMotion({ CI: "true" })).toBe(false);
    expect(supportsMotion({ ALFACODE_REDUCED_MOTION: "1" })).toBe(false);
    expect(supportsMotion({ TERM: "xterm-256color" })).toBe(true);
  });
});
