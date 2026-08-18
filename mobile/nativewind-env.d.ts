/// <reference types="nativewind/types" />

// The NativeWind metro transformer turns this import into style registration; there's nothing
// for TS to resolve, it just has to know the import is legal.
declare module "*.css";
