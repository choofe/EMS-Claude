declare module "stylis" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function prefixer(...args: any[]): string | void;
}

declare module "stylis-plugin-rtl" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rtlPlugin: (...args: any[]) => string | void;
  export default rtlPlugin;
}
