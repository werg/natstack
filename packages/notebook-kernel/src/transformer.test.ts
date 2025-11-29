import { describe, it } from "node:test";
import assert from "node:assert";
import { transformCell } from "./transformer.js";

describe("transformCell", () => {
  describe("variable declarations", () => {
    it("should transform const declarations", () => {
      const result = transformCell("const x = 1;");

      assert.ok(result.code.includes("__scope__.x = x;"));
      assert.deepStrictEqual(result.constNames, ["x"]);
      assert.deepStrictEqual(result.mutableNames, []);
    });

    it("should transform let declarations as mutable", () => {
      const result = transformCell("let y = 2;");

      assert.ok(result.code.includes("__scope__.y = y;"));
      assert.deepStrictEqual(result.constNames, []);
      assert.deepStrictEqual(result.mutableNames, ["y"]);
    });

    it("should transform var declarations as mutable", () => {
      const result = transformCell("var z = 3;");

      assert.ok(result.code.includes("__scope__.z = z;"));
      assert.deepStrictEqual(result.constNames, []);
      assert.deepStrictEqual(result.mutableNames, ["z"]);
    });

    it("should transform multiple declarations", () => {
      const result = transformCell("const a = 1, b = 2;");

      assert.ok(result.code.includes("__scope__.a = a;"));
      assert.ok(result.code.includes("__scope__.b = b;"));
      assert.deepStrictEqual(result.constNames, ["a", "b"]);
    });

    it("should handle declarations without initialization", () => {
      const result = transformCell("let x;");

      assert.ok(result.code.includes("__scope__.x = x;"));
      assert.deepStrictEqual(result.mutableNames, ["x"]);
    });
  });

  describe("destructuring patterns", () => {
    it("should transform object destructuring", () => {
      const result = transformCell("const { a, b } = obj;");

      assert.ok(result.code.includes("__scope__.a = a;"));
      assert.ok(result.code.includes("__scope__.b = b;"));
      assert.deepStrictEqual(result.constNames, ["a", "b"]);
    });

    it("should transform object destructuring with renaming", () => {
      const result = transformCell("const { a: renamed } = obj;");

      assert.ok(result.code.includes("__scope__.renamed = renamed;"));
      assert.ok(!result.code.includes("__scope__.a = a;"));
      assert.deepStrictEqual(result.constNames, ["renamed"]);
    });

    it("should transform array destructuring", () => {
      const result = transformCell("const [first, second] = arr;");

      assert.ok(result.code.includes("__scope__.first = first;"));
      assert.ok(result.code.includes("__scope__.second = second;"));
      assert.deepStrictEqual(result.constNames, ["first", "second"]);
    });

    it("should transform rest patterns in arrays", () => {
      const result = transformCell("const [head, ...tail] = arr;");

      assert.ok(result.code.includes("__scope__.head = head;"));
      assert.ok(result.code.includes("__scope__.tail = tail;"));
      assert.deepStrictEqual(result.constNames, ["head", "tail"]);
    });

    it("should transform rest patterns in objects", () => {
      const result = transformCell("const { a, ...rest } = obj;");

      assert.ok(result.code.includes("__scope__.a = a;"));
      assert.ok(result.code.includes("__scope__.rest = rest;"));
      assert.deepStrictEqual(result.constNames, ["a", "rest"]);
    });

    it("should transform nested destructuring", () => {
      const result = transformCell("const { a: { b } } = obj;");

      assert.ok(result.code.includes("__scope__.b = b;"));
      assert.deepStrictEqual(result.constNames, ["b"]);
    });

    it("should transform destructuring with defaults", () => {
      const result = transformCell("const { a = 1 } = obj;");

      assert.ok(result.code.includes("__scope__.a = a;"));
      assert.deepStrictEqual(result.constNames, ["a"]);
    });

    it("should handle array holes", () => {
      const result = transformCell("const [, second] = arr;");

      assert.ok(result.code.includes("__scope__.second = second;"));
      assert.deepStrictEqual(result.constNames, ["second"]);
    });
  });

  describe("function declarations", () => {
    it("should transform function declarations as mutable", () => {
      const result = transformCell("function foo() { return 42; }");

      assert.ok(result.code.includes("__scope__.foo = function foo()"));
      assert.deepStrictEqual(result.mutableNames, ["foo"]);
      assert.deepStrictEqual(result.constNames, []);
    });

    it("should transform async function declarations", () => {
      const result = transformCell("async function fetchData() { return await fetch('/'); }");

      assert.ok(result.code.includes("__scope__.fetchData = async function fetchData()"));
      assert.deepStrictEqual(result.mutableNames, ["fetchData"]);
    });

    it("should transform generator function declarations", () => {
      const result = transformCell("function* gen() { yield 1; }");

      assert.ok(result.code.includes("__scope__.gen = function* gen()"));
      assert.deepStrictEqual(result.mutableNames, ["gen"]);
    });
  });

  describe("class declarations", () => {
    it("should transform class declarations as mutable", () => {
      const result = transformCell("class Foo { bar() {} }");

      assert.ok(result.code.includes("__scope__.Foo = class Foo"));
      assert.deepStrictEqual(result.mutableNames, ["Foo"]);
      assert.deepStrictEqual(result.constNames, []);
    });

    it("should transform class declarations with extends", () => {
      const result = transformCell("class Child extends Parent { }");

      assert.ok(result.code.includes("__scope__.Child = class Child extends Parent"));
      assert.deepStrictEqual(result.mutableNames, ["Child"]);
    });
  });

  describe("import declarations", () => {
    it("should transform default imports", () => {
      const result = transformCell("import foo from 'bar';");

      assert.ok(result.code.includes("await __importModule__("));
      assert.ok(result.code.includes('"bar"'));
      assert.ok(result.code.includes("default: foo"));
      assert.ok(result.code.includes("__scope__.foo = foo;"));
      assert.deepStrictEqual(result.constNames, ["foo"]);
    });

    it("should transform named imports", () => {
      const result = transformCell("import { a, b } from 'mod';");

      assert.ok(result.code.includes("await __importModule__("));
      assert.ok(result.code.includes('"mod"'));
      assert.ok(result.code.includes("__scope__.a = a;"));
      assert.ok(result.code.includes("__scope__.b = b;"));
      assert.deepStrictEqual(result.constNames, ["a", "b"]);
    });

    it("should transform namespace imports", () => {
      const result = transformCell("import * as ns from 'mod';");

      assert.ok(result.code.includes("const ns = await __importModule__("));
      assert.ok(result.code.includes("__scope__.ns = ns;"));
      assert.deepStrictEqual(result.constNames, ["ns"]);
    });

    it("should transform renamed imports", () => {
      const result = transformCell("import { foo as bar } from 'mod';");

      assert.ok(result.code.includes("foo: bar"));
      assert.ok(result.code.includes("__scope__.bar = bar;"));
      assert.deepStrictEqual(result.constNames, ["bar"]);
    });

    it("should transform side-effect imports", () => {
      const result = transformCell("import 'side-effect';");

      assert.ok(result.code.includes('await __importModule__("side-effect")'));
      assert.deepStrictEqual(result.constNames, []);
    });
  });

  describe("export declarations", () => {
    it("should transform export const to local const", () => {
      const result = transformCell("export const x = 1;");

      assert.ok(result.code.includes("const x = 1;"));
      assert.ok(result.code.includes("__scope__.x = x;"));
      assert.ok(!result.code.includes("export"));
      assert.deepStrictEqual(result.constNames, ["x"]);
    });

    it("should transform export let to local mutable", () => {
      const result = transformCell("export let y = 2;");

      assert.ok(result.code.includes("let y = 2;"));
      assert.ok(result.code.includes("__scope__.y = y;"));
      assert.deepStrictEqual(result.mutableNames, ["y"]);
    });

    it("should transform export function", () => {
      const result = transformCell("export function foo() {}");

      assert.ok(result.code.includes("__scope__.foo = function foo()"));
      assert.ok(!result.code.includes("export"));
      assert.deepStrictEqual(result.mutableNames, ["foo"]);
    });

    it("should transform export class", () => {
      const result = transformCell("export class Bar {}");

      assert.ok(result.code.includes("__scope__.Bar = class Bar"));
      assert.deepStrictEqual(result.mutableNames, ["Bar"]);
    });

    it("should transform export default", () => {
      const result = transformCell("export default 42;");

      assert.ok(result.code.includes("__scope__.__default__ = 42;"));
      assert.deepStrictEqual(result.mutableNames, ["__default__"]);
    });

    it("should strip export { } statements", () => {
      const result = transformCell("const x = 1;\nexport { x };");

      // The export statement should be removed
      assert.ok(!result.code.includes("export {"));
    });

    it("should transform export from", () => {
      const result = transformCell("export { foo } from 'mod';");

      assert.ok(result.code.includes("await __importModule__("));
      assert.ok(result.code.includes("__scope__.foo = foo;"));
    });

    it("should transform export * from to use __exports__", () => {
      const result = transformCell("export * from 'mod';");

      assert.ok(result.code.includes("Object.assign(__exports__,"));
      assert.ok(result.code.includes('await __importModule__("mod")'));
    });

    it("should transform export * as ns from", () => {
      const result = transformCell("export * as ns from 'mod';");

      assert.ok(result.code.includes("__scope__.ns ="));
      assert.ok(result.code.includes('await __importModule__("mod")'));
      assert.deepStrictEqual(result.mutableNames, ["ns"]);
    });
  });

  describe("nested declarations (should NOT be transformed)", () => {
    it("should not transform for loop declarations", () => {
      const result = transformCell("for (let i = 0; i < 10; i++) { }");

      assert.ok(!result.code.includes("__scope__.i = i;"));
      assert.deepStrictEqual(result.constNames, []);
      assert.deepStrictEqual(result.mutableNames, []);
    });

    it("should not transform for-of loop declarations", () => {
      const result = transformCell("for (const item of items) { }");

      assert.ok(!result.code.includes("__scope__.item = item;"));
      assert.deepStrictEqual(result.constNames, []);
    });

    it("should not transform block-scoped declarations", () => {
      const result = transformCell("if (true) { const temp = 1; }");

      assert.ok(!result.code.includes("__scope__.temp = temp;"));
      assert.deepStrictEqual(result.constNames, []);
    });

    it("should not transform function-scoped declarations", () => {
      const result = transformCell("function outer() { const inner = 1; }");

      assert.ok(!result.code.includes("__scope__.inner = inner;"));
      // outer IS transformed since it's top-level
      assert.deepStrictEqual(result.mutableNames, ["outer"]);
    });

    it("should not transform try-catch variables", () => {
      const result = transformCell("try { } catch (e) { }");

      assert.ok(!result.code.includes("__scope__.e = e;"));
      assert.deepStrictEqual(result.constNames, []);
    });
  });

  describe("mixed statements", () => {
    it("should handle code with both declarations and expressions", () => {
      const code = `
const x = 1;
console.log(x);
const y = 2;
`;
      const result = transformCell(code);

      assert.ok(result.code.includes("__scope__.x = x;"));
      assert.ok(result.code.includes("__scope__.y = y;"));
      assert.ok(result.code.includes("console.log(x);"));
      assert.deepStrictEqual(result.constNames, ["x", "y"]);
    });

    it("should handle async/await expressions", () => {
      const result = transformCell("const data = await fetch('/api');");

      assert.ok(result.code.includes("__scope__.data = data;"));
      assert.deepStrictEqual(result.constNames, ["data"]);
    });
  });

  describe("edge cases", () => {
    it("should handle empty code", () => {
      const result = transformCell("");

      assert.strictEqual(result.code, "");
      assert.deepStrictEqual(result.constNames, []);
      assert.deepStrictEqual(result.mutableNames, []);
    });

    it("should handle code with only expressions", () => {
      const result = transformCell("1 + 2;");

      assert.strictEqual(result.code, "1 + 2;");
      assert.deepStrictEqual(result.constNames, []);
    });

    it("should throw on syntax errors", () => {
      // Parser errors should be thrown (not silently ignored)
      assert.throws(() => {
        transformCell("const x = {;");
      }, /Parse error/);
    });

    it("should preserve original code structure", () => {
      const code = "const x = 1;";
      const result = transformCell(code);

      // Original declaration should still be there
      assert.ok(result.code.includes("const x = 1;"));
    });

    it("should handle arrow function expressions (not declarations)", () => {
      const result = transformCell("const fn = () => 42;");

      assert.ok(result.code.includes("__scope__.fn = fn;"));
      assert.deepStrictEqual(result.constNames, ["fn"]);
    });

    it("should handle function expressions (not declarations)", () => {
      const result = transformCell("const fn = function() { return 42; };");

      assert.ok(result.code.includes("__scope__.fn = fn;"));
      assert.deepStrictEqual(result.constNames, ["fn"]);
    });
  });

  describe("complex real-world examples", () => {
    it("should handle multiple lines with various declarations", () => {
      const code = `
const { name, age } = person;
let counter = 0;
function increment() { counter++; }
class Person { constructor(name) { this.name = name; } }
`;
      const result = transformCell(code);

      assert.ok(result.constNames.includes("name"));
      assert.ok(result.constNames.includes("age"));
      assert.ok(result.mutableNames.includes("counter"));
      assert.ok(result.mutableNames.includes("increment"));
      assert.ok(result.mutableNames.includes("Person"));
    });
  });
});
