import { registerHooks } from "node:module";

const stubUrl = new URL("./obsidian-stub.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "obsidian") return { url: stubUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
