import type { TestCase } from "../types.js";
import { findLastAgentMessage, responseContains, responseSucceeds } from "./_helpers.js";

export const filesystemTests: TestCase[] = [
  {
    name: "read-write-text",
    description: "Write and read a text file",
    category: "filesystem",
    prompt: "Write the text 'filesystem test' to /tmp/fs-test.txt and read it back.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const hasContent = msg.toLowerCase().includes("filesystem test");
      return {
        passed: hasContent,
        reason: hasContent ? undefined : `Expected "filesystem test" in response, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "read-write-binary",
    description: "Write binary data and decode it back",
    category: "filesystem",
    prompt: "Write a Uint8Array of bytes [72, 101, 108, 108, 111] to /tmp/binary-test.bin, read it back, and tell me the decoded text.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const hasHello = msg.includes("Hello");
      return {
        passed: hasHello,
        reason: hasHello ? undefined : `Expected "Hello" (decoded from bytes) in response, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "append-file",
    description: "Append content to a file and verify all lines",
    category: "filesystem",
    prompt: "Write 'line1' to /tmp/append-test.txt, then append '\\nline2', then read the whole file.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const hasLine1 = msg.includes("line1");
      const hasLine2 = msg.includes("line2");
      return {
        passed: hasLine1 && hasLine2,
        reason: (hasLine1 && hasLine2) ? undefined : `Expected both "line1" and "line2", got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "directory-ops",
    description: "Create nested directories and list contents",
    category: "filesystem",
    prompt: "Create a directory /tmp/test-dir/sub, list the contents of /tmp/test-dir, and tell me what you find.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const hasSub = msg.toLowerCase().includes("sub");
      return {
        passed: hasSub,
        reason: hasSub ? undefined : `Expected "sub" directory in listing, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "file-stats",
    description: "Get file statistics including size and modification time",
    category: "filesystem",
    prompt: "Write a file to /tmp/stat-test.txt, then get its stats (size, modification time). Tell me the details.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasSize = lower.includes("size") || lower.includes("byte");
      const hasTime = lower.includes("modif") || lower.includes("mtime") || lower.includes("time");
      return {
        passed: hasSize || hasTime,
        reason: (hasSize || hasTime) ? undefined : `Expected file stats (size/time), got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "rename-copy",
    description: "Copy and rename files, then verify contents",
    category: "filesystem",
    prompt: "Write 'original' to /tmp/rename-src.txt, copy it to /tmp/rename-copy.txt, rename the original to /tmp/rename-moved.txt. Read all files and confirm.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const hasOriginal = msg.toLowerCase().includes("original");
      return {
        passed: hasOriginal,
        reason: hasOriginal ? undefined : `Expected "original" content confirmed in files, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "remove",
    description: "Create and recursively remove a directory",
    category: "filesystem",
    prompt: "Create a directory /tmp/rm-test with a file inside, then recursively remove it. Verify it's gone.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const removed = lower.includes("removed") || lower.includes("deleted") || lower.includes("gone") ||
        lower.includes("not found") || lower.includes("does not exist") || lower.includes("enoent") ||
        lower.includes("no such") || lower.includes("verified") || lower.includes("successfully");
      return {
        passed: removed,
        reason: removed ? undefined : `Expected confirmation of removal, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "symlinks",
    description: "Create and read through a symbolic link",
    category: "filesystem",
    prompt: "Create a file /tmp/link-target.txt with content 'linked', create a symlink /tmp/link-sym.txt pointing to it, read through the symlink.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const hasLinked = msg.toLowerCase().includes("linked");
      return {
        passed: hasLinked,
        reason: hasLinked ? undefined : `Expected "linked" read through symlink, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "file-handles",
    description: "Use low-level file handles to write and read",
    category: "filesystem",
    prompt: "Open /tmp/handle-test.txt for writing using fs.open, write 'handle test', close it, then read it back with readFile.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const hasContent = msg.toLowerCase().includes("handle test");
      return {
        passed: hasContent,
        reason: hasContent ? undefined : `Expected "handle test" in response, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];
