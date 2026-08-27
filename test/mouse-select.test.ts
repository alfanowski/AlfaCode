import { describe, expect, it, vi } from "vitest";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  mouseSelectionRowSpan,
  parseSgrMouseSequence,
  reduceMouseSelection,
  resolveMouseSelectionItems,
  useMouseTrackingMode,
  type MouseSelectionTrackerState,
} from "../src/ui/mouse-select.js";

describe("SGR mouse escape sequences", () => {
  it("enable sequence turns on button reporting (1000) and SGR/decimal coordinates (1006)", () => {
    expect(ENABLE_MOUSE_TRACKING).toBe("\x1b[?1000h\x1b[?1006h");
  });

  it("disable sequence is the exact inverse", () => {
    expect(DISABLE_MOUSE_TRACKING).toBe("\x1b[?1000l\x1b[?1006l");
  });
});

describe("parseSgrMouseSequence", () => {
  it("decodes a left-button press", () => {
    expect(parseSgrMouseSequence("\x1b[<0;45;12M")).toEqual({ kind: "press", button: 0, column: 45, row: 12, isWheel: false });
  });

  it("also decodes the ESC-stripped form Ink actually hands to useInput", () => {
    expect(parseSgrMouseSequence("[<0;45;12M")).toEqual({ kind: "press", button: 0, column: 45, row: 12, isWheel: false });
  });

  it("decodes a drag (motion bit 0x20 set) for the same button", () => {
    // 0 | 0x20 = 32
    expect(parseSgrMouseSequence("[<32;50;12M")).toEqual({ kind: "drag", button: 0, column: 50, row: 12, isWheel: false });
  });

  it("decodes a release ('m' final byte) distinctly from a press/drag ('M')", () => {
    expect(parseSgrMouseSequence("[<0;60;12m")).toEqual({ kind: "release", button: 0, column: 60, row: 12, isWheel: false });
  });

  it("decodes middle (1) and right (2) button codes", () => {
    expect(parseSgrMouseSequence("[<1;1;1M")?.button).toBe(1);
    expect(parseSgrMouseSequence("[<2;1;1M")?.button).toBe(2);
  });

  it("flags wheel events (bit 0x40) separately from the button field", () => {
    const wheelUp = parseSgrMouseSequence("[<64;10;10M");
    expect(wheelUp?.isWheel).toBe(true);
  });

  it("returns undefined for non-mouse escape sequences and plain text", () => {
    expect(parseSgrMouseSequence("[A")).toBeUndefined(); // arrow key CSI, not a mouse report
    expect(parseSgrMouseSequence("hello")).toBeUndefined();
    expect(parseSgrMouseSequence("")).toBeUndefined();
  });

  it("returns undefined for a malformed/incomplete mouse report", () => {
    expect(parseSgrMouseSequence("[<0;45M")).toBeUndefined(); // missing a field
    expect(parseSgrMouseSequence("[<0;45;12X")).toBeUndefined(); // wrong final byte
    expect(parseSgrMouseSequence("[<0;0;0M")).toBeUndefined(); // rows/cols are 1-based
  });
});

describe("reduceMouseSelection", () => {
  it("press establishes tracker state and completes nothing", () => {
    const result = reduceMouseSelection(undefined, { kind: "press", button: 0, column: 5, row: 5, isWheel: false });
    expect(result).toEqual({ state: { startRow: 5, startCol: 5 }, completed: undefined });
  });

  it("press → release at a different cell completes a span", () => {
    const afterPress = reduceMouseSelection(undefined, { kind: "press", button: 0, column: 5, row: 5, isWheel: false });
    const afterRelease = reduceMouseSelection(afterPress.state, { kind: "release", button: 0, column: 20, row: 8, isWheel: false });
    expect(afterRelease).toEqual({ state: undefined, completed: { startRow: 5, startCol: 5, endRow: 8, endCol: 20 } });
  });

  it("press → drag → drag → release completes a span using press-start and release-end only", () => {
    let state: MouseSelectionTrackerState | undefined;
    state = reduceMouseSelection(state, { kind: "press", button: 0, column: 1, row: 1, isWheel: false }).state;
    state = reduceMouseSelection(state, { kind: "drag", button: 0, column: 3, row: 1, isWheel: false }).state;
    state = reduceMouseSelection(state, { kind: "drag", button: 0, column: 10, row: 2, isWheel: false }).state;
    const result = reduceMouseSelection(state, { kind: "release", button: 0, column: 15, row: 3, isWheel: false });
    expect(result.completed).toEqual({ startRow: 1, startCol: 1, endRow: 3, endCol: 15 });
  });

  it("a click (release at the exact press cell) completes nothing — it selected no text", () => {
    const afterPress = reduceMouseSelection(undefined, { kind: "press", button: 0, column: 7, row: 7, isWheel: false });
    const afterRelease = reduceMouseSelection(afterPress.state, { kind: "release", button: 0, column: 7, row: 7, isWheel: false });
    expect(afterRelease).toEqual({ state: undefined, completed: undefined });
  });

  it("ignores non-left buttons entirely (state and completion both untouched)", () => {
    const state: MouseSelectionTrackerState = { startRow: 1, startCol: 1 };
    const rightPress = reduceMouseSelection(state, { kind: "press", button: 2, column: 9, row: 9, isWheel: false });
    expect(rightPress).toEqual({ state, completed: undefined });
    const rightRelease = reduceMouseSelection(state, { kind: "release", button: 2, column: 9, row: 9, isWheel: false });
    expect(rightRelease).toEqual({ state, completed: undefined });
  });

  it("ignores wheel events even when the button field happens to be 0", () => {
    const state: MouseSelectionTrackerState = { startRow: 1, startCol: 1 };
    const wheel = reduceMouseSelection(state, { kind: "press", button: 0, column: 9, row: 9, isWheel: true });
    expect(wheel).toEqual({ state, completed: undefined });
  });

  it("a release with no preceding press completes nothing", () => {
    expect(reduceMouseSelection(undefined, { kind: "release", button: 0, column: 1, row: 1, isWheel: false })).toEqual({ state: undefined, completed: undefined });
  });
});

describe("mouseSelectionRowSpan", () => {
  it("is inclusive of both endpoints and direction-independent", () => {
    expect(mouseSelectionRowSpan({ startRow: 5, startCol: 1, endRow: 8, endCol: 1 })).toBe(4);
    expect(mouseSelectionRowSpan({ startRow: 8, startCol: 1, endRow: 5, endCol: 1 })).toBe(4);
  });

  it("is 1 for a single-row span", () => {
    expect(mouseSelectionRowSpan({ startRow: 5, startCol: 1, endRow: 5, endCol: 9 })).toBe(1);
  });
});

describe("resolveMouseSelectionItems (row-span → whole rendered items)", () => {
  const estimateRows = (item: { rows: number }): number => item.rows;

  it("returns nothing for an empty item list or a non-positive row span", () => {
    expect(resolveMouseSelectionItems([], 3, estimateRows)).toEqual([]);
    expect(resolveMouseSelectionItems([{ rows: 1 }], 0, estimateRows)).toEqual([]);
  });

  it("takes a single trailing item when its own row count already covers the span", () => {
    const items = [{ id: "a", rows: 1 }, { id: "b", rows: 4 }];
    expect(resolveMouseSelectionItems(items, 2, estimateRows)).toEqual([{ id: "b", rows: 4 }]);
  });

  it("walks backward accumulating rows until the span is covered, in chronological (oldest-first) order", () => {
    const items = [{ id: "a", rows: 2 }, { id: "b", rows: 1 }, { id: "c", rows: 1 }, { id: "d", rows: 1 }];
    // rowSpan 3: d(1) -> 1, c(1) -> 2, b(1) -> 3 (reached) — stop, keep chronological order.
    expect(resolveMouseSelectionItems(items, 3, estimateRows)).toEqual([{ id: "b", rows: 1 }, { id: "c", rows: 1 }, { id: "d", rows: 1 }]);
  });

  it("clamps to the whole list when the row span exceeds everything rendered", () => {
    const items = [{ id: "a", rows: 1 }, { id: "b", rows: 1 }];
    expect(resolveMouseSelectionItems(items, 100, estimateRows)).toEqual(items);
  });
});

function MouseTrackingHost({ enabled, stdout }: { readonly enabled: boolean; readonly stdout: { write: (chunk: string) => boolean } }): React.JSX.Element {
  useMouseTrackingMode({ enabled, stdout });
  return React.createElement(Text, null, "host");
}

describe("useMouseTrackingMode lifecycle", () => {
  it("writes the enable sequence on mount and the disable sequence on unmount", () => {
    const write = vi.fn(() => true);
    const instance = render(React.createElement(MouseTrackingHost, { enabled: true, stdout: { write } }));
    expect(write).toHaveBeenCalledWith(ENABLE_MOUSE_TRACKING);
    write.mockClear();
    instance.unmount();
    expect(write).toHaveBeenCalledWith(DISABLE_MOUSE_TRACKING);
  });

  it("writes neither sequence when disabled", () => {
    const write = vi.fn(() => true);
    const instance = render(React.createElement(MouseTrackingHost, { enabled: false, stdout: { write } }));
    expect(write).not.toHaveBeenCalled();
    instance.unmount();
    expect(write).not.toHaveBeenCalled();
  });

  it("enables mid-session when the setting flips from off to on, and still disables on unmount", () => {
    const write = vi.fn(() => true);
    const instance = render(React.createElement(MouseTrackingHost, { enabled: false, stdout: { write } }));
    expect(write).not.toHaveBeenCalled();
    instance.rerender(React.createElement(MouseTrackingHost, { enabled: true, stdout: { write } }));
    expect(write).toHaveBeenCalledWith(ENABLE_MOUSE_TRACKING);
    write.mockClear();
    instance.unmount();
    expect(write).toHaveBeenCalledWith(DISABLE_MOUSE_TRACKING);
  });
});
