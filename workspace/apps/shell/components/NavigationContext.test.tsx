// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NavigationProvider, useNavigation } from "./NavigationContext";

function ModeProbe() {
  const { mode } = useNavigation();
  return <div data-testid="mode">{mode}</div>;
}

function renderMode() {
  render(
    <NavigationProvider>
      <ModeProbe />
    </NavigationProvider>
  );

  return screen.getByTestId("mode").textContent;
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-width: 767px)" ? false : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NavigationProvider", () => {
  it("defaults to tree navigation on wider windows", () => {
    expect(renderMode()).toBe("tree");
  });

  it("defaults to stack navigation on very small windows", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    }));

    expect(renderMode()).toBe("stack");
  });
});
