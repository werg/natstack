import { describe, expect, it } from 'vitest';

import { checkCapability } from './capability.js';
import type { EndpointDeclaration } from './types.js';

describe('checkCapability', () => {
  it('allows an exact URL and method match', () => {
    const declarations: EndpointDeclaration[] = [
      { url: 'https://api.example.com/v1/users', methods: ['GET'] },
    ];

    expect(checkCapability('https://api.example.com/v1/users', 'GET', declarations)).toBe('allow');
  });

  it("matches '*' against a single path segment", () => {
    const declarations: EndpointDeclaration[] = [
      { url: 'https://api.example.com/v1/users/*', methods: ['GET'] },
    ];

    expect(checkCapability('https://api.example.com/v1/users/123', 'GET', declarations)).toBe('allow');
    expect(checkCapability('https://api.example.com/v1/users/123/profile', 'GET', declarations)).toBe(
      'deny',
    );
  });

  it("matches '**' across multiple path segments", () => {
    const declarations: EndpointDeclaration[] = [
      { url: 'https://api.example.com/v1/files/**', methods: ['GET'] },
    ];

    expect(
      checkCapability('https://api.example.com/v1/files/folder/nested/file.txt', 'GET', declarations),
    ).toBe('allow');
  });

  it('enforces method matching', () => {
    const declarations: EndpointDeclaration[] = [
      { url: 'https://api.example.com/v1/users', methods: ['POST'] },
    ];

    expect(checkCapability('https://api.example.com/v1/users', 'GET', declarations)).toBe('deny');
  });

  it("accepts '*' as a method wildcard", () => {
    const declarations: EndpointDeclaration[] = [
      { url: 'https://api.example.com/v1/users', methods: '*' },
    ];

    expect(checkCapability('https://api.example.com/v1/users', 'DELETE', declarations)).toBe('allow');
  });

  it('denies when no declaration matches', () => {
    const declarations: EndpointDeclaration[] = [
      { url: 'https://api.example.com/v1/projects/*', methods: ['GET'] },
    ];

    expect(checkCapability('https://api.example.com/v1/users/123', 'GET', declarations)).toBe('deny');
  });

  it('returns warn in warn mode when access would otherwise be denied', () => {
    const declarations: EndpointDeclaration[] = [
      { url: 'https://api.example.com/v1/users', methods: ['GET'] },
    ];

    expect(checkCapability('https://api.example.com/v1/users', 'POST', declarations, 'warn')).toBe('warn');
  });
});
