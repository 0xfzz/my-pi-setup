/** esbuild loads plugin-owned CSS as text for runtime style installation. */
declare module "*.css" {
  const css: string;
  export default css;
}
