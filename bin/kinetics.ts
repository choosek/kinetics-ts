/**
 * Executable entry for the `kinetics` binary. The shebang is added by the build
 * (tsup banner); this file only wires the live process to {@link run}, which
 * holds all CLI logic and is unit-tested in isolation.
 */
import { defaultEnv, run } from "../src/cli";

process.exit(run(process.argv.slice(2), defaultEnv()));
