import { useEffect, useState } from "react";
import { Badge, Button, Callout, Flex, Table, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { remoteCred, type DeviceRecord } from "../shell/client";

export function PairedDevicesSection({ currentDeviceId }: { currentDeviceId?: string }) {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = async () => {
    try {
      setError(null);
      setDevices(await remoteCred.listDevices());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const revoke = async (deviceId: string) => {
    setBusyId(deviceId);
    try {
      await remoteCred.revokeDevice(deviceId);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  };

  if (devices.length === 0 && !error) return null;

  return (
    <Flex direction="column" gap="2" mt="4">
      <Flex justify="between" align="center">
        <Text size="2" weight="medium">
          Paired devices
        </Text>
        <Button size="1" variant="soft" onClick={() => void load()}>
          Refresh
        </Button>
      </Flex>
      {error ? (
        <Callout.Root size="1" color="amber">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      ) : null}
      {confirmId === currentDeviceId ? (
        <Callout.Root size="1" color="red">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>
            Revoking this device will sign you out and relaunch NatStack in local mode.
          </Callout.Text>
        </Callout.Root>
      ) : null}
      <Table.Root size="1" variant="surface">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Label</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Platform</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Created</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Last used</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {devices.map((device) => {
            const isCurrent = device.deviceId === currentDeviceId;
            const revoked = !!device.revokedAt;
            return (
              <Table.Row key={device.deviceId}>
                <Table.Cell>{device.label}</Table.Cell>
                <Table.Cell>{device.platform ?? "unknown"}</Table.Cell>
                <Table.Cell>{formatTime(device.createdAt)}</Table.Cell>
                <Table.Cell>{formatTime(device.lastUsedAt)}</Table.Cell>
                <Table.Cell>
                  <Badge color={revoked ? "red" : isCurrent ? "green" : "gray"}>
                    {revoked ? "revoked" : isCurrent ? "this device" : "active"}
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  {revoked ? null : confirmId === device.deviceId ? (
                    <Flex gap="1">
                      <Button
                        size="1"
                        color="red"
                        disabled={busyId === device.deviceId}
                        onClick={() => void revoke(device.deviceId)}
                      >
                        Confirm
                      </Button>
                      <Button size="1" variant="soft" onClick={() => setConfirmId(null)}>
                        Cancel
                      </Button>
                    </Flex>
                  ) : (
                    <Button
                      size="1"
                      color="red"
                      variant="soft"
                      disabled={!!busyId}
                      onClick={() => setConfirmId(device.deviceId)}
                    >
                      Revoke
                    </Button>
                  )}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Flex>
  );
}

function formatTime(value: number | undefined): string {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}
