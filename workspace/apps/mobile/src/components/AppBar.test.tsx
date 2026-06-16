import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { AppBar } from "./AppBar";
import type { AddressAutocompleteItem } from "@natstack/shared/panelChrome";

jest.mock("@natstack/shared/panelChrome", () => ({
  splitTextByMatchRanges: (text: string, ranges?: Array<{ start: number; end: number }>) => {
    if (!ranges?.length) return [{ text, highlighted: false }];
    const [range] = ranges;
    return [
      { text: text.slice(0, range.start), highlighted: false },
      { text: text.slice(range.start, range.end), highlighted: true },
      { text: text.slice(range.end), highlighted: false },
    ].filter((part) => part.text);
  },
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const suggestion: AddressAutocompleteItem = {
  id: "history:https://example.test/docs",
  kind: "history",
  value: "https://example.test/docs",
  label: "Example Docs",
  meta: "https://example.test/docs",
  iconKind: "history",
  matchRanges: {
    label: [{ start: 8, end: 12 }],
  },
  action: { type: "navigate-url", url: "https://example.test/docs" },
  browser: { url: "https://example.test/docs", title: "Example Docs", source: "history" },
};

describe("AppBar address UX", () => {
  it("updates the address query and selects shared autocomplete actions", () => {
    const onAddressQueryChange = jest.fn();
    const onSelectAddressSuggestion = jest.fn();
    const { getByTestId } = render(
      <AppBar
        title="Panel"
        onMenuPress={jest.fn()}
        addressBarVisible
        address="https://example.test"
        addressSuggestions={[suggestion]}
        onAddressQueryChange={onAddressQueryChange}
        onSelectAddressSuggestion={onSelectAddressSuggestion}
      />,
    );

    fireEvent(getByTestId("address-input"), "focus");
    fireEvent.changeText(getByTestId("address-input"), "docs");
    fireEvent.press(getByTestId("address-suggestion-0"));

    expect(onAddressQueryChange).toHaveBeenCalledWith("docs");
    expect(onSelectAddressSuggestion).toHaveBeenCalledWith(suggestion);
  });
});
