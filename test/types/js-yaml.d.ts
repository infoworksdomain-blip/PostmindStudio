// Minimal types for js-yaml 4 (devDependency, used only by config tests such as
// test/unit/render-blueprint.test.ts). Only the API the tests call is declared.
declare module 'js-yaml' {
  export function load(input: string, options?: { filename?: string }): unknown;
}
