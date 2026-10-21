import { Buffer } from "buffer";

const scope = globalThis as { Buffer?: typeof Buffer };
scope.Buffer ??= Buffer;
