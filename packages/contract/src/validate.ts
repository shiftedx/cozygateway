import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** A value failed schema validation at the wire boundary. `path` is the JSON pointer of the
 *  first failing location ("" for the root). */
export class ContractViolation extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.name = "ContractViolation";
    this.path = path;
  }
}

export function check<S extends TSchema>(schema: S, value: unknown): value is Static<S> {
  return Value.Check(schema, value);
}

export function assertValid<S extends TSchema>(schema: S, value: unknown): Static<S> {
  const first = Value.Errors(schema, value).First();
  if (first !== undefined) {
    throw new ContractViolation(`${first.message} at ${first.path === "" ? "/" : first.path}`, first.path);
  }
  return value as Static<S>;
}
