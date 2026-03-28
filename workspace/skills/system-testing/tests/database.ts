import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const databaseTests: TestCase[] = [
  {
    name: "create-table-insert-query",
    description: "Create a table, insert rows, and query them",
    category: "database",
    prompt: "Create a database, set up a table, insert a couple of rows, and query them back. Tell me what you stored and retrieved.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasData = lower.includes("row") || lower.includes("insert") || lower.includes("query") || lower.includes("retriev") || lower.includes("data") || lower.includes("result");
      return {
        passed: hasData,
        reason: hasData ? undefined : `Expected query results, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "parameterized-queries",
    description: "Use parameterized queries for safe insertion",
    category: "database",
    prompt: "Create a database and use parameterized queries to safely insert and retrieve data. Tell me what you stored and got back.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasParam = lower.includes("parameter") || lower.includes("insert") || lower.includes("query") || lower.includes("data") || lower.includes("retriev") || lower.includes("result");
      return {
        passed: hasParam,
        reason: hasParam ? undefined : `Expected parameterized query result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "multiple-databases",
    description: "Two databases remain isolated from each other",
    category: "database",
    prompt: "Open two separate databases, store different data in each, and verify they are isolated from each other. Tell me what each database contains.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasIsolation = lower.includes("isolat") || lower.includes("separate") || lower.includes("different") || lower.includes("each") || lower.includes("only");
      return {
        passed: hasIsolation,
        reason: hasIsolation ? undefined : `Expected database isolation confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "schema-migration",
    description: "Add a column to an existing table and insert new data",
    category: "database",
    prompt: "Create a database with a table, insert some data, then alter the table to add a new column and insert a row using it. Query everything back.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasMigration = lower.includes("column") || lower.includes("alter") || lower.includes("added") || lower.includes("new field") || lower.includes("schema");
      return {
        passed: hasMigration,
        reason: hasMigration ? undefined : `Expected schema migration result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "transaction-like",
    description: "Execute multiple SQL statements in one call",
    category: "database",
    prompt: "Create a database and execute multiple statements in a single call to set up and populate a table. Then count the rows.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasCount = /\d+/.test(msg) || lower.includes("row") || lower.includes("count");
      return {
        passed: hasCount,
        reason: hasCount ? undefined : `Expected row count, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "close-reopen",
    description: "Data persists after closing and reopening a database",
    category: "database",
    prompt: "Create a database, insert some data, close it, then reopen the same database and verify the data is still there.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasPersist = lower.includes("persist") || lower.includes("still") || lower.includes("found") ||
        lower.includes("verif") || lower.includes("same") || lower.includes("data") || lower.includes("confirm");
      return {
        passed: hasPersist,
        reason: hasPersist ? undefined : `Expected data persistence confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];
