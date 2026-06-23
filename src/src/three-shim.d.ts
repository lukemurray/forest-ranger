// Electrobun's bun API imports `three` (for its WebGPU helpers) without bundled
// types. We don't use WebGPU/three in Forest Ranger, so silence the implicit-any
// error from inside node_modules/electrobun.
declare module "three";
