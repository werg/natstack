import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const workerTests: TestCase[] = [
  {
    name: "list-sources",
    description: "List available worker types",
    category: "workers",
    prompt: "List the available worker types. Tell me what kinds of workers can be created.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasSources = lower.includes("worker") || lower.includes("source") || lower.includes("type") || lower.includes("available");
      return {
        passed: hasSources,
        reason: hasSources ? undefined : `Expected worker source listing, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "create-worker",
    description: "Create a worker instance",
    category: "workers",
    prompt: "Create a worker instance and tell me about it.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasWorker = lower.includes("worker") || lower.includes("created") || lower.includes("instance");
      return {
        passed: hasWorker,
        reason: hasWorker ? undefined : `Expected worker creation result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "list-workers",
    description: "List running worker instances",
    category: "workers",
    prompt: "List the running workers. Tell me what's currently active.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasList = lower.includes("worker") || lower.includes("running") || lower.includes("instance") ||
        lower.includes("active") || lower.includes("none") || lower.includes("no ");
      return {
        passed: hasList,
        reason: hasList ? undefined : `Expected worker instance listing, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "create-destroy",
    description: "Create a worker and then destroy it",
    category: "workers",
    prompt: "Create a worker, verify it exists, then destroy it and verify it's gone.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasDestroy = lower.includes("destroy") || lower.includes("removed") || lower.includes("deleted") ||
        lower.includes("gone") || lower.includes("verified");
      return {
        passed: hasDestroy,
        reason: hasDestroy ? undefined : `Expected worker destroy confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "call-do-method",
    description: "Call a method on a Durable Object worker",
    category: "workers",
    prompt: "Create a Durable Object worker and call a method on it. Tell me the response.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasResult = lower.includes("response") || lower.includes("result") || lower.includes("method") ||
        lower.includes("return") || lower.includes("worker") || lower.includes("call");
      return {
        passed: hasResult,
        reason: hasResult ? undefined : `Expected DO method call result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "worker-env",
    description: "Create a worker with environment variables",
    category: "workers",
    prompt: "Create a worker with custom environment variables and verify they're accessible inside the worker.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasEnv = lower.includes("env") || lower.includes("variable") || lower.includes("worker") ||
        lower.includes("accessible") || lower.includes("value");
      return {
        passed: hasEnv,
        reason: hasEnv ? undefined : `Expected worker env variable info, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];
