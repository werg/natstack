/**
 * MainNavigator -- Drawer navigator wrapping the main panel screen.
 *
 * Uses @react-navigation/drawer with PanelDrawer as custom drawer content.
 * The drawer is swipeable from the left edge. The main content area shows
 * the AppBar + panel content (WebViews will be wired by Agent F).
 */

import React, { useCallback } from "react";
import { createDrawerNavigator } from "@react-navigation/drawer";
import { useSetAtom } from "jotai";
import { MainScreen } from "../components/MainScreen";
import { PanelDrawer } from "../components/PanelDrawer";
import { activePanelIdAtom } from "../state/navigationAtoms";

export type DrawerParamList = {
  PanelContent: undefined;
};

const Drawer = createDrawerNavigator<DrawerParamList>();

export function MainNavigator() {
  return (
    <Drawer.Navigator
      screenOptions={{
        headerShown: false,
        drawerType: "front",
        drawerStyle: { width: 280 },
        swipeEnabled: true,
        swipeEdgeWidth: 50,
      }}
      drawerContent={(props: { navigation: { closeDrawer: () => void } }) => (
        <DrawerContentWrapper navigation={props.navigation} />
      )}
    >
      <Drawer.Screen name="PanelContent" component={MainScreen} />
    </Drawer.Navigator>
  );
}

/**
 * Wrapper that provides PanelDrawer with the onSelectPanel callback.
 * Sets the active panel atom and closes the drawer.
 */
function DrawerContentWrapper({ navigation }: { navigation: { closeDrawer: () => void } }) {
  const setActivePanelId = useSetAtom(activePanelIdAtom);

  const handleSelectPanel = useCallback(
    (panelId: string) => {
      setActivePanelId(panelId);
      navigation.closeDrawer();
    },
    [setActivePanelId, navigation],
  );

  return <PanelDrawer onSelectPanel={handleSelectPanel} />;
}
