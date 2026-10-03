/** Text files bundled with `import x from "./f.py" with { type: "text" }`. */
declare module "*.py" {
  const text: string;
  export default text;
}
