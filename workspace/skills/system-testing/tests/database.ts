import type { TestCase } from "../types.js";
import { findLastAgentMessage, responseContains, responseSucceeds } from "./_helpers.js";

export const databaseTests: TestCase[] = [
  {
    name: "create-table-insert-query",
    description: "Create a table, insert rows, and query them",
    category: "database",
    prompt: "Create a database, make a users table with id and email columns, insert two rows, query all rows, tell me the results.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      // Should mention two rows of data — look for email-like content or row counts
      const lower = msg.toLowerCase();
      const hasRows = lower.includes("2") || lower.includes("two") || lower.includes("row");
      const hasEmail = msg.includes("@") || lower.includes("email");
      return {
        passed: hasRows || hasEmail,
        reason: (hasRows || hasEmail) ? undefined : `Expected query results with 2 rows, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "parameterized-queries",
    description: "Use parameterized queries for safe insertion",
    category: "database",
    prompt: "Create a database with a products table. Insert a product with name 'Widget' and price 9.99 using parameterized queries. Query it back.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const hasWidget = msg.includes("Widget");
      const hasPrice = msg.includes("9.99");
      return {
        passed: hasWidget && hasPrice,
        reason: (hasWidget && hasPrice) ? undefined : `Expected "Widget" and "9.99", got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "multiple-databases",
    description: "Two databases remain isolated from each other",
    category: "database",
    prompt: "Open two different databases (db-alpha and db-beta), create a table in each with different data, query both, confirm they're isolated.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasIsolation = lower.includes("alpha") || lower.includes("beta") || lower.includes("isolat") || lower.includes("different");
      return {
        passed: hasIsolation,
        reason: hasIsolation ? undefined : `Expected confirmation of database isolation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "schema-migration",
    description: "Add a column to an existing table and insert new data",
    category: "database",
    prompt: "Create a database with a v1 table (id, name). Insert data. Then add a 'status' column and insert a new row with status. Query all rows.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasStatus = lower.includes("status");
      return {
        passed: hasStatus,
        reason: hasStatus ? undefined : `Expected "status" column in results, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "transaction-like",
    description: "Execute multiple SQL statements in one call",
    category: "database",
    prompt: "Create a database and use exec to run multiple SQL statements in one call: create table, insert 3 rows. Then query and count.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const has3 = msg.includes("3") || msg.toLowerCase().includes("three");
      return {
        passed: has3,
        reason: has3 ? undefined : `Expected 3 rows counted, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "close-reopen",
    description: "Data persists after closing and reopening a database",
    category: "database",
    prompt: "Create a database, insert data, close it. Then reopen the same database and query — verify the data persisted.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasPersist = lower.includes("persist") || lower.includes("still") || lower.includes("confirm") ||
        lower.includes("same") || lower.includes("found") || lower.includes("success") || lower.includes("data");
      return {
        passed: hasPersist,
        reason: hasPersist ? undefined : `Expected confirmation of data persistence, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];
