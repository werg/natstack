export { PersonalityAgentWorker } from "./personality-agent-worker.js";
export default { fetch(_req: Request) { return new Response("personality-agent DO service"); } };
