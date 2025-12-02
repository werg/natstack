import { useAtom } from "jotai";
import { IconButton, Tooltip, DropdownMenu } from "@radix-ui/themes";
import { SunIcon, MoonIcon, DesktopIcon } from "@radix-ui/react-icons";
import { themeModeAtom, type ThemeMode } from "../state/uiAtoms";

/**
 * Get the icon for the current theme mode.
 */
function ThemeIcon({ mode }: { mode: ThemeMode }) {
  switch (mode) {
    case "light":
      return <SunIcon />;
    case "dark":
      return <MoonIcon />;
    case "system":
      return <DesktopIcon />;
  }
}

/**
 * ThemeToggle - Dropdown menu for switching between light/dark/system themes.
 */
export function ThemeToggle() {
  const [themeMode, setThemeMode] = useAtom(themeModeAtom);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <IconButton variant="ghost" size="1">
          <ThemeIcon mode={themeMode} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content size="1">
        <DropdownMenu.Item onClick={() => setThemeMode("light")}>
          <SunIcon />
          Light
          {themeMode === "light" && " ✓"}
        </DropdownMenu.Item>
        <DropdownMenu.Item onClick={() => setThemeMode("dark")}>
          <MoonIcon />
          Dark
          {themeMode === "dark" && " ✓"}
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onClick={() => setThemeMode("system")}>
          <DesktopIcon />
          System
          {themeMode === "system" && " ✓"}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
