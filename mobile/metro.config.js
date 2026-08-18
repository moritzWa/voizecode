const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

// `shared/protocol.ts` lives outside this package. Metro only watches the project root by
// default, so without these two lines an import of it resolves at type-check time and then
// fails at bundle time — the confusing kind of break where tsc is happy and the app is blank.
config.watchFolders = [path.resolve(repoRoot, "shared")];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

module.exports = withNativeWind(config, { input: "./global.css" });
