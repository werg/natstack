import type { EndpointDeclaration } from './types.js';

export type CapabilityResult = 'allow' | 'deny' | 'warn';

export function checkCapability(
  url: string,
  method: string,
  declarations: EndpointDeclaration[],
  mode: 'enforce' | 'warn' = 'enforce',
): CapabilityResult {
  const normalizedUrl = normalizeUrl(url);
  const normalizedMethod = method.toUpperCase();

  for (const declaration of declarations) {
    if (!matchesUrlPattern(declaration.url, normalizedUrl)) {
      continue;
    }

    if (matchesMethod(declaration.methods, normalizedMethod)) {
      return 'allow';
    }
  }

  return mode === 'warn' ? 'warn' : 'deny';
}

function normalizeUrl(url: string): string {
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  return queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
}

function matchesMethod(
  methods: EndpointDeclaration['methods'],
  method: string,
): boolean {
  if (methods === '*') {
    return true;
  }

  return methods.some((allowedMethod) => allowedMethod.toUpperCase() === method);
}

function matchesUrlPattern(pattern: string, url: string): boolean {
  const patternSegments = normalizeUrl(pattern).split('/');
  const urlSegments = url.split('/');

  return matchSegments(patternSegments, urlSegments, 0, 0);
}

function matchSegments(
  patternSegments: string[],
  urlSegments: string[],
  patternIndex: number,
  urlIndex: number,
): boolean {
  while (patternIndex < patternSegments.length && urlIndex < urlSegments.length) {
    const patternSegment = patternSegments[patternIndex];

    if (patternSegment === '**') {
      if (patternIndex === patternSegments.length - 1) {
        return true;
      }

      for (let nextUrlIndex = urlIndex; nextUrlIndex <= urlSegments.length; nextUrlIndex += 1) {
        if (matchSegments(patternSegments, urlSegments, patternIndex + 1, nextUrlIndex)) {
          return true;
        }
      }

      return false;
    }

    if (patternSegment !== '*' && patternSegment !== urlSegments[urlIndex]) {
      return false;
    }

    patternIndex += 1;
    urlIndex += 1;
  }

  while (patternIndex < patternSegments.length && patternSegments[patternIndex] === '**') {
    patternIndex += 1;
  }

  return patternIndex === patternSegments.length && urlIndex === urlSegments.length;
}
