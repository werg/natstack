import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const filesystemTests: TestCase[] = [
  {
    name: "read-write-text",
    description: "Write and read a text file",
    category: "filesystem",
    prompt: "Write some text to a file and read it back. Tell me what you wrote and what you got back.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasContent = lower.includes("wrote") || lower.includes("read") || lower.includes("content") || lower.includes("match") || lower.includes("text");
      return {
        passed: hasContent,
        reason: hasContent ? undefined : `Expected write/read confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "read-write-binary",
    description: "Write binary data and decode it back",
    category: "filesystem",
    prompt: "Write some binary data to a file, read it back, and decode it. Tell me what you get.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasBinary = lower.includes("byte") || lower.includes("binary") || lower.includes("decode") || lower.includes("buffer") || lower.includes("uint8");
      return {
        passed: hasBinary,
        reason: hasBinary ? undefined : `Expected binary read/decode result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "append-file",
    description: "Append content to a file and verify all content is present",
    category: "filesystem",
    prompt: "Write a line to a file, then append another line, then read the whole file. Tell me all the content.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasLines = lower.includes("line") || lower.includes("append") || lower.includes("both") || lower.includes("content");
      return {
        passed: hasLines,
        reason: hasLines ? undefined : `Expected multi-line content, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "directory-ops",
    description: "Create nested directories and list contents",
    category: "filesystem",
    prompt: "Create a nested directory structure and list its contents. Tell me what directories you created.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasDir = lower.includes("director") || lower.includes("created") || lower.includes("folder") || lower.includes("nested");
      return {
        passed: hasDir,
        reason: hasDir ? undefined : `Expected directory creation confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "file-stats",
    description: "Get file statistics including size and modification time",
    category: "filesystem",
    prompt: "Write a file and then get its stats. Tell me the size and when it was last modified.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasStats = lower.includes("size") || lower.includes("byte") || lower.includes("modif") || lower.includes("time") || lower.includes("stat");
      return {
        passed: hasStats,
        reason: hasStats ? undefined : `Expected file stats, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "rename-copy",
    description: "Copy or rename a file and verify the result",
    category: "filesystem",
    prompt: "Write a file, then copy or rename it, and verify the new file has the same content. Tell me what happened.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasOp = lower.includes("copy") || lower.includes("rename") || lower.includes("moved") || lower.includes("content") || lower.includes("same") || lower.includes("verif");
      return {
        passed: hasOp,
        reason: hasOp ? undefined : `Expected copy/rename confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "remove",
    description: "Create and recursively remove a directory",
    category: "filesystem",
    prompt: "Create a directory with some files inside, then remove it all. Verify it's gone.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const removed = lower.includes("removed") || lower.includes("deleted") || lower.includes("gone") ||
        lower.includes("no longer") || lower.includes("verified") || lower.includes("success");
      return {
        passed: removed,
        reason: removed ? undefined : `Expected removal confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "symlinks",
    description: "Create and read through a symbolic link",
    category: "filesystem",
    prompt: "Create a file, make a symlink pointing to it, and read through the symlink. Verify the content matches.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasLink = lower.includes("symlink") || lower.includes("link") || lower.includes("match") || lower.includes("same content") || lower.includes("point");
      return {
        passed: hasLink,
        reason: hasLink ? undefined : `Expected symlink read confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "file-handles",
    description: "Use low-level file handles to write and read",
    category: "filesystem",
    prompt: "Open a file using low-level file handle APIs, write something, close it, then read it back. Tell me what happened.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasHandle = lower.includes("handle") || lower.includes("open") || lower.includes("wrote") || lower.includes("read") || lower.includes("close");
      return {
        passed: hasHandle,
        reason: hasHandle ? undefined : `Expected file handle operation result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];
