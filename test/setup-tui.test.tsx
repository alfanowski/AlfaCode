import { afterEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { ProviderSetup } from "../src/setup-tui.js";
import type { ProviderDescriptor } from "../src/provider-descriptors.js";

/** Ink commits a keypress-driven re-render asynchronously; give it a tick before reading the frame. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

const ESC = "";

// None of these display names, ids, or descriptions contain a digit, so if a typed digit were
// (incorrectly) fed into the free-text search box before being interpreted as a numbered
// selection, it would narrow the list to zero matches rather than resolve to an entry.
const descriptors: readonly ProviderDescriptor[] = [
  { id: "alpha", configType: "alpha", displayName: "Alpha Cloud", description: "First provider", allowsAnonymous: true },
  { id: "bravo", configType: "bravo", displayName: "Bravo Sky", description: "Second provider", allowsAnonymous: true },
  { id: "charlie", configType: "charlie", displayName: "Charlie Base", description: "Third provider", allowsAnonymous: true },
];

describe("screen-reader numbered provider selection (setup-tui ProviderList)", () => {
  afterEach(() => { delete process.env.ALFACODE_SCREEN_READER; });

  it("selects the numbered entry on the digit keystroke itself, against the pre-keystroke list — not at Enter against an already-mutated search filter", async () => {
    process.env.ALFACODE_SCREEN_READER = "1";
    const view = render(<ProviderSetup descriptors={descriptors} connect={async () => {}} />);
    expect(view.lastFrame()).toContain("2) Bravo Sky");

    view.stdin.write("2");
    await settle();

    // Resolved immediately — no Enter needed — and against "bravo" (index 1, the entry actually
    // labeled "2)" before the keystroke), not against a filter re-narrowed by the digit "2" itself.
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Connect Bravo Sky");
    expect(frame).not.toContain("Choose a provider");
  });

  it("still supports the arrow-key + enter path alongside the numbered shortcut", async () => {
    process.env.ALFACODE_SCREEN_READER = "1";
    const view = render(<ProviderSetup descriptors={descriptors} connect={async () => {}} />);
    view.stdin.write(`${ESC}[B`); // down arrow: alpha -> bravo
    await settle();
    view.stdin.write("\r"); // enter
    await settle();

    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Connect Bravo Sky");
  });

  it("treats typed digits as ordinary search text when screen-reader mode is off", async () => {
    const view = render(<ProviderSetup descriptors={descriptors} connect={async () => {}} />);
    view.stdin.write("2");
    await settle();

    // No numbered entries are on offer, so "2" is just narrowing the free-text search — which
    // matches nothing here — and selection stays on the provider list.
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Choose a provider");
    expect(frame).not.toContain("Connect Bravo Sky");
  });
});
