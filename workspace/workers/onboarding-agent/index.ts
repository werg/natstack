export { OnboardingAgent } from "./onboarding-worker.js";
export default { fetch(_req: Request) { return new Response("onboarding-agent DO service"); } };
