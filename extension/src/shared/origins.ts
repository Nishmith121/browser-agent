// The agent acts only on the built-in test-site origin plus origins the user added in Settings (hard constraint, enforced in code).
export { DEFAULT_ORIGIN, isAllowedUrl, normaliseOrigin } from "./settings";
