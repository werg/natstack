import React from "react";
import { Alert } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { Provider, createStore } from "jotai";
import { ConnectionBar } from "./ConnectionBar";
import { connectionStatusAtom, networkReachableAtom } from "../state/connectionAtoms";
import { shellClientAtom } from "../state/shellClientAtom";

type AlertButton = { text?: string; onPress?: () => void };

describe("ConnectionBar", () => {
  it("offers reconnect and re-pair when disconnected", () => {
    const reconnect = jest.fn();
    const onRepair = jest.fn();
    const store = createStore();
    store.set(connectionStatusAtom, "disconnected");
    store.set(shellClientAtom, { transport: { reconnect } } as never);

    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);

    const { getByRole } = render(
      <Provider store={store}>
        <ConnectionBar onRepair={onRepair} />
      </Provider>,
    );

    fireEvent.press(getByRole("button"));

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as AlertButton[];
    expect(buttons.map((button) => button.text)).toEqual([
      "Reconnect",
      "Re-pair device",
      "Cancel",
    ]);

    buttons.find((button) => button.text === "Reconnect")?.onPress?.();
    expect(reconnect).toHaveBeenCalledTimes(1);

    buttons.find((button) => button.text === "Re-pair device")?.onPress?.();
    expect(onRepair).toHaveBeenCalledTimes(1);

    alertSpy.mockRestore();
  });

  it("omits re-pair when no handler is supplied and stays offline-aware", () => {
    const store = createStore();
    store.set(connectionStatusAtom, "connected");
    store.set(networkReachableAtom, false);

    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);

    const { getByRole } = render(
      <Provider store={store}>
        <ConnectionBar />
      </Provider>,
    );

    // Offline forces the actionable state even if the transport reports connected.
    fireEvent.press(getByRole("button"));
    const buttons = (alertSpy.mock.calls[0]?.[2] ?? []) as AlertButton[];
    expect(buttons.map((button) => button.text)).toEqual(["Reconnect", "Cancel"]);

    alertSpy.mockRestore();
  });

  it("is not interactive when connected and online", () => {
    const store = createStore();
    store.set(connectionStatusAtom, "connected");
    store.set(networkReachableAtom, true);

    const { queryByRole } = render(
      <Provider store={store}>
        <ConnectionBar />
      </Provider>,
    );

    expect(queryByRole("button")).toBeNull();
  });
});
