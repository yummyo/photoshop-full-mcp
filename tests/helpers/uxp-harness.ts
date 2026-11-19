import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

/** CommonJS UXP harness deliberately lacks browser encoding and Node modules. */
export function pluginModules(photoshop: any = {}, overrides: Record<string, unknown> = {}) {
  const cache = new Map<string, any>();
  const load = (file: string): any => {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} as any }; cache.set(file, module);
    const require = (name: string): any => {
      if (name === "photoshop") return photoshop;
      if (name === "./storage") return { getToken: async () => "test-key", getServer: () => ({ serverId: "test-server", port: 38452 }), getPluginInstanceId: () => "test-plugin", randomId: () => "host-test-epoch" };
      if (name === "./operations") return { EXECUTION_PROTOCOL: "ps-mcp-executor/1", hostEpoch: "host-test-epoch" };
      if (name.startsWith(".")) return load(resolve(dirname(file), name.endsWith(".js") ? name : `${name}.js`));
      throw new Error(`No Node built-ins in the UXP harness: ${name}`);
    };
    const wrapper = vm.runInNewContext(`(function(require,module,exports){${readFileSync(file, "utf8")}\n})`, {
      crypto: { getRandomValues: (bytes: Uint8Array) => webcrypto.getRandomValues(bytes) },
      Uint8Array, Int32Array, ArrayBuffer, DataView, AbortController, setTimeout, clearTimeout,
      TextEncoder: undefined, btoa: undefined, ...overrides,
    }, { filename: file });
    wrapper(require, module, module.exports); return module.exports;
  };
  return (name: string) => load(resolve(`apps/uxp-plugin/lib/${name}.js`));
}
