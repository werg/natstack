import { parse } from "tldts";

export async function activate() {
  return {
    async domain(url) {
      return parse(url).domain ?? null;
    },
  };
}
