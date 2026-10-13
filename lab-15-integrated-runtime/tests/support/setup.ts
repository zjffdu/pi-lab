import { afterAll } from "vitest";

import { cleanupTempDirs } from "./scripted-runtime.js";

afterAll(cleanupTempDirs);
