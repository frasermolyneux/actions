import { validateBuild } from "./build.mjs";

try {
  validateBuild(JSON.parse(process.env.SONAR_BUILD), JSON.parse(process.env.SONAR_RECIPE));
} catch (error) {
  console.error(`::error::${error instanceof SyntaxError ? "Malformed analysis build JSON" : error.message}`);
  process.exitCode = 1;
}
