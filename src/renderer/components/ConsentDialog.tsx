import { useEffect, useId, useState } from "react";
import { Badge, Box, Button, Card, Code, Dialog, Flex, Heading, Text } from "@radix-ui/themes";

export interface ConsentDialogProps {
  providerId: string;
  providerName: string;
  scopes: string[];
  scopeDescriptions?: Record<string, string>;
  endpoints?: { url: string; methods: string[] | "*" }[];
  accounts?: { connectionId: string; label: string; email?: string }[];
  onApprove: (connectionId?: string) => void;
  onDeny: () => void;
  open: boolean;
}

interface ProviderHeaderProps {
  providerId: string;
  providerName: string;
}

interface ScopeListProps {
  scopes: string[];
  scopeDescriptions?: Record<string, string>;
}

interface EndpointListProps {
  endpoints?: { url: string; methods: string[] | "*" }[];
}

interface AccountPickerProps {
  accounts?: { connectionId: string; label: string; email?: string }[];
  selectedConnectionId?: string;
  onSelect: (connectionId?: string) => void;
}

interface AccountOptionProps {
  checked: boolean;
  description?: string;
  id: string;
  name: string;
  onChange: () => void;
  title: string;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Text size="2" weight="bold" mb="1" style={{ display: "block" }}>
        {title}
      </Text>
      {description ? (
        <Text size="1" color="gray" mb="3" style={{ display: "block" }}>
          {description}
        </Text>
      ) : null}
      {children}
    </Box>
  );
}

function AccountOption({ checked, description, id, name, onChange, title }: AccountOptionProps) {
  return (
    <label
      htmlFor={id}
      style={{
        display: "block",
        cursor: "pointer",
      }}
    >
      <Card
        style={{
          border: checked ? "1px solid var(--accent-8)" : "1px solid var(--gray-6)",
          backgroundColor: checked ? "var(--accent-3)" : "var(--color-panel)",
        }}
      >
        <Flex align="start" gap="3">
          <input
            id={id}
            name={name}
            type="radio"
            checked={checked}
            onChange={onChange}
            style={{
              marginTop: 2,
              accentColor: "var(--accent-9)",
            }}
          />
          <Box style={{ minWidth: 0 }}>
            <Text size="2" weight="medium" style={{ display: "block" }}>
              {title}
            </Text>
            {description ? (
              <Text size="1" color="gray" style={{ display: "block" }}>
                {description}
              </Text>
            ) : null}
          </Box>
        </Flex>
      </Card>
    </label>
  );
}

export function ProviderHeader({ providerId, providerName }: ProviderHeaderProps) {
  return (
    <Box data-provider-id={providerId}>
      <Heading size="5">{providerName}</Heading>
      <Text size="2" color="gray" mt="1" style={{ display: "block" }}>
        A worker is requesting OAuth access. Review the requested permissions before continuing.
      </Text>
    </Box>
  );
}

export function ScopeList({ scopes, scopeDescriptions }: ScopeListProps) {
  return (
    <Section
      title="Requested scopes"
      description="These permissions define what the worker can access on your behalf."
    >
      <Flex direction="column" gap="2">
        {scopes.length === 0 ? (
          <Card>
            <Text size="2" color="gray">
              No scopes were provided for this request.
            </Text>
          </Card>
        ) : (
          scopes.map((scope) => (
            <Card key={scope}>
              <Flex align="start" gap="3">
                <input
                  type="checkbox"
                  checked
                  disabled
                  readOnly
                  aria-label={scope}
                  style={{
                    marginTop: 2,
                    accentColor: "var(--accent-9)",
                  }}
                />
                <Box style={{ minWidth: 0 }}>
                  <Code variant="soft">{scope}</Code>
                  {scopeDescriptions?.[scope] ? (
                    <Text size="1" color="gray" mt="1" style={{ display: "block" }}>
                      {scopeDescriptions[scope]}
                    </Text>
                  ) : null}
                </Box>
              </Flex>
            </Card>
          ))
        )}
      </Flex>
    </Section>
  );
}

export function EndpointList({ endpoints }: EndpointListProps) {
  return (
    <Section
      title="Requested endpoints"
      description="These API endpoints may be called if you approve access."
    >
      <Flex direction="column" gap="2">
        {!endpoints || endpoints.length === 0 ? (
          <Card>
            <Text size="2" color="gray">
              No endpoint details were provided for this request.
            </Text>
          </Card>
        ) : (
          endpoints.map((endpoint) => {
            const methods = endpoint.methods === "*" ? ["*"] : endpoint.methods;

            return (
              <Card key={`${endpoint.url}:${methods.join(",")}`}>
                <Flex direction="column" gap="2">
                  <Code
                    variant="soft"
                    style={{
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {endpoint.url}
                  </Code>
                  <Flex gap="2" wrap="wrap">
                    {methods.map((method) => (
                      <Badge
                        key={`${endpoint.url}:${method}`}
                        size="1"
                        variant="soft"
                        color={method === "*" ? "amber" : "blue"}
                      >
                        {method === "*" ? "ANY" : method.toUpperCase()}
                      </Badge>
                    ))}
                  </Flex>
                </Flex>
              </Card>
            );
          })
        )}
      </Flex>
    </Section>
  );
}

export function AccountPicker({ accounts, selectedConnectionId, onSelect }: AccountPickerProps) {
  const groupName = useId();

  return (
    <Section
      title="Choose an account"
      description="Reuse an existing connection or approve this request with a new account."
    >
      <Flex direction="column" gap="2">
        {(accounts ?? []).map((account) => {
          return (
            <AccountOption
              key={account.connectionId}
              id={`${groupName}-${account.connectionId}`}
              name={groupName}
              checked={selectedConnectionId === account.connectionId}
              onChange={() => onSelect(account.connectionId)}
              title={account.label}
              description={account.email}
            />
          );
        })}

        <AccountOption
          id={`${groupName}-new`}
          name={groupName}
          checked={selectedConnectionId === undefined}
          onChange={() => onSelect(undefined)}
          title="Connect new account"
          description="Authenticate with a different account instead of reusing an existing connection."
        />
      </Flex>
    </Section>
  );
}

export default function ConsentDialog({
  providerId,
  providerName,
  scopes,
  scopeDescriptions,
  endpoints,
  accounts,
  onApprove,
  onDeny,
  open,
}: ConsentDialogProps) {
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open) {
      return;
    }

    setSelectedConnectionId((current) => {
      if (current && (accounts ?? []).some((account) => account.connectionId === current)) {
        return current;
      }
      return accounts?.[0]?.connectionId;
    });
  }, [accounts, open]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onDeny();
        }
      }}
    >
      <Dialog.Content maxWidth="560px" style={{ maxHeight: "80dvh" }} data-provider-id={providerId}>
        <Dialog.Title>Permission request</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          Review the requested access and approve only if you trust this worker.
        </Dialog.Description>

        <Flex direction="column" gap="4" style={{ overflowY: "auto", paddingRight: 4 }}>
          <ProviderHeader providerId={providerId} providerName={providerName} />
          <ScopeList scopes={scopes} scopeDescriptions={scopeDescriptions} />
          <EndpointList endpoints={endpoints} />
          <AccountPicker
            accounts={accounts}
            selectedConnectionId={selectedConnectionId}
            onSelect={setSelectedConnectionId}
          />
        </Flex>

        <Flex gap="3" mt="5" justify="end">
          <Dialog.Close>
            <Button variant="soft" color="gray">
              Deny
            </Button>
          </Dialog.Close>
          <Button color="green" onClick={() => onApprove(selectedConnectionId)}>
            Approve
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
