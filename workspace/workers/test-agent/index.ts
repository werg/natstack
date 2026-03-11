export { TestAgentWorker } from "./test-agent-worker.js";
export default { fetch(_req: Request) { return new Response("test-agent DO service"); } };
