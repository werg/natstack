import type { PubSubClient } from "@workspace/pubsub";

export async function registerWeatherMessageDemo(client: PubSubClient): Promise<void> {
  await client.registerMessageType({
    typeId: "weather",
    displayMode: "inline",
    source: { type: "file", path: "panels/chat/examples/weather-message-type.tsx" },
  });

  const { messageId } = await client.publishCustomMessage({
    typeId: "weather",
    initialState: { city: "San Francisco", tempF: 64, condition: "Cloudy" },
    displayMode: "inline",
  });

  await client.updateCustomMessage(messageId, { tempF: 66, condition: "Clearing" });
}
