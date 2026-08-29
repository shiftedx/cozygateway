import { openStorage, type FinalizeInput } from "../../src/storage.ts";

const [operation, path, serializedInput] = process.argv.slice(2);
if ((operation !== "finalize" && operation !== "migrate") || path === undefined)
  throw new Error("onboarding race worker requires an operation and database path");

const storage = operation === "finalize" ? openStorage(path) : undefined;
const input = serializedInput === undefined ? undefined : JSON.parse(serializedInput) as FinalizeInput;

process.send?.("ready");
process.once("message", (message) => {
  if (message !== "go") throw new Error("onboarding race worker received an invalid barrier message");
  try {
    const result = operation === "migrate"
      ? (openStorage(path).close(), { outcome: "opened" })
      : storage!.finalizeVerifiedSetupCode(input!);
    storage?.close();
    process.send?.({ result });
    process.disconnect();
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) });
    storage?.close();
    process.exitCode = 1;
    process.disconnect();
  }
});
