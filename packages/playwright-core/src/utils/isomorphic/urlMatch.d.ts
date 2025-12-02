/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
export declare function globToRegexPattern(glob: string): string;
export type URLMatch = string | RegExp | ((url: URL) => boolean);
export declare function urlMatchesEqual(match1: URLMatch, match2: URLMatch): boolean;
export declare function urlMatches(baseURL: string | undefined, urlString: string, match: URLMatch | undefined, webSocketUrl?: boolean): boolean;
export declare function resolveGlobToRegexPattern(baseURL: string | undefined, glob: string, webSocketUrl?: boolean): string;
export declare function constructURLBasedOnBaseURL(baseURL: string | undefined, givenURL: string): string;
//# sourceMappingURL=urlMatch.d.ts.map