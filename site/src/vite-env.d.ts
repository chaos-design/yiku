/// <reference types="vite/client" />

declare module "virtual:yiku-docs" {
  export const docsByLang: { zh: Record<string, string>; en: Record<string, string> };
}
