import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Header } from "../src/chat-tui.js";
import { getTheme } from "../src/ui/theme.js";

const theme = getTheme("nova");

describe("Header", () => {
  const base = { model: "route/model", mode: "default" as const, providers: 3, compatible: true, theme, width: 80 };

  it("keeps every existing piece of information present while ready", () => {
    const frame = render(<Header {...base} busy={false} />).lastFrame() ?? "";
    expect(frame).toContain("AlfaCode");
    expect(frame).toContain("ready");
    expect(frame).toContain("route");
    expect(frame).toContain("model");
    expect(frame).toContain("3P");
    expect(frame).toContain("default");
  });

  it("keeps every existing piece of information present while busy, plus the mismatch warning", () => {
    const frame = render(<Header {...base} busy compatible={false} />).lastFrame() ?? "";
    expect(frame).toContain("AlfaCode");
    expect(frame).toContain("working");
    expect(frame).toContain("route");
    expect(frame).toContain("model");
    expect(frame).toContain("3P");
    expect(frame).toContain("default");
    expect(frame).toContain("mismatch");
  });

  it("renders a full-width activity rule beneath the info rows in both states", () => {
    const readyFrame = render(<Header {...base} busy={false} />).lastFrame() ?? "";
    const busyFrame = render(<Header {...base} busy />).lastFrame() ?? "";
    expect(readyFrame).toContain("━");
    expect(busyFrame).toContain("━");
  });

  it("degrades correctly at a narrow terminal width without throwing", () => {
    const frame = render(<Header {...base} width={30} busy />).lastFrame() ?? "";
    expect(frame).toContain("AlfaCode");
    expect(frame).toContain("working");
  });
});
