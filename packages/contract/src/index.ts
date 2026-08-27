/** cozygateway wire contract. The human-readable spec lives in contract/v1.md at the repo
 *  root; this package is its machine artifact: TypeBox schemas with static types derived
 *  from them. */

export const CONTRACT_VERSION = "v1";

export * from "./validate.ts";
export * from "./rich-blocks.ts";
export * from "./resources.ts";
export * from "./rest.ts";
export * from "./ws.ts";
/** Vendor extension, versioned independently of the frozen core: contract/ext-bots-v1.md. */
export * from "./ext-bots.ts";
export * from "./gateway-management.ts";
