import React from "react";
import { createStackNavigator } from "@react-navigation/stack";
import { LoginScreen } from "../components/LoginScreen";
import { MainNavigator } from "./MainNavigator";
import { SettingsScreen } from "../components/SettingsScreen";

export type RootStackParamList = {
  Login: undefined;
  Main: undefined;
  Settings: undefined;
};

const Stack = createStackNavigator<RootStackParamList>();

export function RootNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="Login"
      screenOptions={{ headerShown: false }}
    >
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Main" component={MainNavigator} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
    </Stack.Navigator>
  );
}
