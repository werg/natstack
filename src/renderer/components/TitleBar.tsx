import { HamburgerMenuIcon } from "@radix-ui/react-icons";
import { Box, DropdownMenu, Flex, IconButton, Text } from "@radix-ui/themes";

interface TitleBarProps {
  title: string;
  onOpenPanelDevTools?: () => void;
  onOpenAppDevTools?: () => void;
}

export function TitleBar({ title, onOpenPanelDevTools, onOpenAppDevTools }: TitleBarProps) {
  const handleExit = () => {
    window.close();
  };

  return (
    <Box
      style={
        {
          appRegion: "drag",
          WebkitAppRegion: "drag",
          userSelect: "none",
          height: "32px",
          backgroundColor: "var(--gray-2)",
          borderBottom: "1px solid var(--gray-6)",
        } as React.CSSProperties
      }
    >
      <Flex align="center" justify="between" height="100%" px="2">
        {/* Left side: Hamburger menu */}
        <Flex
          align="center"
          gap="2"
          style={{ appRegion: "no-drag", WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <IconButton variant="ghost" size="1">
                <HamburgerMenuIcon />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              <DropdownMenu.Item shortcut="Ctrl+Z">Undo</DropdownMenu.Item>
              <DropdownMenu.Item shortcut="Ctrl+Y">Redo</DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item shortcut="Ctrl+X">Cut</DropdownMenu.Item>
              <DropdownMenu.Item shortcut="Ctrl+C">Copy</DropdownMenu.Item>
              <DropdownMenu.Item shortcut="Ctrl+V">Paste</DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item shortcut="Ctrl+R">Reload</DropdownMenu.Item>
              <DropdownMenu.Item shortcut="Ctrl+Shift+R">Force Reload</DropdownMenu.Item>
              <DropdownMenu.Item
                shortcut="Ctrl+Shift+I"
                onSelect={() => onOpenPanelDevTools?.()}
              >
                Toggle Panel DevTools
              </DropdownMenu.Item>
              <DropdownMenu.Item
                shortcut="Ctrl+Alt+I"
                onSelect={() => onOpenAppDevTools?.()}
              >
                Toggle App DevTools
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item shortcut="Ctrl+Q" onSelect={handleExit}>
                Exit
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </Flex>

        {/* Center: Title */}
        <Text
          size="2"
          weight="medium"
          style={{ position: "absolute", left: "50%", transform: "translateX(-50%)" }}
        >
          {title}
        </Text>

        {/* Right side: spacer for native window controls (handled by titleBarOverlay) */}
        <Box style={{ width: "138px" }} />
      </Flex>
    </Box>
  );
}
