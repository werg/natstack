/**
 * Tests for MDX type definitions
 */

import { describe, it, expect } from "vitest";
import type { AnyComponent, MDXOptions, MDXResult, MDXContext } from "./types.js";
import type { PackageRegistry, PackageSpec } from "@natstack/build";

describe("AnyComponent type", () => {
  it("should accept React functional components", () => {
    const FunctionalComponent: AnyComponent = () => null;
    expect(typeof FunctionalComponent).toBe("function");
  });

  it("should accept components with props", () => {
    const ComponentWithProps: AnyComponent = (props: { name: string }) => null;
    expect(typeof ComponentWithProps).toBe("function");
  });
});

describe("MDXOptions type", () => {
  it("should accept empty options", () => {
    const options: MDXOptions = {};
    expect(options).toBeDefined();
  });

  it("should accept components option", () => {
    const CustomDiv: AnyComponent = () => null;
    const options: MDXOptions = {
      components: {
        div: CustomDiv,
        CustomComponent: () => null,
      },
    };
    expect(options.components).toBeDefined();
    expect(options.components?.div).toBe(CustomDiv);
  });

  it("should accept scope option", () => {
    const options: MDXOptions = {
      scope: {
        data: { value: 42 },
        helper: (x: number) => x * 2,
      },
    };
    expect(options.scope).toBeDefined();
    expect(options.scope?.data).toEqual({ value: 42 });
  });

  it("should accept signal option", () => {
    const controller = new AbortController();
    const options: MDXOptions = {
      signal: controller.signal,
    };
    expect(options.signal).toBe(controller.signal);
  });

  it("should accept all options together", () => {
    const controller = new AbortController();
    const options: MDXOptions = {
      components: { Custom: () => null },
      scope: { data: 123 },
      signal: controller.signal,
    };
    expect(options).toBeDefined();
  });

  it("should accept optional context", () => {
    const options: MDXOptions = {
      context: {
        projectRoot: "/project",
      },
    };
    expect(options.context?.projectRoot).toBe("/project");
  });

  it("should accept context with registry", () => {
    const mockRegistry: PackageRegistry = {
      get: () => undefined,
      has: () => false,
      keys: () => [],
    };
    const options: MDXOptions = {
      context: {
        projectRoot: "/project",
        registry: mockRegistry,
      },
    };
    expect(options.context?.registry).toBe(mockRegistry);
  });

  it("should accept context with dependencies", () => {
    const options: MDXOptions = {
      context: {
        projectRoot: "/project",
        dependencies: {
          lodash: "^4.17.0",
          "my-lib": "user/lib#main",
        },
      },
    };
    expect(options.context?.dependencies?.["lodash"]).toBe("^4.17.0");
  });
});

describe("MDXContext type", () => {
  it("should require projectRoot", () => {
    const context: MDXContext = {
      projectRoot: "/my/project",
    };
    expect(context.projectRoot).toBe("/my/project");
  });

  it("should accept optional sourceRoot", () => {
    const context: MDXContext = {
      projectRoot: "/project",
      sourceRoot: "/project/content",
    };
    expect(context.sourceRoot).toBe("/project/content");
  });

  it("should accept optional registry", () => {
    const mockRegistry: PackageRegistry = {
      get: (name: string): PackageSpec | undefined => {
        if (name === "test") return { gitSpec: "user/test#main" };
        return undefined;
      },
      has: (name: string) => name === "test",
      keys: () => ["test"],
    };
    const context: MDXContext = {
      projectRoot: "/project",
      registry: mockRegistry,
    };
    expect(context.registry?.has("test")).toBe(true);
    expect(context.registry?.get("test")?.gitSpec).toBe("user/test#main");
  });

  it("should accept optional dependencies map", () => {
    const context: MDXContext = {
      projectRoot: "/project",
      dependencies: {
        react: "^18.0.0",
        "@mdx-js/react": "^3.0.0",
      },
    };
    expect(context.dependencies).toEqual({
      react: "^18.0.0",
      "@mdx-js/react": "^3.0.0",
    });
  });

  it("should accept all context properties", () => {
    const mockRegistry: PackageRegistry = {
      get: () => undefined,
      has: () => false,
      keys: () => [],
    };
    const context: MDXContext = {
      projectRoot: "/project",
      sourceRoot: "/project/docs",
      registry: mockRegistry,
      dependencies: {
        "local-lib": "user/lib#main",
      },
    };
    expect(context.projectRoot).toBe("/project");
    expect(context.sourceRoot).toBe("/project/docs");
    expect(context.registry).toBe(mockRegistry);
    expect(context.dependencies).toHaveProperty("local-lib");
  });
});

describe("MDXResult type", () => {
  it("should have Component property", () => {
    const result: MDXResult = {
      Component: () => null,
      exports: {},
    };
    expect(result.Component).toBeDefined();
    expect(typeof result.Component).toBe("function");
  });

  it("should have exports object", () => {
    const result: MDXResult = {
      Component: () => null,
      exports: {
        customExport: 42,
        anotherExport: "value",
      },
    };
    expect(result.exports).toEqual({
      customExport: 42,
      anotherExport: "value",
    });
  });

  it("Component should accept components prop", () => {
    const result: MDXResult = {
      Component: (props) => {
        // Props type should include optional components
        const { components } = props;
        return null;
      },
      exports: {},
    };
    expect(result.Component).toBeDefined();
  });

  it("should handle empty exports", () => {
    const result: MDXResult = {
      Component: () => null,
      exports: {},
    };
    expect(Object.keys(result.exports)).toHaveLength(0);
  });
});

describe("type composition", () => {
  it("should allow using MDXResult.Component with custom components", () => {
    const result: MDXResult = {
      Component: (props) => {
        // This tests that the Component type correctly accepts components prop
        return null;
      },
      exports: {},
    };

    // Test that we can call Component with components
    const CustomParagraph: AnyComponent = () => null;
    const element = result.Component({ components: { p: CustomParagraph } });
    expect(element).toBeNull();
  });

  it("should allow MDXOptions components to be passed to MDXResult.Component", () => {
    const options: MDXOptions = {
      components: {
        CustomBlock: () => null,
      },
    };

    const result: MDXResult = {
      Component: (props) => null,
      exports: {},
    };

    // Components from options should be compatible with Component props
    const element = result.Component({ components: options.components });
    expect(element).toBeNull();
  });
});

describe("edge cases", () => {
  it("should handle components with any props", () => {
    // AnyComponent is ComponentType<any>, so it should accept various component shapes
    const NoPropsComponent: AnyComponent = () => null;
    const WithPropsComponent: AnyComponent = (props: { x: number; y: string }) => null;
    const WithChildrenComponent: AnyComponent = (props: { children: unknown }) => null;

    expect(typeof NoPropsComponent).toBe("function");
    expect(typeof WithPropsComponent).toBe("function");
    expect(typeof WithChildrenComponent).toBe("function");
  });

  it("should allow undefined in scope values", () => {
    const options: MDXOptions = {
      scope: {
        definedValue: 42,
        undefinedValue: undefined,
      },
    };
    expect(options.scope?.undefinedValue).toBeUndefined();
  });

  it("should allow nested objects in scope", () => {
    const options: MDXOptions = {
      scope: {
        nested: {
          deeply: {
            value: "test",
          },
        },
      },
    };
    expect(options.scope?.nested).toEqual({ deeply: { value: "test" } });
  });
});
