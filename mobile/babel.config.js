module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
    // react-native-worklets/plugin has to stay last — Reanimated 4 needs it after every
    // other transform has run, or worklets silently fall back to running on the JS thread.
    plugins: ["react-native-worklets/plugin"],
  };
};
