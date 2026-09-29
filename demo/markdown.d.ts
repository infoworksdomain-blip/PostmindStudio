// The demo bundle imports the legal placeholders as text (scripts/demo/build.mjs loader '.md').
declare module '*.md' {
  const text: string;
  export default text;
}
